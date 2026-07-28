import { convertFileSrc } from "@tauri-apps/api/core";
import { confirm, message, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appLocationKey,
  isSpaceLocation,
  type AppLocation,
} from "../../hooks/useNavigationHistory";
import type { LibraryCardItem } from "./LibraryCard";
import {
  copyLibraryImage,
  createLink,
  deleteLibraryItem,
  importClipboardItem,
  importImageFiles,
  listFavoriteItems,
  listItemsForSpace,
  listLibraryItems,
  openLibraryItem,
  refreshLinkMetadata,
  renameLibraryItem,
  revealLibraryImage,
  setLibraryItemArchived,
  setLibraryItemFavorite,
  type LibraryItem,
} from "./api";
import { itemBelongsToLibraryView } from "./libraryViews";

const SUPPORTED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const HIGHLIGHT_DURATION_MS = 1_600;

type LibraryCardEntry = {
  metadata: LibraryItem;
  card: LibraryCardItem;
};

type LibraryViews = Record<string, LibraryCardEntry[] | null>;

type ImportedImagesController = {
  archiveItem: (id: string, archived: boolean) => Promise<boolean>;
  copyImage: (id: string) => Promise<void>;
  createLinkItem: (url: string) => Promise<boolean>;
  deleteItem: (item: LibraryCardItem) => Promise<boolean>;
  favoriteItem: (id: string, isFavorite: boolean) => Promise<boolean>;
  highlightedItemId: string | null;
  importedItems: LibraryCardItem[];
  importImagePaths: (paths: string[]) => Promise<void>;
  isImporting: boolean;
  openItem: (id: string) => Promise<void>;
  pasteClipboardItem: () => Promise<void>;
  pickImages: () => Promise<void>;
  renameItem: (id: string, title: string) => Promise<boolean>;
  removeItemFromCurrentView: (id: string) => void;
  revealImage: (id: string) => Promise<void>;
};

export async function showLibraryError(text: string) {
  try {
    await message(text, { kind: "error", title: "No. 8" });
  } catch {
    // A failed system dialog must not turn a recoverable library error into a crash.
  }
}

function localImageAspectRatio(imageSrc: string) {
  return new Promise<number | undefined>((resolve) => {
    const image = new Image();
    image.onload = () => {
      resolve(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? image.naturalWidth / image.naturalHeight
          : undefined,
      );
    };
    image.onerror = () => resolve(undefined);
    image.src = imageSrc;
  });
}

async function toLibraryCardEntry(
  metadata: LibraryItem,
): Promise<LibraryCardEntry> {
  if (metadata.itemType === "link") {
    const imageSrc = metadata.previewPath
      ? convertFileSrc(metadata.previewPath)
      : undefined;
    return {
      metadata,
      card: {
        id: metadata.id,
        title: metadata.title,
        imageSrc,
        imageAlt: `Preview of ${metadata.title}`,
        isFavorite: metadata.isFavorite,
        mediaAspectRatio: imageSrc
          ? await localImageAspectRatio(imageSrc)
          : undefined,
        sourceType: "link",
        sourceIconSrc: metadata.faviconPath
          ? convertFileSrc(metadata.faviconPath)
          : undefined,
        metadataStatus: metadata.metadataStatus,
      },
    };
  }

  const imageSrc = convertFileSrc(metadata.storedPath);
  return {
    metadata,
    card: {
      id: metadata.id,
      title: metadata.title,
      imageSrc,
      imageAlt: `Imported image: ${metadata.title}`,
      isFavorite: metadata.isFavorite,
      mediaAspectRatio: await localImageAspectRatio(imageSrc),
      sourceType: "image",
    },
  };
}

function sortLibraryEntries(entries: LibraryCardEntry[]) {
  return entries.sort((left, right) => {
    const archivedDifference =
      (right.metadata.archivedAtMs ?? 0) - (left.metadata.archivedAtMs ?? 0);
    if (left.metadata.archivedAtMs !== null || right.metadata.archivedAtMs !== null) {
      if (archivedDifference !== 0) return archivedDifference;
    }
    const createdDifference =
      right.metadata.createdAtMs - left.metadata.createdAtMs;
    const leftKey =
      left.metadata.itemType === "image"
        ? left.metadata.fileName
        : left.metadata.url;
    const rightKey =
      right.metadata.itemType === "image"
        ? right.metadata.fileName
        : right.metadata.url;
    return createdDifference || leftKey.localeCompare(rightKey);
  });
}

function mergeLibraryEntries(
  current: LibraryCardEntry[] | null,
  incoming: LibraryCardEntry[],
) {
  const merged = new Map(
    (current ?? []).map((entry) => [entry.metadata.id, entry]),
  );
  for (const entry of incoming) merged.set(entry.metadata.id, entry);
  return sortLibraryEntries([...merged.values()]);
}

function removeEntry(entries: LibraryCardEntry[] | null, id: string) {
  return entries?.filter((entry) => entry.metadata.id !== id) ?? entries;
}

