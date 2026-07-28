import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { AddMediaKind } from "./AddMediaMenu";
import { useClipboardPaste } from "../features/library/useClipboardPaste";
import { useFileDropImport } from "../features/library/useFileDropImport";
import { LibraryGrid } from "../features/library/LibraryGrid";
import type { LibraryCardItem } from "../features/library/LibraryCard";
import type { LibraryItemAction } from "../features/library/LibraryContextMenu";
import { resolveLibraryShortcut } from "../features/library/libraryShortcuts";
import { itemContextSelection } from "../features/library/contextMenuState";
import {
  isEditableApplicationElement,
} from "../features/library/nativeInteractions";
import { useImportedImages } from "../features/library/useImportedImages";
import { showLibraryError } from "../features/library/useImportedImages";
import {
  createSpace,
  createSpaceAndAssign,
  deleteSpace,
  listSpaces,
  nativeShareAvailable,
  shareItem,
  type Space,
  type SpaceColorKey,
  type SpaceIconKey,
  updateSpace,
} from "../features/library/api";
import {
  isSpaceLocation,
  useNavigationHistory,
  type AppLocation,
} from "../hooks/useNavigationHistory";
import { MainHeader } from "./MainHeader";
import { Sidebar } from "./Sidebar";
import { SpaceEditorDialog } from "./CreateSpaceDialog";
import type { SpaceContextAction } from "./SpaceContextMenu";

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 256;

type SpaceEditorRequest =
  | { mode: "create"; targetItemId: string | null }
  | { mode: "edit"; spaceId: string };

