import { convertFileSrc } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryCardItem } from "./LibraryCard";
import {
  createLink,
  importClipboardItem,
  importImageFiles,
  listImportedImages,
  refreshLinkMetadata,
  type LibraryItem,
} from "./api";

const SUPPORTED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const REFERENCE_CARD_WIDTH = 282;
const INFO_PANEL_HEIGHT = 40;
const MIN_CARD_HEIGHT = 190;
const MAX_CARD_HEIGHT = 464;
const FALLBACK_CARD_HEIGHT = 322;
const LINK_CARD_HEIGHT = 206;
const HIGHLIGHT_DURATION_MS = 1_600;

type LibraryCardEntry = {
  metadata: LibraryItem;
  card: LibraryCardItem;
};

type ImportedImagesController = {
  createLinkItem: (url: string) => Promise<boolean>;
  highlightedItemId: string | null;
  importedItems: LibraryCardItem[];
  importImagePaths: (paths: string[]) => Promise<void>;
  isImporting: boolean;
  pasteClipboardItem: () => Promise<void>;
  pickImages: () => Promise<void>;
};

async function showLibraryError(text: string) {
  try {
    await message(text, { kind: "error", title: "No. 8" });
  } catch {
    // A failed system dialog must not turn a recoverable library error into a crash.
  }
}

function importedImageHeight(imageSrc: string) {
  return new Promise<number>((resolve) => {
    const image = new Image();

    image.onload = () => {
      if (image.naturalWidth === 0 || image.naturalHeight === 0) {
        resolve(FALLBACK_CARD_HEIGHT);
        return;
      }

      const previewHeight =
        (REFERENCE_CARD_WIDTH * image.naturalHeight) / image.naturalWidth;
      const totalHeight = Math.round(previewHeight + INFO_PANEL_HEIGHT);
      resolve(Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, totalHeight)));
    };
    image.onerror = () => resolve(FALLBACK_CARD_HEIGHT);
    image.src = imageSrc;
  });
}

async function toLibraryCardEntry(
  metadata: LibraryItem,
): Promise<LibraryCardEntry> {
  if (metadata.itemType === "link") {
    return {
      metadata,
      card: {
        id: `imported:${metadata.id}`,
        title: metadata.title,
        imageSrc: metadata.previewPath
          ? convertFileSrc(metadata.previewPath)
          : undefined,
        imageAlt: `Preview of ${metadata.title}`,
        displayHeight: LINK_CARD_HEIGHT,
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
      id: `imported:${metadata.id}`,
      title: metadata.title,
      imageSrc,
      imageAlt: `Imported image: ${metadata.title}`,
      displayHeight: await importedImageHeight(imageSrc),
      sourceType: "image",
    },
  };
}

function sortLibraryEntries(entries: LibraryCardEntry[]) {
  return entries.sort((left, right) => {
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
  current: LibraryCardEntry[],
  incoming: LibraryCardEntry[],
) {
  const merged = new Map(current.map((entry) => [entry.metadata.id, entry]));
  for (const entry of incoming) {
    merged.set(entry.metadata.id, entry);
  }
  return sortLibraryEntries([...merged.values()]);
}

function failedImportMessage(failedCount: number) {
  return failedCount === 1
    ? "1 image could not be imported."
    : `${failedCount} images could not be imported.`;
}

export function useImportedImages(): ImportedImagesController {
  const [entries, setEntries] = useState<LibraryCardEntry[]>([]);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const isImportingRef = useRef(false);
  const refreshingLinkIds = useRef(new Set<string>());
  const highlightTimer = useRef<number | null>(null);
  const initialLoadRef = useRef<
    Promise<{
      entries: LibraryCardEntry[];
      items: LibraryItem[];
    }> | null
  >(null);

  const mergeLibraryMetadata = useCallback(async (items: LibraryItem[]) => {
    if (items.length === 0) return;
    const nextEntries = await Promise.all(items.map(toLibraryCardEntry));
    setEntries((current) => mergeLibraryEntries(current, nextEntries));
  }, []);

  const refreshLink = useCallback(
    async (id: string) => {
      if (refreshingLinkIds.current.has(id)) return;
      refreshingLinkIds.current.add(id);
      try {
        const refreshed = await refreshLinkMetadata(id);
        await mergeLibraryMetadata([refreshed]);
      } catch {
        // Rust persists ordinary fetch failures as a failed Link item.
      } finally {
        refreshingLinkIds.current.delete(id);
      }
    },
    [mergeLibraryMetadata],
  );

  useEffect(() => {
    let active = true;
    initialLoadRef.current ??= listImportedImages().then(async (result) => ({
      entries: await Promise.all(result.items.map(toLibraryCardEntry)),
      items: result.items,
    }));

    initialLoadRef.current
      .then(({ entries: loadedEntries, items }) => {
        if (!active) return;
        setEntries((current) => mergeLibraryEntries(current, loadedEntries));
        for (const item of items) {
          if (item.itemType === "link" && item.metadataStatus === "pending") {
            void refreshLink(item.id);
          }
        }
      })
      .catch(() => {
        if (active) {
          void showLibraryError("No. 8 couldn’t load library items.");
        }
      });

    return () => {
      active = false;
    };
  }, [refreshLink]);

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  const processImagePaths = useCallback(
    async (paths: string[]) => {
      const uniquePaths = [...new Set(paths.filter((path) => path.length > 0))];
      if (uniquePaths.length === 0) return;

      const result = await importImageFiles(uniquePaths);
      await mergeLibraryMetadata(result.imported);
      if (result.failed.length > 0) {
        await showLibraryError(failedImportMessage(result.failed.length));
      }
    },
    [mergeLibraryMetadata],
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
      await mergeLibraryMetadata([link]);
      const cardId = `imported:${link.id}`;
      setHighlightedItemId(cardId);
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
      highlightTimer.current = window.setTimeout(() => {
        setHighlightedItemId((current) => (current === cardId ? null : current));
        highlightTimer.current = null;
      }, HIGHLIGHT_DURATION_MS);
      if (link.metadataStatus === "pending") {
        void refreshLink(link.id);
      }
    },
    [mergeLibraryMetadata, refreshLink],
  );

  const pasteClipboardItem = useCallback(async () => {
    await runImportSession(
      async () => {
        const item = await importClipboardItem();
        if (!item) return;
        if (item.itemType === "link") {
          await presentCreatedLink(item);
        } else {
          await mergeLibraryMetadata([item]);
        }
      },
      "No. 8 couldn’t import the clipboard item.",
    );
  }, [mergeLibraryMetadata, presentCreatedLink, runImportSession]);

  const createLinkItem = useCallback(
    async (url: string) => {
      try {
        const link = await createLink(url);
        await presentCreatedLink(link);
        return true;
      } catch {
        await showLibraryError("No. 8 couldn’t create the link.");
        return false;
      }
    },
    [presentCreatedLink],
  );

  const importedItems = useMemo(
    () => entries.map((entry) => entry.card),
    [entries],
  );

  return {
    createLinkItem,
    highlightedItemId,
    importedItems,
    importImagePaths,
    isImporting,
    pasteClipboardItem,
    pickImages,
  };
}
