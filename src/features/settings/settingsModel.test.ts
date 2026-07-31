import assert from "node:assert/strict";
import test from "node:test";
import { appCommandManifest } from "../command-menu/commandRegistry.ts";
import { applySettingsPatch, normalizeBootstrap, shortcutRows } from "./settingsModel.ts";
import type { AppBootstrap } from "./types.ts";

const bootstrap: AppBootstrap = {
  appVersion: "1.2.3",
  defaultVaultPath: "/Documents/No. 8 Vault",
  resolvedStartupLocation: "all",
  settings: {
    theme: "system",
    density: "comfortable",
    startupLocation: "lastVisited",
    sidebarWidth: 240,
    sidebarCollapsed: false,
    lastLibraryLocation: "favorites",
    vaultRoot: null,
  },
  vaultAvailability: { type: "ready", rootPath: "/Documents/No. 8 Vault" },
};

test("invalid resolved startup locations fall back to All", () => {
  const normalized = normalizeBootstrap({
    ...bootstrap,
    resolvedStartupLocation: { kind: "space", spaceId: "" },
  });
  assert.equal(normalized.resolvedStartupLocation, "all");
});

test("settings patches preserve unmentioned values", () => {
  const updated = applySettingsPatch(bootstrap.settings, { theme: "dark" });
  assert.equal(updated.theme, "dark");
  assert.equal(updated.density, "comfortable");
  assert.equal(updated.sidebarWidth, 240);
});

test("shortcut rows come exclusively from visible static manifest entries", () => {
  const rows = shortcutRows();
  assert.deepEqual(
    new Set(rows.map((row) => row.id)),
    new Set(
      Object.entries(appCommandManifest)
        .filter(([, command]) => command.shortcutPageVisible)
        .map(([id]) => id),
    ),
  );
  assert.equal(rows.some((row) => row.id.startsWith("navigate.space.")), false);
});

test("shortcut search includes descriptions, groups, accelerators, and symbols", () => {
  assert.ok(shortcutRows("searchable command").some((row) => row.id === "command-menu.toggle"));
  assert.ok(shortcutRows("Window").some((row) => row.id === "navigate.settings"));
  assert.ok(shortcutRows("CmdOrCtrl+,").some((row) => row.id === "navigate.settings"));
  assert.ok(shortcutRows("⌘,").some((row) => row.id === "navigate.settings"));
});
