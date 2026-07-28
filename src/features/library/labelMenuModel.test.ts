import assert from "node:assert/strict";
import test from "node:test";
import type { Label } from "./api.ts";
import { filterLabels, hasExactLabel, labelMenuVariant } from "./labelMenuModel.ts";

const labels: Label[] = [
  { id: "one", name: "Inspiration", colorKey: "blue", createdAtMs: 1, updatedAtMs: 1 },
  { id: "two", name: "Reference", colorKey: "green", createdAtMs: 2, updatedAtMs: 2 },
];

test("Label filtering is trimmed and case-insensitive", () => {
  assert.deepEqual(filterLabels(labels, "  SPIR  ").map((label) => label.id), ["one"]);
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
