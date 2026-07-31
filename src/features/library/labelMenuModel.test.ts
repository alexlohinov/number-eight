import assert from "node:assert/strict";
import test from "node:test";
import { COLOR_KEYS, type Label } from "./api.ts";
import {
  MAX_LABEL_NAME_LENGTH,
  clampLabelName,
  escapeLabelMenuState,
  filterLabels,
  hasExactLabel,
  isValidNewLabelName,
  labelCreateOperation,
  labelMembershipTarget,
  labelMenuVariant,
  moveLabelMenuActiveId,
} from "./labelMenuModel.ts";

const labels: Label[] = [
  { id: "one", name: "Inspiration", colorKey: "blue", createdAtMs: 1, updatedAtMs: 1 },
  { id: "two", name: "Reference", colorKey: "green", createdAtMs: 2, updatedAtMs: 2 },
];

test("Label filtering is trimmed and case-insensitive", () => {
  assert.deepEqual(filterLabels(labels, "  SPIR  ").map((label) => label.id), ["one"]);
});

test("Label filtering ranks prefixes before substrings and sorts within each rank", () => {
  const ranked: Label[] = [
    { id: "substring", name: "My Alpha", colorKey: "gray", createdAtMs: 1, updatedAtMs: 1 },
    { id: "prefix-z", name: "Alpine", colorKey: "gray", createdAtMs: 2, updatedAtMs: 2 },
    { id: "prefix-a", name: "Alpha", colorKey: "gray", createdAtMs: 3, updatedAtMs: 3 },
  ];
  assert.deepEqual(
    filterLabels(ranked, "Al").map((label) => label.id),
    ["prefix-a", "prefix-z", "substring"],
  );
});

test("Label menu derives all four Figma variants", () => {
  assert.equal(labelMenuVariant([], "", false), "default");
  assert.equal(labelMenuVariant([], "New", false), "filled");
  assert.equal(labelMenuVariant(labels, "", false), "created");
  assert.equal(labelMenuVariant(labels, "New", true), "pick-color");
});

test("exact Label matches suppress duplicate creation case-insensitively", () => {
  assert.equal(hasExactLabel(labels, "inspiration"), true);
  assert.equal(hasExactLabel(labels, "Inspirations"), false);
});

test("new Label validation trims names, preserves internal spaces, and enforces 80 characters", () => {
  assert.equal(isValidNewLabelName(labels, "  New   Label  "), true);
  assert.equal(isValidNewLabelName(labels, "  inspiration  "), false);
  assert.equal(isValidNewLabelName(labels, " "), false);
  assert.equal(isValidNewLabelName(labels, "x".repeat(MAX_LABEL_NAME_LENGTH + 1)), false);
  assert.equal(clampLabelName("😀".repeat(81)), "😀".repeat(80));
});

test("Assign and Browse creation operations keep explicit targets isolated", () => {
  assert.deepEqual(
    labelCreateOperation({ type: "assign", itemId: "item-exact" }, "Ideas", "blue"),
    {
      type: "create-and-assign",
      itemId: "item-exact",
      name: "Ideas",
      colorKey: "blue",
    },
  );
  assert.deepEqual(
    labelCreateOperation({ type: "browse", activeLabelId: "active" }, "Ideas", "blue"),
    { type: "create", name: "Ideas", colorKey: "blue" },
  );
  assert.equal(labelMembershipTarget({ type: "assign", itemId: "item-exact" }), "item-exact");
  assert.equal(labelMembershipTarget({ type: "browse", activeLabelId: null }), null);
});

test("Pick Color uses all 13 semantic colors in Figma order and Escape backs up one state", () => {
  assert.deepEqual(COLOR_KEYS, [
    "gray", "red", "orange", "yellow", "green", "mint", "teal", "cyan",
    "blue", "indigo", "purple", "pink", "brown",
  ]);
  assert.equal(escapeLabelMenuState("pick-color"), "list");
  assert.equal(escapeLabelMenuState("list"), "close");
});

test("keyboard navigation wraps and informational-only menus have no active row", () => {
  const ids = ["label:a", "label:b", "create"];
  assert.equal(moveLabelMenuActiveId(ids, "label:a", -1), "create");
  assert.equal(moveLabelMenuActiveId(ids, "create", 1), "label:a");
  assert.equal(moveLabelMenuActiveId(ids, null, 1), "label:a");
  assert.equal(moveLabelMenuActiveId([], null, 1), null);
});
