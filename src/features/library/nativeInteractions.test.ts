import assert from "node:assert/strict";
import test from "node:test";
import {
  closeItemContextSelection,
  openItemContextSelection,
} from "./contextMenuState.ts";
import {
  EDITABLE_CONTEXT_SELECTOR,
  isEditableApplicationElement,
  shouldSuppressNativeContextMenu,
} from "./nativeInteractions.ts";

test("root Context Menu close clears its target and temporary selection", () => {
  const opened = openItemContextSelection(null, "item-a");
  assert.deepEqual(opened, {
    menuOpenItemId: "item-a",
    selectedItemId: "item-a",
    temporarySelectionId: "item-a",
  });
  assert.deepEqual(
    closeItemContextSelection(
      opened.selectedItemId,
      opened.temporarySelectionId,
      "item-a",
      true,
    ),
    { selectedItemId: null, temporarySelectionId: null },
  );
});

test("root Context Menu preserves a selection not created by right click", () => {
  const opened = openItemContextSelection("item-a", "item-a");
  assert.equal(opened.temporarySelectionId, null);
  assert.deepEqual(
    closeItemContextSelection("item-a", null, "item-a", true),
    { selectedItemId: "item-a", temporarySelectionId: null },
  );
});

test("only editable application surfaces retain the native Context Menu", () => {
  let receivedSelector = "";
  assert.equal(
    isEditableApplicationElement({
      closest(selector: string) {
        receivedSelector = selector;
        return {} as Element;
      },
    }),
    true,
  );
  assert.equal(receivedSelector, EDITABLE_CONTEXT_SELECTOR);
  assert.equal(
    isEditableApplicationElement({ closest: () => null }),
    false,
  );
  assert.equal(
    shouldSuppressNativeContextMenu({ closest: () => null }),
    true,
  );
  assert.equal(
    shouldSuppressNativeContextMenu({ closest: () => ({}) as Element }),
    false,
  );
});
