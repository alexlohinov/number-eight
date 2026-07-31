import type { MigrationProgress } from "./types";

export type MigrationDismissal = "close-and-cancel" | "keep-open";

export function migrationDismissal(
  progress: MigrationProgress | null,
): MigrationDismissal {
  return progress?.cancellable ? "close-and-cancel" : "keep-open";
}
