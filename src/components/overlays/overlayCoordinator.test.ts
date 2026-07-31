import assert from "node:assert/strict";
import test from "node:test";
import {
  completeOverlayClose,
  initialOverlayCoordinatorState,
  requestOverlayClose,
  requestOverlayOpen,
  type OverlayTarget,
} from "./overlayCoordinator.ts";

const item = (itemId: string): OverlayTarget => ({
  layer: "floating",
  overlay: { type: "itemContext", itemId },
});

const labels: OverlayTarget = {
  layer: "floating",
  overlay: { type: "labels" },
};

const command: OverlayTarget = {
  layer: "blocking",
  overlay: { type: "commandMenu" },
};

test("a stale Context Menu close cannot clear the newly active target", () => {
  let state = requestOverlayOpen(initialOverlayCoordinatorState, item("a"));
  state = requestOverlayOpen(state, item("b"));
  assert.deepEqual(state.closing, item("a"));
  assert.deepEqual(state.pending, item("b"));

  state = requestOverlayClose(state, item("a"));
  state = completeOverlayClose(state, item("a"));
  assert.deepEqual(state.floating, { type: "itemContext", itemId: "b" });

  const repeated = completeOverlayClose(state, item("a"));
  assert.strictEqual(repeated, state);
});

test("a blocking modal waits for the floating surface close exactly once", () => {
  let state = requestOverlayOpen(initialOverlayCoordinatorState, labels);
  state = requestOverlayOpen(state, command);
  assert.equal(state.floating, null);
  assert.equal(state.blocking, null);
  assert.deepEqual(state.pending, command);

  state = completeOverlayClose(state, labels);
  assert.deepEqual(state.blocking, { type: "commandMenu" });
  assert.equal(state.pending, null);

  const repeated = completeOverlayClose(state, labels);
  assert.strictEqual(repeated, state);
});

test("onOpenChange false closes the matching controlled surface", () => {
  const opened = requestOverlayOpen(initialOverlayCoordinatorState, labels);
  const closed = requestOverlayClose(opened, labels);
  assert.equal(closed.floating, null);
  assert.deepEqual(closed.closing, labels);
});
