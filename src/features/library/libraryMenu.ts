export type LibraryItemAction =
  | "open"
  | "share"
  | "toggleFavorite"
  | "reveal"
  | "rename"
  | "copy"
  | "archive"
  | "restore"
  | "delete";

export type LibraryMenuItem = {
  isFavorite: boolean;
  sourceType: "image" | "link";
};

export type LibraryMenuEntry = {
  action: LibraryItemAction;
  label: string;
  shortcut?: string;
};

export function libraryMenuGroups(
  item: LibraryMenuItem,
  archived: boolean,
  shareAvailable = false,
): LibraryMenuEntry[][] {
  const first: LibraryMenuEntry[] = [
    { action: "open", label: "Open", shortcut: "⌘O" },
  ];
  if (shareAvailable) first.push({ action: "share", label: "Share…" });
  if (item.sourceType === "image") {
    first.push({ action: "reveal", label: "Reveal in Finder" });
  }

  const second: LibraryMenuEntry[] = [
    {
      action: "toggleFavorite",
      label: item.isFavorite ? "Remove from Favorites" : "Add to Favorites",
      shortcut: "⌘D",
    },
  ];
  const third: LibraryMenuEntry[] = [{ action: "rename", label: "Rename" }];
  if (item.sourceType === "image") {
    third.push({ action: "copy", label: "Copy Image", shortcut: "⌘C" });
  }
  const fourth: LibraryMenuEntry[] = [
    archived
      ? { action: "restore", label: "Restore" }
      : { action: "archive", label: "Archive" },
    { action: "delete", label: "Delete", shortcut: "⌫" },
  ];

  return [first, second, third, fourth];
}
