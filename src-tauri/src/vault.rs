use crate::{library, settings::SettingsState};
use rusqlite::{backup::Backup, Connection};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    ops::Deref,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

const VAULT_NAME: &str = "No. 8 Vault";
const REPOSITORY_URL: &str = "https://github.com/alexlohinov/number-eight";

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum VaultAvailability {
    Ready { root_path: String },
    Unavailable { configured_path: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummary {
    pub root_path: String,
    pub item_count: i64,
    pub image_count: i64,
    pub link_count: i64,
    pub space_count: i64,
    pub label_count: i64,
    pub total_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationCandidate {
    pub candidate_id: String,
    pub display_path: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChangeResult {
    pub root_path: String,
    pub source_cleanup_warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationProgress {
    phase: String,
    bytes_completed: u64,
    bytes_total: u64,
    cancellable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum CandidatePurpose {
    Backup,
    MoveCurrent,
    StartEmpty,
    UseExisting,
    LocateUnavailable,
}

impl CandidatePurpose {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "backup" => Ok(Self::Backup),
            "moveCurrent" => Ok(Self::MoveCurrent),
            "startEmpty" => Ok(Self::StartEmpty),
            "useExisting" => Ok(Self::UseExisting),
            "locateUnavailable" => Ok(Self::LocateUnavailable),
            _ => Err("The vault destination purpose is invalid.".into()),
        }
    }
}

#[derive(Clone, Debug)]
struct Candidate {
    root: PathBuf,
    purpose: CandidatePurpose,
}

#[derive(Debug)]
struct RuntimeState {
    root: PathBuf,
    availability: VaultAvailability,
    readers: usize,
    exclusive: bool,
    cancelled: bool,
    candidates: HashMap<String, Candidate>,
}

#[derive(Debug)]
struct RuntimeInner {
    state: Mutex<RuntimeState>,
    available: Condvar,
}

#[derive(Clone, Debug)]
pub struct VaultRuntime {
    inner: Arc<RuntimeInner>,
}

#[derive(Debug)]
pub struct VaultAccess {
    root: PathBuf,
    runtime: VaultRuntime,
}

impl AsRef<Path> for VaultAccess {
    fn as_ref(&self) -> &Path {
        &self.root
    }
}

impl Deref for VaultAccess {
    type Target = Path;
    fn deref(&self) -> &Self::Target {
        &self.root
    }
}

impl Drop for VaultAccess {
    fn drop(&mut self) {
        if let Ok(mut state) = self.runtime.inner.state.lock() {
            state.readers = state.readers.saturating_sub(1);
            self.runtime.inner.available.notify_all();
        }
    }
}

struct ExclusiveAccess {
    runtime: VaultRuntime,
}

impl Drop for ExclusiveAccess {
    fn drop(&mut self) {
        if let Ok(mut state) = self.runtime.inner.state.lock() {
            state.exclusive = false;
            state.cancelled = false;
            self.runtime.inner.available.notify_all();
        }
    }
}

impl VaultRuntime {
    pub fn initialize(app: &AppHandle, configured_root: Option<&str>) -> Result<Self, String> {
        let default = default_vault_root(app)?;
        let (root, availability) = if let Some(configured) = configured_root {
            let root = PathBuf::from(configured);
            if valid_existing_vault(&root).is_ok() {
                let root = canonicalize_existing(&root)?;
                (
                    root.clone(),
                    VaultAvailability::Ready {
                        root_path: root.to_string_lossy().into_owned(),
                    },
                )
            } else {
                (
                    root.clone(),
                    VaultAvailability::Unavailable {
                        configured_path: root.to_string_lossy().into_owned(),
                    },
                )
            }
        } else {
            library::ensure_vault(&default)?;
            let root = canonicalize_existing(&default)?;
            (
                root.clone(),
                VaultAvailability::Ready {
                    root_path: root.to_string_lossy().into_owned(),
                },
            )
        };
        let runtime = Self {
            inner: Arc::new(RuntimeInner {
                state: Mutex::new(RuntimeState {
                    root,
                    availability,
                    readers: 0,
                    exclusive: false,
                    cancelled: false,
                    candidates: HashMap::new(),
                }),
                available: Condvar::new(),
            }),
        };
        if matches!(runtime.availability()?, VaultAvailability::Ready { .. }) {
            runtime.allow_asset_directories(app)?;
        }
        Ok(runtime)
    }

    pub fn acquire(&self) -> Result<VaultAccess, String> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "The vault runtime is unavailable.".to_string())?;
        while state.exclusive {
            state = self
                .inner
                .available
                .wait(state)
                .map_err(|_| "The vault runtime is unavailable.".to_string())?;
        }
        if let VaultAvailability::Unavailable { .. } = state.availability {
            return Err(
                "The configured No. 8 Vault is unavailable. Open Settings to recover it.".into(),
            );
        }
        state.readers += 1;
        Ok(VaultAccess {
            root: state.root.clone(),
            runtime: self.clone(),
        })
    }

    fn exclusive(&self) -> Result<ExclusiveAccess, String> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "The vault runtime is unavailable.".to_string())?;
        while state.exclusive {
            state = self
                .inner
                .available
                .wait(state)
                .map_err(|_| "The vault runtime is unavailable.".to_string())?;
        }
        state.exclusive = true;
        while state.readers > 0 {
            state = self
                .inner
                .available
                .wait(state)
                .map_err(|_| "The vault runtime is unavailable.".to_string())?;
        }
        state.cancelled = false;
        Ok(ExclusiveAccess {
            runtime: self.clone(),
        })
    }

    pub fn availability(&self) -> Result<VaultAvailability, String> {
        self.inner
            .state
            .lock()
            .map(|state| state.availability.clone())
            .map_err(|_| "The vault runtime is unavailable.".to_string())
    }

    pub fn current_root(&self) -> Result<PathBuf, String> {
        self.inner
            .state
            .lock()
            .map(|state| state.root.clone())
            .map_err(|_| "The vault runtime is unavailable.".to_string())
    }

    fn replace_root(&self, root: PathBuf) -> Result<(), String> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "The vault runtime is unavailable.".to_string())?;
        state.root = root.clone();
        state.availability = VaultAvailability::Ready {
            root_path: root.to_string_lossy().into_owned(),
        };
        Ok(())
    }

    fn cancelled(&self) -> bool {
        self.inner
            .state
            .lock()
            .map(|state| state.cancelled)
            .unwrap_or(true)
    }

    fn allow_asset_directories(&self, app: &AppHandle) -> Result<(), String> {
        let root = self.current_root()?;
        let scope = app.asset_protocol_scope();
        scope
            .allow_directory(root.join("Library"), true)
            .and_then(|_| scope.allow_directory(root.join(".no8/assets/links"), true))
            .map_err(|_| "The vault media scope could not be configured.".to_string())
    }
}