function reconcileLoadedView(
  entries: LibraryCardEntry[] | null,
  view: "all" | "favorites" | "archive",
  entry: LibraryCardEntry,
) {
  if (entries === null) return null;
  const withoutItem = removeEntry(entries, entry.metadata.id) ?? [];
  return itemBelongsToLibraryView(entry.metadata, view)
    ? mergeLibraryEntries(withoutItem, [entry])
    : withoutItem;
}

function failedImportMessage(failedCount: number) {
  return failedCount === 1
    ? "1 image could not be imported."
    : `${failedCount} images could not be imported.`;
}

export function useImportedImages(location: AppLocation): ImportedImagesController {
  const viewKey = appLocationKey(location);
  const activeSpaceId = isSpaceLocation(location) ? location.spaceId : null;
  const [views, setViews] = useState<LibraryViews>({
    all: null,
    favorites: null,
    archive: null,
  });
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const isImportingRef = useRef(false);
  const refreshingLinkIds = useRef(new Set<string>());
  const highlightTimer = useRef<number | null>(null);
  const loadPromises = useRef<Partial<Record<string, Promise<void>>>>({});

  const mergeMetadataIntoView = useCallback(
    async (key: string, items: LibraryItem[]) => {
      if (items.length === 0) return;
      const nextEntries = await Promise.all(items.map(toLibraryCardEntry));
      setViews((current) => ({
        ...current,
        [key]: mergeLibraryEntries(current[key], nextEntries),
      }));
    },
    [],
  );

  const replaceMetadata = useCallback(async (item: LibraryItem) => {
    const entry = await toLibraryCardEntry(item);
    setViews((current) => {
      const next: LibraryViews = {
        ...current,
        all: reconcileLoadedView(current.all, "all", entry),
        favorites: reconcileLoadedView(current.favorites, "favorites", entry),
        archive: reconcileLoadedView(current.archive, "archive", entry),
      };
      for (const [key, entries] of Object.entries(current)) {
        if (!key.startsWith("space:") || entries === null) continue;
        if (!entries.some((candidate) => candidate.metadata.id === item.id)) continue;
        next[key] = item.archivedAtMs === null
          ? mergeLibraryEntries(removeEntry(entries, item.id) ?? [], [entry])
          : removeEntry(entries, item.id);
      }
      return next;
    });
  }, []);

  const refreshLink = useCallback(
    async (id: string) => {
      if (refreshingLinkIds.current.has(id)) return;
      refreshingLinkIds.current.add(id);
      try {
        await replaceMetadata(await refreshLinkMetadata(id));
      } catch {
        // Rust persists ordinary fetch failures as a failed Link item.
      } finally {
        refreshingLinkIds.current.delete(id);
      }
    },
    [replaceMetadata],
  );

  useEffect(() => {
    if ((viewKey in views && views[viewKey] !== null) || loadPromises.current[viewKey]) return;
    const request = (isSpaceLocation(location)
      ? listItemsForSpace(location.spaceId)
      : viewKey === "favorites"
        ? listFavoriteItems()
        : listLibraryItems(viewKey === "archive"))
      .then(async ({ items }) => {
        const entries = await Promise.all(items.map(toLibraryCardEntry));
        setViews((current) => ({
          ...current,
          [viewKey]: mergeLibraryEntries(current[viewKey], entries),
        }));
        for (const item of items) {
          if (item.itemType === "link" && item.metadataStatus === "pending") {
            void refreshLink(item.id);
          }
        }
      })
      .catch(() => showLibraryError("No. 8 couldn’t load library items."))
      .finally(() => {
        delete loadPromises.current[viewKey];
      });
    loadPromises.current[viewKey] = request;
  }, [location, refreshLink, viewKey, views]);

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  const runImportSession = useCallback(
    async (operation: () => Promise<void>, errorMessage: string) => {
      if (isImportingRef.current) return;
      isImportingRef.current = true;
      setIsImporting(true);
      try {
        await operation();
      } catch {
        await showLibraryError(errorMessage);
      } finally {
        isImportingRef.current = false;
        setIsImporting(false);
      }
    },
    [],
  );

  const processImagePaths = useCallback(
    async (paths: string[]) => {
      const uniquePaths = [...new Set(paths.filter(Boolean))];
      if (uniquePaths.length === 0) return;
      const result = await importImageFiles(uniquePaths, activeSpaceId);
      await mergeMetadataIntoView("all", result.imported);
      if (activeSpaceId) await mergeMetadataIntoView(viewKey, result.imported);
      if (result.failed.length > 0) {
        await showLibraryError(failedImportMessage(result.failed.length));
      }
    },
    [activeSpaceId, mergeMetadataIntoView, viewKey],
  );

  const pickImages = useCallback(async () => {
    await runImportSession(
      async () => {
        const selectedPaths = await open({
          directory: false,
          filters: [{ name: "Images", extensions: SUPPORTED_IMAGE_EXTENSIONS }],
          multiple: true,
          title: "Import Images",
        });
        if (selectedPaths?.length) await processImagePaths(selectedPaths);
      },
      "No. 8 couldn’t import the selected images.",
    );
  }, [processImagePaths, runImportSession]);

  const importImagePaths = useCallback(
    async (paths: string[]) => {
      await runImportSession(
        () => processImagePaths(paths),
        "No. 8 couldn’t import the selected images.",
      );
    },
    [processImagePaths, runImportSession],
  );

  const presentCreatedLink = useCallback(
    async (link: Extract<LibraryItem, { itemType: "link" }>) => {
      await mergeMetadataIntoView("all", [link]);
      if (activeSpaceId) await mergeMetadataIntoView(viewKey, [link]);
      setHighlightedItemId(link.id);
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
      highlightTimer.current = window.setTimeout(() => {
        setHighlightedItemId((current) => (current === link.id ? null : current));
        highlightTimer.current = null;
      }, HIGHLIGHT_DURATION_MS);
      if (link.metadataStatus === "pending") void refreshLink(link.id);
    },
    [activeSpaceId, mergeMetadataIntoView, refreshLink, viewKey],
  );

  const pasteClipboardItem = useCallback(async () => {
    await runImportSession(async () => {
      const item = await importClipboardItem(activeSpaceId);
      if (!item) return;
      if (item.itemType === "link") await presentCreatedLink(item);
      else await mergeMetadataIntoView("all", [item]);
    }, "No. 8 couldn’t import the clipboard item.");
  }, [activeSpaceId, mergeMetadataIntoView, presentCreatedLink, runImportSession, viewKey]);

  const createLinkItem = useCallback(
    async (url: string) => {
      try {
        await presentCreatedLink(await createLink(url, activeSpaceId));
        return true;
      } catch {
        await showLibraryError("No. 8 couldn’t create the link.");
        return false;
      }
    },
    [activeSpaceId, presentCreatedLink],
  );

  const renameItem = useCallback(
    async (id: string, title: string) => {
      try {
        await replaceMetadata(await renameLibraryItem(id, title));
        return true;
      } catch {
        await showLibraryError("No. 8 couldn’t rename this item.");
        return false;
      }
    },
    [replaceMetadata],
  );

  const archiveItem = useCallback(
    async (id: string, nextArchived: boolean) => {
      try {
        await replaceMetadata(await setLibraryItemArchived(id, nextArchived));
        return true;
      } catch {
        await showLibraryError(
          nextArchived
            ? "No. 8 couldn’t archive this item."
            : "No. 8 couldn’t restore this item.",
        );
        return false;
      }
    },
    [replaceMetadata],
  );

  const favoriteItem = useCallback(
    async (id: string, isFavorite: boolean) => {
      try {
        await replaceMetadata(await setLibraryItemFavorite(id, isFavorite));
        return true;
      } catch {
        await showLibraryError(
          isFavorite
            ? "No. 8 couldn’t add this item to Favorites."
            : "No. 8 couldn’t remove this item from Favorites.",
        );
        return false;
      }
    },
    [replaceMetadata],
  );

  const openItem = useCallback(async (id: string) => {
    try {
      await openLibraryItem(id);
    } catch {
      await showLibraryError("No. 8 couldn’t open this item.");
    }
  }, []);

  const revealImage = useCallback(async (id: string) => {
    try {
      await revealLibraryImage(id);
    } catch {
      await showLibraryError("No. 8 couldn’t reveal this image in Finder.");
    }
  }, []);

  const copyImage = useCallback(async (id: string) => {
    try {
      await copyLibraryImage(id);
    } catch {
      await showLibraryError("No. 8 couldn’t copy this image.");
    }
  }, []);

  const deleteItem = useCallback(async (item: LibraryCardItem) => {
    const accepted = await confirm(
      `Delete “${item.title}” permanently from No. 8?\n\nThis is different from Archive and cannot be undone in No. 8.`,
      {
        cancelLabel: "Cancel",
        kind: "warning",
        okLabel: "Delete",
        title: "Delete Item",
      },
    );
    if (!accepted) return false;

    try {
      const result = await deleteLibraryItem(item.id);
      if (!result.deleted) return false;
      setViews((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, entries]) => [key, removeEntry(entries, item.id)]),
        ),
      );
      if (result.cleanupWarning) await showLibraryError(result.cleanupWarning);
      return true;
    } catch {
      await showLibraryError("No. 8 couldn’t delete this item.");
      return false;
    }
  }, []);

  const importedItems = useMemo(
    () => (views[viewKey] ?? []).map((entry) => entry.card),
    [viewKey, views],
  );

  const removeItemFromCurrentView = useCallback((id: string) => {
    setViews((current) => ({
      ...current,
      [viewKey]: removeEntry(current[viewKey] ?? null, id),
    }));
  }, [viewKey]);

  return {
    archiveItem,
    copyImage,
    createLinkItem,
    deleteItem,
    favoriteItem,
    highlightedItemId,
    importedItems,
    importImagePaths,
    isImporting,
    openItem,
    pasteClipboardItem,
    pickImages,
    renameItem,
    removeItemFromCurrentView,
    revealImage,
  };
}
