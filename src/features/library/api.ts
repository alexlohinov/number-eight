import { invoke } from "@tauri-apps/api/core";

export type LibraryItemType = "image" | "link";
export type MetadataStatus = "pending" | "ready" | "failed";

type LibraryItemBase = {
  id: string;
  title: string;
  createdAtMs: number;
  modifiedAtMs: number | null;
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

export type ImportFailure = {
  sourceFileName: string | null;
  reason: string;
};

export type ImportImageFilesResult = {
  imported: LibraryItem[];
  failed: ImportFailure[];
};

export type ListImportedImagesResult = {
  items: LibraryItem[];
};

export function importImageFiles(paths: string[]) {
  return invoke<ImportImageFilesResult>("import_image_files", { paths });
}

export function importClipboardItem() {
  return invoke<LibraryItem | null>("import_clipboard_item");
}

export function listImportedImages() {
  return invoke<ListImportedImagesResult>("list_imported_images");
}

export function createLink(url: string) {
  return invoke<LinkLibraryItem>("create_link", { url });
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
