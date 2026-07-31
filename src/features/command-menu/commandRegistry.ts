import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Globe,
  Image,
  Library,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Share,
  Star,
  Tag,
  Trash2,
  Type,
  type LucideIcon,
} from "lucide-react";
import commandManifestJson from "../../shared/app-command-manifest.json" with { type: "json" };
import type { LibraryCardItem } from "../library/LibraryCard";
import type { LibraryItemAction } from "../library/libraryMenu";
import type { Space } from "../library/api";
import type { AppLocation } from "../../hooks/useNavigationHistory";
import type { AppMode } from "../settings/types";

export const appCommandManifest = commandManifestJson.commands;

export type AppCommandId = keyof typeof appCommandManifest;
export type DynamicSpaceCommandId = `navigate.space.${string}`;
export type ExecutableAppCommandId = AppCommandId | DynamicSpaceCommandId;
export type CommandSection = "actions" | "navigation";
export type CommandSource =
  | "native-menu"
  | "command-menu"
  | "keyboard"
  | "sidebar"
  | "toolbar";

export type CommandContext = {
  blockingEditorOpen: boolean;
  blockingOverlayOpen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  commandMenuOpen: boolean;
  currentLocation: AppLocation;
  editableFocused: boolean;
  selectedItem: LibraryCardItem | null;
  selectedItemArchived: boolean;
  shareAvailable: boolean;
  sidebarCollapsed: boolean;
  appMode: AppMode;
  vaultAvailable: boolean;
};

export type AppCommandHandlers = {
  addLink: () => void | Promise<void>;
  addMedia: () => void | Promise<void>;
  browseLabels: () => void | Promise<void>;
  clearSelection: () => void | Promise<void>;
  createSpace: () => void | Promise<void>;
  goBack: () => void | Promise<void>;
  goForward: () => void | Promise<void>;
  navigate: (location: AppLocation) => void | Promise<void>;
  openSettings: () => void | Promise<void>;
  runItemAction: (itemId: string, action: LibraryItemAction) => void | Promise<void>;
  toggleCommandMenu: () => void | Promise<void>;
  toggleSidebar: () => void | Promise<void>;
};

export type AppCommandSnapshot = {
  context: CommandContext;
  handlers: AppCommandHandlers;
  spaces: Space[];
};

export type CommandDefinition = {
  id: AppCommandId;
  title: string;
  section: CommandSection;
  icon: LucideIcon;
  keywords: readonly string[];
  shortcut?: { label: string };
  enabled: boolean;
};

const COMMAND_ICONS: Record<AppCommandId, LucideIcon> = {
  "command-menu.toggle": Search,
  "media.add": Image,
  "link.add": Globe,
  "space.create": Plus,
  "sidebar.toggle": PanelLeft,
  "item.open": Globe,
  "item.share": Share,
  "item.reveal": Search,
  "item.favorite.toggle": Star,
  "item.rename": Type,
  "item.copy-image": Image,
  "item.archive.toggle": Archive,
  "item.delete": Trash2,
  "item.selection.clear": Search,
  "navigate.all": Library,
  "navigate.favorites": Star,
  "navigate.labels": Tag,
  "navigate.archive": Archive,
  "navigate.back": ArrowLeft,
  "navigate.forward": ArrowRight,
  "navigate.settings": Settings,
};

const STATIC_COMMAND_IDS = new Set<string>(Object.keys(appCommandManifest));

export function isAppCommandId(id: string): id is AppCommandId {
  return STATIC_COMMAND_IDS.has(id);
}

export function spaceCommandId(spaceId: string): DynamicSpaceCommandId {
  return `navigate.space.${spaceId}`;
}

function selectedItemEnabled(context: CommandContext) {
  return (
    context.selectedItem !== null &&
    !context.blockingEditorOpen &&
    !context.blockingOverlayOpen
  );
}

