import type { AppLocation } from "../../hooks/useNavigationHistory";

const isSpaceLocation = (
  location: AppLocation,
): location is Extract<AppLocation, { kind: "space" }> => typeof location === "object";

export type LibraryViewIcon = "archive" | "library" | "star" | "space";

export const LIBRARY_VIEW_PRESENTATION: Record<
  "all" | "favorites" | "archive",
  { icon: LibraryViewIcon; label: string }
> = {
  all: { icon: "library", label: "All" },
  favorites: { icon: "star", label: "Favorites" },
  archive: { icon: "archive", label: "Archive" },
};

export function libraryViewPresentation(location: AppLocation) {
  return isSpaceLocation(location)
    ? { icon: "space" as const, label: "Space" }
    : LIBRARY_VIEW_PRESENTATION[location];
}

export type LibraryViewItem = {
  archivedAtMs: number | null;
  isFavorite: boolean;
};

export function itemBelongsToLibraryView(
  item: LibraryViewItem,
  view: AppLocation,
) {
  if (isSpaceLocation(view)) return item.archivedAtMs === null;
  if (view === "archive") return item.archivedAtMs !== null;
  if (item.archivedAtMs !== null) return false;
  return view === "all" || item.isFavorite;
}
