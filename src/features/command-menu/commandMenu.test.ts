import assert from "node:assert/strict";
import test from "node:test";
import {
  appCommandManifest,
  canExecuteAppCommand,
  createCommandRegistry,
  executeAppCommand,
  filterCommands,
  getAppCommandTitle,
  isAppCommandChecked,
  runAppCommand,
  spaceCommandId,
  type AppCommandHandlers,
  type CommandContext,
  type CommandSource,
} from "./commandRegistry.ts";
import {
  filterSpaces,
  firstSelectableResultId,
  isCurrentRequest,
  moveActiveResult,
  normalizedSearchQuery,
  optionDomId,
  selectableResultIds,
} from "./commandMenuModel.ts";
import type { Space } from "../library/api.ts";

const image = {
  id: "image-1",
  title: "Image",
  imageAlt: "Image",
  isFavorite: false,
  sourceType: "image" as const,
};

const baseContext: CommandContext = {
  appMode: "library",
  blockingEditorOpen: false,
  blockingOverlayOpen: false,
  canGoBack: false,
  canGoForward: false,
  commandMenuOpen: false,
  currentLocation: "all",
  editableFocused: false,
  selectedItem: null,
  selectedItemArchived: false,
  shareAvailable: true,
  sidebarCollapsed: false,
  vaultAvailable: true,
};

const spaces: Space[] = [
  {
    id: "work",
    name: "Work",
    colorKey: "blue",
    iconKey: "folder",
    createdAtMs: 1,
    updatedAtMs: 1,
  },
  {
    id: "ideas",
    name: "Product Ideas",
    colorKey: "purple",
    iconKey: "brain",
    createdAtMs: 2,
    updatedAtMs: 2,
  },
];

function createHandlers(calls: string[]): AppCommandHandlers {
  return {
    addLink: () => { calls.push("link.add"); },
    addMedia: () => { calls.push("media.add"); },
    browseLabels: () => { calls.push("navigate.labels"); },
    clearSelection: () => { calls.push("item.selection.clear"); },
    createSpace: () => { calls.push("space.create"); },
    goBack: () => { calls.push("navigate.back"); },
    goForward: () => { calls.push("navigate.forward"); },
    navigate: (location) => {
      calls.push(
        typeof location === "string"
          ? `navigate:${location}`
          : location.kind === "space"
            ? `navigate.space.${location.spaceId}`
            : `navigate.label.${location.labelId}`,
      );
    },
    openSettings: () => { calls.push("navigate.settings"); },
    runItemAction: (id, action) => { calls.push(`${id}:${action}`); },
    toggleCommandMenu: () => { calls.push("command-menu.toggle"); },
    toggleSidebar: () => { calls.push("sidebar.toggle"); },
  };
}

test("shared manifest has unique accelerators and valid group order", () => {
  const entries = Object.entries(appCommandManifest);
  assert.equal(new Set(entries.map(([id]) => id)).size, entries.length);
  const accelerators = entries.flatMap(([, command]) =>
    command.accelerator ? [command.accelerator] : [],
  );
  assert.equal(new Set(accelerators).size, accelerators.length);
  const groupOrders = entries.map(([, command]) => `${command.group}:${command.order}`);
  assert.equal(new Set(groupOrders).size, groupOrders.length);
  assert.ok(entries.every(([, command]) => command.order > 0));
});

test("Command Menu projects its metadata from the shared manifest", () => {
  const commands = createCommandRegistry(baseContext);
  assert.equal(commands.some((command) => command.id === "command-menu.toggle"), false);
  assert.equal(commands.some((command) => command.id === "item.selection.clear"), false);
  assert.equal(commands.find((command) => command.id === "navigate.settings")?.enabled, true);
  assert.equal(
    commands.find((command) => command.id === "media.add")?.title,
    appCommandManifest["media.add"].commandMenuTitle,
  );
  assert.equal(
    commands.find((command) => command.id === "media.add")?.shortcut?.label,
    appCommandManifest["media.add"].shortcutLabel,
  );
});

test("command filtering ranks prefixes before substrings and includes aliases", () => {
  const commands = createCommandRegistry(baseContext);
  assert.deepEqual(filterCommands(commands, "add").slice(0, 2).map(({ id }) => id), [
    "media.add",
    "link.add",
  ]);
  assert.equal(filterCommands(commands, "website")[0]?.id, "link.add");
  assert.equal(filterCommands(commands, "preferences")[0]?.id, "navigate.settings");
  assert.equal(filterCommands(commands, "command shift m")[0]?.id, "media.add");
});

test("all explicit sources execute the same runtime handler", async () => {
  const calls: string[] = [];
  const handlers = createHandlers(calls);
  const sources: CommandSource[] = [
    "native-menu",
    "command-menu",
    "keyboard",
    "sidebar",
    "toolbar",
  ];
  for (const source of sources) {
    assert.equal(
      await executeAppCommand("media.add", source, () => ({
        context: baseContext,
        handlers,
        spaces,
      })),
      true,
    );
  }
  assert.deepEqual(calls, sources.map(() => "media.add"));
});