export function isAppCommandEnabled(id: AppCommandId, context: CommandContext) {
  const libraryReady = context.appMode === "library" && context.vaultAvailable;
  switch (id) {
    case "navigate.settings":
      return context.appMode !== "settings";
    case "command-menu.toggle":
      return context.commandMenuOpen || !context.blockingEditorOpen;
    case "media.add":
    case "link.add":
    case "space.create":
    case "sidebar.toggle":
    case "navigate.all":
    case "navigate.favorites":
    case "navigate.labels":
    case "navigate.archive":
      return libraryReady && !context.blockingEditorOpen && !context.blockingOverlayOpen;
    case "navigate.back":
      return (
        libraryReady && context.canGoBack &&
        !context.blockingEditorOpen &&
        !context.blockingOverlayOpen
      );
    case "navigate.forward":
      return (
        libraryReady && context.canGoForward &&
        !context.blockingEditorOpen &&
        !context.blockingOverlayOpen
      );
    case "item.share":
      return libraryReady && selectedItemEnabled(context) && context.shareAvailable;
    case "item.reveal":
    case "item.copy-image":
      return (
        libraryReady && selectedItemEnabled(context) && context.selectedItem?.sourceType === "image"
      );
    case "item.open":
    case "item.favorite.toggle":
    case "item.rename":
    case "item.archive.toggle":
    case "item.delete":
    case "item.selection.clear":
      return libraryReady && selectedItemEnabled(context);
  }
}

export function canExecuteAppCommand(
  id: AppCommandId,
  source: CommandSource,
  context: CommandContext,
) {
  if (!isAppCommandEnabled(id, context)) return false;
  if (
    (source === "native-menu" || source === "keyboard") &&
    context.editableFocused &&
    id !== "command-menu.toggle"
  ) {
    return false;
  }
  return true;
}

export function getAppCommandTitle(id: AppCommandId, context: CommandContext) {
  if (id === "item.favorite.toggle") {
    return context.selectedItem?.isFavorite
      ? "Remove from Favorites"
      : "Add to Favorites";
  }
  if (id === "item.archive.toggle") {
    return context.selectedItemArchived ? "Restore" : "Archive";
  }
  return appCommandManifest[id].commandMenuTitle;
}

export function isAppCommandChecked(id: AppCommandId, context: CommandContext) {
  const location = context.currentLocation;
  switch (id) {
    case "sidebar.toggle":
      return !context.sidebarCollapsed;
    case "navigate.all":
      return location === "all";
    case "navigate.favorites":
      return location === "favorites";
    case "navigate.labels":
      return typeof location === "object" && location.kind === "label";
    case "navigate.archive":
      return location === "archive";
    default:
      return undefined;
  }
}

export function createCommandRegistry(context: CommandContext): CommandDefinition[] {
  return (Object.entries(appCommandManifest) as Array<
    [AppCommandId, (typeof appCommandManifest)[AppCommandId]]
  >)
    .filter(([, metadata]) => metadata.commandMenuVisible)
    .sort((left, right) => {
      const group = left[1].group.localeCompare(right[1].group);
      return group || left[1].order - right[1].order;
    })
    .map(([id, metadata]) => ({
      id,
      title: getAppCommandTitle(id, context),
      section: metadata.group as CommandSection,
      icon: COMMAND_ICONS[id],
      keywords: metadata.keywords,
      shortcut: metadata.shortcutLabel
        ? { label: metadata.shortcutLabel }
        : undefined,
      enabled: isAppCommandEnabled(id, context),
    }));
}