pub fn default_vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .document_dir()
        .map(|directory| directory.join(VAULT_NAME))
        .map_err(|_| "The Documents directory is unavailable.".to_string())
}

#[tauri::command]
pub fn get_vault_summary(runtime: tauri::State<'_, VaultRuntime>) -> Result<VaultSummary, String> {
    let access = runtime.acquire()?;
    vault_summary(&access)
}

#[tauri::command]
pub fn reveal_active_vault(
    app: AppHandle,
    runtime: tauri::State<'_, VaultRuntime>,
) -> Result<(), String> {
    let access = runtime.acquire()?;
    app.opener()
        .reveal_item_in_dir(access.as_ref())
        .map_err(|_| "The No. 8 Vault could not be revealed in Finder.".to_string())
}

#[tauri::command]
pub fn open_source_repository(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(REPOSITORY_URL, None::<&str>)
        .map_err(|_| "The source repository could not be opened.".to_string())
}

#[tauri::command]
pub fn choose_vault_destination(
    app: AppHandle,
    purpose: String,
    runtime: tauri::State<'_, VaultRuntime>,
) -> Result<Option<DestinationCandidate>, String> {
    let purpose = CandidatePurpose::parse(&purpose)?;
    let Some(selected) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let selected = selected
        .into_path()
        .map_err(|_| "The selected directory is invalid.".to_string())?;
    let selected = canonicalize_existing(&selected)?;
    ensure_writable(&selected)?;
    let active = runtime.current_root()?;
    let root = if matches!(
        purpose,
        CandidatePurpose::UseExisting | CandidatePurpose::LocateUnavailable
    ) && selected.join(".no8/no8.sqlite").is_file()
    {
        selected
    } else if matches!(purpose, CandidatePurpose::Backup) {
        selected
    } else {
        selected.join(VAULT_NAME)
    };
    reject_related_paths(&active, &root)?;
    let status = match purpose {
        CandidatePurpose::UseExisting | CandidatePurpose::LocateUnavailable => {
            valid_existing_vault(&root)?;
            "existingVault"
        }
        CandidatePurpose::Backup => "readyForBackup",
        _ if root.exists() => return Err("A No. 8 Vault already exists at this location.".into()),
        _ => "ready",
    };
    let candidate_id = Uuid::new_v4().to_string();
    runtime
        .inner
        .state
        .lock()
        .map_err(|_| "The vault runtime is unavailable.".to_string())?
        .candidates
        .insert(
            candidate_id.clone(),
            Candidate {
                root: root.clone(),
                purpose,
            },
        );
    Ok(Some(DestinationCandidate {
        candidate_id,
        display_path: root.to_string_lossy().into_owned(),
        status: status.into(),
    }))
}

