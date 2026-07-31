import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import { Select } from "@base-ui/react/select";
import { Dialog } from "@base-ui/react/dialog";
import {
  ChevronLeft,
  ChevronDown,
  Check,
  Database,
  ExternalLink,
  FolderOpen,
  Gauge,
  Info,
  Keyboard,
  Palette,
  RotateCcw,
  Settings2,
} from "lucide-react";
import {
  backUpVault,
  cancelVaultMigration,
  chooseVaultDestination,
  executeVaultChange,
  getVaultSummary,
  locateUnavailableVault,
  openSourceRepository,
  resetWindowLayout,
  retryActiveVault,
  revealActiveVault,
  switchToDefaultVault,
} from "./api";
import { shortcutRows } from "./settingsModel";
import type {
  AppSettings,
  AppTheme,
  LibraryDensity,
  MigrationProgress,
  SettingsSection,
  StartupLocation,
  VaultAvailability,
  VaultDestinationPurpose,
  VaultSummary,
} from "./types";
import {
  AppDialogBackdrop,
  AppDialogPopup,
  AppDialogViewport,
} from "../../components/overlays/AppDialog";
import { floatingSurfaceClassName } from "../../components/overlays/floatingSurfaceStyles";
import { overlayLayerStyles } from "../../components/overlays/overlayLayers";
import { migrationDismissal } from "./migrationDialogModel";

type SettingsViewProps = {
  appVersion: string;
  availability: VaultAvailability;
  section: SettingsSection;
  settings: AppSettings;
  onAvailabilityChange: (availability: VaultAvailability) => void;
  onClose: () => void;
  onSectionChange: (section: SettingsSection) => void;
  onSettingsChange: (patch: Partial<AppSettings>, immediate?: boolean) => Promise<boolean>;
  onVaultChanged: (rootPath: string) => void;
};

const sections = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "dataStorage", label: "Data & Storage", icon: Database },
  { id: "shortcuts", label: "Keyboard Shortcuts", icon: Keyboard },
] as const;

const sectionTitles: Record<SettingsSection, string> = {
  general: "General",
  appearance: "Appearance",
  dataStorage: "Data & Storage",
  shortcuts: "Keyboard Shortcuts",
};

const startupOptions = [
  { value: "lastVisited", label: "Last visited" },
  { value: "all", label: "All" },
  { value: "favorites", label: "Favorites" },
  { value: "archive", label: "Archive" },
] as const;

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-3 text-[12px] font-medium text-secondary">{title}</h2>
      <div className="overflow-hidden rounded-xl border border-border-1 bg-background-1">{children}</div>
    </section>
  );
}

