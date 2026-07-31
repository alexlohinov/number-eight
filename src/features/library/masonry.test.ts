import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_GAP,
  CONTENT_PADDING,
  INFO_PANEL_HEIGHT,
  MIN_CARD_WIDTH,
  REFERENCE_CARD_WIDTH,
  calculateColumns,
  calculateMasonryLayout,
} from "./masonry.ts";

test("uses the required padding, gap, and reference constants", () => {
  assert.equal(CONTENT_PADDING, 16);
  assert.equal(CARD_GAP, 12);
  assert.equal(MIN_CARD_WIDTH, 240);
  assert.equal(REFERENCE_CARD_WIDTH, 280);
});

test("fills a design-sized viewport with approximately four reference cards", () => {
  const result = calculateColumns(1196);
  assert.equal(result.innerWidth, 1164);
  assert.equal(result.columnCount, 4);
  assert.equal(result.cardWidth, 282);
});

test("adds a fifth column when fullscreen width can fit it", () => {
  const result = calculateColumns(1356);
  assert.equal(result.columnCount, 5);
  assert.ok(result.cardWidth >= MIN_CARD_WIDTH);
  assert.equal(result.cardWidth, (1324 - CARD_GAP * 4) / 5);
});

test("never uses sub-minimum cards unless the viewport is itself narrower", () => {
  const fourColumnThreshold =
    CONTENT_PADDING * 2 + MIN_CARD_WIDTH * 4 + CARD_GAP * 3;
  const atThreshold = calculateColumns(fourColumnThreshold);
  const belowThreshold = calculateColumns(fourColumnThreshold - 1);
  const narrow = calculateColumns(200);

  assert.equal(atThreshold.columnCount, 4);
  assert.equal(atThreshold.cardWidth, MIN_CARD_WIDTH);
  assert.equal(belowThreshold.columnCount, 3);
  assert.ok(belowThreshold.cardWidth >= MIN_CARD_WIDTH);
  assert.equal(narrow.columnCount, 1);
  assert.equal(narrow.cardWidth, 168);
});

test("divides inner width without unused trailing space", () => {
  const viewportWidth = 1234;
  const { cardWidth, columnCount } = calculateColumns(viewportWidth);
  const rightEdge =
    CONTENT_PADDING +
    (columnCount - 1) * (cardWidth + CARD_GAP) +
    cardWidth;
  assert.ok(Math.abs(rightEdge - (viewportWidth - CONTENT_PADDING)) < 1e-9);
});

test("sidebar width changes recalculate the column count", () => {
  assert.equal(calculateColumns(1196).columnCount, 4);
  assert.equal(calculateColumns(944).columnCount, 3);
});

test("keeps source order while assigning cards left to right", () => {
  const items = [
    { id: "one", aspectRatio: 1 },
    { id: "two", aspectRatio: 2 },
    { id: "three", aspectRatio: 1 },
    { id: "four", aspectRatio: 2 },
  ];
  const layout = calculateMasonryLayout(800, items);

  assert.deepEqual(
    layout.positions.map(({ id }) => id),
    items.map(({ id }) => id),
  );
  assert.equal(layout.columnCount, 3);
  assert.equal(layout.positions[3].x, layout.positions[0].x);
  assert.equal(
    layout.positions[3].y,
    CONTENT_PADDING + layout.positions[0].height + CARD_GAP,
  );
});

test("density widths preserve source order and intrinsic ratios", () => {
  const items = [
    { id: "wide", aspectRatio: 2 },
    { id: "square", aspectRatio: 1 },
    { id: "tall", aspectRatio: 0.5 },
  ];
  for (const minimum of [200, 240, 300]) {
    const layout = calculateMasonryLayout(1000, items, minimum);
    assert.deepEqual(layout.positions.map((position) => position.id), items.map((item) => item.id));
    assert.equal(layout.positions[0].height - INFO_PANEL_HEIGHT, layout.cardWidth / 2);
    assert.equal(layout.positions[1].height - INFO_PANEL_HEIGHT, layout.cardWidth);
    assert.equal(layout.positions[2].height - INFO_PANEL_HEIGHT, layout.cardWidth * 2);
  }
});

test("never falls back to the shortest column", () => {
  const layout = calculateMasonryLayout(800, [
    { id: "tall", aspectRatio: 0.5 },
    { id: "short", aspectRatio: 4 },
    { id: "medium", aspectRatio: 1 },
    { id: "fourth", aspectRatio: 2 },
    { id: "fifth", aspectRatio: 2 },
  ]);

  assert.equal(layout.columnCount, 3);
  assert.equal(layout.positions[3].x, layout.positions[0].x);
  assert.equal(layout.positions[4].x, layout.positions[1].x);
});

test("one-column layout appends every item vertically", () => {
  const layout = calculateMasonryLayout(220, [
    { id: "one", aspectRatio: 1 },
    { id: "two", aspectRatio: 2 },
  ]);

  assert.equal(layout.columnCount, 1);
  assert.equal(layout.positions[0].x, layout.positions[1].x);
  assert.equal(
    layout.positions[1].y,
    CONTENT_PADDING + layout.positions[0].height + CARD_GAP,
  );
});

test("container height includes top and bottom padding without clipping", () => {
  const layout = calculateMasonryLayout(600, [
    { id: "portrait", aspectRatio: 0.5 },
    { id: "landscape", aspectRatio: 2 },
    { id: "square", aspectRatio: 1 },
  ]);
  const maximumBottom = Math.max(
    ...layout.positions.map((position) => position.y + position.height),
  );
  assert.equal(layout.height, maximumBottom + CONTENT_PADDING);
});