#[tauri::command]
pub fn back_up_vault(
    app: AppHandle,
    candidate_id: String,
    runtime: tauri::State<'_, VaultRuntime>,
) -> Result<String, String> {
    let candidate = take_candidate(&runtime, &candidate_id, CandidatePurpose::Backup)?;
    let _exclusive = runtime.exclusive()?;
    let source = runtime.current_root()?;
    let timestamp = unix_timestamp();
    let final_root = candidate.root.join(format!("No. 8 Backup {timestamp}"));
    let staging = candidate
        .root
        .join(format!(".no8-backup-{}.staging", Uuid::new_v4()));
    let result: Result<String, String> = (|| {
        fs::create_dir(&staging)
            .map_err(|_| "The backup staging folder could not be created.".to_string())?;
        copy_vault_payload(&source, &staging, None, None)?;
        write_manifest(&staging, &source, "backup")?;
        verify_vault(&staging)?;
        fs::rename(&staging, &final_root)
            .map_err(|_| "The completed backup could not be finalized.".to_string())?;
        Ok(final_root.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    let path = result?;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|_| "The backup completed, but Finder could not reveal it.".to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn execute_vault_change(
    app: AppHandle,
    candidate_id: String,
    runtime: tauri::State<'_, VaultRuntime>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<VaultChangeResult, String> {
    let candidate = take_candidate_any(&runtime, &candidate_id)?;
    if candidate.purpose == CandidatePurpose::Backup {
        return Err("A backup destination cannot be used to switch vaults.".into());
    }
    let _exclusive = runtime.exclusive()?;
    let source = runtime.current_root()?;
    let retained_candidate = candidate.clone();
    let target = candidate.root;
    let staging = target.with_file_name(format!(".no8-vault-{}.staging", Uuid::new_v4()));
    let total = directory_size(&source.join("Library"))?
        + directory_size(&source.join(".no8/assets/links"))?;
    emit_progress(&app, "preparing", 0, total, true);
    let result = (|| {
        if runtime.cancelled() {
            return Err("The vault migration was cancelled.".to_string());
        }
        match candidate.purpose {
            CandidatePurpose::StartEmpty => {
                emit_progress(&app, "creating", 0, total, true);
                library::ensure_vault(&staging)?;
            }
            CandidatePurpose::UseExisting | CandidatePurpose::LocateUnavailable => {
                emit_progress(&app, "validating", 0, total, true);
                valid_existing_vault(&target)?;
                if vault_schema_version(&target)? < library::current_schema_version() {
                    create_pre_upgrade_backup(&target)?;
                }
                library::ensure_vault(&target)?;
            }
            CandidatePurpose::MoveCurrent => {
                fs::create_dir(&staging)
                    .map_err(|_| "The vault staging folder could not be created.".to_string())?;
                emit_progress(&app, "snapshotting", 0, total, true);
                copy_vault_payload(&source, &staging, Some(&app), Some(&runtime))?;
                emit_progress(&app, "verifying", total, total, true);
                verify_vault(&staging)?;
                verify_matching_vaults(&source, &staging)?;
                fs::rename(&staging, &target)
                    .map_err(|_| "The migrated vault could not be finalized.".to_string())?;
            }
            CandidatePurpose::Backup => unreachable!(),
        }
        let target = canonicalize_existing(&target)?;
        emit_progress(&app, "switching", total, total, false);
        runtime.replace_root(target.clone())?;
        runtime.allow_asset_directories(&app)?;
        if let Err(error) = settings.set_vault_root(Some(&target)) {
            runtime.replace_root(source.clone())?;
            return Err(error);
        }
        if let Err(error) = library::validate_vault_readable(&target) {
            let _ = settings.set_vault_root(Some(&source));
            runtime.replace_root(source.clone())?;
            return Err(error);
        }
        emit_progress(&app, "reloading", total, total, false);
        let cleanup_warning = if candidate.purpose == CandidatePurpose::MoveCurrent {
            emit_progress(&app, "trashingSource", total, total, false);
            trash::delete(&source).err().map(|_| {
                format!(
                    "The new vault is active, but the old vault could not be moved to Trash: {}",
                    source.display()
                )
            })
        } else {
            None
        };
        emit_progress(&app, "complete", total, total, false);
        Ok(VaultChangeResult {
            root_path: target.to_string_lossy().into_owned(),
            source_cleanup_warning: cleanup_warning,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
        if let Ok(mut state) = runtime.inner.state.lock() {
            state.candidates.insert(candidate_id, retained_candidate);
        }
    }
    result
}

#[tauri::command]
pub fn cancel_vault_migration(runtime: tauri::State<'_, VaultRuntime>) -> Result<(), String> {
    let mut state = runtime
        .inner
        .state
        .lock()
        .map_err(|_| "The vault runtime is unavailable.".to_string())?;
    state.cancelled = true;
    Ok(())
}

#[tauri::command]
pub fn retry_active_vault(
    app: AppHandle,
    runtime: tauri::State<'_, VaultRuntime>,
) -> Result<VaultAvailability, String> {
    let root = runtime.current_root()?;
    valid_existing_vault(&root)?;
    library::validate_vault_readable(&root)?;
    runtime.replace_root(canonicalize_existing(&root)?)?;
    runtime.allow_asset_directories(&app)?;
    runtime.availability()
}

#[tauri::command]
pub fn locate_unavailable_vault(
    app: AppHandle,
    runtime: tauri::State<'_, VaultRuntime>,
) -> Result<Option<DestinationCandidate>, String> {
    choose_vault_destination(app, "locateUnavailable".into(), runtime)
}

#[tauri::command]
pub fn switch_to_default_vault(
    app: AppHandle,
    runtime: tauri::State<'_, VaultRuntime>,
    settings: tauri::State<'_, SettingsState>,
) -> Result<VaultChangeResult, String> {
    let _exclusive = runtime.exclusive()?;
    let root = default_vault_root(&app)?;
    library::ensure_vault(&root)?;
    let root = canonicalize_existing(&root)?;
    library::validate_vault_readable(&root)?;
    settings.set_vault_root(None)?;
    runtime.replace_root(root.clone())?;
    runtime.allow_asset_directories(&app)?;
    Ok(VaultChangeResult {
        root_path: root.to_string_lossy().into_owned(),
        source_cleanup_warning: None,
    })
}

fn take_candidate(
    runtime: &VaultRuntime,
    id: &str,
    purpose: CandidatePurpose,
) -> Result<Candidate, String> {
    let candidate = take_candidate_any(runtime, id)?;
    if candidate.purpose != purpose {
        return Err("The vault destination is not valid for this operation.".into());
    }
    Ok(candidate)
}

fn take_candidate_any(runtime: &VaultRuntime, id: &str) -> Result<Candidate, String> {
    runtime
        .inner
        .state
        .lock()
        .map_err(|_| "The vault runtime is unavailable.".to_string())?
        .candidates
        .remove(id)
        .ok_or_else(|| "The vault destination expired. Choose it again.".to_string())
}

fn vault_summary(root: &Path) -> Result<VaultSummary, String> {
    let connection = Connection::open(root.join(".no8/no8.sqlite"))
        .map_err(|_| "The No. 8 database could not be opened.".to_string())?;
    let count = |sql: &str| {
        connection
            .query_row(sql, [], |row| row.get::<_, i64>(0))
            .map_err(|_| "The vault statistics could not be read.".to_string())
    };
    Ok(VaultSummary {
        root_path: root.to_string_lossy().into_owned(),
        item_count: count("SELECT COUNT(*) FROM items")?,
        image_count: count("SELECT COUNT(*) FROM items WHERE item_type = 'image'")?,
        link_count: count("SELECT COUNT(*) FROM items WHERE item_type = 'link'")?,
        space_count: count("SELECT COUNT(*) FROM spaces")?,
        label_count: count("SELECT COUNT(*) FROM labels")?,
        total_bytes: directory_size(&root.join("Library"))?
            + directory_size(&root.join(".no8/assets/links"))?
            + fs::metadata(root.join(".no8/no8.sqlite"))
                .map(|metadata| metadata.len())
                .unwrap_or(0),
    })
}

fn copy_vault_payload(
    source: &Path,
    target: &Path,
    app: Option<&AppHandle>,
    runtime: Option<&VaultRuntime>,
) -> Result<(), String> {
    fs::create_dir_all(target.join(".no8/assets/links"))
        .and_then(|_| fs::create_dir_all(target.join("Library")))
        .map_err(|_| "The vault staging directories could not be created.".to_string())?;
    snapshot_database(
        &source.join(".no8/no8.sqlite"),
        &target.join(".no8/no8.sqlite"),
    )?;
    let total = directory_size(&source.join("Library"))?
        + directory_size(&source.join(".no8/assets/links"))?;
    let mut completed = 0;
    copy_tree(
        &source.join("Library"),
        &target.join("Library"),
        &mut completed,
        total,
        app,
        runtime,
    )?;
    copy_tree(
        &source.join(".no8/assets/links"),
        &target.join(".no8/assets/links"),
        &mut completed,
        total,
        app,
        runtime,
    )
}

fn copy_tree(
    source: &Path,
    target: &Path,
    completed: &mut u64,
    total: u64,
    app: Option<&AppHandle>,
    runtime: Option<&VaultRuntime>,
) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    for entry in
        fs::read_dir(source).map_err(|_| "A vault directory could not be read.".to_string())?
    {
        if runtime.is_some_and(VaultRuntime::cancelled) {
            return Err("The vault migration was cancelled.".into());
        }
        let entry = entry.map_err(|_| "A vault directory entry could not be read.".to_string())?;
        let metadata = entry
            .file_type()
            .map_err(|_| "A vault entry could not be inspected.".to_string())?;
        if metadata.is_symlink() {
            return Err("Vaults cannot contain symbolic links.".into());
        }
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|_| "A backup directory could not be created.".to_string())?;
            copy_tree(&entry.path(), &destination, completed, total, app, runtime)?;
        } else if metadata.is_file() {
            let bytes = fs::copy(entry.path(), destination)
                .map_err(|_| "A vault file could not be copied.".to_string())?;
            *completed += bytes;
            if let Some(app) = app {
                emit_progress(app, "copying", *completed, total, true);
            }
        }
    }
    Ok(())
}

fn snapshot_database(source: &Path, target: &Path) -> Result<(), String> {
    let source = Connection::open(source)
        .map_err(|_| "The source database could not be opened for backup.".to_string())?;
    let mut target = Connection::open(target)
        .map_err(|_| "The backup database could not be created.".to_string())?;
    let backup = Backup::new(&source, &mut target)
        .map_err(|_| "The database backup could not start.".to_string())?;
    backup
        .run_to_completion(64, Duration::from_millis(5), None)
        .map_err(|_| "The database backup could not be completed.".to_string())
}

fn verify_vault(root: &Path) -> Result<(), String> {
    let connection = Connection::open(root.join(".no8/no8.sqlite"))
        .map_err(|_| "The copied database could not be opened.".to_string())?;
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| "The copied database could not be verified.".to_string())?;
    if result != "ok" {
        return Err("The copied database failed its integrity check.".into());
    }
    let mut statement = connection
        .prepare("SELECT relative_path FROM items WHERE relative_path IS NOT NULL")
        .map_err(|_| "The copied image paths could not be verified.".to_string())?;
    let paths = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "The copied image paths could not be verified.".to_string())?;
    for path in paths {
        let path = path.map_err(|_| "A copied image path is invalid.".to_string())?;
        if !root.join("Library").join(path).is_file() {
            return Err("A copied Library image is missing.".into());
        }
    }
    let mut statement = connection
        .prepare(
            "SELECT preview_relative_path, favicon_relative_path FROM items
             WHERE preview_relative_path IS NOT NULL OR favicon_relative_path IS NOT NULL",
        )
        .map_err(|_| "The copied link assets could not be verified.".to_string())?;
    let assets = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })
        .map_err(|_| "The copied link assets could not be verified.".to_string())?;
    for asset in assets {
        let (preview, favicon) =
            asset.map_err(|_| "A copied link asset path is invalid.".to_string())?;
        for path in [preview, favicon].into_iter().flatten() {
            if !root.join(path).is_file() {
                return Err("A copied persistent link asset is missing.".into());
            }
        }
    }
    Ok(())
}

