import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { AddMediaKind } from "./AddMediaMenu";
import { CommandMenu, type CommandMenuExecution } from "./CommandMenu";
import {
  canExecuteAppCommand,
  createCommandRegistry,
  executeAppCommand as executeRegisteredAppCommand,
  spaceCommandId,
  type AppCommandHandlers,
  type CommandContext,
  type CommandSource,
} from "../features/command-menu/commandRegistry";
import {
  createTauriNativeMenuStateSynchronizer,
  deriveNativeMenuState,
  isExecutableCommandId,
  listenForNativeCommands,
} from "../features/command-menu/nativeMenuBridge";
import { useClipboardPaste } from "../features/library/useClipboardPaste";
import { useFileDropImport } from "../features/library/useFileDropImport";
import { LibraryGrid, type LibraryGridHandle } from "../features/library/LibraryGrid";
import type { LibraryItemAction } from "../features/library/LibraryContextMenu";
import { resolveLibraryShortcut } from "../features/library/libraryShortcuts";
import {
  closeItemContextSelection,
  openItemContextSelection,
} from "../features/library/contextMenuState";
import {
  isEditableApplicationElement,
  shouldSuppressNativeContextMenu,
} from "../features/library/nativeInteractions";
import { useImportedImages } from "../features/library/useImportedImages";
import { showLibraryError } from "../features/library/useImportedImages";
import {
  createSpace,
  createSpaceAndAssign,
  deleteSpace,
  listLabels,
  listSpaces,
  nativeShareAvailable,
  shareItem,
  type Label,
  type Space,
  type SpaceColorKey,
  type SpaceIconKey,
  updateSpace,
} from "../features/library/api";
import {
  isLabelLocation,
  isSpaceLocation,
  useNavigationHistory,
  type AppLocation,
} from "../hooks/useNavigationHistory";
import { MainHeader } from "./MainHeader";
import { Sidebar } from "./Sidebar";
import { SpaceEditorDialog } from "./CreateSpaceDialog";
import type { SpaceContextAction } from "./SpaceContextMenu";
import { SettingsView } from "../features/settings/SettingsView";
import { updateAppPreferences } from "../features/settings/api";
import { applySettingsPatch } from "../features/settings/settingsModel";
import {
  DENSITY_MIN_CARD_WIDTH,
  type AppBootstrap,
  type AppMode,
  type AppSettings,
  type SettingsSection,
} from "../features/settings/types";
import {
  closeAllOverlays as closeAllOverlayState,
  completeOverlayClose,
  initialOverlayCoordinatorState,
  isOverlayTargetActive,
  requestOverlayClose,
  requestOverlayOpen,
  sameFloatingOverlay,
  type BlockingOverlay,
  type FloatingOverlay,
  type OverlayTarget,
  type SpaceEditorRequest,
} from "./overlays/overlayCoordinator";

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 256;

