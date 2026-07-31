import type { AppLocation } from "../../hooks/useNavigationHistory";

export type AppMode = "library" | "settings";
export type SettingsSection = "general" | "appearance" | "dataStorage" | "shortcuts";
export type AppTheme = "system" | "light" | "dark";
export type LibraryDensity = "compact" | "comfortable" | "large";
export type StartupLocation = "lastVisited" | AppLocation;

export type AppSettings = {
  theme: AppTheme;
  density: LibraryDensity;
  startupLocation: StartupLocation;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  lastLibraryLocation: AppLocation;
  vaultRoot: string | null;
};

export type VaultAvailability =
  | { type: "ready"; rootPath: string }
  | { type: "unavailable"; configuredPath: string };

export type AppBootstrap = {
  settings: AppSettings;
  resolvedStartupLocation: AppLocation;
  appVersion: string;
  defaultVaultPath: string;
  vaultAvailability: VaultAvailability;
};

export type VaultSummary = {
  rootPath: string;
  itemCount: number;
  imageCount: number;
  linkCount: number;
  spaceCount: number;
  labelCount: number;
  totalBytes: number;
};

export type VaultDestinationPurpose =
  | "backup"
  | "moveCurrent"
  | "startEmpty"
  | "useExisting"
  | "locateUnavailable";

export type DestinationCandidate = {
  candidateId: string;
  displayPath: string;
  status: "ready" | "existingVault" | "readyForBackup";
};

export type MigrationProgress = {
  phase:
    | "preparing"
    | "creating"
    | "snapshotting"
    | "copying"
    | "verifying"
    | "switching"
    | "reloading"
    | "trashingSource"
    | "complete";
  bytesCompleted: number;
  bytesTotal: number;
  cancellable: boolean;
};

export type VaultChangeResult = {
  rootPath: string;
  sourceCleanupWarning: string | null;
};

export const DENSITY_MIN_CARD_WIDTH: Record<LibraryDensity, number> = {
  compact: 200,
  comfortable: 240,
  large: 300,
};
