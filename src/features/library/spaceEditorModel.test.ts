import assert from "node:assert/strict";
import test from "node:test";
import type { Space } from "./api.ts";
import { isDuplicateSpaceName } from "./spaceEditorModel.ts";

const spaces: Space[] = [
  {
    id: "personal",
    name: "Personal",
    colorKey: "gray",
    iconKey: "heart",
    createdAtMs: 1,
    updatedAtMs: 1,
  },
];

test("Space names are compared case-insensitively after trimming", () => {
  assert.equal(isDuplicateSpaceName(spaces, " personal "), true);
  assert.equal(isDuplicateSpaceName(spaces, "Work"), false);
});

test("Space editing excludes the current persisted ID", () => {
  assert.equal(isDuplicateSpaceName(spaces, "Personal", "personal"), false);
});
