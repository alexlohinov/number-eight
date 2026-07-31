import assert from "node:assert/strict";
import test from "node:test";
import { migrationDismissal } from "./migrationDialogModel.ts";

test("cancellable migration phases close and request cancellation", () => {
  assert.equal(
    migrationDismissal({
      phase: "copying",
      bytesCompleted: 4,
      bytesTotal: 10,
      cancellable: true,
    }),
    "close-and-cancel",
  );
});

test("protected migration phases intentionally remain open", () => {
  assert.equal(
    migrationDismissal({
      phase: "switching",
      bytesCompleted: 10,
      bytesTotal: 10,
      cancellable: false,
    }),
    "keep-open",
  );
  assert.equal(migrationDismissal(null), "keep-open");
});
