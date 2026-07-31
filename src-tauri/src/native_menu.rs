use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::menu::{
    AboutMetadata, CheckMenuItem, CheckMenuItemBuilder, IsMenuItem, Menu, MenuItem,
    MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

const MANIFEST_JSON: &str = include_str!("../../src/shared/app-command-manifest.json");
const SPACES_SUBMENU_ID: &str = "no8.spaces";
const SPACE_COMMAND_PREFIX: &str = "navigate.space.";

#[derive(Debug, Deserialize)]
struct ManifestDocument {
    commands: HashMap<String, ManifestCommand>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestCommand {
    title: String,
    command_menu_title: String,
    description: String,
    shortcut_category: String,
    shortcut_page_visible: bool,
    accelerator: Option<String>,
    shortcut_label: Option<String>,
    keywords: Vec<String>,
    group: String,
    order: u32,
    native_menu: Option<String>,
    command_menu_visible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PredefinedKind {
    About,
    Separator,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Zoom,
    BringAllToFront,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum MenuEntryModel {
    Command { id: &'static str, checked: bool },
    Predefined(PredefinedKind),
    Spaces,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubmenuModel {
    id: Option<&'static str>,
    title: &'static str,
    entries: Vec<MenuEntryModel>,
}

fn native_menu_model() -> Vec<SubmenuModel> {
    use MenuEntryModel::{Command, Predefined, Spaces};
    use PredefinedKind::*;

    vec![
        SubmenuModel {
            id: None,
            title: "No. 8",
            entries: vec![
                Predefined(About),
                Predefined(Separator),
                Command {
                    id: "navigate.settings",
                    checked: false,
                },
                Predefined(Separator),
                Predefined(Services),
                Predefined(Separator),
                Predefined(Hide),
                Predefined(HideOthers),
                Predefined(ShowAll),
                Predefined(Separator),
                Predefined(Quit),
            ],
        },
        SubmenuModel {
            id: None,
            title: "File",
            entries: vec![
                Command {
                    id: "media.add",
                    checked: false,
                },
                Command {
                    id: "link.add",
                    checked: false,
                },
                Command {
                    id: "space.create",
                    checked: false,
                },
                Predefined(Separator),
                Command {
                    id: "item.open",
                    checked: false,
                },
                Command {
                    id: "item.share",
                    checked: false,
                },
                Command {
                    id: "item.reveal",
                    checked: false,
                },
                Predefined(Separator),
                Predefined(CloseWindow),
            ],
        },
        SubmenuModel {
            id: None,
            title: "Edit",
            entries: vec![
                Predefined(Undo),
                Predefined(Redo),
                Predefined(Separator),
                Predefined(Cut),
                Predefined(Copy),
                Predefined(Paste),
                Predefined(SelectAll),
                Predefined(Separator),
                Command {
                    id: "item.favorite.toggle",
                    checked: false,
                },
                Command {
                    id: "item.rename",
                    checked: false,
                },
                Command {
                    id: "item.copy-image",
                    checked: false,
                },
                Command {
                    id: "item.archive.toggle",
                    checked: false,
                },
                Predefined(Separator),
                Command {
                    id: "item.delete",
                    checked: false,
                },
            ],
        },
        SubmenuModel {
            id: None,
            title: "View",
            entries: vec![
                Command {
                    id: "command-menu.toggle",
                    checked: false,
                },
                Predefined(Separator),
                Command {
                    id: "sidebar.toggle",
                    checked: true,
                },
                Predefined(Separator),
                Command {
                    id: "navigate.all",
                    checked: true,
                },
                Command {
                    id: "navigate.favorites",
                    checked: true,
                },
                Command {
                    id: "navigate.labels",
                    checked: true,
                },
                Command {
                    id: "navigate.archive",
                    checked: true,
                },
                Spaces,
                Predefined(Separator),
                Predefined(Fullscreen),
            ],
        },
        SubmenuModel {
            id: None,
            title: "Navigate",
            entries: vec![
                Command {
                    id: "navigate.back",
                    checked: false,
                },
                Command {
                    id: "navigate.forward",
                    checked: false,
                },
            ],
        },
        SubmenuModel {
            id: Some(WINDOW_SUBMENU_ID),
            title: "Window",
            entries: vec![
                Predefined(Minimize),
                Predefined(Zoom),
                Predefined(Separator),
                Predefined(BringAllToFront),
            ],
        },
    ]
}

fn accelerator_is_valid(accelerator: &str) -> bool {
    let parts = accelerator.split('+').collect::<Vec<_>>();
    if parts.len() < 2 {
        return false;
    }
    let mut modifiers = HashSet::new();
    if !parts[..parts.len() - 1].iter().all(|modifier| {
        matches!(
            *modifier,
            "CmdOrCtrl" | "Command" | "Ctrl" | "Alt" | "Option" | "Shift" | "Super"
        ) && modifiers.insert(*modifier)
    }) {
        return false;
    }
    let key = parts[parts.len() - 1];
    key.chars().count() == 1
        && key
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric() || "[],".contains(character))
}

fn parse_manifest() -> Result<ManifestDocument, String> {
    let manifest: ManifestDocument = serde_json::from_str(MANIFEST_JSON)
        .map_err(|error| format!("shared command manifest is invalid: {error}"))?;
    if manifest.commands.is_empty() {
        return Err("shared command manifest contains no commands".to_string());
    }

    let mut accelerators = HashSet::new();
    let mut group_orders = HashSet::new();
    for (id, command) in &manifest.commands {
        if id.trim().is_empty() || command.title.trim().is_empty() {
            return Err("command IDs and titles must not be empty".to_string());
        }
        if !matches!(command.group.as_str(), "actions" | "navigation") {
            return Err(format!("command {id} uses an unknown group"));
        }
        if command.order == 0 || !group_orders.insert((command.group.clone(), command.order)) {
            return Err(format!(
                "command {id} uses an invalid or duplicate group order"
            ));
        }
        if let Some(native_menu) = command.native_menu.as_deref() {
            if !matches!(native_menu, "app" | "file" | "edit" | "view" | "navigate") {
                return Err(format!("command {id} uses an unknown native menu"));
            }
        }
        if let Some(accelerator) = command.accelerator.as_deref() {
            if !accelerator_is_valid(accelerator) {
                return Err(format!("command {id} uses an invalid native accelerator"));
            }
            if !accelerators.insert(accelerator.to_string()) {
                return Err(format!("command {id} duplicates a native accelerator"));
            }
        }
        if command.command_menu_title.trim().is_empty()
            || command.description.trim().is_empty()
            || !matches!(
                command.shortcut_category.as_str(),
                "Actions" | "Navigation" | "Items" | "Organization" | "Window"
            )
            || command.keywords.is_empty()
            || (command.command_menu_visible && command.shortcut_label == Some(String::new()))
            || (command.shortcut_page_visible && command.shortcut_label == Some(String::new()))
        {
            return Err(format!("command {id} has incomplete Command Menu metadata"));
        }
    }

    let mut modeled_commands = HashSet::new();
    for submenu in native_menu_model() {
        let expected_placement = match submenu.title {
            "No. 8" => Some("app"),
            "File" => Some("file"),
            "Edit" => Some("edit"),
            "View" => Some("view"),
            "Navigate" => Some("navigate"),
            _ => None,
        };
        for entry in submenu.entries {
            if let MenuEntryModel::Command { id, .. } = entry {
                let command = manifest.commands.get(id).ok_or_else(|| {
                    format!("native menu command {id} is missing from the manifest")
                })?;
                if command.native_menu.as_deref() != expected_placement {
                    return Err(format!(
                        "native menu command {id} has the wrong native placement"
                    ));
                }
                modeled_commands.insert(id);
            }
        }
    }
    for (id, command) in &manifest.commands {
        if command.native_menu.is_some() && !modeled_commands.contains(id.as_str()) {
            return Err(format!(
                "manifest command {id} has native placement but no native menu item"
            ));
        }
    }

    Ok(manifest)
}

#[derive(Default)]
struct MenuBuildState {
    normal_items: HashMap<String, MenuItem<Wry>>,
    check_items: HashMap<String, CheckMenuItem<Wry>>,
    spaces_submenu: Option<Submenu<Wry>>,
    static_event_ids: HashSet<String>,
}

#[derive(Default)]
struct DynamicSpacesState {
    signature: Vec<(String, String)>,
    items: HashMap<String, CheckMenuItem<Wry>>,
}

pub struct NativeMenuState {
    normal_items: HashMap<String, MenuItem<Wry>>,
    check_items: HashMap<String, CheckMenuItem<Wry>>,
    spaces_submenu: Submenu<Wry>,
    static_event_ids: HashSet<String>,
    allowed_titles: HashMap<String, HashSet<String>>,
    dynamic_spaces: Mutex<DynamicSpacesState>,
    sync_lock: Mutex<()>,
}

fn menu_error(message: impl Into<String>) -> tauri::Error {
    std::io::Error::other(message.into()).into()
}

fn build_command_item(
    app: &AppHandle<Wry>,
    manifest: &ManifestDocument,
    build_state: &mut MenuBuildState,
    id: &str,
    checked: bool,
) -> tauri::Result<MenuItemKind<Wry>> {
    let command = manifest
        .commands
        .get(id)
        .ok_or_else(|| menu_error(format!("native menu command {id} is missing")))?;

    build_state.static_event_ids.insert(id.to_string());
    if checked {
        let mut builder = CheckMenuItemBuilder::with_id(id, &command.title)
            .enabled(false)
            .checked(false);
        if let Some(accelerator) = command.accelerator.as_deref() {
            builder = builder.accelerator(accelerator);
        }
        let item = builder.build(app)?;
        build_state.check_items.insert(id.to_string(), item.clone());
        Ok(item.kind())
    } else {
        let mut builder = MenuItemBuilder::with_id(id, &command.title).enabled(false);
        if let Some(accelerator) = command.accelerator.as_deref() {
            builder = builder.accelerator(accelerator);
        }
        let item = builder.build(app)?;
        build_state
            .normal_items
            .insert(id.to_string(), item.clone());
        Ok(item.kind())
    }
}

fn build_predefined_item(
    app: &AppHandle<Wry>,
    kind: PredefinedKind,
) -> tauri::Result<PredefinedMenuItem<Wry>> {
    let app_name = app.package_info().name.clone();
    match kind {
        PredefinedKind::About => {
            let text = format!("About {app_name}");
            PredefinedMenuItem::about(
                app,
                Some(&text),
                Some(AboutMetadata {
                    name: Some(app_name),
                    version: Some(app.package_info().version.to_string()),
                    icon: app.default_window_icon().cloned(),
                    ..Default::default()
                }),
            )
        }
        PredefinedKind::Separator => PredefinedMenuItem::separator(app),
        PredefinedKind::Services => PredefinedMenuItem::services(app, None),
        PredefinedKind::Hide => {
            let text = format!("Hide {app_name}");
            PredefinedMenuItem::hide(app, Some(&text))
        }
        PredefinedKind::HideOthers => PredefinedMenuItem::hide_others(app, None),
        PredefinedKind::ShowAll => PredefinedMenuItem::show_all(app, None),
        PredefinedKind::Quit => {
            let text = format!("Quit {app_name}");
            PredefinedMenuItem::quit(app, Some(&text))
        }
        PredefinedKind::CloseWindow => PredefinedMenuItem::close_window(app, None),
        PredefinedKind::Undo => PredefinedMenuItem::undo(app, None),
        PredefinedKind::Redo => PredefinedMenuItem::redo(app, None),
        PredefinedKind::Cut => PredefinedMenuItem::cut(app, None),
        PredefinedKind::Copy => PredefinedMenuItem::copy(app, None),
        PredefinedKind::Paste => PredefinedMenuItem::paste(app, None),
        PredefinedKind::SelectAll => PredefinedMenuItem::select_all(app, None),
        PredefinedKind::Fullscreen => {
            PredefinedMenuItem::fullscreen(app, Some("Enter Full Screen"))
        }
        PredefinedKind::Minimize => PredefinedMenuItem::minimize(app, None),
        PredefinedKind::Zoom => PredefinedMenuItem::maximize(app, None),
        PredefinedKind::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, None),
    }
}

fn build_submenu(
    app: &AppHandle<Wry>,
    manifest: &ManifestDocument,
    build_state: &mut MenuBuildState,
    model: SubmenuModel,
) -> tauri::Result<Submenu<Wry>> {
    let submenu = match model.id {
        Some(id) => SubmenuBuilder::with_id(app, id, model.title).build()?,
        None => SubmenuBuilder::new(app, model.title).build()?,
    };

    for entry in model.entries {
        match entry {
            MenuEntryModel::Command { id, checked } => {
                let item = build_command_item(app, manifest, build_state, id, checked)?;
                submenu.append(&item)?;
            }
            MenuEntryModel::Predefined(kind) => {
                submenu.append(&build_predefined_item(app, kind)?)?;
            }
            MenuEntryModel::Spaces => {
                let spaces = SubmenuBuilder::with_id(app, SPACES_SUBMENU_ID, "Spaces")
                    .enabled(false)
                    .build()?;
                submenu.append(&spaces)?;
                build_state.spaces_submenu = Some(spaces);
            }
        }
    }
    Ok(submenu)
}

pub fn build_native_menu(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let manifest = parse_manifest().map_err(menu_error)?;
    let mut build_state = MenuBuildState::default();
    let menu = Menu::new(app)?;
    for submenu_model in native_menu_model() {
        let submenu = build_submenu(app, &manifest, &mut build_state, submenu_model)?;
        menu.append(&submenu)?;
    }

    let mut allowed_titles = manifest
        .commands
        .iter()
        .map(|(id, command)| (id.clone(), HashSet::from([command.title.clone()])))
        .collect::<HashMap<_, _>>();
    allowed_titles
        .entry("item.favorite.toggle".to_string())
        .or_default()
        .insert("Remove from Favorites".to_string());
    allowed_titles
        .entry("item.archive.toggle".to_string())
        .or_default()
        .insert("Restore".to_string());

    let state = NativeMenuState {
        normal_items: build_state.normal_items,
        check_items: build_state.check_items,
        spaces_submenu: build_state
            .spaces_submenu
            .ok_or_else(|| menu_error("native Spaces submenu was not created"))?,
        static_event_ids: build_state.static_event_ids,
        allowed_titles,
        dynamic_spaces: Mutex::new(DynamicSpacesState::default()),
        sync_lock: Mutex::new(()),
    };
    if !app.manage(state) {
        return Err(menu_error("native menu state was already initialized"));
    }
    Ok(menu)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMenuCommandState {
    id: String,
    enabled: Option<bool>,
    checked: Option<bool>,
    title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NativeSpaceState {
    id: String,
    name: String,
    active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMenuStatePayload {
    commands: Vec<NativeMenuCommandState>,
    spaces_enabled: bool,
    spaces: Vec<NativeSpaceState>,
}

fn validate_command_ids(
    known_ids: &HashSet<String>,
    commands: &[NativeMenuCommandState],
) -> Result<(), String> {
    let mut command_ids = HashSet::new();
    for command in commands {
        if !command_ids.insert(command.id.clone()) || !known_ids.contains(&command.id) {
            return Err(format!(
                "unknown or duplicate native menu command: {}",
                command.id
            ));
        }
    }
    if command_ids != *known_ids {
        return Err("native menu state payload is missing static commands".to_string());
    }
    Ok(())
}

fn validate_spaces(spaces: &[NativeSpaceState]) -> Result<(), String> {
    let mut space_ids = HashSet::new();
    let mut active_count = 0;
    for space in spaces {
        if space.id.is_empty()
            || space.id.len() > 128
            || !space.id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
            || !space_ids.insert(&space.id)
        {
            return Err("native menu Spaces contain an invalid or duplicate ID".to_string());
        }
        if space.name.trim().is_empty() || space.name.chars().count() > 256 {
            return Err("native menu Spaces contain an invalid name".to_string());
        }
        active_count += usize::from(space.active);
    }
    if active_count > 1 {
        return Err("native menu Spaces contain multiple active destinations".to_string());
    }
    Ok(())
}

fn dynamic_space_menu_model(
    spaces: &[NativeSpaceState],
) -> Result<Vec<(String, String, bool)>, String> {
    validate_spaces(spaces)?;
    Ok(spaces
        .iter()
        .map(|space| {
            (
                format!("{SPACE_COMMAND_PREFIX}{}", space.id),
                space.name.clone(),
                space.active,
            )
        })
        .collect())
}

fn validate_state_payload(
    state: &NativeMenuState,
    payload: &NativeMenuStatePayload,
) -> Result<(), String> {
    validate_command_ids(&state.static_event_ids, &payload.commands)?;
    for command in &payload.commands {
        if command.checked.is_some() && !state.check_items.contains_key(&command.id) {
            return Err(format!(
                "command {} does not support checked state",
                command.id
            ));
        }
        if let Some(title) = command.title.as_deref() {
            if !state
                .allowed_titles
                .get(&command.id)
                .is_some_and(|titles| titles.contains(title))
            {
                return Err(format!("command {} uses an unsupported title", command.id));
            }
        }
    }

    validate_spaces(&payload.spaces)
}

fn rebuild_spaces(
    app: &AppHandle<Wry>,
    state: &NativeMenuState,
    spaces: &[NativeSpaceState],
    enabled: bool,
) -> Result<(), String> {
    let model = dynamic_space_menu_model(spaces)?;
    let signature = spaces
        .iter()
        .map(|space| (space.id.clone(), space.name.clone()))
        .collect::<Vec<_>>();
    let rebuild = state
        .dynamic_spaces
        .lock()
        .map_err(|_| "native Space state lock is unavailable".to_string())?
        .signature
        != signature;

    if rebuild {
        let mut items = HashMap::new();
        let ordered_items = model
            .iter()
            .map(|(id, name, active)| {
                let item = CheckMenuItemBuilder::with_id(id, name)
                    .enabled(enabled)
                    .checked(*active)
                    .build(app)
                    .map_err(|error| error.to_string())?;
                items.insert(id.clone(), item.clone());
                Ok(item)
            })
            .collect::<Result<Vec<_>, String>>()?;

        let child_count = state
            .spaces_submenu
            .items()
            .map_err(|error| error.to_string())?
            .len();
        for _ in 0..child_count {
            state
                .spaces_submenu
                .remove_at(0)
                .map_err(|error| error.to_string())?;
        }
        for item in &ordered_items {
            state
                .spaces_submenu
                .append(item)
                .map_err(|error| error.to_string())?;
        }
        state
            .spaces_submenu
            .set_enabled(enabled && !spaces.is_empty())
            .map_err(|error| error.to_string())?;
        *state
            .dynamic_spaces
            .lock()
            .map_err(|_| "native Space state lock is unavailable".to_string())? =
            DynamicSpacesState { signature, items };
    } else {
        let items = state
            .dynamic_spaces
            .lock()
            .map_err(|_| "native Space state lock is unavailable".to_string())?
            .items
            .clone();
        for space in spaces {
            let id = format!("{SPACE_COMMAND_PREFIX}{}", space.id);
            let item = items
                .get(&id)
                .ok_or_else(|| "native Space item is unavailable".to_string())?;
            item.set_checked(space.active)
                .map_err(|error| error.to_string())?;
            item.set_enabled(enabled)
                .map_err(|error| error.to_string())?;
        }
        state
            .spaces_submenu
            .set_enabled(enabled && !spaces.is_empty())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn sync_native_menu_state(
    app: AppHandle<Wry>,
    state: State<'_, NativeMenuState>,
    payload: NativeMenuStatePayload,
) -> Result<(), String> {
    validate_state_payload(&state, &payload)?;
    let _sync_guard = state
        .sync_lock
        .lock()
        .map_err(|_| "native menu synchronization lock is unavailable".to_string())?;

    for command in &payload.commands {
        if let Some(item) = state.normal_items.get(&command.id) {
            if let Some(enabled) = command.enabled {
                item.set_enabled(enabled)
                    .map_err(|error| error.to_string())?;
            }
            if let Some(title) = command.title.as_deref() {
                item.set_text(title).map_err(|error| error.to_string())?;
            }
        } else if let Some(item) = state.check_items.get(&command.id) {
            if let Some(enabled) = command.enabled {
                item.set_enabled(enabled)
                    .map_err(|error| error.to_string())?;
            }
            if let Some(checked) = command.checked {
                item.set_checked(checked)
                    .map_err(|error| error.to_string())?;
            }
            if let Some(title) = command.title.as_deref() {
                item.set_text(title).map_err(|error| error.to_string())?;
            }
        }
    }
    rebuild_spaces(&app, &state, &payload.spaces, payload.spaces_enabled)
}

#[derive(Clone, Serialize)]
struct NativeCommandEventPayload {
    id: String,
}

pub fn handle_menu_event(app: &AppHandle<Wry>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    let Some(state) = app.try_state::<NativeMenuState>() else {
        return;
    };
    let known_static = state.static_event_ids.contains(id);
    let known_space = state
        .dynamic_spaces
        .lock()
        .is_ok_and(|spaces| spaces.items.contains_key(id));
    if !known_static && !known_space {
        return;
    }

    let Some(window) = app.get_webview_window("main") else {
        #[cfg(debug_assertions)]
        eprintln!("No. 8 ignored menu command {id}: main window is unavailable");
        return;
    };
    let result = window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .and_then(|_| {
            window.emit(
                "no8://app-command",
                NativeCommandEventPayload { id: id.into() },
            )
        });
    if let Err(error) = result {
        #[cfg(debug_assertions)]
        eprintln!("No. 8 could not deliver menu command {id}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_and_native_model_are_valid() {
        let manifest = parse_manifest().expect("manifest should parse");
        assert!(manifest.commands.contains_key("media.add"));
        assert!(manifest.commands.contains_key("item.delete"));
        assert!(!manifest.commands.contains_key("navigate.space.personal"));
    }

    #[test]
    fn top_level_menu_order_and_window_identifier_are_stable() {
        let model = native_menu_model();
        assert_eq!(
            model
                .iter()
                .map(|submenu| submenu.title)
                .collect::<Vec<_>>(),
            ["No. 8", "File", "Edit", "View", "Navigate", "Window"]
        );
        assert_eq!(
            model.last().and_then(|submenu| submenu.id),
            Some(WINDOW_SUBMENU_ID)
        );
    }

    #[test]
    fn predefined_text_editing_and_window_commands_keep_native_placement() {
        let model = native_menu_model();
        let edit = model
            .iter()
            .find(|submenu| submenu.title == "Edit")
            .unwrap();
        assert_eq!(
            &edit.entries[..7],
            &[
                MenuEntryModel::Predefined(PredefinedKind::Undo),
                MenuEntryModel::Predefined(PredefinedKind::Redo),
                MenuEntryModel::Predefined(PredefinedKind::Separator),
                MenuEntryModel::Predefined(PredefinedKind::Cut),
                MenuEntryModel::Predefined(PredefinedKind::Copy),
                MenuEntryModel::Predefined(PredefinedKind::Paste),
                MenuEntryModel::Predefined(PredefinedKind::SelectAll),
            ]
        );
        let window = model
            .iter()
            .find(|submenu| submenu.title == "Window")
            .unwrap();
        assert!(window
            .entries
            .contains(&MenuEntryModel::Predefined(PredefinedKind::Zoom)));
    }

    #[test]
    fn every_custom_native_item_uses_a_manifest_id() {
        let manifest = parse_manifest().unwrap();
        for submenu in native_menu_model() {
            for entry in submenu.entries {
                if let MenuEntryModel::Command { id, .. } = entry {
                    assert!(manifest.commands.contains_key(id), "unknown command {id}");
                }
            }
        }
    }

    #[test]
    fn manifest_accelerators_use_the_supported_native_syntax() {
        let manifest = parse_manifest().unwrap();
        for command in manifest.commands.values() {
            if let Some(accelerator) = command.accelerator.as_deref() {
                assert!(accelerator_is_valid(accelerator), "{accelerator}");
            }
        }
        assert!(!accelerator_is_valid("Command"));
        assert!(!accelerator_is_valid("CmdOrCtrl+Shift+"));
        assert!(!accelerator_is_valid("CmdOrCtrl+Unknown+K"));
    }

    #[test]
    fn dynamic_space_model_preserves_order_and_constructs_stable_ids() {
        let spaces = vec![
            NativeSpaceState {
                id: "work".into(),
                name: "Work".into(),
                active: false,
            },
            NativeSpaceState {
                id: "ideas-2".into(),
                name: "Ideas".into(),
                active: true,
            },
        ];
        assert_eq!(
            dynamic_space_menu_model(&spaces).unwrap(),
            [
                ("navigate.space.work".into(), "Work".into(), false),
                ("navigate.space.ideas-2".into(), "Ideas".into(), true),
            ]
        );
    }

    #[test]
    fn dynamic_space_validation_rejects_arbitrary_or_ambiguous_records() {
        assert!(validate_spaces(&[NativeSpaceState {
            id: "../../menu".into(),
            name: "Bad".into(),
            active: false,
        }])
        .is_err());
        assert!(validate_spaces(&[
            NativeSpaceState {
                id: "one".into(),
                name: "One".into(),
                active: true,
            },
            NativeSpaceState {
                id: "two".into(),
                name: "Two".into(),
                active: true,
            },
        ])
        .is_err());
    }

    #[test]
    fn state_command_validation_rejects_unknown_partial_and_duplicate_ids() {
        let known = HashSet::from(["media.add".to_string(), "link.add".to_string()]);
        let command = |id: &str| NativeMenuCommandState {
            id: id.into(),
            enabled: Some(true),
            checked: None,
            title: None,
        };
        assert!(validate_command_ids(&known, &[command("media.add"), command("link.add")]).is_ok());
        assert!(validate_command_ids(&known, &[command("media.add")]).is_err());
        assert!(validate_command_ids(&known, &[command("media.add"), command("unknown")]).is_err());
        assert!(
            validate_command_ids(&known, &[command("media.add"), command("media.add")]).is_err()
        );
    }
}
