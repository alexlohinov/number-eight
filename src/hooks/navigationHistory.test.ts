import assert from "node:assert/strict";
import test from "node:test";
import {
  goBackInHistory,
  goForwardInHistory,
  isSpaceLocation,
  navigateHistory,
  removeHistoryEntries,
  type AppLocation,
  type NavigationHistoryState,
} from "./useNavigationHistory.ts";

test("Favorites participates in internal Back and Forward history", () => {
  let history: NavigationHistoryState<AppLocation> = {
    entries: ["all"],
    index: 0,
  };
  history = navigateHistory(history, "favorites");
  history = navigateHistory(history, "archive");

  history = goBackInHistory(history);
  assert.equal(history.entries[history.index], "favorites");
  history = goBackInHistory(history);
  assert.equal(history.entries[history.index], "all");
  history = goForwardInHistory(history);
  assert.equal(history.entries[history.index], "favorites");
  history = goForwardInHistory(history);
  assert.equal(history.entries[history.index], "archive");
});

test("deleting the active Space replaces it with All and removes stale history", () => {
  const history: NavigationHistoryState<AppLocation> = {
    entries: [
      "all",
      { kind: "space", spaceId: "deleted" },
      "favorites",
      { kind: "space", spaceId: "deleted" },
    ],
    index: 3,
  };
  const next = removeHistoryEntries(
    history,
    (location) =>
      isSpaceLocation(location) && location.spaceId === "deleted",
    "all",
  );

  assert.deepEqual(next.entries, ["all", "favorites", "all"]);
  assert.equal(next.entries[next.index], "all");
});

test("deleting an inactive Space preserves the current location", () => {
  const history: NavigationHistoryState<AppLocation> = {
    entries: [
      "all",
      { kind: "space", spaceId: "deleted" },
      "favorites",
    ],
    index: 2,
  };
  const next = removeHistoryEntries(
    history,
    (location) =>
      isSpaceLocation(location) && location.spaceId === "deleted",
    "all",
  );

  assert.deepEqual(next.entries, ["all", "favorites"]);
  assert.equal(next.entries[next.index], "favorites");
});

test("Label routes participate in Back and Forward history and deduplicate by ID", () => {
  let history: NavigationHistoryState<AppLocation> = {
    entries: ["all"],
    index: 0,
  };
  history = navigateHistory(history, { kind: "label", labelId: "label-a" });
  assert.equal(
    navigateHistory(history, { kind: "label", labelId: "label-a" }),
    history,
  );
  history = navigateHistory(history, "favorites");
  history = goBackInHistory(history);
  assert.deepEqual(history.entries[history.index], {
    kind: "label",
    labelId: "label-a",
  });
  history = goBackInHistory(history);
  assert.equal(history.entries[history.index], "all");
  history = goForwardInHistory(history);
  assert.deepEqual(history.entries[history.index], {
    kind: "label",
    labelId: "label-a",
  });
});

test("Space routes participate in history and equivalent routes are deduplicated", () => {
  let history: NavigationHistoryState<AppLocation> = {
    entries: ["all"],
    index: 0,
  };
  history = navigateHistory(history, { kind: "space", spaceId: "space-personal" });
  const unchanged = navigateHistory(history, { kind: "space", spaceId: "space-personal" });
  assert.equal(unchanged, history);
  history = navigateHistory(history, "favorites");
  history = goBackInHistory(history);
  assert.deepEqual(history.entries[history.index], {
    kind: "space",
    spaceId: "space-personal",
  });
});
