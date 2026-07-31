import assert from "node:assert/strict";
import test from "node:test";
import {
  createNativeMenuStateSynchronizer,
  deriveNativeMenuState,
  registerNativeCommandListener,
  type NativeMenuStatePayload,
} from "./nativeMenuBridge.ts";
import type { CommandContext } from "./commandRegistry.ts";

const context: CommandContext = {
  appMode: "library",
  blockingEditorOpen: false,
  blockingOverlayOpen: false,
  canGoBack: true,
  canGoForward: false,
  commandMenuOpen: false,
  currentLocation: { kind: "space", spaceId: "space-1" },
  editableFocused: false,
  selectedItem: {
    id: "image-1",
    title: "Image",
    imageAlt: "Image",
    isFavorite: true,
    sourceType: "image",
  },
  selectedItemArchived: true,
  shareAvailable: true,
  sidebarCollapsed: true,
  vaultAvailable: true,
};

test("native state derives enabled, checked, title, history, and active Space state", () => {
  const payload = deriveNativeMenuState(context, [
    {
      id: "space-1",
      name: "Work",
      colorKey: "blue",
      iconKey: "folder",
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  ]);
  const command = (id: string) => payload.commands.find((candidate) => candidate.id === id);
  assert.equal(command("item.reveal")?.enabled, true);
  assert.equal(command("item.favorite.toggle")?.title, "Remove from Favorites");
  assert.equal(command("item.archive.toggle")?.title, "Restore");
  assert.equal(command("navigate.back")?.enabled, true);
  assert.equal(command("navigate.forward")?.enabled, false);
  assert.equal(command("sidebar.toggle")?.checked, false);
  assert.equal(payload.spacesEnabled, true);
  assert.deepEqual(payload.spaces, [{ id: "space-1", name: "Work", active: true }]);

  const editablePayload = deriveNativeMenuState(
    { ...context, editableFocused: true },
    [],
  );
  assert.equal(editablePayload.spacesEnabled, false);

  const linkPayload = deriveNativeMenuState(
    {
      ...context,
      selectedItem: { ...context.selectedItem!, sourceType: "link" },
    },
    [],
  );
  const linkCommand = (id: string) =>
    linkPayload.commands.find((candidate) => candidate.id === id);
  assert.equal(linkCommand("item.reveal")?.enabled, false);
  assert.equal(linkCommand("item.copy-image")?.enabled, false);
});

test("state synchronizer serializes sends and coalesces pending payloads", async () => {
  const sent: NativeMenuStatePayload[] = [];
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const synchronizer = createNativeMenuStateSynchronizer(async (payload) => {
    sent.push(payload);
    if (sent.length === 1) await firstPending;
  }, () => assert.fail("sync should not fail"));
  const payload = (name: string): NativeMenuStatePayload => ({
    commands: [],
    spacesEnabled: true,
    spaces: [{ id: name, name, active: false }],
  });
  synchronizer.enqueue(payload("first"));
  synchronizer.enqueue(payload("second"));
  synchronizer.enqueue(payload("latest"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((candidate) => candidate.spaces[0].name), ["first", "latest"]);
  synchronizer.dispose();
});

test("listener cleanup prevents duplicate Strict Mode delivery", async () => {
  const listeners = new Set<(event: { payload: { id: string } }) => void>();
  const subscribe = async (handler: (event: { payload: { id: string } }) => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  };
  const calls: string[] = [];
  const firstCleanup = registerNativeCommandListener(subscribe, (id) => calls.push(id), () => {});
  await new Promise((resolve) => setImmediate(resolve));
  firstCleanup();
  const secondCleanup = registerNativeCommandListener(subscribe, (id) => calls.push(id), () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener({ payload: { id: "media.add" } });
  assert.deepEqual(calls, ["media.add"]);
  secondCleanup();
  assert.equal(listeners.size, 0);
});
