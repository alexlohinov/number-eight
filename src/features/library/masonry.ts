export const CONTENT_PADDING = 16;
export const CARD_GAP = 12;
export const MIN_CARD_WIDTH = 240;
export const REFERENCE_CARD_WIDTH = 280;
export const INFO_PANEL_HEIGHT = 40;
export const FALLBACK_MEDIA_ASPECT_RATIO = 16 / 9;

export type MasonryItem = {
  id: string;
  aspectRatio?: number;
};

export type MasonryPosition = {
  id: string;
  height: number;
  width: number;
  x: number;
  y: number;
};

export type MasonryLayout = {
  cardWidth: number;
  columnCount: number;
  height: number;
  innerWidth: number;
  positions: MasonryPosition[];
};

export function calculateColumns(viewportWidth: number) {
  const innerWidth = Math.max(0, viewportWidth - CONTENT_PADDING * 2);
  const columnCount = Math.max(
    1,
    Math.floor((innerWidth + CARD_GAP) / (MIN_CARD_WIDTH + CARD_GAP)),
  );
  const cardWidth =
    (innerWidth - CARD_GAP * (columnCount - 1)) / columnCount;

  return { cardWidth: Math.max(0, cardWidth), columnCount, innerWidth };
}

export function calculateMasonryLayout(
  viewportWidth: number,
  items: MasonryItem[],
): MasonryLayout {
  const { cardWidth, columnCount, innerWidth } =
    calculateColumns(viewportWidth);
  const columnHeights = Array.from({ length: columnCount }, () => 0);
  const positions = items.map((item, itemIndex) => {
    const columnIndex = itemIndex % columnCount;

    const aspectRatio =
      item.aspectRatio && Number.isFinite(item.aspectRatio) && item.aspectRatio > 0
        ? item.aspectRatio
        : FALLBACK_MEDIA_ASPECT_RATIO;
    const height = cardWidth / aspectRatio + INFO_PANEL_HEIGHT;
    const x = CONTENT_PADDING + columnIndex * (cardWidth + CARD_GAP);
    const y = CONTENT_PADDING + columnHeights[columnIndex];
    columnHeights[columnIndex] += height + CARD_GAP;

    return { id: item.id, height, width: cardWidth, x, y };
  });
  const tallestColumn = items.length
    ? Math.max(...columnHeights) - CARD_GAP
    : 0;

  return {
    cardWidth,
    columnCount,
    height: items.length
      ? CONTENT_PADDING + tallestColumn + CONTENT_PADDING
      : 0,
    innerWidth,
    positions,
  };
}
