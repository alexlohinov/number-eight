import assert from "node:assert/strict";
import test from "node:test";
import { libraryMenuGroups } from "./libraryMenu.ts";
import { resolveLibraryShortcut } from "./libraryShortcuts.ts";
import {
  itemBelongsToLibraryView,
  LIBRARY_VIEW_PRESENTATION,
} from "./libraryViews.ts";

const commandC = {
  altKey: false,
  code: "KeyC",
  ctrlKey: false,
  key: "c",
  metaKey: true,
  repeat: false,
  shiftKey: false,
};

test("Favorites uses the existing Star presentation", () => {
  assert.deepEqual(LIBRARY_VIEW_PRESENTATION.favorites, {
    icon: "star",
    label: "Favorites",
  });
});

test("Context Menu uses the current favorite label in the specified group", () => {
  const imageGroups = libraryMenuGroups(
    { isFavorite: false, sourceType: "image" },
    false,
  );
  const archivedLinkGroups = libraryMenuGroups(
    { isFavorite: true, sourceType: "link" },
    true,
  );

  assert.deepEqual(
    imageGroups[0].map(({ label }) => label),
    ["Open", "Reveal in Finder"],
  );
  assert.equal(imageGroups[1][0].label, "Add to Favorites");
  assert.equal(imageGroups[1][0].shortcut, "⌘D");
  assert.deepEqual(
    archivedLinkGroups[1].map(({ label }) => label),
    ["Remove from Favorites"],
  );
  assert.equal(archivedLinkGroups[3][0].label, "Restore");
});

test("retained item shortcuts resolve only focus-aware keys", () => {
  assert.equal(resolveLibraryShortcut(commandC), "item.copy-image");
  assert.equal(resolveLibraryShortcut({ ...commandC, metaKey: false, key: "Enter" }), "item.rename");
  assert.equal(resolveLibraryShortcut({ ...commandC, metaKey: false, key: "Delete" }), "item.delete");
  assert.equal(resolveLibraryShortcut({ ...commandC, metaKey: false, key: "Escape" }), "item.selection.clear");
  assert.equal(resolveLibraryShortcut({ ...commandC, repeat: true }), null);
  assert.equal(resolveLibraryShortcut({ ...commandC, code: "KeyD", key: "d" }), null);
});

test("Context Menu variants hide image-only actions for Links and show Share only when available", () => {
  const image = libraryMenuGroups(
    { isFavorite: false, sourceType: "image" },
    false,
    true,
  );
  const link = libraryMenuGroups(
    { isFavorite: false, sourceType: "link" },
    false,
    true,
  );
  assert.deepEqual(image[0].map(({ label }) => label), ["Open", "Share…", "Reveal in Finder"]);
  assert.deepEqual(link[0].map(({ label }) => label), ["Open", "Share…"]);
  assert.equal(link.flat().some(({ action }) => action === "copy"), false);
});

test("favorite view membership preserves All and excludes archived items", () => {
  const favorite = { archivedAtMs: null, isFavorite: true };
  const notFavorite = { archivedAtMs: null, isFavorite: false };
  const archivedFavorite = { archivedAtMs: 1_000, isFavorite: true };

  assert.equal(itemBelongsToLibraryView(favorite, "all"), true);
  assert.equal(itemBelongsToLibraryView(favorite, "favorites"), true);
  assert.equal(itemBelongsToLibraryView(notFavorite, "all"), true);
  assert.equal(itemBelongsToLibraryView(notFavorite, "favorites"), false);
  assert.equal(itemBelongsToLibraryView(archivedFavorite, "favorites"), false);
  assert.equal(itemBelongsToLibraryView(archivedFavorite, "archive"), true);
  assert.equal(
    itemBelongsToLibraryView(favorite, { kind: "label", labelId: "reference" }),
    true,
  );
  assert.equal(
    itemBelongsToLibraryView(archivedFavorite, { kind: "label", labelId: "reference" }),
    false,
  );
});