function useAppShellController(bootstrap: AppBootstrap) {
  const navigation = useNavigationHistory<AppLocation>(bootstrap.resolvedStartupLocation);
  const [appMode, setAppMode] = useState<AppMode>(
    bootstrap.vaultAvailability.type === "unavailable" ? "settings" : "library",
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(
    bootstrap.vaultAvailability.type === "unavailable" ? "dataStorage" : "general",
  );
  const [settings, setSettings] = useState<AppSettings>(bootstrap.settings);
  const [vaultAvailability, setVaultAvailability] = useState(bootstrap.vaultAvailability);
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
    nativeDialogOpen,
    openItem,
    pasteClipboardItem,
    pickImages,
    renameItem,
    removeItemFromCurrentView,
    revealImage,
    updateLabelMembership,
    reloadLibrary,
  } = useImportedImages(
    navigation.currentLocation,
    vaultAvailability.type === "unavailable",
  );
  useFileDropImport(
    importImagePaths,
    appMode !== "library" || vaultAvailability.type === "unavailable",
  );
  useClipboardPaste({
    disabled:
      isImporting || appMode !== "library" || vaultAvailability.type === "unavailable",
    onPaste: pasteClipboardItem,
  });
  const [sidebarWidth, setSidebarWidth] = useState(bootstrap.settings.sidebarWidth);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(bootstrap.settings.sidebarCollapsed);
  const [overlayState, setOverlayState] = useState(initialOverlayCoordinatorState);
  const [storedSelectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [spaceConfirmationOpen, setSpaceConfirmationOpen] = useState(false);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [shareAvailable, setShareAvailable] = useState(false);
  const [editableFocused, setEditableFocused] = useState(false);
  const lastExpandedWidth = useRef(bootstrap.settings.sidebarWidth);
  const stopResize = useRef<(() => void) | null>(null);
  const commandMenuFinalFocusRef = useRef<HTMLElement | null>(null);
  const spaceEditorFinalFocusRef = useRef<HTMLElement | null>(null);
  const labelsTriggerRef = useRef<HTMLButtonElement>(null);
  const pendingCommandExecution = useRef<CommandMenuExecution | null>(null);
  const temporaryContextSelection = useRef<string | null>(null);
  const nativeMenuSyncErrorReported = useRef(false);
  const libraryGridRef = useRef<LibraryGridHandle>(null);
  const libraryScrollOffset = useRef(0);
  const pendingScrollRestore = useRef(false);
  const settingsRef = useRef(settings);
  const overlayStateRef = useRef(overlayState);

  useEffect(() => {
    overlayStateRef.current = overlayState;
  }, [overlayState]);

  const requestOverlay = useCallback((target: OverlayTarget) => {
    if (target.layer === "blocking") {
      const activeElement = document.activeElement;
      const finalFocus = activeElement instanceof HTMLElement ? activeElement : null;
      if (target.overlay.type === "commandMenu") {
        commandMenuFinalFocusRef.current = finalFocus;
      } else {
        spaceEditorFinalFocusRef.current = finalFocus;
      }
    }
    setOverlayState((current) => requestOverlayOpen(current, target));
  }, []);

  const closeOverlay = useCallback((target: OverlayTarget) => {
    setOverlayState((current) => requestOverlayClose(current, target));
  }, []);

  const finishOverlayClose = useCallback((target: OverlayTarget, open: boolean) => {
    if (open) return;
    setOverlayState((current) => completeOverlayClose(current, target));
  }, []);

  const dismissAllOverlays = useCallback(() => {
    temporaryContextSelection.current = null;
    setOverlayState((current) => closeAllOverlayState(current));
  }, []);

  const floatingOverlay = overlayState.floating;
  const blockingOverlay = overlayState.blocking;
  const addMediaMenuOpen = floatingOverlay?.type === "addMedia";
  const addLinkOpen = floatingOverlay?.type === "addLink";
  const labelMenuOpen = floatingOverlay?.type === "labels";
  const commandMenuOpen = blockingOverlay?.type === "commandMenu";
  const spaceEditorRequest =
    blockingOverlay?.type === "spaceEditor" ? blockingOverlay.request : null;
  const spaceMenuOpenId =
    floatingOverlay?.type === "spaceContext" ? floatingOverlay.spaceId : null;

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
  }, [settings.theme]);

  const saveSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const previous = settingsRef.current;
      const optimistic = applySettingsPatch(previous, patch);
      if (patch.sidebarWidth !== undefined) {
        lastExpandedWidth.current = patch.sidebarWidth;
        setSidebarWidth(patch.sidebarWidth);
      }
      if (patch.sidebarCollapsed !== undefined) {
        setIsSidebarCollapsed(patch.sidebarCollapsed);
      }
      setSettings(optimistic);
      try {
        const persisted = await updateAppPreferences(patch);
        setSettings(persisted);
        return true;
      } catch {
        setSettings(previous);
        await showLibraryError("No. 8 couldn’t save that preference.");
        return false;
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void saveSettings({ sidebarWidth, sidebarCollapsed: isSidebarCollapsed });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isSidebarCollapsed, saveSettings, sidebarWidth]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void saveSettings({ lastLibraryLocation: navigation.currentLocation });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [navigation.currentLocation, saveSettings]);

  const openSettings = useCallback(() => {
    if (appMode === "settings") return;
    libraryScrollOffset.current = libraryGridRef.current?.getScrollTop() ?? 0;
    setSelectedItemId(null);
    setRenamingItemId(null);
    dismissAllOverlays();
    setAppMode("settings");
  }, [appMode, dismissAllOverlays]);

  const closeSettings = useCallback(() => {
    if (vaultAvailability.type === "unavailable") return;
    pendingScrollRestore.current = true;
    setAppMode("library");
  }, [vaultAvailability.type]);

  useEffect(() => {
    if (appMode !== "library" || !pendingScrollRestore.current) return;
    pendingScrollRestore.current = false;
    libraryGridRef.current?.restoreScrollTop(libraryScrollOffset.current);
  }, [appMode]);

  useEffect(() => {
    if (vaultAvailability.type === "unavailable") return;
    let active = true;
    listSpaces()
      .then((items) => { if (active) setSpaces(items); })
      .catch(() => showLibraryError("No. 8 couldn’t load Spaces."));
    listLabels()
      .then((items) => { if (active) setLabels(items); })
      .catch(() => showLibraryError("No. 8 couldn’t load Labels."));
    nativeShareAvailable()
      .then((available) => { if (active) setShareAvailable(available); })
      .catch(() => { if (active) setShareAvailable(false); });
    return () => { active = false; };
  }, [vaultAvailability.type]);

  const toggleSidebar = useCallback(() => {
    if (isSidebarCollapsed) {
      setSidebarWidth(lastExpandedWidth.current);
    } else {
      if (floatingOverlay?.type === "labels") {
        closeOverlay({ layer: "floating", overlay: floatingOverlay });
      }
    }
    setIsSidebarCollapsed(!isSidebarCollapsed);
  }, [closeOverlay, floatingOverlay, isSidebarCollapsed]);

  useEffect(() => () => stopResize.current?.(), []);

  useEffect(() => {
    const updateEditableFocus = () => {
      const activeElement = document.activeElement;
      setEditableFocused(
        activeElement instanceof Element &&
          isEditableApplicationElement(activeElement),
      );
    };
    const deferEditableFocusUpdate = () => queueMicrotask(updateEditableFocus);
    document.addEventListener("focusin", updateEditableFocus);
    document.addEventListener("focusout", deferEditableFocusUpdate);
    window.addEventListener("focus", updateEditableFocus);
    updateEditableFocus();
    return () => {
      document.removeEventListener("focusin", updateEditableFocus);
      document.removeEventListener("focusout", deferEditableFocusUpdate);
      window.removeEventListener("focus", updateEditableFocus);
    };
  }, []);

  const resetLocationState = useCallback(() => {
    setSelectedItemId(null);
    setRenamingItemId(null);
    dismissAllOverlays();
  }, [dismissAllOverlays]);

  const navigate = useCallback(
    (location: AppLocation) => {
      resetLocationState();
      navigation.navigate(location);
    },
    [navigation.navigate, resetLocationState],
  );

  const goBack = useCallback(() => {
    resetLocationState();
    navigation.goBack();
  }, [navigation.goBack, resetLocationState]);

  const goForward = useCallback(() => {
    resetLocationState();
    navigation.goForward();
  }, [navigation.goForward, resetLocationState]);

  const selectedItemId = importedItems.some(
    (item) => item.id === storedSelectedItemId,
  )
    ? storedSelectedItemId
    : null;
  const menuOpenItemId =
    floatingOverlay?.type === "itemContext" &&
    importedItems.some((item) => item.id === floatingOverlay.itemId)
      ? floatingOverlay.itemId
      : null;

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

  const activeLabel = useMemo(() => {
    const location = navigation.currentLocation;
    return isLabelLocation(location)
      ? labels.find((label) => label.id === location.labelId) ?? null
      : null;
  }, [labels, navigation.currentLocation]);

  const handleLabelCreated = useCallback((label: Label) => {
    setLabels((current) =>
      current.some((candidate) => candidate.id === label.id)
        ? current
        : [...current, label],
    );
  }, []);

  const commandMenuBlocked =
    renamingItemId !== null ||
    spaceEditorRequest !== null ||
    nativeDialogOpen ||
    spaceConfirmationOpen ||
    isImporting;

  const handleFloatingOpenChange = useCallback(
    (target: FloatingOverlay, open: boolean) => {
      const overlayTarget: OverlayTarget = { layer: "floating", overlay: target };
      if (open) {
        if (target.type === "itemContext") {
          const selection = openItemContextSelection(selectedItemId, target.itemId);
          temporaryContextSelection.current = selection.temporarySelectionId;
          setSelectedItemId(selection.selectedItemId);
        }
        requestOverlay(overlayTarget);
        return;
      }

      const wasActive = isOverlayTargetActive(
        overlayStateRef.current,
        overlayTarget,
      );
      closeOverlay(overlayTarget);
      if (target.type === "itemContext") {
        const selection = closeItemContextSelection(
          selectedItemId,
          temporaryContextSelection.current,
          target.itemId,
          wasActive,
        );
        temporaryContextSelection.current = selection.temporarySelectionId;
        setSelectedItemId(selection.selectedItemId);
      }
    },
    [closeOverlay, requestOverlay, selectedItemId],
  );

  const closeActiveFloatingOverlay = useCallback(() => {
    const current = overlayStateRef.current.floating;
    if (!current) return;
    if (
      current.type === "itemContext" &&
      temporaryContextSelection.current === current.itemId
    ) {
      temporaryContextSelection.current = null;
      setSelectedItemId(null);
    }
    closeOverlay({ layer: "floating", overlay: current });
  }, [closeOverlay]);

  const setAddMediaMenuOpen = useCallback(
    (open: boolean) => handleFloatingOpenChange({ type: "addMedia" }, open),
    [handleFloatingOpenChange],
  );

  const setAddLinkOpen = useCallback(
    (open: boolean) => handleFloatingOpenChange({ type: "addLink" }, open),
    [handleFloatingOpenChange],
  );

  const setLabelMenuOpen = useCallback(
    (open: boolean) => handleFloatingOpenChange({ type: "labels" }, open),
    [handleFloatingOpenChange],
  );

  const handleItemMenuOpenChange = useCallback(
    (open: boolean, itemId: string) =>
      handleFloatingOpenChange({ type: "itemContext", itemId }, open),
    [handleFloatingOpenChange],
  );

  const handleSpaceMenuOpenChange = useCallback(
    (open: boolean, spaceId: string) =>
      handleFloatingOpenChange({ type: "spaceContext", spaceId }, open),
    [handleFloatingOpenChange],
  );

  useEffect(() => {
    if (
      floatingOverlay?.type === "itemContext" &&
      !importedItems.some((item) => item.id === floatingOverlay.itemId)
    ) {
      handleItemMenuOpenChange(false, floatingOverlay.itemId);
    }
  }, [floatingOverlay, handleItemMenuOpenChange, importedItems]);

  const requestLabelMenuOpen = useCallback(() => {
    if (isSidebarCollapsed) {
      setSidebarWidth(lastExpandedWidth.current);
      setIsSidebarCollapsed(false);
    }
    requestOverlay({ layer: "floating", overlay: { type: "labels" } });
  }, [isSidebarCollapsed, requestOverlay]);

  const requestCommandMenuOpen = useCallback(() => {
    if (commandMenuOpen || commandMenuBlocked) return;
    requestOverlay({ layer: "blocking", overlay: { type: "commandMenu" } });
  }, [commandMenuBlocked, commandMenuOpen, requestOverlay]);

  const setCommandMenuOpen = useCallback(
    (open: boolean) => {
      const target: OverlayTarget = {
        layer: "blocking",
        overlay: { type: "commandMenu" },
      };
      if (open) requestOverlay(target);
      else closeOverlay(target);
    },
    [closeOverlay, requestOverlay],
  );

  const setSpaceEditorRequest = useCallback(
    (request: SpaceEditorRequest | null) => {
      if (request) {
        requestOverlay({
          layer: "blocking",
          overlay: { type: "spaceEditor", request },
        });
        return;
      }
      const current = overlayStateRef.current.blocking;
      if (current?.type === "spaceEditor") {
        closeOverlay({ layer: "blocking", overlay: current });
      }
    },
    [closeOverlay, requestOverlay],
  );

  const toggleCommandMenu = useCallback(() => {
    if (commandMenuOpen) {
      pendingCommandExecution.current = null;
      setCommandMenuOpen(false);
      return;
    }
    requestCommandMenuOpen();
  }, [commandMenuOpen, requestCommandMenuOpen]);

  const queueCommandMenuExecution = useCallback((execution: CommandMenuExecution) => {
    pendingCommandExecution.current = execution;
    setCommandMenuOpen(false);
  }, [setCommandMenuOpen]);

  const handleItemAction = useCallback(
    (targetId: string, action: LibraryItemAction) => {
      const item = importedItems.find((candidate) => candidate.id === targetId);
      if (!item) {
        const current = overlayStateRef.current.floating;
        if (current?.type === "itemContext") {
          closeOverlay({ layer: "floating", overlay: current });
        }
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
      closeOverlay,
      copyImage,
      deleteItem,
      favoriteItem,
      importedItems,
      navigation.currentLocation,
      openItem,
      revealImage,
    ],
  );

  const blockingOverlayOpen = floatingOverlay !== null;

  const commandContext = useMemo<CommandContext>(
    () => ({
      blockingEditorOpen: commandMenuBlocked,
      blockingOverlayOpen,
      canGoBack: navigation.canGoBack,
      canGoForward: navigation.canGoForward,
      commandMenuOpen,
      currentLocation: navigation.currentLocation,
      editableFocused,
      selectedItem,
      selectedItemArchived: archived,
      shareAvailable,
      sidebarCollapsed: isSidebarCollapsed,
      appMode,
      vaultAvailable: vaultAvailability.type === "ready",
    }),
    [
      archived,
      appMode,
      blockingOverlayOpen,
      commandMenuBlocked,
      commandMenuOpen,
      editableFocused,
      isSidebarCollapsed,
      navigation.canGoBack,
      navigation.canGoForward,
      navigation.currentLocation,
      selectedItem,
      shareAvailable,
      vaultAvailability.type,
    ],
  );

  const commandHandlers = useMemo<AppCommandHandlers>(
    () => ({
      addLink: () => setAddLinkOpen(true),
      addMedia: pickImages,
      browseLabels: requestLabelMenuOpen,
      clearSelection: () => setSelectedItemId(null),
      createSpace: () =>
        setSpaceEditorRequest({ mode: "create", targetItemId: null }),
      goBack,
      goForward,
      navigate,
      openSettings,
      runItemAction: handleItemAction,
      toggleCommandMenu,
      toggleSidebar,
    }),
    [
      handleItemAction,
      goBack,
      goForward,
      navigate,
      openSettings,
      pickImages,
      requestLabelMenuOpen,
      setAddLinkOpen,
      setSpaceEditorRequest,
      toggleCommandMenu,
      toggleSidebar,
    ],
  );

  const commandSnapshotRef = useRef({
    context: commandContext,
    handlers: commandHandlers,
    spaces,
  });

  useEffect(() => {
    commandSnapshotRef.current = {
      context: commandContext,
      handlers: commandHandlers,
      spaces,
    };
  }, [commandContext, commandHandlers, spaces]);

  const nativeMenuSynchronizerRef = useRef<
    ReturnType<typeof createTauriNativeMenuStateSynchronizer> | null
  >(null);
  if (nativeMenuSynchronizerRef.current === null) {
    nativeMenuSynchronizerRef.current = createTauriNativeMenuStateSynchronizer(
      () => {
        if (nativeMenuSyncErrorReported.current) return;
        nativeMenuSyncErrorReported.current = true;
        void showLibraryError("No. 8 couldn’t update the application menu.");
      },
    );
  }

  const requestNativeMenuSync = useCallback(() => {
    const snapshot = commandSnapshotRef.current;
    nativeMenuSynchronizerRef.current?.enqueue(
      deriveNativeMenuState(snapshot.context, snapshot.spaces),
    );
  }, []);

  const executeAppCommand = useCallback(
    async (id: string, source: CommandSource) => {
      try {
        return await executeRegisteredAppCommand(
          id,
          source,
          () => commandSnapshotRef.current,
          (commandId) => {
            if (commandId === "command-menu.toggle") return;
            closeActiveFloatingOverlay();
          },
        );
      } catch {
        await showLibraryError("No. 8 couldn’t run that command.");
        return false;
      } finally {
        queueMicrotask(requestNativeMenuSync);
      }
    },
    [closeActiveFloatingOverlay, requestNativeMenuSync],
  );

  const commandRegistry = useMemo(
    () => createCommandRegistry(commandContext),
    [commandContext],
  );

  const handleCommandMenuOpenChangeComplete = useCallback(
    (open: boolean) => {
      if (open) return;
      finishOverlayClose(
        { layer: "blocking", overlay: { type: "commandMenu" } },
        false,
      );
      if (pendingCommandExecution.current === null) return;
      const execution = pendingCommandExecution.current;
      pendingCommandExecution.current = null;
      if (execution.kind === "item") {
        try {
          void Promise.resolve(execution.run()).catch(() =>
            showLibraryError("No. 8 couldn’t run that command."),
          );
        } catch {
          void showLibraryError("No. 8 couldn’t run that command.");
        }
        return;
      }
      void executeAppCommand(execution.commandId, "command-menu");
    },
    [executeAppCommand, finishOverlayClose],
  );

  const handleAddMediaSelect = useCallback(
    (kind: AddMediaKind) => {
      void executeAppCommand(
        kind === "media" ? "media.add" : "link.add",
        "toolbar",
      );
    },
    [executeAppCommand],
  );

  useEffect(() => {
    requestNativeMenuSync();
  }, [commandContext, requestNativeMenuSync, spaces]);

  useEffect(
    () => () => nativeMenuSynchronizerRef.current?.dispose(),
    [],
  );

  useEffect(
    () =>
      listenForNativeCommands(
        (id) => {
          if (!isExecutableCommandId(id)) return;
          void executeAppCommand(id, "native-menu");
        },
        () => void showLibraryError("No. 8 couldn’t connect to the application menu."),
      ),
    [executeAppCommand],
  );

  useEffect(() => {
    const handleWindowFocus = () => requestNativeMenuSync();
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [requestNativeMenuSync]);

  useEffect(() => {
    const handleLibraryShortcut = (event: KeyboardEvent) => {
      const id = resolveLibraryShortcut(event);
      if (!id) return;
      if (
        event.target instanceof Element &&
        isEditableApplicationElement(event.target)
      ) {
        return;
      }
      const overlays = overlayStateRef.current;
      if (overlays.floating || overlays.blocking || overlays.closing) return;
      const snapshot = commandSnapshotRef.current;
      if (!canExecuteAppCommand(id, "keyboard", snapshot.context)) return;
      event.preventDefault();
      void executeAppCommand(id, "keyboard");
    };

    window.addEventListener("keydown", handleLibraryShortcut);
    return () => window.removeEventListener("keydown", handleLibraryShortcut);
  }, [executeAppCommand]);

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
          const current = overlayStateRef.current.floating;
          if (current?.type === "labels") {
            closeOverlay({ layer: "floating", overlay: current });
          }
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
    [closeOverlay, isSidebarCollapsed, sidebarWidth],
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
        setSpaceConfirmationOpen(true);
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
        } finally {
          setSpaceConfirmationOpen(false);
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
          closeActiveFloatingOverlay();
        } catch {
          await showLibraryError("No. 8 couldn’t delete the Space.");
        }
      })();
    },
    [closeActiveFloatingOverlay, navigation, spaces],
  );

  const editedSpace =
    spaceEditorRequest?.mode === "edit"
      ? spaces.find((space) => space.id === spaceEditorRequest.spaceId)
      : undefined;

  return {
    activeLabel,
    activeSpace,
    addLinkOpen,
    addMediaMenuOpen,
    appMode,
    archived,
    bootstrap,
    closeSettings,
    commandMenuFinalFocusRef,
    commandMenuOpen,
    commandRegistry,
    createLinkItem,
    editedSpace,
    executeAppCommand,
    finishOverlayClose,
    handleAddMediaSelect,
    handleCommandMenuOpenChangeComplete,
    handleItemAction,
    handleItemMenuOpenChange,
    handleLabelCreated,
    handleResizeStart,
    handleSaveSpace,
    handleSpaceAction,
    handleSpaceMenuOpenChange,
    highlightedItemId,
    importedItems,
    isImporting,
    isSidebarCollapsed,
    labelMenuOpen,
    labels,
    labelsTriggerRef,
    libraryGridRef,
    libraryScrollOffset,
    menuOpenItemId,
    navigate,
    navigation,
    openItem,
    queueCommandMenuExecution,
    reloadLibrary,
    removeItemFromCurrentView,
    renameItem,
    renamingItemId,
    resetLocationState,
    saveSettings,
    selectedItemId,
    setAddLinkOpen,
    setAddMediaMenuOpen,
    setCommandMenuOpen,
    setLabelMenuOpen,
    setLabels,
    setRenamingItemId,
    setSelectedItemId,
    setSettingsSection,
    setSpaceEditorRequest,
    setSpaces,
    setVaultAvailability,
    settings,
    settingsSection,
    shareAvailable,
    sidebarWidth,
    spaceEditorFinalFocusRef,
    spaceEditorRequest,
    spaceMenuOpenId,
    spaces,
    updateLabelMembership,
    vaultAvailability,
  };
}

