import assert from "node:assert/strict";
import test from "node:test";
import { itemContextSelection } from "./contextMenuState.ts";
import {
  EDITABLE_CONTEXT_SELECTOR,
  isEditableApplicationElement,
} from "./nativeInteractions.ts";

test("root Context Menu close clears its target and temporary selection", () => {
  assert.deepEqual(itemContextSelection("item-a"), {
    menuOpenItemId: "item-a",
    selectedItemId: "item-a",
  });
  assert.deepEqual(itemContextSelection(null), {
    menuOpenItemId: null,
    selectedItemId: null,
  });
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
});
