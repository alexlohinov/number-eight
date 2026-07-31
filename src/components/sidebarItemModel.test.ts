import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSidebarItemVisualState,
  SIDEBAR_ITEM_STATE_CLASS_NAMES,
} from "./sidebarItemModel.ts";

test("All remains Selected while an open Labels menu gives Labels Hover", () => {
  const allState = resolveSidebarItemVisualState(true);
  const labelsState = resolveSidebarItemVisualState(false, true);

  assert.equal(allState, "selected");
  assert.equal(labelsState, "hover");
  assert.notEqual(labelsState, "selected");
});

test("closing the Labels menu removes its temporary Hover state", () => {
  assert.equal(resolveSidebarItemVisualState(false, true), "hover");
  assert.equal(resolveSidebarItemVisualState(false, false), "default");
});

test("an active Label route keeps Selected priority while its menu is open", () => {
  assert.equal(resolveSidebarItemVisualState(true, true), "selected");
});

test("other Sidebar items remain independent of the Labels menu state", () => {
  assert.equal(resolveSidebarItemVisualState(true), "selected");
  assert.equal(resolveSidebarItemVisualState(false), "default");
});

test("Sidebar visual states use the existing semantic interaction classes", () => {
  assert.equal(
    SIDEBAR_ITEM_STATE_CLASS_NAMES.selected,
    "bg-selected text-primary",
  );
  assert.equal(
    SIDEBAR_ITEM_STATE_CLASS_NAMES.hover,
    "bg-component-hover text-primary",
  );
  assert.match(
    SIDEBAR_ITEM_STATE_CLASS_NAMES.default,
    /hover:bg-component-hover/,
  );
});
