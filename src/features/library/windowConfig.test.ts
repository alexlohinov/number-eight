import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("main window starts hidden at the 1280 by 832 fallback", async () => {
  const config = JSON.parse(
    await readFile(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const mainWindow = config.app.windows.find((window: { label: string }) => window.label === "main");
  assert.equal(mainWindow.width, 1280);
  assert.equal(mainWindow.height, 832);
  assert.equal(mainWindow.visible, false);
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

test("asset protocol scope exposes media only", async () => {
  const config = JSON.parse(
    await readFile(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  const scopes: string[] = config.app.security.assetProtocol.scope;
  assert.deepEqual(scopes, [
    "$DOCUMENT/No. 8 Vault/Library/**",
    "$DOCUMENT/No. 8 Vault/.no8/assets/links/**",
  ]);
  assert.equal(scopes.some((scope) => scope.includes("sqlite")), false);
  assert.equal(scopes.some((scope) => scope.includes("cache")), false);
  assert.equal(scopes.some((scope) => scope.includes("..")), false);
});
