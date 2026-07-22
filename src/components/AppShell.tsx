import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { AddMediaKind } from "./AddMediaMenu";
import { useClipboardPaste } from "../features/library/useClipboardPaste";
import { useFileDropImport } from "../features/library/useFileDropImport";
import { LibraryGrid } from "../features/library/LibraryGrid";
import { useImportedImages } from "../features/library/useImportedImages";
import {
  useNavigationHistory,
  type AppLocation,
} from "../hooks/useNavigationHistory";
import { MainHeader } from "./MainHeader";
import { Sidebar } from "./Sidebar";

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 256;

export function AppShell() {
  const navigation = useNavigationHistory<AppLocation>("all");
  const {
    createLinkItem,
    highlightedItemId,
    importedItems,
    importImagePaths,
    isImporting,
    pasteClipboardItem,
    pickImages,
  } = useImportedImages();
  useFileDropImport(importImagePaths);
  useClipboardPaste({
    disabled: isImporting,
    onPaste: pasteClipboardItem,
  });
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const lastExpandedWidth = useRef(DEFAULT_SIDEBAR_WIDTH);
  const stopResize = useRef<(() => void) | null>(null);

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

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background-2 text-primary">
      {!isSidebarCollapsed && (
        <Sidebar
          activeLocation={navigation.currentLocation}
          canGoBack={navigation.canGoBack}
          canGoForward={navigation.canGoForward}
          onCollapse={toggleSidebar}
          onGoBack={navigation.goBack}
          onGoForward={navigation.goForward}
          onResizeStart={handleResizeStart}
          width={sidebarWidth}
        />
      )}
      <main className="min-w-0 flex-1 pb-1 pr-1 pt-1">
        <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-background-1">
          <MainHeader
            isImporting={isImporting}
            onAddMediaSelect={handleAddMediaSelect}
            onCreateLink={createLinkItem}
            sidebarCollapsed={isSidebarCollapsed}
          />
          <LibraryGrid
            highlightedItemId={highlightedItemId}
            importedItems={importedItems}
          />
        </section>
      </main>
    </div>
  );
}
