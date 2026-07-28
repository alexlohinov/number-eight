import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("main window uses the visible 1280 by 832 fallback", async () => {
  const config = JSON.parse(
    await readFile(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const mainWindow = config.app.windows.find((window: { label: string }) => window.label === "main");
  assert.equal(mainWindow.width, 1280);
  assert.equal(mainWindow.height, 832);
  assert.equal(mainWindow.visible, true);
});

test("window state restores only persistent main-window behavior", async () => {
  const source = await readFile(
    new URL("../../../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  assert.match(source, /with_filter\(\|label\| label == "main"\)/);
  assert.match(source, /StateFlags::SIZE/);
  assert.match(source, /StateFlags::POSITION/);
  assert.match(source, /StateFlags::MAXIMIZED/);
  assert.doesNotMatch(source, /StateFlags::VISIBLE/);
  assert.doesNotMatch(source, /StateFlags::FULLSCREEN/);
  assert.doesNotMatch(source, /StateFlags::DECORATIONS/);
  assert.doesNotMatch(source, /StateFlags::all\(\)/);
  assert.match(source, /get_webview_window\("main"\)/);
  assert.match(source, /main_window\.show\(\)\?/);
  assert.match(source, /main_window\.set_focus\(\)\?/);
});