function SettingsRow({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-6 border-b border-border-1 px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-primary">{label}</div>
        {detail ? <div className="mt-0.5 text-[12px] leading-4 text-secondary">{detail}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SettingsButton({
  children,
  disabled,
  onClick,
  prominent = false,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  prominent?: boolean;
}) {
  return (
    <button
      className={`focus-ring rounded-lg border px-3 py-1.5 font-medium disabled:opacity-45 ${
        prominent
          ? "border-accent bg-accent text-accent-foreground"
          : "border-border-2 bg-foreground-1 text-primary hover:bg-component-hover"
      }`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-border-2 bg-background-2 p-0.5">
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={`focus-ring rounded-md px-3 py-1 text-[12px] font-medium ${
            value === option.value ? "bg-background-1 text-primary shadow-sm" : "text-secondary"
          }`}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function MiddleTruncatedPath({ path }: { path: string }) {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const parent = separator >= 0 ? path.slice(0, separator + 1) : "";
  const name = separator >= 0 ? path.slice(separator + 1) : path;
  return (
    <span
      className="flex max-w-[360px] select-text items-center text-right font-mono text-[11px] text-secondary"
      title={path}
    >
      <span className="min-w-0 truncate">{parent}</span>
      <span className="shrink-0">{name}</span>
    </span>
  );
}

function errorText(error: unknown) {
  return typeof error === "string" ? error : "The operation could not be completed.";
}

function GeneralSettings({
  appVersion,
  onSettingsChange,
  settings,
}: Pick<SettingsViewProps, "appVersion" | "onSettingsChange" | "settings">) {
  return (
    <>
      <SettingsGroup title="Startup">
        <SettingsRow label="Open No. 8 to" detail="Choose which Library view appears at launch.">
          <Select.Root
            items={startupOptions}
            modal={false}
            onValueChange={(value) => {
              if (!value) return;
              void onSettingsChange(
                value === "lastVisited"
                  ? { startupLocation: "lastVisited" }
                  : { startupLocation: value as StartupLocation },
                true,
              );
            }}
            value={typeof settings.startupLocation === "string" ? settings.startupLocation : "lastVisited"}
          >
            <Select.Trigger
              aria-label="Startup view"
              className="focus-ring flex min-w-32 items-center justify-between gap-2 rounded-lg border border-border-2 bg-background-1 px-2.5 py-1.5 text-primary"
            >
              <Select.Value />
              <Select.Icon><ChevronDown size={14} /></Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner
                align="end"
                sideOffset={4}
                style={overlayLayerStyles.floating}
              >
                <Select.Popup className={`${floatingSurfaceClassName} min-w-40 p-1`}>
                  <Select.List>
                    {startupOptions.map((option) => (
                      <Select.Item
                        className="flex h-7 items-center gap-2 rounded-lg px-2 text-primary outline-none data-[highlighted]:bg-component-hover"
                        key={option.value}
                        value={option.value}
                      >
                        <Select.ItemIndicator className="w-4"><Check size={14} /></Select.ItemIndicator>
                        <Select.ItemText>{option.label}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Window">
        <SettingsRow label="Reset window layout" detail="Restore 1280 × 832, center the window, and expand the 240 px sidebar.">
          <SettingsButton onClick={() => {
            void confirm("Reset the window to 1280 × 832, center it, and restore the expanded 240 px sidebar?", {
              cancelLabel: "Cancel",
              kind: "info",
              okLabel: "Reset",
              title: "Reset Window Layout",
            }).then((accepted) => accepted ? resetWindowLayout() : null).then((updated) => {
              if (updated) void onSettingsChange(updated, true);
            }).catch((error) => message(errorText(error), { kind: "error", title: "Reset Window Layout" }));
          }}>
            <span className="flex items-center gap-1.5"><RotateCcw size={14} /> Reset</span>
          </SettingsButton>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="About">
        <SettingsRow label="No. 8" detail={`Version ${appVersion}`}>
          <SettingsButton onClick={() => void openSourceRepository()}>
            <span className="flex items-center gap-1.5"><ExternalLink size={14} /> Source</span>
          </SettingsButton>
        </SettingsRow>
        <SettingsRow
          label="Local-first by design"
          detail="Your Library and metadata stay in the active No. 8 Vault. No account or cloud service is required."
        />
      </SettingsGroup>
    </>
  );
}

function AppearanceSettings({
  onSettingsChange,
  settings,
}: Pick<SettingsViewProps, "onSettingsChange" | "settings">) {
  return (
    <>
      <SettingsGroup title="Theme">
        <SettingsRow label="Appearance" detail="System follows the current macOS appearance.">
          <SegmentedControl<AppTheme>
            onChange={(theme) => void onSettingsChange({ theme }, true)}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            value={settings.theme}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Library">
        <SettingsRow label="Card density" detail="Adjust the minimum card width without changing Library order or proportions.">
          <SegmentedControl<LibraryDensity>
            onChange={(density) => void onSettingsChange({ density }, true)}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
              { value: "large", label: "Large" },
            ]}
            value={settings.density}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

type DataStorageSettingsProps = Pick<
  SettingsViewProps,
  "availability" | "onAvailabilityChange" | "onVaultChanged"
> & {
  operation: string | null;
  runDestinationOperation: (purpose: VaultDestinationPurpose) => Promise<void>;
  setOperation: (operation: string | null) => void;
  summary: VaultSummary | null;
  summaryLoading: boolean;
};

function DataStorageSettings({
  availability,
  onAvailabilityChange,
  onVaultChanged,
  operation,
  runDestinationOperation,
  setOperation,
  summary,
  summaryLoading,
}: DataStorageSettingsProps) {
  if (availability.type === "unavailable") {
    return (
      <SettingsGroup title="Vault unavailable">
        <div className="p-5">
          <div className="flex gap-3">
            <Info className="mt-0.5 shrink-0 text-error" size={18} />
            <div>
              <h2 className="font-semibold">No. 8 can’t find your configured vault</h2>
              <p className="mt-1 max-w-xl text-[12px] leading-5 text-secondary">
                Nothing has been created or replaced. Reconnect the drive, locate the vault, or explicitly return to the default location.
              </p>
              <p className="mt-2 max-w-xl truncate font-mono text-[11px] text-secondary" title={availability.configuredPath}>
                {availability.configuredPath}
              </p>
              <div className="mt-4 flex gap-2">
                <SettingsButton onClick={() => {
                  void retryActiveVault()
                    .then(onAvailabilityChange)
                    .catch((error) => message(errorText(error), { kind: "error", title: "Vault Unavailable" }));
                }}>Try Again</SettingsButton>
                <SettingsButton onClick={() => {
                  setOperation("locateUnavailable");
                  void locateUnavailableVault().then(async (candidate) => {
                    if (!candidate) return;
                    const result = await executeVaultChange(candidate.candidateId);
                    onAvailabilityChange({ type: "ready", rootPath: result.rootPath });
                    onVaultChanged(result.rootPath);
                  }).catch((error) => message(errorText(error), { kind: "error", title: "Locate Vault" })).finally(() => setOperation(null));
                }}>Locate Vault…</SettingsButton>
                <SettingsButton prominent onClick={() => {
                  void confirm("Return to the default No. 8 Vault? The missing custom path will only be replaced after the default vault opens successfully.", {
                    kind: "warning", title: "Back to Default", okLabel: "Back to Default", cancelLabel: "Cancel",
                  }).then((accepted) => accepted ? switchToDefaultVault() : null).then((result) => {
                    if (!result) return;
                    onAvailabilityChange({ type: "ready", rootPath: result.rootPath });
                    onVaultChanged(result.rootPath);
                  });
                }}>Back to Default</SettingsButton>
              </div>
            </div>
          </div>
        </div>
      </SettingsGroup>
    );
  }

  return (
    <>
      <SettingsGroup title="Active vault">
        <SettingsRow label="Location" detail="Library media and metadata are stored together.">
          <MiddleTruncatedPath path={summary?.rootPath ?? availability.rootPath ?? ""} />
        </SettingsRow>
        <SettingsRow label="Contents" detail={summaryLoading ? "Calculating…" : summary ? `${summary.itemCount} items · ${summary.imageCount} images · ${summary.linkCount} links · ${summary.spaceCount} Spaces · ${summary.labelCount} Labels` : "Not calculated"}>
          <span className="text-[12px] tabular-nums text-secondary">{summary ? bytesLabel(summary.totalBytes) : "—"}</span>
        </SettingsRow>
        <SettingsRow label="Show in Finder">
          <SettingsButton onClick={() => void revealActiveVault()}><span className="flex items-center gap-1.5"><FolderOpen size={14} /> Show</span></SettingsButton>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Vault management">
        <SettingsRow label="Back up vault" detail="Create a verified snapshot without cache files.">
          <SettingsButton disabled={operation !== null} onClick={() => void runDestinationOperation("backup")}>Back Up…</SettingsButton>
        </SettingsRow>
        <SettingsRow label="Move current Library" detail="Copy, verify, switch, then move the old vault to Trash.">
          <SettingsButton disabled={operation !== null} onClick={() => void runDestinationOperation("moveCurrent")}>Move…</SettingsButton>
        </SettingsRow>
        <SettingsRow label="Start empty" detail="Create and switch to a new empty No. 8 Vault.">
          <SettingsButton disabled={operation !== null} onClick={() => void runDestinationOperation("startEmpty")}>Choose…</SettingsButton>
        </SettingsRow>
        <SettingsRow label="Use existing vault" detail="Open a compatible No. 8 Vault without merging data.">
          <SettingsButton disabled={operation !== null} onClick={() => void runDestinationOperation("useExisting")}>Choose…</SettingsButton>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function ShortcutSettings() {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const grouped = new Map<string, ReturnType<typeof shortcutRows>>();
    for (const row of shortcutRows(query)) {
      const rows = grouped.get(row.category) ?? [];
      rows.push(row);
      grouped.set(row.category, rows);
    }
    return [...grouped.entries()];
  }, [query]);

  return (
    <>
      <div className="relative">
        <Keyboard className="pointer-events-none absolute left-3 top-2.5 text-tertiary" size={15} />
        <input
          aria-label="Filter keyboard shortcuts"
          className="h-9 w-full rounded-lg border border-border-2 bg-background-1 pl-9 pr-3 text-primary outline-none [box-shadow:none] focus:[box-shadow:none] focus-visible:[box-shadow:none]"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search shortcuts"
          type="search"
          value={query}
        />
      </div>
      {groups.map(([category, rows]) => (
        <SettingsGroup key={category} title={category}>
          {rows.map((row) => (
            <SettingsRow key={row.id} label={row.title} detail={row.description}>
              {row.shortcutLabel ? (
                <kbd className="rounded-md border border-border-2 bg-background-2 px-2 py-1 font-sans text-[12px] text-secondary shadow-sm">
                  {row.shortcutLabel}
                </kbd>
              ) : null}
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}
      {groups.length === 0 ? (
        <div className="py-12 text-center text-secondary">No shortcuts found.</div>
      ) : null}
    </>
  );
}

export function SettingsView({
  appVersion,
  availability,
  section,
  settings,
  onAvailabilityChange,
  onClose,
  onSectionChange,
  onSettingsChange,
  onVaultChanged,
}: SettingsViewProps) {
  const [summary, setSummary] = useState<VaultSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const summaryRequest = useRef(0);
  const migrationDismissed = useRef(false);
  const migrationCancelRequested = useRef(false);
  const migrationFinalFocusRef = useRef<HTMLElement | null>(null);
  const migrationInProgress = progress !== null && progress.phase !== "complete";

  const refreshSummary = useCallback(() => {
    if (availability.type !== "ready") return Promise.resolve();
    const request = ++summaryRequest.current;
    setSummaryLoading(true);
    return getVaultSummary()
      .then((nextSummary) => {
        if (request === summaryRequest.current) setSummary(nextSummary);
      })
      .catch((error) => {
        if (request !== summaryRequest.current) return;
        return message(errorText(error), { kind: "error", title: "Data & Storage" });
      })
      .finally(() => {
        if (request === summaryRequest.current) setSummaryLoading(false);
      });
  }, [availability.type]);

  useEffect(() => {
    if (section === "dataStorage" && availability.type === "ready") void refreshSummary();
    return () => {
      summaryRequest.current += 1;
    };
  }, [availability.type, refreshSummary, section]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<MigrationProgress>("vault-migration-progress", (event) => {
      setProgress(event.payload);
      if (event.payload.phase !== "complete" && !migrationDismissed.current) {
        setMigrationOpen(true);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, []);

  const runDestinationOperation = async (purpose: VaultDestinationPurpose) => {
    const activeElement = document.activeElement;
    migrationFinalFocusRef.current =
      activeElement instanceof HTMLElement ? activeElement : null;
    migrationDismissed.current = false;
    migrationCancelRequested.current = false;
    setOperation(purpose);
    try {
      const candidate = await chooseVaultDestination(purpose);
      if (!candidate) return;
      if (purpose === "backup") {
        const path = await backUpVault(candidate.candidateId);
        await message(`Your vault was backed up to:\n${path}`, {
          kind: "info",
          title: "Backup Complete",
        });
        await refreshSummary();
        return;
      }
      const result = await executeVaultChange(candidate.candidateId);
      onAvailabilityChange({ type: "ready", rootPath: result.rootPath });
      onVaultChanged(result.rootPath);
      await refreshSummary();
      if (result.sourceCleanupWarning) {
        await message(result.sourceCleanupWarning, { kind: "warning", title: "Vault Changed" });
      }
    } catch (error) {
      await message(errorText(error), { kind: "error", title: "Vault Operation" });
    } finally {
      setOperation(null);
      setProgress(null);
      setMigrationOpen(false);
      migrationDismissed.current = false;
      migrationCancelRequested.current = false;
    }
  };

  const requestMigrationCancellation = useCallback(async () => {
    if (migrationCancelRequested.current) return;
    migrationCancelRequested.current = true;
    migrationDismissed.current = true;
    setMigrationOpen(false);
    try {
      await cancelVaultMigration();
    } catch (error) {
      migrationCancelRequested.current = false;
      migrationDismissed.current = false;
      if (migrationInProgress && progress?.cancellable) setMigrationOpen(true);
      await message(errorText(error), {
        kind: "error",
        title: "Cancel Vault Change",
      });
    }
  }, [migrationInProgress, progress?.cancellable]);

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background-2 text-primary">
      <aside className="flex h-full w-60 shrink-0 flex-col bg-background-2">
        <header className="flex h-11 shrink-0 items-center px-3 pb-1.5 pt-2.5" data-tauri-drag-region>
          <button
            className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1.5 text-secondary hover:bg-component-hover hover:text-primary"
            onClick={onClose}
            type="button"
          >
            <ChevronLeft aria-hidden size={15} />
            Library
          </button>
        </header>
        <nav aria-label="Settings" className="flex flex-col gap-1 px-3 py-2.5">
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              aria-current={section === id ? "page" : undefined}
              className={`focus-ring flex h-7 w-[216px] items-center gap-2 rounded-lg px-2 text-left ${
                section === id ? "bg-selected text-primary" : "text-secondary hover:bg-component-hover"
              }`}
              key={id}
              onClick={() => onSectionChange(id)}
              type="button"
            >
              <Icon aria-hidden size={16} strokeWidth={1.5} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 p-1">
        <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border-[0.5px] border-border-1 bg-background-1">
          <header className="flex h-10 shrink-0 items-center px-5" data-tauri-drag-region>
            <h1 className="text-[13px] font-semibold">{sectionTitles[section]}</h1>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto bg-background-2/40">
            <div className="mx-auto flex w-full max-w-[904px] flex-col gap-7 px-8 py-8">
              {section === "general" ? (
                <GeneralSettings
                  appVersion={appVersion}
                  onSettingsChange={onSettingsChange}
                  settings={settings}
                />
              ) : null}
              {section === "appearance" ? (
                <AppearanceSettings
                  onSettingsChange={onSettingsChange}
                  settings={settings}
                />
              ) : null}
              {section === "dataStorage" ? (
                <DataStorageSettings
                  availability={availability}
                  onAvailabilityChange={onAvailabilityChange}
                  onVaultChanged={onVaultChanged}
                  operation={operation}
                  runDestinationOperation={runDestinationOperation}
                  setOperation={setOperation}
                  summary={summary}
                  summaryLoading={summaryLoading}
                />
              ) : null}
              {section === "shortcuts" ? <ShortcutSettings /> : null}
            </div>
          </div>
        </section>
      </main>

      <Dialog.Root
        disablePointerDismissal={!progress?.cancellable}
        modal
        onOpenChange={(nextOpen, eventDetails) => {
          if (!nextOpen && migrationDismissal(progress) === "keep-open") {
            eventDetails.cancel();
            return;
          }
          setMigrationOpen(nextOpen);
          if (!nextOpen) void requestMigrationCancellation();
        }}
        open={migrationOpen && migrationInProgress}
      >
        <Dialog.Portal>
          <AppDialogBackdrop />
          <AppDialogViewport className="flex items-center justify-center p-4">
            <AppDialogPopup
              className="w-[420px] p-5 text-primary outline-none"
              finalFocus={() => migrationFinalFocusRef.current ?? true}
            >
              {migrationInProgress && progress ? (
                <>
                  <Dialog.Title
                    className="flex items-center gap-2 font-semibold"
                    id="vault-migration-title"
                  >
                    <Gauge aria-hidden="true" size={18} /> Changing Vault
                  </Dialog.Title>
                  <Dialog.Description className="mt-2 capitalize text-secondary">
                    {progress.phase.replace(/([A-Z])/g, " $1")}
                  </Dialog.Description>
                  <progress
                    className="mt-4 h-2 w-full accent-accent"
                    max={Math.max(1, progress.bytesTotal)}
                    value={progress.bytesCompleted}
                  />
                  <div className="mt-4 flex justify-end">
                    {progress.cancellable ? (
                      <Dialog.Close className="focus-ring rounded-lg border border-border-2 bg-foreground-1 px-3 py-1.5 font-medium text-primary hover:bg-component-hover">
                        Cancel
                      </Dialog.Close>
                    ) : (
                      <button
                        className="focus-ring rounded-lg border border-border-2 bg-foreground-1 px-3 py-1.5 font-medium text-primary opacity-45"
                        disabled
                        type="button"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </>
              ) : null}
            </AppDialogPopup>
          </AppDialogViewport>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
