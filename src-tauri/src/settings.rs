use crate::vault::{default_vault_root, VaultAvailability, VaultRuntime};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, LogicalSize, Manager, Size, Theme};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};
use uuid::Uuid;

const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub density: String,
    pub startup_location: Value,
    pub sidebar_width: f64,
    pub sidebar_collapsed: bool,
    pub last_library_location: Value,
    pub vault_root: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsPatch {
    pub theme: Option<Value>,
    pub density: Option<Value>,
    pub startup_location: Option<Value>,
    pub sidebar_width: Option<Value>,
    pub sidebar_collapsed: Option<Value>,
    pub last_library_location: Option<Value>,
}

pub struct SettingsState {
    path: PathBuf,
    settings: Mutex<AppSettings>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBootstrap {
    pub settings: AppSettings,
    pub resolved_startup_location: Value,
    pub app_version: String,
    pub default_vault_path: String,
    pub vault_availability: VaultAvailability,
}

impl AppSettings {
    pub fn defaults() -> Self {
        Self {
            theme: "system".into(),
            density: "comfortable".into(),
            startup_location: Value::String("lastVisited".into()),
            sidebar_width: 240.0,
            sidebar_collapsed: false,
            last_library_location: Value::String("all".into()),
            vault_root: None,
        }
    }

    fn from_value(value: Value) -> Self {
        let mut settings = Self::defaults();
        let Some(object) = value.as_object() else {
            return settings;
        };
        if let Some(value) = valid_choice(object.get("theme"), &["system", "light", "dark"]) {
            settings.theme = value;
        }
        if let Some(value) =
            valid_choice(object.get("density"), &["compact", "comfortable", "large"])
        {
            settings.density = value;
        }
        if let Some(value) = object
            .get("startupLocation")
            .filter(|value| valid_location(value))
        {
            settings.startup_location = value.clone();
        }
        if let Some(value) = object
            .get("sidebarWidth")
            .and_then(Value::as_f64)
            .filter(|value| (190.0..=256.0).contains(value))
        {
            settings.sidebar_width = value;
        }
        if let Some(value) = object.get("sidebarCollapsed").and_then(Value::as_bool) {
            settings.sidebar_collapsed = value;
        }
        if let Some(value) = object
            .get("lastLibraryLocation")
            .filter(|value| valid_library_location(value))
        {
            settings.last_library_location = value.clone();
        }
        settings.vault_root = object
            .get("vaultRoot")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned);
        settings
    }

    fn apply_patch(&mut self, patch: AppSettingsPatch) -> Result<(), String> {
        if let Some(value) = patch.theme {
            self.theme = valid_choice(Some(&value), &["system", "light", "dark"])
                .ok_or_else(|| "Theme must be System, Light, or Dark.".to_string())?;
        }
        if let Some(value) = patch.density {
            self.density = valid_choice(Some(&value), &["compact", "comfortable", "large"])
                .ok_or_else(|| "Density must be Compact, Comfortable, or Large.".to_string())?;
        }
        if let Some(value) = patch.startup_location {
            if !valid_location(&value) {
                return Err("The startup location is invalid.".into());
            }
            self.startup_location = value;
        }
        if let Some(value) = patch.sidebar_width {
            let value = value
                .as_f64()
                .filter(|value| (190.0..=256.0).contains(value))
                .ok_or_else(|| "Sidebar width must be between 190 and 256 pixels.".to_string())?;
            self.sidebar_width = value;
        }
        if let Some(value) = patch.sidebar_collapsed {
            self.sidebar_collapsed = value
                .as_bool()
                .ok_or_else(|| "Sidebar collapsed must be a boolean.".to_string())?;
        }
        if let Some(value) = patch.last_library_location {
            if !valid_library_location(&value) {
                return Err("The last Library location is invalid.".into());
            }
            self.last_library_location = value;
        }
        Ok(())
    }
}

impl SettingsState {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let directory = app
            .path()
            .app_config_dir()
            .map_err(|_| "The application settings directory is unavailable.".to_string())?;
        let path = directory.join(SETTINGS_FILE_NAME);
        let settings = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(AppSettings::from_value)
                .unwrap_or_else(|_| AppSettings::defaults()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppSettings::defaults(),
            Err(_) => return Err("The application settings could not be read.".into()),
        };
        Ok(Self {
            path,
            settings: Mutex::new(settings),
        })
    }

    pub fn get(&self) -> Result<AppSettings, String> {
        self.settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "The application settings are unavailable.".to_string())
    }

    pub fn update(&self, patch: AppSettingsPatch) -> Result<AppSettings, String> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|_| "The application settings are unavailable.".to_string())?;
        let mut updated = guard.clone();
        updated.apply_patch(patch)?;
        write_atomic(&self.path, &updated)?;
        *guard = updated.clone();
        Ok(updated)
    }

    pub fn set_vault_root(&self, root: Option<&Path>) -> Result<AppSettings, String> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|_| "The application settings are unavailable.".to_string())?;
        let mut updated = guard.clone();
        updated.vault_root = root.map(|path| path.to_string_lossy().into_owned());
        write_atomic(&self.path, &updated)?;
        *guard = updated.clone();
        Ok(updated)
    }
}

