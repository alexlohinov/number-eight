import type { AppLocation } from "../../hooks/useNavigationHistory";

const isSpaceLocation = (
  location: AppLocation,
): location is Extract<AppLocation, { kind: "space" }> =>
  typeof location === "object" && location.kind === "space";

const isLabelLocation = (
  location: AppLocation,
): location is Extract<AppLocation, { kind: "label" }> =>
  typeof location === "object" && location.kind === "label";

export type LibraryViewIcon = "archive" | "label" | "library" | "star" | "space";

export const LIBRARY_VIEW_PRESENTATION: Record<
  "all" | "favorites" | "archive",
  { icon: LibraryViewIcon; label: string }
> = {
  all: { icon: "library", label: "All" },
  favorites: { icon: "star", label: "Favorites" },
  archive: { icon: "archive", label: "Archive" },
};

export function libraryViewPresentation(location: AppLocation) {
  if (isSpaceLocation(location)) return { icon: "space" as const, label: "Space" };
  if (isLabelLocation(location)) return { icon: "label" as const, label: "Label" };
  return LIBRARY_VIEW_PRESENTATION[location];
}

export type LibraryViewItem = {
  archivedAtMs: number | null;
  isFavorite: boolean;
};

export function itemBelongsToLibraryView(
  item: LibraryViewItem,
  view: AppLocation,
) {
  if (isSpaceLocation(view) || isLabelLocation(view)) return item.archivedAtMs === null;
  if (view === "archive") return item.archivedAtMs !== null;
  if (item.archivedAtMs !== null) return false;
  return view === "all" || item.isFavorite;
}
