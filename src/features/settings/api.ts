import { invoke } from "@tauri-apps/api/core";
import type {
  AppBootstrap,
  AppSettings,
  DestinationCandidate,
  VaultAvailability,
  VaultChangeResult,
  VaultDestinationPurpose,
  VaultSummary,
} from "./types";

export type AppSettingsPatch = Partial<
  Pick<
    AppSettings,
    | "theme"
    | "density"
    | "startupLocation"
    | "sidebarWidth"
    | "sidebarCollapsed"
    | "lastLibraryLocation"
  >
>;

export const getAppBootstrap = () => invoke<AppBootstrap>("get_app_bootstrap");
export const updateAppPreferences = (patch: AppSettingsPatch) =>
  invoke<AppSettings>("update_app_preferences", { patch });
export const resetWindowLayout = () => invoke<AppSettings>("reset_window_layout");
export const getVaultSummary = () => invoke<VaultSummary>("get_vault_summary");
export const revealActiveVault = () => invoke<void>("reveal_active_vault");
export const openSourceRepository = () => invoke<void>("open_source_repository");
export const chooseVaultDestination = (purpose: VaultDestinationPurpose) =>
  invoke<DestinationCandidate | null>("choose_vault_destination", { purpose });
export const backUpVault = (candidateId: string) =>
  invoke<string>("back_up_vault", { candidateId });
export const executeVaultChange = (candidateId: string) =>
  invoke<VaultChangeResult>("execute_vault_change", { candidateId });
export const cancelVaultMigration = () => invoke<void>("cancel_vault_migration");
export const retryActiveVault = () => invoke<VaultAvailability>("retry_active_vault");
export const locateUnavailableVault = () =>
  invoke<DestinationCandidate | null>("locate_unavailable_vault");
export const switchToDefaultVault = () =>
  invoke<VaultChangeResult>("switch_to_default_vault");