type AppShellController = ReturnType<typeof useAppShellController>;

function SettingsShell({ controller }: { controller: AppShellController }) {
  const {
    bootstrap,
    closeSettings,
    libraryScrollOffset,
    navigation,
    reloadLibrary,
    resetLocationState,
    saveSettings,
    setLabels,
    setSettingsSection,
    setSpaces,
    setVaultAvailability,
    settings,
    settingsSection,
    vaultAvailability,
  } = controller;

  return (
    <SettingsView
      appVersion={bootstrap.appVersion}
      availability={vaultAvailability}
      onAvailabilityChange={setVaultAvailability}
      onClose={closeSettings}
      onSectionChange={setSettingsSection}
      onSettingsChange={saveSettings}
      onVaultChanged={() => {
        resetLocationState();
        navigation.reset("all");
        libraryScrollOffset.current = 0;
        reloadLibrary();
        setSpaces([]);
        setLabels([]);
        void saveSettings({ lastLibraryLocation: "all" });
        void listSpaces().then(setSpaces).catch(() => undefined);
        void listLabels().then(setLabels).catch(() => undefined);
      }}
      section={settingsSection}
      settings={settings}
    />
  );
}

function LibraryShell({ controller }: { controller: AppShellController }) {
  const {
    activeLabel,
    activeSpace,
    addLinkOpen,
    addMediaMenuOpen,
    archived,
    commandMenuFinalFocusRef,
    commandMenuOpen,
    commandRegistry,
    createLinkItem,
    editedSpace,
    executeAppCommand,
    finishOverlayClose,
    handleAddMediaSelect,
    handleCommandMenuOpenChangeComplete,
    handleItemAction,
    handleItemMenuOpenChange,
    handleLabelCreated,
    handleResizeStart,
    handleSaveSpace,
    handleSpaceAction,
    handleSpaceMenuOpenChange,
    highlightedItemId,
    importedItems,
    isImporting,
    isSidebarCollapsed,
    labelMenuOpen,
    labels,
    labelsTriggerRef,
    libraryGridRef,
    menuOpenItemId,
    navigate,
    navigation,
    openItem,
    queueCommandMenuExecution,
    removeItemFromCurrentView,
    renameItem,
    renamingItemId,
    selectedItemId,
    setAddLinkOpen,
    setAddMediaMenuOpen,
    setCommandMenuOpen,
    setLabelMenuOpen,
    setRenamingItemId,
    setSelectedItemId,
    setSpaceEditorRequest,
    settings,
    shareAvailable,
    sidebarWidth,
    spaceEditorFinalFocusRef,
    spaceEditorRequest,
    spaceMenuOpenId,
    spaces,
    updateLabelMembership,
  } = controller;

  return (
    <div
      className="app-shell flex h-full min-h-0 w-full overflow-hidden bg-background-2 text-primary"
      onContextMenuCapture={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          shouldSuppressNativeContextMenu(target)
        ) event.preventDefault();
      }}
    >
      {!isSidebarCollapsed && (
        <Sidebar
          activeLocation={navigation.currentLocation}
          canGoBack={navigation.canGoBack}
          canGoForward={navigation.canGoForward}
          labels={labels}
          labelMenuOpen={labelMenuOpen}
          labelsTriggerRef={labelsTriggerRef}
          onCollapse={() => void executeAppCommand("sidebar.toggle", "sidebar")}
          onGoBack={() => void executeAppCommand("navigate.back", "sidebar")}
          onGoForward={() => void executeAppCommand("navigate.forward", "sidebar")}
          onNavigate={(location) => {
            if (isSpaceLocation(location)) {
              void executeAppCommand(spaceCommandId(location.spaceId), "sidebar");
            } else if (isLabelLocation(location)) {
              navigate(location);
            } else {
              const id = {
                all: "navigate.all",
                favorites: "navigate.favorites",
                archive: "navigate.archive",
              }[location];
              void executeAppCommand(id, "sidebar");
            }
          }}
          onLabelCreated={handleLabelCreated}
          onLabelMenuOpenChange={setLabelMenuOpen}
          onLabelMenuOpenChangeComplete={(open) =>
            finishOverlayClose(
              { layer: "floating", overlay: { type: "labels" } },
              open,
            )
          }
          onCreateSpace={() => void executeAppCommand("space.create", "sidebar")}
          onResizeStart={handleResizeStart}
          onSearch={() => void executeAppCommand("command-menu.toggle", "sidebar")}
          onSettings={() => void executeAppCommand("navigate.settings", "sidebar")}
          onSpaceAction={handleSpaceAction}
          onSpaceMenuOpenChange={handleSpaceMenuOpenChange}
          onSpaceMenuOpenChangeComplete={(open, spaceId) =>
            finishOverlayClose(
              { layer: "floating", overlay: { type: "spaceContext", spaceId } },
              open,
            )
          }
          spaceMenuOpenId={spaceMenuOpenId}
          spaces={spaces}
          width={sidebarWidth}
        />
      )}
      <main className="min-w-0 flex-1 pb-1 pr-1 pt-1">
        <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-background-1">
          <MainHeader
            addLinkOpen={addLinkOpen}
            addMediaMenuOpen={addMediaMenuOpen}
            activeLocation={navigation.currentLocation}
            activeLabel={activeLabel}
            activeSpace={activeSpace}
            isImporting={isImporting}
            onAddLinkOpenChange={setAddLinkOpen}
            onAddLinkOpenChangeComplete={(open) =>
              finishOverlayClose(
                { layer: "floating", overlay: { type: "addLink" } },
                open,
              )
            }
            onAddMediaMenuOpenChange={setAddMediaMenuOpen}
            onAddMediaMenuOpenChangeComplete={(open) =>
              finishOverlayClose(
                { layer: "floating", overlay: { type: "addMedia" } },
                open,
              )
            }
            onAddMediaSelect={handleAddMediaSelect}
            onCreateLink={createLinkItem}
            sidebarCollapsed={isSidebarCollapsed}
          />
          <LibraryGrid
            archived={archived}
            highlightedItemId={highlightedItemId}
            importedItems={importedItems}
            minCardWidth={DENSITY_MIN_CARD_WIDTH[settings.density]}
            labels={labels}
            menuOpenItemId={menuOpenItemId}
            onAction={handleItemAction}
            onCreateSpace={(targetId) =>
              setSpaceEditorRequest({ mode: "create", targetItemId: targetId })
            }
            onLabelCreated={handleLabelCreated}
            onLabelMembershipChange={(targetId, labelId, assigned) => {
              updateLabelMembership(targetId, labelId, assigned);
              if (
                !assigned &&
                isLabelLocation(navigation.currentLocation) &&
                navigation.currentLocation.labelId === labelId
              ) {
                setSelectedItemId(null);
                handleItemMenuOpenChange(false, targetId);
              }
            }}
            onCancelRename={() => setRenamingItemId(null)}
            onCommitRename={async (id, title) => {
              const committed = await renameItem(id, title);
              if (committed) setRenamingItemId(null);
              return committed;
            }}
            onMenuOpenChange={handleItemMenuOpenChange}
            onMenuOpenChangeComplete={(open, itemId) =>
              finishOverlayClose(
                { layer: "floating", overlay: { type: "itemContext", itemId } },
                open,
              )
            }
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
                handleItemMenuOpenChange(false, targetId);
              }
            }}
            renamingItemId={renamingItemId}
            selectedItemId={selectedItemId}
            shareAvailable={shareAvailable}
            spaces={spaces}
            ref={libraryGridRef}
          />
        </section>
      </main>
      <SpaceEditorDialog
        contentOffset={isSidebarCollapsed ? 0 : sidebarWidth}
        existingSpaces={spaces}
        finalFocusRef={spaceEditorFinalFocusRef}
        mode={spaceEditorRequest?.mode ?? "create"}
        onOpenChange={(open) => {
          if (open && spaceEditorRequest) setSpaceEditorRequest(spaceEditorRequest);
          else if (!open) setSpaceEditorRequest(null);
        }}
        onOpenChangeComplete={(open) =>
          finishOverlayClose(
            {
              layer: "blocking",
              overlay: {
                type: "spaceEditor",
                request: spaceEditorRequest ?? {
                  mode: "create",
                  targetItemId: null,
                },
              },
            },
            open,
          )
        }
        onSubmit={handleSaveSpace}
        open={spaceEditorRequest !== null}
        space={editedSpace}
      />
      <CommandMenu
        commands={commandRegistry}
        finalFocusRef={commandMenuFinalFocusRef}
        onExecute={queueCommandMenuExecution}
        onOpenChange={setCommandMenuOpen}
        onOpenChangeComplete={handleCommandMenuOpenChangeComplete}
        onOpenItem={openItem}
        open={commandMenuOpen}
        spaces={spaces}
      />
    </div>
  );
}

export function AppShell({ bootstrap }: { bootstrap: AppBootstrap }) {
  const controller = useAppShellController(bootstrap);
  return controller.appMode === "settings" ? (
    <SettingsShell controller={controller} />
  ) : (
    <LibraryShell controller={controller} />
  );
}