pub fn apply_native_theme(app: &AppHandle, theme: &str) -> Result<(), String> {
    let theme = match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    app.set_theme(theme);
    Ok(())
}

#[tauri::command]
pub fn get_app_bootstrap(
    app: AppHandle,
    settings: tauri::State<'_, SettingsState>,
    runtime: tauri::State<'_, VaultRuntime>,
) -> Result<AppBootstrap, String> {
    let settings = settings.get()?;
    let resolved_startup_location = if settings.startup_location == "lastVisited" {
        settings.last_library_location.clone()
    } else {
        settings.startup_location.clone()
    };
    Ok(AppBootstrap {
        settings,
        resolved_startup_location,
        app_version: app.package_info().version.to_string(),
        default_vault_path: default_vault_root(&app)?.to_string_lossy().into_owned(),
        vault_availability: runtime.availability()?,
    })
}

#[tauri::command]
pub fn update_app_preferences(
    app: AppHandle,
    patch: AppSettingsPatch,
    settings: tauri::State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let previous = settings.get()?;
    let updated = settings.update(patch)?;
    if updated.theme != previous.theme {
        if let Err(error) = apply_native_theme(&app, &updated.theme) {
            let rollback = AppSettingsPatch {
                theme: Some(Value::String(previous.theme)),
                ..Default::default()
            };
            let _ = settings.update(rollback);
            return Err(error);
        }
    }
    Ok(updated)
}

#[tauri::command]
pub fn reset_window_layout(
    app: AppHandle,
    settings: tauri::State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main application window is unavailable.".to_string())?;
    window
        .set_fullscreen(false)
        .and_then(|_| window.unmaximize())
        .and_then(|_| window.set_size(Size::Logical(LogicalSize::new(1280.0, 832.0))))
        .and_then(|_| window.center())
        .map_err(|_| "The application window layout could not be reset.".to_string())?;
    let updated = settings.update(AppSettingsPatch {
        sidebar_width: Some(Value::from(240.0)),
        sidebar_collapsed: Some(Value::Bool(false)),
        ..Default::default()
    })?;
    app.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
        .map_err(|_| "The reset window layout could not be saved.".to_string())?;
    Ok(updated)
}

fn valid_choice(value: Option<&Value>, choices: &[&str]) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| choices.contains(value))
        .map(str::to_owned)
}

fn valid_location(value: &Value) -> bool {
    value == "lastVisited" || valid_library_location(value)
}

fn valid_library_location(value: &Value) -> bool {
    match value {
        Value::String(value) => matches!(value.as_str(), "all" | "favorites" | "archive"),
        Value::Object(value) => valid_location_object(value),
        _ => false,
    }
}

fn valid_location_object(value: &Map<String, Value>) -> bool {
    match value.get("kind").and_then(Value::as_str) {
        Some("space") => value
            .get("spaceId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        Some("label") => value
            .get("labelId")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        _ => false,
    }
}

fn write_atomic(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "The application settings path is invalid.".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|_| "The application settings directory could not be created.".to_string())?;
    let temporary_path = directory.join(format!(".{SETTINGS_FILE_NAME}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|_| "The application settings could not be encoded.".to_string())?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
            .map_err(|_| "The temporary settings file could not be created.".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|_| "The application settings could not be saved.".to_string())?;
        fs::rename(&temporary_path, path)
            .map_err(|_| "The application settings could not be replaced.".to_string())?;
        FileSync::sync_directory(directory);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

struct FileSync;

impl FileSync {
    fn sync_directory(directory: &Path) {
        if let Ok(file) = OpenOptions::new().read(true).open(directory) {
            let _ = file.sync_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_fields_default_independently_and_unknown_fields_are_ignored() {
        let settings = AppSettings::from_value(serde_json::json!({
            "theme": "sepia",
            "density": "compact",
            "sidebarWidth": 999,
            "sidebarCollapsed": true,
            "unknown": "ignored"
        }));
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.density, "compact");
        assert_eq!(settings.sidebar_width, 240.0);
        assert!(settings.sidebar_collapsed);
    }

    #[test]
    fn patches_preserve_unmentioned_fields() {
        let mut settings = AppSettings::defaults();
        settings
            .apply_patch(AppSettingsPatch {
                theme: Some(Value::String("dark".into())),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.density, "comfortable");
        assert_eq!(settings.sidebar_width, 240.0);
    }
}
