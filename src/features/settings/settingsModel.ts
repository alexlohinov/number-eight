import { appCommandManifest } from "../command-menu/commandRegistry.ts";
import type { AppLocation } from "../../hooks/useNavigationHistory";
import type { AppBootstrap, AppSettings } from "./types";

export function isAppLocation(value: unknown): value is AppLocation {
  if (value === "all" || value === "favorites" || value === "archive") return true;
  if (!value || typeof value !== "object") return false;
  const location = value as Record<string, unknown>;
  return (
    (location.kind === "space" && typeof location.spaceId === "string" && location.spaceId !== "") ||
    (location.kind === "label" && typeof location.labelId === "string" && location.labelId !== "")
  );
}

export function normalizeBootstrap(value: AppBootstrap): AppBootstrap {
  return {
    ...value,
    resolvedStartupLocation: isAppLocation(value.resolvedStartupLocation)
      ? value.resolvedStartupLocation
      : "all",
  };
}

export function applySettingsPatch(
  settings: AppSettings,
  patch: Partial<AppSettings>,
): AppSettings {
  return { ...settings, ...patch };
}

export type ShortcutRow = {
  id: string;
  title: string;
  description: string;
  category: string;
  accelerator: string | null;
  shortcutLabel: string | null;
};

export function shortcutRows(query = ""): ShortcutRow[] {
  const normalized = query.trim().toLocaleLowerCase();
  const rows: ShortcutRow[] = [];
  for (const [id, command] of Object.entries(appCommandManifest)) {
    if (!command.shortcutPageVisible) continue;
    const searchable = [
      command.title,
      command.commandMenuTitle,
      command.description,
      command.shortcutCategory,
      command.accelerator ?? "",
      command.shortcutLabel ?? "",
      ...command.keywords,
    ]
      .join(" ")
      .toLocaleLowerCase();
    if (normalized && !searchable.includes(normalized)) continue;
    rows.push({
      id,
      title: command.commandMenuTitle,
      description: command.description,
      category: command.shortcutCategory,
      accelerator: command.accelerator,
      shortcutLabel: command.shortcutLabel,
    });
  }
  return rows.sort((left, right) =>
    left.category.localeCompare(right.category) || left.title.localeCompare(right.title),
  );
}
