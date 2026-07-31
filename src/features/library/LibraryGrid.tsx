import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { LibraryCard, type LibraryCardItem } from "./LibraryCard";
import {
  LibraryContextMenu,
  type LibraryItemAction,
} from "./LibraryContextMenu";
import { calculateMasonryLayout } from "./masonry";
import type { Label, Space } from "./api";

type LibraryGridProps = {
  archived: boolean;
  highlightedItemId?: string | null;
  importedItems?: LibraryCardItem[];
  labels: Label[];
  menuOpenItemId: string | null;
  onAction: (targetId: string, action: LibraryItemAction) => void;
  onCreateSpace: (targetId: string) => void;
  onLabelCreated: (label: Label) => void;
  onLabelMembershipChange: (targetId: string, labelId: string, assigned: boolean) => void;
  onCancelRename: () => void;
  onCommitRename: (id: string, title: string) => Promise<boolean>;
  onMenuOpenChange: (open: boolean, id: string) => void;
  onMenuOpenChangeComplete: (open: boolean, id: string) => void;
  onSelect: (id: string | null) => void;
  onSpaceMembershipChange: (targetId: string, spaceId: string, assigned: boolean) => void;
  renamingItemId: string | null;
  selectedItemId: string | null;
  shareAvailable: boolean;
  spaces: Space[];
  minCardWidth?: number;
};

export type LibraryGridHandle = {
  getScrollTop: () => number;
  restoreScrollTop: (offset: number) => void;
};

const EMPTY_IMPORTED_ITEMS: LibraryCardItem[] = [];

export const LibraryGrid = forwardRef<LibraryGridHandle, LibraryGridProps>(function LibraryGrid({
  archived,
  highlightedItemId = null,
  importedItems = EMPTY_IMPORTED_ITEMS,
  labels,
  menuOpenItemId,
  onAction,
  onCreateSpace,
  onLabelCreated,
  onLabelMembershipChange,
  onCancelRename,
  onCommitRename,
  onMenuOpenChange,
  onMenuOpenChangeComplete,
  onSelect,
  onSpaceMembershipChange,
  renamingItemId,
  selectedItemId,
  shareAvailable,
  spaces,
  minCardWidth = 240,
}, forwardedRef) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  useImperativeHandle(forwardedRef, () => ({
    getScrollTop: () => scrollRef.current?.scrollTop ?? 0,
    restoreScrollTop: (offset) => {
      const viewport = scrollRef.current;
      if (!viewport) return;
      requestAnimationFrame(() => {
        viewport.scrollTop = offset;
      });
    },
  }), []);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    const updateWidth = (width: number) => {
      setViewportWidth((current) => (current === width ? current : width));
    };
    updateWidth(viewport.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      updateWidth(entry.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!highlightedItemId) return;
    const frame = window.requestAnimationFrame(() => {
      const scrollContainer = scrollRef.current;
      const card = document.getElementById(`library-card-${highlightedItemId}`);
      if (!scrollContainer || !card) return;
      const containerBounds = scrollContainer.getBoundingClientRect();
      const cardBounds = card.getBoundingClientRect();
      if (
        cardBounds.top < containerBounds.top ||
        cardBounds.bottom > containerBounds.bottom
      ) {
        const reduceMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        card.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "nearest",
          inline: "nearest",
        });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightedItemId]);

  const layout = useMemo(
    () =>
      calculateMasonryLayout(
        viewportWidth,
        importedItems.map((item) => ({
          id: item.id,
          aspectRatio: item.mediaAspectRatio,
        })),
        minCardWidth,
      ),
    [importedItems, minCardWidth, viewportWidth],
  );
  const positions = useMemo(
    () => new Map(layout.positions.map((position) => [position.id, position])),
    [layout.positions],
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      onPointerDown={(event) => {
        if (
          event.button === 0 &&
          !(event.target as HTMLElement).closest("[data-library-card]")
        ) {
          onSelect(null);
        }
      }}
      ref={scrollRef}
    >
      <div
        aria-label={archived ? "Archived library items" : "Library items"}
        aria-multiselectable="false"
        className="relative w-full"
        role="listbox"
        style={{ height: layout.height }}
      >
        {importedItems.map((item) => {
          const position = positions.get(item.id);
          if (!position) return null;
          const selected = selectedItemId === item.id;
          const renaming = renamingItemId === item.id;

          return (
            <div
              className="absolute left-0 top-0"
              key={item.id}
              style={{
                height: position.height,
                transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
                width: position.width,
              }}
            >
              <LibraryContextMenu
                archived={archived}
                disabled={renaming}
                item={item}
                labels={labels}
                onAction={onAction}
                onCreateSpace={onCreateSpace}
                onLabelCreated={onLabelCreated}
                onLabelMembershipChange={onLabelMembershipChange}
                onMenuOpenChange={onMenuOpenChange}
                onMenuOpenChangeComplete={onMenuOpenChangeComplete}
                open={menuOpenItemId === item.id}
                onSpaceMembershipChange={onSpaceMembershipChange}
                shareAvailable={shareAvailable}
                spaces={spaces}
              >
                <LibraryCard
                  highlighted={item.id === highlightedItemId}
                  item={item}
                  onCancelRename={onCancelRename}
                  onCommitRename={(title) => onCommitRename(item.id, title)}
                  onOpen={() => onAction(item.id, "open")}
                  onSelect={() => onSelect(item.id)}
                  renaming={renaming}
                  selected={selected}
                />
              </LibraryContextMenu>
            </div>
          );
        })}
      </div>
    </div>
  );
});