fn verify_matching_vaults(source: &Path, target: &Path) -> Result<(), String> {
    let source = Connection::open(source.join(".no8/no8.sqlite"))
        .map_err(|_| "The source database could not be opened for verification.".to_string())?;
    let target = Connection::open(target.join(".no8/no8.sqlite"))
        .map_err(|_| "The copied database could not be opened for verification.".to_string())?;
    for table in ["items", "spaces", "labels", "item_spaces", "item_labels"] {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        let source_count: i64 = source
            .query_row(&sql, [], |row| row.get(0))
            .map_err(|_| "A source table could not be verified.".to_string())?;
        let target_count: i64 = target
            .query_row(&sql, [], |row| row.get(0))
            .map_err(|_| "A copied table could not be verified.".to_string())?;
        if source_count != target_count {
            return Err(format!(
                "The copied {table} table has a different row count."
            ));
        }
    }
    Ok(())
}

fn vault_schema_version(root: &Path) -> Result<i64, String> {
    let connection = Connection::open(root.join(".no8/no8.sqlite"))
        .map_err(|_| "The No. 8 database could not be opened.".to_string())?;
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| "The No. 8 database version could not be read.".to_string())
}

fn create_pre_upgrade_backup(source: &Path) -> Result<PathBuf, String> {
    let parent = source
        .parent()
        .ok_or_else(|| "The existing vault has no parent directory.".to_string())?;
    let final_root = parent.join(format!("No. 8 Vault Pre-Upgrade {}", unix_timestamp()));
    let staging = parent.join(format!(".no8-upgrade-{}.staging", Uuid::new_v4()));
    let result = (|| {
        fs::create_dir(&staging).map_err(|_| {
            "The pre-upgrade backup staging folder could not be created.".to_string()
        })?;
        copy_vault_payload(source, &staging, None, None)?;
        write_manifest(&staging, source, "preUpgrade")?;
        verify_vault(&staging)?;
        verify_matching_vaults(source, &staging)?;
        fs::rename(&staging, &final_root)
            .map_err(|_| "The pre-upgrade backup could not be finalized.".to_string())?;
        Ok(final_root.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn valid_existing_vault(root: &Path) -> Result<(), String> {
    if !root.is_dir() || !root.join(".no8/no8.sqlite").is_file() || !root.join("Library").is_dir() {
        return Err("The selected folder is not a No. 8 Vault.".into());
    }
    library::validate_vault_version(root)
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|_| "The selected directory could not be resolved.".to_string())
}

fn reject_related_paths(active: &Path, destination: &Path) -> Result<(), String> {
    let active = active
        .canonicalize()
        .unwrap_or_else(|_| active.to_path_buf());
    let parent = destination.parent().unwrap_or(destination);
    let parent = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    let destination = if destination.exists() {
        destination
            .canonicalize()
            .unwrap_or_else(|_| destination.to_path_buf())
    } else {
        parent.join(destination.file_name().unwrap_or_default())
    };
    if destination == active || destination.starts_with(&active) || active.starts_with(&destination)
    {
        return Err("Choose a location outside the active No. 8 Vault.".into());
    }
    Ok(())
}

fn ensure_writable(directory: &Path) -> Result<(), String> {
    let path = directory.join(format!(".no8-write-test-{}", Uuid::new_v4()));
    let result = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .and_then(|mut file| file.write_all(b"No. 8").and_then(|_| file.sync_all()));
    let _ = fs::remove_file(&path);
    result.map_err(|_| "The selected directory is not writable.".to_string())
}

fn directory_size(root: &Path) -> Result<u64, String> {
    if !root.exists() {
        return Ok(0);
    }
    let mut total = 0;
    for entry in
        fs::read_dir(root).map_err(|_| "A vault directory could not be scanned.".to_string())?
    {
        let entry =
            entry.map_err(|_| "A vault directory entry could not be scanned.".to_string())?;
        let kind = entry
            .file_type()
            .map_err(|_| "A vault entry could not be inspected.".to_string())?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            total += directory_size(&entry.path())?;
        } else if kind.is_file() {
            total += entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        }
    }
    Ok(total)
}

fn write_manifest(root: &Path, source: &Path, kind: &str) -> Result<(), String> {
    let summary = vault_summary(root)?;
    let manifest = serde_json::json!({
        "formatVersion": 1,
        "createdAtUnix": unix_timestamp(),
        "kind": kind,
        "itemCount": summary.item_count,
        "originalName": source.file_name().and_then(|value| value.to_str()).unwrap_or(VAULT_NAME),
    });
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| "The backup manifest could not be encoded.".to_string())?;
    fs::write(root.join("backup-manifest.json"), bytes)
        .map_err(|_| "The backup manifest could not be written.".to_string())
}

fn emit_progress(app: &AppHandle, phase: &str, completed: u64, total: u64, cancellable: bool) {
    let _ = app.emit(
        "vault-migration-progress",
        MigrationProgress {
            phase: phase.into(),
            bytes_completed: completed,
            bytes_total: total,
            cancellable,
        },
    );
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("no8-{name}-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_same_nested_and_parent_destinations() {
        let root = TestDirectory::new("paths");
        let active = root.0.join("active");
        fs::create_dir_all(active.join("nested")).unwrap();
        assert!(reject_related_paths(&active, &active).is_err());
        assert!(reject_related_paths(&active, &active.join("nested")).is_err());
        assert!(reject_related_paths(&active, &root.0).is_err());
        assert!(reject_related_paths(&active, &root.0.join("sibling")).is_ok());
    }

    #[test]
    fn availability_uses_the_frontend_contract() {
        let ready = serde_json::to_value(VaultAvailability::Ready {
            root_path: "/tmp/vault".into(),
        })
        .unwrap();
        assert_eq!(
            ready,
            serde_json::json!({ "type": "ready", "rootPath": "/tmp/vault" })
        );
        let unavailable = serde_json::to_value(VaultAvailability::Unavailable {
            configured_path: "/missing".into(),
        })
        .unwrap();
        assert_eq!(
            unavailable,
            serde_json::json!({ "type": "unavailable", "configuredPath": "/missing" })
        );
    }

    #[test]
    fn summary_counts_payload_but_excludes_cache() {
        let root = TestDirectory::new("summary");
        let vault = root.0.join("vault");
        library::ensure_vault(&vault).unwrap();
        fs::write(vault.join("Library/image.jpg"), b"image").unwrap();
        fs::create_dir_all(vault.join(".no8/assets/links/link")).unwrap();
        fs::write(vault.join(".no8/assets/links/link/preview.jpg"), b"preview").unwrap();
        let before = vault_summary(&vault).unwrap();
        fs::create_dir_all(vault.join(".no8/cache")).unwrap();
        fs::write(vault.join(".no8/cache/large.bin"), vec![1; 4096]).unwrap();
        let after = vault_summary(&vault).unwrap();
        assert_eq!(before.total_bytes, after.total_bytes);
        assert_eq!(after.space_count, 1);
    }

    #[test]
    fn online_snapshot_is_consistent_and_verifiable() {
        let root = TestDirectory::new("snapshot");
        let source = root.0.join("source");
        let target = root.0.join("target");
        library::ensure_vault(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        copy_vault_payload(&source, &target, None, None).unwrap();
        verify_vault(&target).unwrap();
        verify_matching_vaults(&source, &target).unwrap();
        assert!(!target.join(".no8/cache").exists());
    }

    #[cfg(unix)]
    #[test]
    fn copying_refuses_symbolic_links() {
        use std::os::unix::fs::symlink;
        let root = TestDirectory::new("symlink");
        let source = root.0.join("source");
        let target = root.0.join("target");
        library::ensure_vault(&source).unwrap();
        fs::write(root.0.join("outside"), b"outside").unwrap();
        symlink(root.0.join("outside"), source.join("Library/escape")).unwrap();
        fs::create_dir_all(&target).unwrap();
        assert!(copy_vault_payload(&source, &target, None, None).is_err());
    }
}