test("disabled, blocking, and editable states prevent unsafe execution", async () => {
  assert.equal(canExecuteAppCommand("item.open", "native-menu", baseContext), false);
  assert.equal(
    canExecuteAppCommand("media.add", "native-menu", {
      ...baseContext,
      blockingEditorOpen: true,
    }),
    false,
  );
  assert.equal(
    canExecuteAppCommand("navigate.all", "native-menu", {
      ...baseContext,
      editableFocused: true,
    }),
    false,
  );
  assert.equal(
    canExecuteAppCommand("navigate.all", "command-menu", {
      ...baseContext,
      editableFocused: true,
    }),
    true,
  );
  assert.equal(
    canExecuteAppCommand("command-menu.toggle", "native-menu", {
      ...baseContext,
      editableFocused: true,
    }),
    true,
  );
  const calls: string[] = [];
  assert.equal(
    await executeAppCommand("item.open", "native-menu", () => ({
      context: baseContext,
      handlers: createHandlers(calls),
      spaces,
    })),
    false,
  );
  assert.equal(
    await executeAppCommand("unknown.command", "native-menu", () => ({
      context: baseContext,
      handlers: createHandlers(calls),
      spaces,
    })),
    false,
  );
  assert.deepEqual(calls, []);
});

test("item commands use current selection and dynamic titles", async () => {
  const calls: string[] = [];
  const handlers = createHandlers(calls);
  const firstContext = { ...baseContext, selectedItem: image };
  await runAppCommand("item.open", firstContext, handlers, spaces);
  const nextContext = {
    ...baseContext,
    selectedItem: { ...image, id: "image-2", isFavorite: true },
    selectedItemArchived: true,
  };
  await runAppCommand("item.open", nextContext, handlers, spaces);
  assert.deepEqual(calls, ["image-1:open", "image-2:open"]);
  assert.equal(getAppCommandTitle("item.favorite.toggle", nextContext), "Remove from Favorites");
  assert.equal(getAppCommandTitle("item.archive.toggle", nextContext), "Restore");
});

test("executor reads the latest command snapshot instead of a stale selection", async () => {
  const calls: string[] = [];
  const handlers = createHandlers(calls);
  let snapshot = {
    context: { ...baseContext, selectedItem: image },
    handlers,
    spaces,
  };
  const getSnapshot = () => snapshot;
  snapshot = {
    ...snapshot,
    context: {
      ...snapshot.context,
      selectedItem: { ...image, id: "image-current" },
    },
  };
  assert.equal(await executeAppCommand("item.open", "native-menu", getSnapshot), true);
  assert.deepEqual(calls, ["image-current:open"]);
});

test("route checks are mutually correct and Labels menu state does not affect them", () => {
  const checked = (context: CommandContext) =>
    ["navigate.all", "navigate.favorites", "navigate.labels", "navigate.archive"].filter(
      (id) => isAppCommandChecked(id as keyof typeof appCommandManifest, context),
    );
  assert.deepEqual(checked(baseContext), ["navigate.all"]);
  assert.deepEqual(
    checked({ ...baseContext, blockingOverlayOpen: true }),
    ["navigate.all"],
  );
  assert.deepEqual(
    checked({
      ...baseContext,
      currentLocation: { kind: "label", labelId: "label-1" },
    }),
    ["navigate.labels"],
  );
  assert.equal(isAppCommandChecked("sidebar.toggle", baseContext), true);
  assert.equal(
    isAppCommandChecked("sidebar.toggle", { ...baseContext, sidebarCollapsed: true }),
    false,
  );
});

test("persisted Spaces use stable dynamic IDs without a hard-coded Personal row", async () => {
  assert.deepEqual(filterSpaces(spaces, "work").map((space) => space.id), ["work"]);
  assert.deepEqual(filterSpaces(spaces, "brain").map((space) => space.id), ["ideas"]);
  assert.equal(filterSpaces(spaces, "personal").length, 0);
  const calls: string[] = [];
  await runAppCommand(spaceCommandId("work"), baseContext, createHandlers(calls), spaces);
  await runAppCommand(spaceCommandId("missing"), baseContext, createHandlers(calls), spaces);
  assert.deepEqual(calls, ["navigate.space.work"]);
});

test("flattened navigation skips disabled rows, wraps, and exposes stable option IDs", () => {
  const results = [
    { id: "command:first" },
    { id: "command:disabled", disabled: true },
    { id: "space:one" },
    { id: "item:two" },
  ];
  const ids = selectableResultIds(results);
  assert.deepEqual(ids, ["command:first", "space:one", "item:two"]);
  assert.equal(firstSelectableResultId(results), "command:first");
  assert.equal(moveActiveResult(ids, "command:first", -1), "item:two");
  assert.equal(moveActiveResult(ids, "item:two", 1), "command:first");
  assert.equal(moveActiveResult(ids, null, -1), "item:two");
  assert.equal(optionDomId("space:one"), optionDomId("space:one"));
});

test("whitespace-only queries are empty and stale request sequences are rejected", () => {
  assert.equal(normalizedSearchQuery("   \n "), "");
  assert.equal(normalizedSearchQuery("  visible value  "), "visible value");
  assert.equal(isCurrentRequest(4, 4), true);
  assert.equal(isCurrentRequest(5, 4), false);
});
