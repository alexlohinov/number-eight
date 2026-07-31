import { invoke } from "@tauri-apps/api/core";

export type LibraryItemType = "image" | "link";
export type MetadataStatus = "pending" | "ready" | "failed";

type LibraryItemBase = {
  id: string;
  title: string;
  createdAtMs: number;
  modifiedAtMs: number | null;
  archivedAtMs: number | null;
  isFavorite: boolean;
};

export type ImportedImageItem = LibraryItemBase & {
  itemType: "image";
  fileName: string;
  storedPath: string;
  url: null;
  previewPath: null;
  faviconPath: null;
  metadataStatus: null;
};

export type LinkLibraryItem = LibraryItemBase & {
  itemType: "link";
  fileName: null;
  storedPath: null;
  url: string;
  previewPath: string | null;
  faviconPath: string | null;
  metadataStatus: MetadataStatus;
};

export type LibraryItem = ImportedImageItem | LinkLibraryItem;

export const COLOR_KEYS = [
  "gray", "red", "orange", "yellow", "green", "mint", "teal", "cyan",
  "blue", "indigo", "purple", "pink", "brown",
] as const;
export type SpaceColorKey = (typeof COLOR_KEYS)[number];
export type SpaceIconKey =
  | "heart" | "flower" | "brain" | "folder" | "pencil" | "popcorn"
  | "square-terminal" | "mouse-pointer-click" | "sparkles" | "target"
  | "tool-case" | "vault";

export type Space = {
  id: string;
  name: string;
  colorKey: SpaceColorKey;
  iconKey: SpaceIconKey;
  createdAtMs: number;
  updatedAtMs: number;
};

export type Label = {
  id: string;
  name: string;
  colorKey: SpaceColorKey;
  createdAtMs: number;
  updatedAtMs: number;
};

export type ImportFailure = {
  sourceFileName: string | null;
  reason: string;
};

export type ImportImageFilesResult = {
  imported: LibraryItem[];
  failed: ImportFailure[];
};

export type ListLibraryItemsResult = {
  items: LibraryItem[];
};

export type DeleteLibraryItemResult = {
  deleted: boolean;
  cleanupWarning: string | null;
};

export function importImageFiles(paths: string[], activeSpaceId: string | null) {
  return invoke<ImportImageFilesResult>("import_image_files", { paths, activeSpaceId });
}

export function importClipboardItem(activeSpaceId: string | null) {
  return invoke<LibraryItem | null>("import_clipboard_item", { activeSpaceId });
}

export function listLibraryItems(archived: boolean) {
  return invoke<ListLibraryItemsResult>("list_library_items", { archived });
}

export function listFavoriteItems() {
  return invoke<ListLibraryItemsResult>("list_favorite_items");
}

export function listRecentItems(limit = 5) {
  return invoke<ListLibraryItemsResult>("list_recent_items", { limit });
}

export function searchItems(query: string, limit = 30) {
  return invoke<ListLibraryItemsResult>("search_items", { query, limit });
}

export function createLink(url: string, activeSpaceId: string | null) {
  return invoke<LinkLibraryItem>("create_link", { url, activeSpaceId });
}

export function normalizeLinkUrl(value: string) {
  return invoke<string>("normalize_link_url", { value });
}

export function previewLinkMetadata(url: string) {
  return invoke<string | null>("preview_link_metadata", { url });
}

export function refreshLinkMetadata(id: string) {
  return invoke<LinkLibraryItem>("refresh_link_metadata", { id });
}

export function renameLibraryItem(id: string, title: string) {
  return invoke<LibraryItem>("rename_library_item", { id, title });
}

export function setLibraryItemArchived(id: string, archived: boolean) {
  return invoke<LibraryItem>("set_library_item_archived", { id, archived });
}

export function setLibraryItemFavorite(id: string, isFavorite: boolean) {
  return invoke<LibraryItem>("set_library_item_favorite", { id, isFavorite });
}

export function openLibraryItem(id: string) {
  return invoke<void>("open_library_item", { id });
}

export function revealLibraryImage(id: string) {
  return invoke<void>("reveal_library_image", { id });
}

export function copyLibraryImage(id: string) {
  return invoke<void>("copy_library_image", { id });
}

export function deleteLibraryItem(id: string) {
  return invoke<DeleteLibraryItemResult>("delete_library_item", { id });
}

export const listSpaces = () => invoke<Space[]>("list_spaces");
export const listItemsForSpace = (spaceId: string) =>
  invoke<ListLibraryItemsResult>("list_items_for_space", { spaceId });
export const listSpacesForItem = (itemId: string) =>
  invoke<Space[]>("list_spaces_for_item", { itemId });
export const createSpace = (name: string, colorKey: SpaceColorKey, iconKey: SpaceIconKey) =>
  invoke<Space>("create_space", { name, colorKey, iconKey });
export const createSpaceAndAssign = (
  name: string,
  colorKey: SpaceColorKey,
  iconKey: SpaceIconKey,
  itemId: string,
) => invoke<Space>("create_space_and_assign", { name, colorKey, iconKey, itemId });
export const updateSpace = (
  id: string,
  name: string,
  colorKey: SpaceColorKey,
  iconKey: SpaceIconKey,
) => invoke<Space>("update_space", { id, name, colorKey, iconKey });
export const deleteSpace = (id: string) => invoke<boolean>("delete_space", { id });
export const setItemSpaceMembership = (itemId: string, spaceId: string, assigned: boolean) =>
  invoke<void>("set_item_space_membership", { itemId, spaceId, assigned });

export const listLabels = () => invoke<Label[]>("list_labels");
export const listItemsForLabel = (labelId: string) =>
  invoke<ListLibraryItemsResult>("list_items_for_label", { labelId });
export const listLabelsForItem = (itemId: string) =>
  invoke<Label[]>("list_labels_for_item", { itemId });
export const createLabel = (name: string, colorKey: SpaceColorKey) =>
  invoke<Label>("create_label", { name, colorKey });
export const createLabelAndAssign = (name: string, colorKey: SpaceColorKey, itemId: string) =>
  invoke<Label>("create_label_and_assign", { name, colorKey, itemId });
export const setItemLabelMembership = (itemId: string, labelId: string, assigned: boolean) =>
  invoke<void>("set_item_label_membership", { itemId, labelId, assigned });

export const nativeShareAvailable = () => invoke<boolean>("native_share_available");
export const shareItem = (itemId: string) => invoke<void>("share_item", { itemId });