export function AppShell() {
  const navigation = useNavigationHistory<AppLocation>("all");
  const archived = navigation.currentLocation === "archive";
  const {
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
  } = useImportedImages(navigation.currentLocation);
  useFileDropImport(importImagePaths);
  useClipboardPaste({
    disabled: isImporting,
    onPaste: pasteClipboardItem,
  });
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [menuOpenItemId, setMenuOpenItemId] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [shareAvailable, setShareAvailable] = useState(false);
  const [spaceEditorRequest, setSpaceEditorRequest] = useState<SpaceEditorRequest | null>(null);
  const contextTargetIdRef = useRef<string | null>(null);
  const lastExpandedWidth = useRef(DEFAULT_SIDEBAR_WIDTH);
  const stopResize = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    listSpaces()
      .then((items) => { if (active) setSpaces(items); })
      .catch(() => showLibraryError("No. 8 couldn’t load Spaces."));
    nativeShareAvailable()
      .then((available) => { if (active) setShareAvailable(available); })
      .catch(() => { if (active) setShareAvailable(false); });
    return () => { active = false; };
  }, []);

  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((collapsed) => {
      if (collapsed) {
        setSidebarWidth(lastExpandedWidth.current);
      }
      return !collapsed;
    });
  }, []);

  const handleAddMediaSelect = useCallback(
    (kind: AddMediaKind) => {
      if (kind === "media") {
        void pickImages();
      }
    },
    [pickImages],
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.metaKey && event.code === "Backslash") {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [toggleSidebar]);

  useEffect(() => () => stopResize.current?.(), []);

  useEffect(() => {
    setSelectedItemId(null);
    setRenamingItemId(null);
    setMenuOpenItemId(null);
  }, [navigation.currentLocation]);

  const selectedItem = useMemo(
    () => importedItems.find((item) => item.id === selectedItemId) ?? null,
    [importedItems, selectedItemId],
  );

  const activeSpace = useMemo(
    () => {
      const location = navigation.currentLocation;
      return isSpaceLocation(location)
        ? spaces.find((space) => space.id === location.spaceId) ?? null
        : null;
    },
    [navigation.currentLocation, spaces],
  );

  const handleItemAction = useCallback(
    (targetId: string, action: LibraryItemAction) => {
      const item = importedItems.find((candidate) => candidate.id === targetId);
      if (!item) {
        setMenuOpenItemId(null);
        contextTargetIdRef.current = null;
        return;
      }
      switch (action) {
        case "open":
          void openItem(targetId);
          break;
        case "share":
          void shareItem(targetId).catch(() => showLibraryError("No. 8 couldn’t share this item."));
          break;
        case "reveal":
          if (item.sourceType === "image") void revealImage(targetId);
          break;
        case "copy":
          if (item.sourceType === "image") void copyImage(targetId);
          break;
        case "toggleFavorite":
          void favoriteItem(targetId, !item.isFavorite).then((changed) => {
            if (
              changed &&
              navigation.currentLocation === "favorites" &&
              item.isFavorite
            ) {
              setSelectedItemId(null);
              setRenamingItemId(null);
            }
          });
          break;
        case "rename":
          setRenamingItemId(targetId);
          break;
        case "archive":
        case "restore":
          void archiveItem(targetId, action === "archive").then((changed) => {
            if (changed) {
              setSelectedItemId(null);
              setRenamingItemId(null);
            }
          });
          break;
        case "delete":
          void deleteItem(item).then((deleted) => {
            if (deleted) {
              setSelectedItemId(null);
              setRenamingItemId(null);
            }
          });
          break;
      }
    },
    [
      archiveItem,
      copyImage,
      deleteItem,
      favoriteItem,
      importedItems,
      navigation.currentLocation,
      openItem,
      revealImage,
    ],
  );

  useEffect(() => {
    if (menuOpenItemId && !importedItems.some((item) => item.id === menuOpenItemId)) {
      setMenuOpenItemId(null);
      contextTargetIdRef.current = null;
      setSelectedItemId(null);
    }
  }, [importedItems, menuOpenItemId]);

  const selectedItemRef = useRef(selectedItem);
  const shortcutStateRef = useRef({ archived, renamingItemId, menuOpenItemId });
  const handleItemActionRef = useRef(handleItemAction);
  selectedItemRef.current = selectedItem;
  shortcutStateRef.current = { archived, renamingItemId, menuOpenItemId };
  handleItemActionRef.current = handleItemAction;

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest("input, textarea, select") !== null);

    const handleLibraryShortcut = (event: KeyboardEvent) => {
      const selected = selectedItemRef.current;
      const state = shortcutStateRef.current;
      const action = resolveLibraryShortcut(event, {
        archived: state.archived,
        blocked:
          state.renamingItemId !== null ||
          state.menuOpenItemId !== null ||
          document.querySelector('[role="dialog"], [role="menu"]') !== null,
        editable: isEditableTarget(event.target),
        hasSelection: selected !== null,
        selectedIsImage: selected?.sourceType === "image",
      });
      if (!action) return;

      event.preventDefault();
      if (action === "clearSelection") {
        setSelectedItemId(null);
      } else if (selected) {
        handleItemActionRef.current(selected.id, action);
      }
    };

    window.addEventListener("keydown", handleLibraryShortcut);
    return () => window.removeEventListener("keydown", handleLibraryShortcut);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      stopResize.current?.();

      const startX = event.clientX;
      const startWidth = isSidebarCollapsed
        ? lastExpandedWidth.current
        : sidebarWidth;

      document.body.classList.add("is-resizing-sidebar");

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const candidateWidth = startWidth + pointerEvent.clientX - startX;

        if (candidateWidth < MIN_SIDEBAR_WIDTH) {
          setIsSidebarCollapsed(true);
          return;
        }

        const nextWidth = Math.min(candidateWidth, MAX_SIDEBAR_WIDTH);
        lastExpandedWidth.current = nextWidth;
        setSidebarWidth(nextWidth);
        setIsSidebarCollapsed(false);
      };

      const finishResize = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", finishResize);
        window.removeEventListener("pointercancel", finishResize);
        document.body.classList.remove("is-resizing-sidebar");
        stopResize.current = null;
      };

      stopResize.current = finishResize;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finishResize);
      window.addEventListener("pointercancel", finishResize);
    },
    [isSidebarCollapsed, sidebarWidth],
  );

  const handleSaveSpace = useCallback(
    async (name: string, colorKey: SpaceColorKey, iconKey: SpaceIconKey) => {
      const request = spaceEditorRequest;
      if (!request) return false;
      if (request.mode === "edit") {
        if (!spaces.some((space) => space.id === request.spaceId)) return false;
        try {
          const updated = await updateSpace(request.spaceId, name, colorKey, iconKey);
          setSpaces((current) =>
            current.map((space) => (space.id === updated.id ? updated : space)),
          );
          return true;
        } catch {
          await showLibraryError("No. 8 couldn’t update the Space.");
          return false;
        }
      }

      const targetId = request.targetItemId;
      if (targetId && !importedItems.some((item) => item.id === targetId)) {
        setSpaceEditorRequest(null);
        return false;
      }
      try {
        const space = targetId
          ? await createSpaceAndAssign(name, colorKey, iconKey, targetId)
          : await createSpace(name, colorKey, iconKey);
        setSpaces((current) => [...current, space]);
        return true;
      } catch {
        await showLibraryError("No. 8 couldn’t create the Space.");
        return false;
      }
    },
    [importedItems, spaceEditorRequest, spaces],
  );

  const handleSpaceAction = useCallback(
    (space: Space, action: SpaceContextAction) => {
      if (!spaces.some((candidate) => candidate.id === space.id)) return;
      if (action === "edit") {
        setSpaceEditorRequest({ mode: "edit", spaceId: space.id });
        return;
      }

      void (async () => {
        let accepted = false;
        try {
          accepted = await confirm(
            `Delete “${space.name}” Space?\n\nIts media and links will remain in No. 8. Items will only be removed from this Space.`,
            {
              cancelLabel: "Cancel",
              kind: "warning",
              okLabel: "Delete",
              title: "Delete Space",
            },
          );
        } catch {
          await showLibraryError("No. 8 couldn’t confirm the Space deletion.");
          return;
        }
        if (!accepted) return;
        try {
          const deleted = await deleteSpace(space.id);
          if (!deleted) return;
          setSpaces((current) => current.filter((candidate) => candidate.id !== space.id));
          navigation.removeEntries(
            (location) => isSpaceLocation(location) && location.spaceId === space.id,
            "all",
          );
          setSelectedItemId(null);
          setRenamingItemId(null);
          setMenuOpenItemId(null);
          contextTargetIdRef.current = null;
        } catch {
          await showLibraryError("No. 8 couldn’t delete the Space.");
        }
      })();
    },
    [navigation, spaces],
  );

  const editedSpace =
    spaceEditorRequest?.mode === "edit"
      ? spaces.find((space) => space.id === spaceEditorRequest.spaceId)
      : undefined;

  return (
    <div
      className="app-shell flex h-full min-h-0 w-full overflow-hidden bg-background-2 text-primary"
      onContextMenuCapture={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          isEditableApplicationElement(target)
        ) {
          return;
        }
        event.preventDefault();
      }}
    >
      {!isSidebarCollapsed && (
        <Sidebar
          activeLocation={navigation.currentLocation}
          canGoBack={navigation.canGoBack}
          canGoForward={navigation.canGoForward}
          onCollapse={toggleSidebar}
          onGoBack={navigation.goBack}
          onGoForward={navigation.goForward}
          onNavigate={navigation.navigate}
          onCreateSpace={() => setSpaceEditorRequest({ mode: "create", targetItemId: null })}
          onResizeStart={handleResizeStart}
          onSpaceAction={handleSpaceAction}
          spaces={spaces}
          width={sidebarWidth}
        />
      )}
      <main className="min-w-0 flex-1 pb-1 pr-1 pt-1">
        <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-background-1">
          <MainHeader
            activeLocation={navigation.currentLocation}
            activeSpace={activeSpace}
            isImporting={isImporting}
            onAddMediaSelect={handleAddMediaSelect}
            onCreateLink={createLinkItem}
            sidebarCollapsed={isSidebarCollapsed}
          />
          <LibraryGrid
            archived={archived}
            highlightedItemId={highlightedItemId}
            importedItems={importedItems}
            onAction={handleItemAction}
            onCreateSpace={(targetId) =>
              setSpaceEditorRequest({ mode: "create", targetItemId: targetId })
            }
            onCancelRename={() => setRenamingItemId(null)}
            onCommitRename={async (id, title) => {
              const committed = await renameItem(id, title);
              if (committed) setRenamingItemId(null);
              return committed;
            }}
            onMenuOpenChange={(targetId) => {
              const state = itemContextSelection(targetId);
              contextTargetIdRef.current = targetId;
              setMenuOpenItemId(state.menuOpenItemId);
              setSelectedItemId(state.selectedItemId);
            }}
            onSelect={(id) => {
              if (renamingItemId === null) setSelectedItemId(id);
            }}
            onSpaceMembershipChange={(targetId, spaceId, assigned) => {
              if (
                !assigned &&
                isSpaceLocation(navigation.currentLocation) &&
                navigation.currentLocation.spaceId === spaceId
              ) {
                removeItemFromCurrentView(targetId);
                setSelectedItemId(null);
                setMenuOpenItemId(null);
              }
            }}
            renamingItemId={renamingItemId}
            selectedItemId={selectedItemId}
            shareAvailable={shareAvailable}
            spaces={spaces}
          />
        </section>
      </main>
      <SpaceEditorDialog
        contentOffset={isSidebarCollapsed ? 0 : sidebarWidth}
        existingSpaces={spaces}
        mode={spaceEditorRequest?.mode ?? "create"}
        onOpenChange={(open) => {
          if (!open) setSpaceEditorRequest(null);
        }}
        onSubmit={handleSaveSpace}
        open={spaceEditorRequest !== null}
        space={editedSpace}
      />
    </div>
  );
}