export async function runAppCommand(
  id: ExecutableAppCommandId,
  context: CommandContext,
  handlers: AppCommandHandlers,
  spaces: Space[],
) {
  if (!isAppCommandId(id)) {
    const space = spaces.find((candidate) => spaceCommandId(candidate.id) === id);
    if (space) await handlers.navigate({ kind: "space", spaceId: space.id });
    return;
  }

  const selectedId = context.selectedItem?.id;
  switch (id) {
    case "command-menu.toggle":
      return handlers.toggleCommandMenu();
    case "media.add":
      return handlers.addMedia();
    case "link.add":
      return handlers.addLink();
    case "space.create":
      return handlers.createSpace();
    case "sidebar.toggle":
      return handlers.toggleSidebar();
    case "navigate.all":
      return handlers.navigate("all");
    case "navigate.favorites":
      return handlers.navigate("favorites");
    case "navigate.labels":
      return handlers.browseLabels();
    case "navigate.archive":
      return handlers.navigate("archive");
    case "navigate.back":
      return handlers.goBack();
    case "navigate.forward":
      return handlers.goForward();
    case "navigate.settings":
      return handlers.openSettings();
    case "item.selection.clear":
      return handlers.clearSelection();
    case "item.open":
      if (selectedId) return handlers.runItemAction(selectedId, "open");
      return;
    case "item.share":
      if (selectedId) return handlers.runItemAction(selectedId, "share");
      return;
    case "item.reveal":
      if (selectedId) return handlers.runItemAction(selectedId, "reveal");
      return;
    case "item.favorite.toggle":
      if (selectedId) return handlers.runItemAction(selectedId, "toggleFavorite");
      return;
    case "item.rename":
      if (selectedId) return handlers.runItemAction(selectedId, "rename");
      return;
    case "item.copy-image":
      if (selectedId) return handlers.runItemAction(selectedId, "copy");
      return;
    case "item.archive.toggle":
      if (selectedId) {
        return handlers.runItemAction(
          selectedId,
          context.selectedItemArchived ? "restore" : "archive",
        );
      }
      return;
    case "item.delete":
      if (selectedId) return handlers.runItemAction(selectedId, "delete");
  }
}

export async function executeAppCommand(
  id: string,
  source: CommandSource,
  getSnapshot: () => AppCommandSnapshot,
  beforeRun?: (id: ExecutableAppCommandId) => void,
) {
  const snapshot = getSnapshot();
  const staticId = isAppCommandId(id) ? id : null;
  const dynamicSpace = staticId
    ? null
    : snapshot.spaces.find((space) => spaceCommandId(space.id) === id) ?? null;
  if (!staticId && !dynamicSpace) return false;
  if (staticId && !canExecuteAppCommand(staticId, source, snapshot.context)) {
    return false;
  }
  if (
    dynamicSpace &&
    (snapshot.context.blockingEditorOpen ||
      snapshot.context.blockingOverlayOpen ||
      ((source === "native-menu" || source === "keyboard") &&
        snapshot.context.editableFocused))
  ) {
    return false;
  }

  const executableId = id as ExecutableAppCommandId;
  beforeRun?.(executableId);
  await runAppCommand(
    executableId,
    snapshot.context,
    snapshot.handlers,
    snapshot.spaces,
  );
  return true;
}

function shortcutKeywords(shortcut: CommandDefinition["shortcut"]) {
  if (!shortcut) return [];
  const words = shortcut.label
    .replaceAll("⌘", " command ")
    .replaceAll("⌥", " option ")
    .replaceAll("⇧", " shift ")
    .replace(/\s+/g, " ")
    .trim();
  return [shortcut.label, words, words.replace("shift command", "command shift")];
}

export function filterCommands(commands: CommandDefinition[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return commands;
  return commands
    .map((command, index) => {
      const terms = [
        command.title,
        ...command.keywords,
        ...shortcutKeywords(command.shortcut),
      ].map((term) => term.toLocaleLowerCase());
      const rank = terms.some((term) => term.startsWith(normalized))
        ? 0
        : terms.some((term) => term.includes(normalized))
          ? 1
          : null;
      return { command, index, rank };
    })
    .filter(
      (candidate): candidate is typeof candidate & { rank: number } =>
        candidate.rank !== null,
    )
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ command }) => command);
}
