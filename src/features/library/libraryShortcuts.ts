import type { AppCommandId } from "../command-menu/commandRegistry";

export type RetainedLibraryShortcut =
  | "item.selection.clear"
  | "item.rename"
  | "item.copy-image"
  | "item.delete";

export type LibraryShortcutEvent = {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
};

export function resolveLibraryShortcut(
  event: LibraryShortcutEvent,
): Extract<AppCommandId, RetainedLibraryShortcut> | null {
  if (event.repeat) return null;
  const noModifiers =
    !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (event.key === "Escape" && noModifiers) return "item.selection.clear";
  if (event.key === "Enter" && noModifiers) return "item.rename";
  if (
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.code === "KeyC"
  ) {
    return "item.copy-image";
  }
  if (
    noModifiers &&
    (event.key === "Backspace" || event.key === "Delete")
  ) {
    return "item.delete";
  }
  return null;
}
