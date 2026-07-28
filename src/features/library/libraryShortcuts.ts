export type LibraryShortcutAction =
  | "clearSelection"
  | "open"
  | "rename"
  | "copy"
  | "toggleFavorite"
  | "archive"
  | "restore"
  | "delete";

export type LibraryShortcutEvent = {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
};

export type LibraryShortcutContext = {
  archived: boolean;
  blocked: boolean;
  editable: boolean;
  hasSelection: boolean;
  selectedIsImage: boolean;
};

export function resolveLibraryShortcut(
  event: LibraryShortcutEvent,
  context: LibraryShortcutContext,
): LibraryShortcutAction | null {
  if (event.repeat || context.editable || context.blocked) return null;

  const noModifiers =
    !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (event.key === "Escape" && noModifiers) {
    return context.hasSelection ? "clearSelection" : null;
  }
  if (!context.hasSelection) return null;

  const commandOnly =
    event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (commandOnly && event.code === "KeyO") return "open";
  if (commandOnly && event.code === "KeyD") return "toggleFavorite";
  if (commandOnly && event.code === "KeyC" && context.selectedIsImage) {
    return "copy";
  }
  if (event.key === "Enter" && noModifiers) return "rename";
  if (
    event.metaKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.code === "KeyA"
  ) {
    return context.archived ? "restore" : "archive";
  }
  if (
    noModifiers &&
    (event.key === "Backspace" || event.key === "Delete")
  ) {
    return "delete";
  }
  return null;
}
