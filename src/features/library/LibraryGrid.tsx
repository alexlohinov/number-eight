import { useEffect, useMemo, useRef, useState } from "react";
import { LibraryCard, type LibraryCardItem } from "./LibraryCard";

const MIN_COLUMN_WIDTH = 270;
const COLUMN_GAP = 12;
const MAX_COLUMNS = 4;

type LibraryGridProps = {
  highlightedItemId?: string | null;
  importedItems?: LibraryCardItem[];
};

export function LibraryGrid({
  highlightedItemId = null,
  importedItems = [],
}: LibraryGridProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(1);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const updateColumnCount = (width: number) => {
      const nextCount = Math.min(
        MAX_COLUMNS,
        Math.max(1, Math.floor((width + COLUMN_GAP) / (MIN_COLUMN_WIDTH + COLUMN_GAP))),
      );
      setColumnCount((currentCount) =>
        currentCount === nextCount ? currentCount : nextCount,
      );
    };

    updateColumnCount(grid.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      updateColumnCount(entry.contentRect.width);
    });
    observer.observe(grid);

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

  const columns = useMemo(() => {
    return Array.from({ length: columnCount }, (_, columnIndex) =>
      importedItems.filter(
        (_, itemIndex) => itemIndex % columnCount === columnIndex,
      ),
    );
  }, [columnCount, importedItems]);

  return (
    <div
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4"
      ref={scrollRef}
    >
      <div
        className="library-grid"
        ref={gridRef}
        style={{ "--column-count": columnCount } as React.CSSProperties}
      >
        {columns.map((column, columnIndex) => (
          <div className="flex min-w-0 flex-col gap-3" key={columnIndex}>
            {column.map((item) => (
              <LibraryCard
                highlighted={item.id === highlightedItemId}
                item={item}
                key={item.id}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
