use crate::vault::{VaultAccess, VaultRuntime};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat, ImageReader, Limits};
use reqwest::{
    blocking::{Client, Response},
    header::{CONTENT_TYPE, LOCATION},
    redirect::Policy,
};
use rusqlite::{params, Connection, OptionalExtension};
use scraper::{Html, Selector};
use serde::Serialize;
use std::{
    collections::HashSet,
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Cursor, Read},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::{ClipboardExt, Error as ClipboardError};
use tauri_plugin_opener::OpenerExt;
use url::{Host, ParseError, Url};
use uuid::Uuid;

const SUPPORTED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
#[cfg(test)]
const VAULT_DIRECTORY_NAME: &str = "No. 8 Vault";
const LIBRARY_DIRECTORY_NAME: &str = "Library";
const DATABASE_DIRECTORY_NAME: &str = ".no8";
const DATABASE_FILE_NAME: &str = "no8.sqlite";
const LINK_ASSETS_DIRECTORY_NAME: &str = "assets/links";
const LINK_PREVIEW_CACHE_DIRECTORY_NAME: &str = "cache/link-previews";
const DATABASE_SCHEMA_VERSION: i64 = 5;
const PERSONAL_SPACE_ID: &str = "space-personal";
const PASTED_IMAGE_FILE_NAME: &str = "Pasted Image.png";
const MAX_REDIRECTS: usize = 5;
const MAX_HTML_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMAGE_ALLOCATION: u64 = 128 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "no8/0.1";
const MAX_RECENT_ITEMS: usize = 5;
const MAX_SEARCH_ITEMS: usize = 30;
const MAX_LABEL_NAME_LENGTH: usize = 80;
const CLIPBOARD_CONTENT_NOT_AVAILABLE: &str =
    "The clipboard contents were not available in the requested format or the clipboard is empty.";
static ACTIVE_LINK_REFRESHES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static COPY_IMAGE_WRITES: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

const COLOR_KEYS: [&str; 13] = [
    "gray", "red", "orange", "yellow", "green", "mint", "teal", "cyan", "blue", "indigo", "purple",
    "pink", "brown",
];
const SPACE_ICON_KEYS: [&str; 12] = [
    "heart",
    "flower",
    "brain",
    "folder",
    "pencil",
    "popcorn",
    "square-terminal",
    "mouse-pointer-click",
    "sparkles",
    "target",
    "tool-case",
    "vault",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    id: String,
    item_type: String,
    title: String,
    file_name: Option<String>,
    stored_path: Option<String>,
    url: Option<String>,
    preview_path: Option<String>,
    favicon_path: Option<String>,
    metadata_status: Option<String>,
    created_at_ms: i64,
    modified_at_ms: Option<i64>,
    archived_at_ms: Option<i64>,
    is_favorite: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    id: String,
    name: String,
    color_key: String,
    icon_key: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    id: String,
    name: String,
    color_key: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    source_file_name: Option<String>,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportImageFilesResult {
    imported: Vec<LibraryItem>,
    failed: Vec<ImportFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLibraryItemsResult {
    items: Vec<LibraryItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLibraryItemResult {
    deleted: bool,
    cleanup_warning: Option<String>,
}

#[derive(Clone, Debug)]
struct LibraryPaths {
    vault_directory: PathBuf,
    library_directory: PathBuf,
    database_directory: PathBuf,
    database_path: PathBuf,
    link_assets_directory: PathBuf,
    link_preview_cache_directory: PathBuf,
}

struct LibraryStore {
    paths: LibraryPaths,
    connection: Connection,
}

#[derive(Clone, Debug)]
struct DatabaseItem {
    id: String,
    item_type: String,
    title: String,
    relative_path: Option<String>,
    url: Option<String>,
    preview_relative_path: Option<String>,
    favicon_relative_path: Option<String>,
    metadata_status: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    archived_at_ms: Option<i64>,
    is_favorite: bool,
}

#[derive(Clone, Copy)]
enum LibraryQuery {
    Active,
    Favorites,
    Archived,
}

enum LibraryOpenTarget {
    Image(PathBuf),
    Link(String),
}

enum ShareTarget {
    Image(PathBuf),
    Link(String),
}

#[derive(Debug)]
struct PageMetadata {
    title: String,
    preview_url: Option<Url>,
    favicon_url: Option<Url>,
}

struct RefreshGuard {
    id: String,
}

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = active_link_refreshes().lock() {
            active.remove(&self.id);
        }
    }
}

#[tauri::command]
pub async fn import_clipboard_item(
    app: AppHandle,
    active_space_id: Option<String>,
) -> Result<Option<LibraryItem>, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        let clipboard = app.clipboard();
        match clipboard.read_image() {
            Ok(image) => {
                return save_clipboard_png(
                    &store,
                    image.rgba(),
                    image.width(),
                    image.height(),
                    active_space_id.as_deref(),
                )
                .map(Some)
            }
            Err(error) if is_clipboard_content_unavailable(&error) => {}
            Err(_) => return Err("The clipboard image could not be read.".to_string()),
        }

        match clipboard.read_text() {
            Ok(text) => {
                create_link_item_from_clipboard_text(&store, &text, active_space_id.as_deref())
            }
            Err(error) if is_clipboard_content_unavailable(&error) => Ok(None),
            Err(_) => Err("The clipboard text could not be read.".to_string()),
        }
    })
    .await
    .map_err(|_| "The clipboard import task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn import_image_files(
    app: AppHandle,
    paths: Vec<String>,
    active_space_id: Option<String>,
) -> Result<ImportImageFilesResult, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        import_files(&store, paths, active_space_id.as_deref())
    })
    .await
    .map_err(|_| "The image import task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn list_library_items(
    app: AppHandle,
    archived: bool,
) -> Result<ListLibraryItemsResult, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open_active(&documents_directory)?;
        reconcile_library(&mut store)?;
        let query = if archived {
            LibraryQuery::Archived
        } else {
            LibraryQuery::Active
        };
        let items = query_library_items(&store.connection, &store.paths, query)?;

        Ok(ListLibraryItemsResult { items })
    })
    .await
    .map_err(|_| "The library could not be read.".to_string())?
}

#[tauri::command]
pub async fn list_favorite_items(app: AppHandle) -> Result<ListLibraryItemsResult, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open_active(&documents_directory)?;
        reconcile_library(&mut store)?;
        let items = query_library_items(&store.connection, &store.paths, LibraryQuery::Favorites)?;

        Ok(ListLibraryItemsResult { items })
    })
    .await
    .map_err(|_| "The favorites could not be read.".to_string())?
}

#[tauri::command]
pub async fn list_recent_items(
    app: AppHandle,
    limit: usize,
) -> Result<ListLibraryItemsResult, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open_active(&documents_directory)?;
        reconcile_library(&mut store)?;
        let items = query_recent_items(&store.connection, &store.paths, limit)?;
        Ok(ListLibraryItemsResult { items })
    })
    .await
    .map_err(|_| "The recent library items could not be read.".to_string())?
}

#[tauri::command]
pub async fn search_items(
    app: AppHandle,
    query: String,
    limit: usize,
) -> Result<ListLibraryItemsResult, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open_active(&documents_directory)?;
        reconcile_library(&mut store)?;
        let items = query_search_items(&store.connection, &store.paths, &query, limit)?;
        Ok(ListLibraryItemsResult { items })
    })
    .await
    .map_err(|_| "The library search could not be completed.".to_string())?
}

#[tauri::command]
pub async fn create_link(
    app: AppHandle,
    url: String,
    active_space_id: Option<String>,
) -> Result<LibraryItem, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        create_link_item(&store, &url, active_space_id.as_deref())
    })
    .await
    .map_err(|_| "The link creation task could not be completed.".to_string())?
}

#[tauri::command]
pub fn normalize_link_url(value: String) -> Result<String, String> {
    parse_normalized_link_url(&value).map(|url| url.into())
}

#[tauri::command]
pub async fn preview_link_metadata(app: AppHandle, url: String) -> Result<Option<String>, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        preview_link_metadata_file(&store, &url)
    })
    .await
    .map_err(|_| "The link preview task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn refresh_link_metadata(app: AppHandle, id: String) -> Result<LibraryItem, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        refresh_link_item(&store, &id)
    })
    .await
    .map_err(|_| "The link metadata task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn rename_library_item(
    app: AppHandle,
    id: String,
    title: String,
) -> Result<LibraryItem, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open_active(&documents_directory)?;
        rename_stored_item(&mut store, &id, &title)
    })
    .await
    .map_err(|_| "The rename task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn set_library_item_archived(
    app: AppHandle,
    id: String,
    archived: bool,
) -> Result<LibraryItem, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        set_stored_item_archived(&store, &id, archived)
    })
    .await
    .map_err(|_| "The archive task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn set_library_item_favorite(
    app: AppHandle,
    id: String,
    is_favorite: bool,
) -> Result<LibraryItem, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        set_stored_item_favorite(&store, &id, is_favorite)
    })
    .await
    .map_err(|_| "The favorite task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn open_library_item(app: AppHandle, id: String) -> Result<(), String> {
    let documents_directory = documents_directory_path(&app)?;
    let target = tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        library_open_target(&store, &id)
    })
    .await
    .map_err(|_| "The open task could not be completed.".to_string())??;

    match target {
        LibraryOpenTarget::Image(path) => app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|_| "The image could not be opened.".to_string()),
        LibraryOpenTarget::Link(url) => app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "The link could not be opened.".to_string()),
    }
}

#[tauri::command]
pub async fn reveal_library_image(app: AppHandle, id: String) -> Result<(), String> {
    let documents_directory = documents_directory_path(&app)?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        stored_image_path(&store, &id)
    })
    .await
    .map_err(|_| "The reveal task could not be completed.".to_string())??;

    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|_| "The image could not be revealed in Finder.".to_string())
}

#[tauri::command]
pub async fn copy_library_image(app: AppHandle, id: String) -> Result<(), String> {
    let documents_directory = documents_directory_path(&app)?;
    let _write_guard = COPY_IMAGE_WRITES
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        let path = stored_image_path(&store, &id)?;
        let decoded = ImageReader::open(&path)
            .map_err(|_| "The image could not be opened for copying.".to_string())?
            .with_guessed_format()
            .map_err(|_| "The image format could not be read.".to_string())?
            .decode()
            .map_err(|_| "The image could not be decoded for copying.".to_string())?
            .to_rgba8();
        let (width, height) = decoded.dimensions();
        let image = tauri::image::Image::new_owned(decoded.into_raw(), width, height);
        let clipboard = app.clipboard();
        clipboard
            .clear()
            .map_err(|_| "The clipboard could not be cleared.".to_string())?;
        clipboard
            .write_image(&image)
            .map_err(|_| "The image could not be copied.".to_string())
    })
    .await
    .map_err(|_| "The copy task could not be completed.".to_string())?
}

#[tauri::command]
pub fn native_share_available() -> bool {
    cfg!(target_os = "macos")
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn share_item(_app: AppHandle, _item_id: String) -> Result<(), String> {
    Err("Share is unavailable on this platform.".to_string())
}

#[cfg(target_os = "macos")]
thread_local! {
    static ACTIVE_SHARE_PICKER: std::cell::RefCell<
        Option<objc2::rc::Retained<objc2_app_kit::NSSharingServicePicker>>
    > = const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn share_item(app: AppHandle, item_id: String) -> Result<(), String> {
    use objc2::{runtime::AnyObject, AnyThread};
    use objc2_app_kit::{NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSRectEdge, NSString, NSURL};

    let documents_directory = documents_directory_path(&app)?;
    let target = tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        let item = query_database_item_by_id(&store.connection, &item_id)?
            .ok_or_else(|| "The item could not be found.".to_string())?;
        match item.item_type.as_str() {
            "image" => validated_existing_image_path(&store.paths, &item).map(ShareTarget::Image),
            "link" => item
                .url
                .as_deref()
                .ok_or_else(|| "The Link URL is missing.".to_string())
                .and_then(parse_normalized_link_url)
                .map(|url| ShareTarget::Link(url.into())),
            _ => Err("The item cannot be shared.".to_string()),
        }
    })
    .await
    .map_err(|_| "The Share Sheet could not be prepared.".to_string())??;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    let view_address = window
        .ns_view()
        .map_err(|_| "The Share Sheet anchor is unavailable.".to_string())?
        as usize;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = (|| {
            let (value, is_file) = match &target {
                ShareTarget::Image(path) => (path.to_string_lossy().into_owned(), true),
                ShareTarget::Link(url) => (url.clone(), false),
            };
            let string = NSString::from_str(&value);
            let url = if is_file {
                NSURL::fileURLWithPath(&string)
            } else {
                NSURL::URLWithString(&string)
                    .ok_or_else(|| "The Link URL could not be shared.".to_string())?
            };
            let items = NSArray::<AnyObject>::from_slice(&[&*url]);
            let picker = unsafe {
                NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items)
            };
            let view = unsafe { &*(view_address as *const NSView) };
            picker.showRelativeToRect_ofView_preferredEdge(view.bounds(), view, NSRectEdge::MinY);
            ACTIVE_SHARE_PICKER.with(|active| {
                if let Some(previous) = active.replace(Some(picker)) {
                    previous.close();
                }
            });
            Ok(())
        })();
        let _ = sender.send(result);
    })
    .map_err(|_| "The Share Sheet could not be shown.".to_string())?;
    receiver
        .recv()
        .map_err(|_| "The Share Sheet could not be shown.".to_string())?
}

#[tauri::command]
pub async fn delete_library_item(
    app: AppHandle,
    id: String,
) -> Result<DeleteLibraryItemResult, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open_active(&documents_directory)?;
        delete_stored_item(&mut store, &id)
    })
    .await
    .map_err(|_| "The delete task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn list_spaces(app: AppHandle) -> Result<Vec<Space>, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        query_spaces(&store.connection, None)
    })
    .await
    .map_err(|_| "The Spaces could not be read.".to_string())?
}

#[tauri::command]
pub async fn create_space(
    app: AppHandle,
    name: String,
    color_key: String,
    icon_key: String,
) -> Result<Space, String> {
    create_space_command(app, name, color_key, icon_key, None).await
}

#[tauri::command]
pub async fn create_space_and_assign(
    app: AppHandle,
    name: String,
    color_key: String,
    icon_key: String,
    item_id: String,
) -> Result<Space, String> {
    create_space_command(app, name, color_key, icon_key, Some(item_id)).await
}

#[tauri::command]
pub async fn update_space(
    app: AppHandle,
    id: String,
    name: String,
    color_key: String,
    icon_key: String,
) -> Result<Space, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        update_space_record(&store.connection, &id, &name, &color_key, &icon_key)
    })
    .await
    .map_err(|_| "The Space could not be updated.".to_string())?
}

#[tauri::command]
pub async fn delete_space(app: AppHandle, id: String) -> Result<bool, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        delete_space_record(&store.connection, &id)
    })
    .await
    .map_err(|_| "The Space could not be deleted.".to_string())?
}

async fn create_space_command(
    app: AppHandle,
    name: String,
    color_key: String,
    icon_key: String,
    item_id: Option<String>,
) -> Result<Space, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        create_space_record(
            &store.connection,
            &name,
            &color_key,
            &icon_key,
            item_id.as_deref(),
        )
    })
    .await
    .map_err(|_| "The Space could not be created.".to_string())?
}

#[tauri::command]
pub async fn list_items_for_space(
    app: AppHandle,
    space_id: String,
) -> Result<ListLibraryItemsResult, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open_active(&documents_directory)?;
        reconcile_library(&mut store)?;
        require_record(&store.connection, "spaces", &space_id, "Space")?;
        let mut statement = store
            .connection
            .prepare(
                "SELECT items.id, items.item_type, items.title, items.relative_path, items.url,
                        items.preview_relative_path, items.favicon_relative_path,
                        items.metadata_status, items.created_at_ms, items.updated_at_ms,
                        items.archived_at_ms, items.is_favorite
                 FROM items
                 JOIN item_spaces ON item_spaces.item_id = items.id
                 WHERE item_spaces.space_id = ?1 AND items.archived_at_ms IS NULL
                 ORDER BY items.created_at_ms DESC, COALESCE(items.relative_path, items.url) ASC",
            )
            .map_err(|_| "The Space items could not be read.".to_string())?;
        let rows = statement
            .query_map([space_id], database_item_from_row)
            .map_err(|_| "The Space items could not be read.".to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(library_item_from_database(
                &store.paths,
                row.map_err(|_| "A Space item could not be read.".to_string())?,
            )?);
        }
        Ok(ListLibraryItemsResult { items })
    })
    .await
    .map_err(|_| "The Space items could not be read.".to_string())?
}

#[tauri::command]
pub async fn list_spaces_for_item(app: AppHandle, item_id: String) -> Result<Vec<Space>, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        require_record(&store.connection, "items", &item_id, "item")?;
        query_spaces(&store.connection, Some(&item_id))
    })
    .await
    .map_err(|_| "The item Spaces could not be read.".to_string())?
}

#[tauri::command]
pub async fn set_item_space_membership(
    app: AppHandle,
    item_id: String,
    space_id: String,
    assigned: bool,
) -> Result<(), String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        set_membership(
            &store.connection,
            "spaces",
            "item_spaces",
            "space_id",
            &item_id,
            &space_id,
            assigned,
        )
    })
    .await
    .map_err(|_| "The Space membership could not be saved.".to_string())?
}

#[tauri::command]
pub async fn list_labels(app: AppHandle) -> Result<Vec<Label>, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        query_labels(&store.connection, None)
    })
    .await
    .map_err(|_| "The Labels could not be read.".to_string())?
}

#[tauri::command]
pub async fn list_items_for_label(
    app: AppHandle,
    label_id: String,
) -> Result<ListLibraryItemsResult, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open_active(&documents_directory)?;
        reconcile_library(&mut store)?;
        let items = query_items_for_label(&store.connection, &store.paths, &label_id)?;
        Ok(ListLibraryItemsResult { items })
    })
    .await
    .map_err(|_| "The Label items could not be read.".to_string())?
}

#[tauri::command]
pub async fn list_labels_for_item(app: AppHandle, item_id: String) -> Result<Vec<Label>, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        require_record(&store.connection, "items", &item_id, "item")?;
        query_labels(&store.connection, Some(&item_id))
    })
    .await
    .map_err(|_| "The item Labels could not be read.".to_string())?
}

#[tauri::command]
pub async fn create_label(
    app: AppHandle,
    name: String,
    color_key: String,
) -> Result<Label, String> {
    create_label_command(app, name, color_key, None).await
}

#[tauri::command]
pub async fn create_label_and_assign(
    app: AppHandle,
    name: String,
    color_key: String,
    item_id: String,
) -> Result<Label, String> {
    create_label_command(app, name, color_key, Some(item_id)).await
}

async fn create_label_command(
    app: AppHandle,
    name: String,
    color_key: String,
    item_id: Option<String>,
) -> Result<Label, String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        create_label_record(&store.connection, &name, &color_key, item_id.as_deref())
    })
    .await
    .map_err(|_| "The Label could not be created.".to_string())?
}

#[tauri::command]
pub async fn set_item_label_membership(
    app: AppHandle,
    item_id: String,
    label_id: String,
    assigned: bool,
) -> Result<(), String> {
    let documents_directory = documents_directory_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open_active(&documents_directory)?;
        set_membership(
            &store.connection,
            "labels",
            "item_labels",
            "label_id",
            &item_id,
            &label_id,
            assigned,
        )
    })
    .await
    .map_err(|_| "The Label membership could not be saved.".to_string())?
}

impl LibraryStore {
    #[cfg(test)]
    fn open(documents_directory: &Path) -> Result<Self, String> {
        let paths = resolve_library_paths(documents_directory);
        Self::open_paths(paths)
    }

    fn open_active(vault_root: &VaultAccess) -> Result<Self, String> {
        Self::open_paths(resolve_vault_paths(vault_root))
    }

    fn open_vault(vault_root: &Path) -> Result<Self, String> {
        Self::open_paths(resolve_vault_paths(vault_root))
    }

    fn open_paths(paths: LibraryPaths) -> Result<Self, String> {
        fs::create_dir_all(&paths.library_directory)
            .map_err(|_| "The No. 8 Vault library directory could not be created.".to_string())?;
        fs::create_dir_all(&paths.database_directory)
            .map_err(|_| "The No. 8 Vault metadata directory could not be created.".to_string())?;
        fs::create_dir_all(&paths.link_assets_directory)
            .map_err(|_| "The No. 8 link assets directory could not be created.".to_string())?;
        fs::create_dir_all(&paths.link_preview_cache_directory)
            .map_err(|_| "The No. 8 link preview cache could not be created.".to_string())?;

        let mut connection = Connection::open(&paths.database_path)
            .map_err(|_| "The No. 8 database could not be opened.".to_string())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| "The No. 8 database could not be configured.".to_string())?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(|_| {
                "The No. 8 database could not enable data integrity checks.".to_string()
            })?;
        migrate_database(&mut connection)?;

        Ok(Self { paths, connection })
    }
}

fn documents_directory_path(app: &AppHandle) -> Result<VaultAccess, String> {
    app.state::<VaultRuntime>().acquire()
}

#[cfg(test)]
fn resolve_library_paths(documents_directory: &Path) -> LibraryPaths {
    let vault_directory = documents_directory.join(VAULT_DIRECTORY_NAME);
    resolve_vault_paths(&vault_directory)
}

fn resolve_vault_paths(vault_directory: &Path) -> LibraryPaths {
    let vault_directory = vault_directory.to_path_buf();
    let library_directory = vault_directory.join(LIBRARY_DIRECTORY_NAME);
    let database_directory = vault_directory.join(DATABASE_DIRECTORY_NAME);
    let database_path = database_directory.join(DATABASE_FILE_NAME);
    let link_assets_directory = database_directory.join(LINK_ASSETS_DIRECTORY_NAME);
    let link_preview_cache_directory = database_directory.join(LINK_PREVIEW_CACHE_DIRECTORY_NAME);

    LibraryPaths {
        vault_directory,
        library_directory,
        database_directory,
        database_path,
        link_assets_directory,
        link_preview_cache_directory,
    }
}

pub(crate) fn ensure_vault(vault_root: &Path) -> Result<(), String> {
    LibraryStore::open_vault(vault_root).map(|_| ())
}

pub(crate) fn validate_vault_readable(vault_root: &Path) -> Result<(), String> {
    let store = LibraryStore::open_vault(vault_root)?;
    store
        .connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|_| "The No. 8 database could not be verified.".to_string())
        .and_then(|result| {
            if result == "ok" {
                Ok(())
            } else {
                Err("The No. 8 database failed its integrity check.".into())
            }
        })
}

pub(crate) fn validate_vault_version(vault_root: &Path) -> Result<(), String> {
    let connection = Connection::open(
        vault_root
            .join(DATABASE_DIRECTORY_NAME)
            .join(DATABASE_FILE_NAME),
    )
    .map_err(|_| "The No. 8 database could not be opened.".to_string())?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| "The No. 8 database version could not be read.".to_string())?;
    if version > DATABASE_SCHEMA_VERSION {
        return Err(
            "This vault was created by a newer version of No. 8 and cannot be opened.".into(),
        );
    }
    Ok(())
}

pub(crate) const fn current_schema_version() -> i64 {
    DATABASE_SCHEMA_VERSION
}

fn migrate_database(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| "The No. 8 database version could not be read.".to_string())?;

    match version {
        0 => {
            let transaction = connection
                .transaction()
                .map_err(|_| "The No. 8 database migration could not start.".to_string())?;
            transaction
                .execute_batch(&format!("{V4_SCHEMA}{V5_SCHEMA}"))
                .map_err(|_| "The No. 8 database schema could not be created.".to_string())?;
            insert_initial_personal_space(&transaction)?;
            transaction
                .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
                .map_err(|_| "The No. 8 database version could not be updated.".to_string())?;
            transaction
                .commit()
                .map_err(|_| "The No. 8 database migration could not be saved.".to_string())
        }
        1 => {
            let transaction = connection
                .transaction()
                .map_err(|_| "The No. 8 database migration could not start.".to_string())?;
            transaction
                .execute_batch(&format!(
                    "{V4_SCHEMA_TEMP}
                     INSERT INTO items_v4 (
                         id, item_type, title, relative_path, url,
                         preview_relative_path, favicon_relative_path, metadata_status,
                         created_at_ms, updated_at_ms, archived_at_ms, is_favorite
                     )
                     SELECT id, item_type, title, relative_path, NULL,
                            NULL, NULL, NULL, created_at_ms, updated_at_ms, NULL, 0
                     FROM items;
                     DROP TABLE items;
                     ALTER TABLE items_v4 RENAME TO items;
                     {V5_SCHEMA}"
                ))
                .map_err(|_| "The No. 8 database schema could not be upgraded.".to_string())?;
            insert_initial_personal_space(&transaction)?;
            transaction
                .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
                .map_err(|_| "The No. 8 database version could not be updated.".to_string())?;
            transaction
                .commit()
                .map_err(|_| "The No. 8 database migration could not be saved.".to_string())
        }
        2 => {
            let transaction = connection
                .transaction()
                .map_err(|_| "The No. 8 database migration could not start.".to_string())?;
            transaction
                .execute("ALTER TABLE items ADD COLUMN archived_at_ms INTEGER", [])
                .map_err(|_| "The No. 8 archive schema could not be added.".to_string())?;
            transaction
                .execute(
                    "ALTER TABLE items ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0
                     CHECK (is_favorite IN (0, 1))",
                    [],
                )
                .map_err(|_| "The No. 8 favorites schema could not be added.".to_string())?;
            transaction
                .execute_batch(V5_SCHEMA)
                .map_err(|_| "The No. 8 organization schema could not be added.".to_string())?;
            insert_initial_personal_space(&transaction)?;
            transaction
                .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
                .map_err(|_| "The No. 8 database version could not be updated.".to_string())?;
            transaction
                .commit()
                .map_err(|_| "The No. 8 database migration could not be saved.".to_string())
        }
        3 => {
            let transaction = connection
                .transaction()
                .map_err(|_| "The No. 8 database migration could not start.".to_string())?;
            transaction
                .execute(
                    "ALTER TABLE items ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0
                     CHECK (is_favorite IN (0, 1))",
                    [],
                )
                .map_err(|_| "The No. 8 favorites schema could not be added.".to_string())?;
            transaction
                .execute_batch(V5_SCHEMA)
                .map_err(|_| "The No. 8 organization schema could not be added.".to_string())?;
            insert_initial_personal_space(&transaction)?;
            transaction
                .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
                .map_err(|_| "The No. 8 database version could not be updated.".to_string())?;
            transaction
                .commit()
                .map_err(|_| "The No. 8 database migration could not be saved.".to_string())
        }
        4 => {
            let transaction = connection
                .transaction()
                .map_err(|_| "The No. 8 database migration could not start.".to_string())?;
            transaction
                .execute_batch(V5_SCHEMA)
                .map_err(|_| "The No. 8 organization schema could not be added.".to_string())?;
            insert_initial_personal_space(&transaction)?;
            transaction
                .pragma_update(None, "user_version", DATABASE_SCHEMA_VERSION)
                .map_err(|_| "The No. 8 database version could not be updated.".to_string())?;
            transaction
                .commit()
                .map_err(|_| "The No. 8 database migration could not be saved.".to_string())
        }
        DATABASE_SCHEMA_VERSION => Ok(()),
        _ => Err("The No. 8 database version is not supported.".to_string()),
    }
}

const V4_SCHEMA: &str = "CREATE TABLE items (
    id TEXT PRIMARY KEY NOT NULL,
    item_type TEXT NOT NULL CHECK (item_type IN ('image', 'link')),
    title TEXT NOT NULL,
    relative_path TEXT UNIQUE,
    url TEXT UNIQUE,
    preview_relative_path TEXT,
    favicon_relative_path TEXT,
    metadata_status TEXT CHECK (
        metadata_status IS NULL OR metadata_status IN ('pending', 'ready', 'failed')
    ),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    archived_at_ms INTEGER,
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    CHECK (
        (item_type = 'image' AND relative_path IS NOT NULL AND url IS NULL
            AND preview_relative_path IS NULL AND favicon_relative_path IS NULL
            AND metadata_status IS NULL)
        OR
        (item_type = 'link' AND relative_path IS NULL AND url IS NOT NULL
            AND metadata_status IS NOT NULL)
    )
);";

const V4_SCHEMA_TEMP: &str = "CREATE TABLE items_v4 (
    id TEXT PRIMARY KEY NOT NULL,
    item_type TEXT NOT NULL CHECK (item_type IN ('image', 'link')),
    title TEXT NOT NULL,
    relative_path TEXT UNIQUE,
    url TEXT UNIQUE,
    preview_relative_path TEXT,
    favicon_relative_path TEXT,
    metadata_status TEXT CHECK (
        metadata_status IS NULL OR metadata_status IN ('pending', 'ready', 'failed')
    ),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    archived_at_ms INTEGER,
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    CHECK (
        (item_type = 'image' AND relative_path IS NOT NULL AND url IS NULL
            AND preview_relative_path IS NULL AND favicon_relative_path IS NULL
            AND metadata_status IS NULL)
        OR
        (item_type = 'link' AND relative_path IS NULL AND url IS NOT NULL
            AND metadata_status IS NOT NULL)
    )
);";

const V5_SCHEMA: &str = "
CREATE TABLE spaces (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color_key TEXT NOT NULL,
    icon_key TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE item_spaces (
    item_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (item_id, space_id),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);
CREATE INDEX idx_item_spaces_space_id ON item_spaces(space_id);
CREATE TABLE labels (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    color_key TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE item_labels (
    item_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (item_id, label_id),
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
    FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);
CREATE INDEX idx_item_labels_label_id ON item_labels(label_id);
";

fn insert_initial_personal_space(connection: &Connection) -> Result<(), String> {
    let timestamp = now_ms()?;
    connection
        .execute(
            "INSERT INTO spaces (id, name, color_key, icon_key, created_at_ms, updated_at_ms)
             VALUES (?1, 'Personal', 'gray', 'heart', ?2, ?2)",
            params![PERSONAL_SPACE_ID, timestamp],
        )
        .map_err(|_| "The Personal Space could not be created.".to_string())?;
    Ok(())
}

fn validated_name(raw_name: &str, kind: &str) -> Result<String, String> {
    let name = raw_name.trim();
    if name.is_empty() {
        return Err(format!("Enter a name for this {kind}."));
    }
    Ok(name.to_string())
}

fn validate_color_key(color_key: &str) -> Result<(), String> {
    if COLOR_KEYS.contains(&color_key) {
        Ok(())
    } else {
        Err("The selected color is not supported.".to_string())
    }
}

fn validate_space_icon_key(icon_key: &str) -> Result<(), String> {
    if SPACE_ICON_KEYS.contains(&icon_key) {
        Ok(())
    } else {
        Err("The selected Space icon is not supported.".to_string())
    }
}

fn require_record(
    connection: &Connection,
    table: &str,
    id: &str,
    kind: &str,
) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
            [id],
            |row| row.get(0),
        )
        .map_err(|_| format!("The {kind} could not be validated."))?;
    if exists {
        Ok(())
    } else {
        Err(format!("The {kind} could not be found."))
    }
}

fn set_membership(
    connection: &Connection,
    owner_table: &str,
    join_table: &str,
    owner_column: &str,
    item_id: &str,
    owner_id: &str,
    assigned: bool,
) -> Result<(), String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|_| "The membership update could not start.".to_string())?;
    require_record(&transaction, "items", item_id, "item")?;
    require_record(&transaction, owner_table, owner_id, "selection")?;
    if assigned {
        transaction
            .execute(
                &format!(
                    "INSERT OR IGNORE INTO {join_table} (item_id, {owner_column}, created_at_ms)
                     VALUES (?1, ?2, ?3)"
                ),
                params![item_id, owner_id, now_ms()?],
            )
            .map_err(|_| "The membership could not be assigned.".to_string())?;
    } else {
        transaction
            .execute(
                &format!("DELETE FROM {join_table} WHERE item_id = ?1 AND {owner_column} = ?2"),
                params![item_id, owner_id],
            )
            .map_err(|_| "The membership could not be removed.".to_string())?;
    }
    transaction
        .commit()
        .map_err(|_| "The membership update could not be saved.".to_string())
}

fn create_space_record(
    connection: &Connection,
    raw_name: &str,
    color_key: &str,
    icon_key: &str,
    item_id: Option<&str>,
) -> Result<Space, String> {
    let name = validated_name(raw_name, "Space")?;
    validate_color_key(color_key)?;
    validate_space_icon_key(icon_key)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|_| "The Space creation could not start.".to_string())?;
    if let Some(item_id) = item_id {
        require_record(&transaction, "items", item_id, "item")?;
    }
    let id = Uuid::new_v4().to_string();
    let timestamp = now_ms()?;
    transaction
        .execute(
            "INSERT INTO spaces (id, name, color_key, icon_key, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, color_key, icon_key, timestamp],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "A Space with this name already exists.".to_string()
            } else {
                "The Space could not be created.".to_string()
            }
        })?;
    if let Some(item_id) = item_id {
        transaction
            .execute(
                "INSERT INTO item_spaces (item_id, space_id, created_at_ms) VALUES (?1, ?2, ?3)",
                params![item_id, id, timestamp],
            )
            .map_err(|_| "The item could not be added to the new Space.".to_string())?;
    }
    let space = transaction
        .query_row(
            "SELECT id, name, color_key, icon_key, created_at_ms, updated_at_ms
             FROM spaces WHERE id = ?1",
            [&id],
            space_from_row,
        )
        .map_err(|_| "The new Space could not be read.".to_string())?;
    transaction
        .commit()
        .map_err(|_| "The Space could not be saved.".to_string())?;
    Ok(space)
}

fn update_space_record(
    connection: &Connection,
    id: &str,
    raw_name: &str,
    color_key: &str,
    icon_key: &str,
) -> Result<Space, String> {
    let name = validated_name(raw_name, "Space")?;
    validate_color_key(color_key)?;
    validate_space_icon_key(icon_key)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|_| "The Space update could not start.".to_string())?;
    require_record(&transaction, "spaces", id, "Space")?;
    let timestamp = now_ms()?;
    transaction
        .execute(
            "UPDATE spaces
             SET name = ?1, color_key = ?2, icon_key = ?3, updated_at_ms = ?4
             WHERE id = ?5",
            params![name, color_key, icon_key, timestamp, id],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "A Space with this name already exists.".to_string()
            } else {
                "The Space could not be updated.".to_string()
            }
        })?;
    let space = transaction
        .query_row(
            "SELECT id, name, color_key, icon_key, created_at_ms, updated_at_ms
             FROM spaces WHERE id = ?1",
            [id],
            space_from_row,
        )
        .map_err(|_| "The updated Space could not be read.".to_string())?;
    transaction
        .commit()
        .map_err(|_| "The Space update could not be saved.".to_string())?;
    Ok(space)
}

fn delete_space_record(connection: &Connection, id: &str) -> Result<bool, String> {
    let transaction = connection
        .unchecked_transaction()
        .map_err(|_| "The Space deletion could not start.".to_string())?;
    require_record(&transaction, "spaces", id, "Space")?;
    let deleted = transaction
        .execute("DELETE FROM spaces WHERE id = ?1", [id])
        .map_err(|_| "The Space could not be deleted.".to_string())?
        == 1;
    transaction
        .commit()
        .map_err(|_| "The Space deletion could not be saved.".to_string())?;
    Ok(deleted)
}

fn query_spaces(connection: &Connection, item_id: Option<&str>) -> Result<Vec<Space>, String> {
    let (sql, parameter): (&str, Option<&str>) = match item_id {
        Some(item_id) => (
            "SELECT spaces.id, spaces.name, spaces.color_key, spaces.icon_key,
                    spaces.created_at_ms, spaces.updated_at_ms
             FROM spaces JOIN item_spaces ON item_spaces.space_id = spaces.id
             WHERE item_spaces.item_id = ?1
             ORDER BY spaces.created_at_ms ASC, spaces.name COLLATE NOCASE ASC",
            Some(item_id),
        ),
        None => (
            "SELECT id, name, color_key, icon_key, created_at_ms, updated_at_ms
             FROM spaces ORDER BY created_at_ms ASC, name COLLATE NOCASE ASC",
            None,
        ),
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|_| "The Spaces could not be read.".to_string())?;
    let rows = if let Some(parameter) = parameter {
        statement.query_map([parameter], space_from_row)
    } else {
        statement.query_map([], space_from_row)
    }
    .map_err(|_| "The Spaces could not be read.".to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "A Space could not be read.".to_string())
}

fn space_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Space> {
    Ok(Space {
        id: row.get(0)?,
        name: row.get(1)?,
        color_key: row.get(2)?,
        icon_key: row.get(3)?,
        created_at_ms: row.get(4)?,
        updated_at_ms: row.get(5)?,
    })
}

fn create_label_record(
    connection: &Connection,
    raw_name: &str,
    color_key: &str,
    item_id: Option<&str>,
) -> Result<Label, String> {
    let name = validated_name(raw_name, "Label")?;
    if name.chars().count() > MAX_LABEL_NAME_LENGTH {
        return Err(format!(
            "The Label name must be {MAX_LABEL_NAME_LENGTH} characters or fewer."
        ));
    }
    validate_color_key(color_key)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|_| "The Label creation could not start.".to_string())?;
    if let Some(item_id) = item_id {
        require_record(&transaction, "items", item_id, "item")?;
    }
    let id = Uuid::new_v4().to_string();
    let timestamp = now_ms()?;
    transaction
        .execute(
            "INSERT INTO labels (id, name, color_key, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, name, color_key, timestamp],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "A Label with this name already exists.".to_string()
            } else {
                "The Label could not be created.".to_string()
            }
        })?;
    if let Some(item_id) = item_id {
        transaction
            .execute(
                "INSERT INTO item_labels (item_id, label_id, created_at_ms) VALUES (?1, ?2, ?3)",
                params![item_id, id, timestamp],
            )
            .map_err(|_| "The item could not be assigned the new Label.".to_string())?;
    }
    let label = transaction
        .query_row(
            "SELECT id, name, color_key, created_at_ms, updated_at_ms
             FROM labels WHERE id = ?1",
            [&id],
            label_from_row,
        )
        .map_err(|_| "The new Label could not be read.".to_string())?;
    transaction
        .commit()
        .map_err(|_| "The Label could not be saved.".to_string())?;
    Ok(label)
}

fn query_labels(connection: &Connection, item_id: Option<&str>) -> Result<Vec<Label>, String> {
    let (sql, parameter): (&str, Option<&str>) = match item_id {
        Some(item_id) => (
            "SELECT labels.id, labels.name, labels.color_key,
                    labels.created_at_ms, labels.updated_at_ms
             FROM labels JOIN item_labels ON item_labels.label_id = labels.id
             WHERE item_labels.item_id = ?1
             ORDER BY labels.created_at_ms ASC, labels.name COLLATE NOCASE ASC",
            Some(item_id),
        ),
        None => (
            "SELECT id, name, color_key, created_at_ms, updated_at_ms
             FROM labels ORDER BY created_at_ms ASC, name COLLATE NOCASE ASC",
            None,
        ),
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|_| "The Labels could not be read.".to_string())?;
    let rows = if let Some(parameter) = parameter {
        statement.query_map([parameter], label_from_row)
    } else {
        statement.query_map([], label_from_row)
    }
    .map_err(|_| "The Labels could not be read.".to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "A Label could not be read.".to_string())
}

fn query_items_for_label(
    connection: &Connection,
    paths: &LibraryPaths,
    label_id: &str,
) -> Result<Vec<LibraryItem>, String> {
    require_record(connection, "labels", label_id, "Label")?;
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT items.id, items.item_type, items.title, items.relative_path,
                    items.url, items.preview_relative_path, items.favicon_relative_path,
                    items.metadata_status, items.created_at_ms, items.updated_at_ms,
                    items.archived_at_ms, items.is_favorite
             FROM items
             JOIN item_labels ON item_labels.item_id = items.id
             WHERE item_labels.label_id = ?1 AND items.archived_at_ms IS NULL
             ORDER BY items.created_at_ms DESC,
                      COALESCE(items.relative_path, items.url) ASC",
        )
        .map_err(|_| "The Label items could not be read.".to_string())?;
    let rows = statement
        .query_map([label_id], database_item_from_row)
        .map_err(|_| "The Label items could not be read.".to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(library_item_from_database(
            paths,
            row.map_err(|_| "A Label item could not be read.".to_string())?,
        )?);
    }
    Ok(items)
}

fn label_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Label> {
    Ok(Label {
        id: row.get(0)?,
        name: row.get(1)?,
        color_key: row.get(2)?,
        created_at_ms: row.get(3)?,
        updated_at_ms: row.get(4)?,
    })
}

fn reconcile_library(store: &mut LibraryStore) -> Result<(), String> {
    let entries = fs::read_dir(&store.paths.library_directory)
        .map_err(|_| "The No. 8 Vault library directory could not be read.".to_string())?;
    let mut image_paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| is_indexable_library_file(path))
        .collect::<Vec<_>>();
    image_paths.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    let registration_time = now_ms()?;
    let paths = store.paths.clone();
    let transaction = store
        .connection
        .transaction()
        .map_err(|_| "The No. 8 library index could not be updated.".to_string())?;

    for image_path in image_paths {
        register_image(&transaction, &paths, &image_path, registration_time)?;
    }

    transaction
        .commit()
        .map_err(|_| "The No. 8 library index could not be saved.".to_string())
}

fn is_indexable_library_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if file_name.starts_with('.') || !has_supported_extension(path) {
        return false;
    }

    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

fn register_image(
    connection: &Connection,
    paths: &LibraryPaths,
    image_path: &Path,
    registration_time: i64,
) -> Result<LibraryItem, String> {
    let (relative_path, title, metadata) = library_image_details(paths, image_path)?;
    let updated_at_ms = modified_at_ms(&metadata).unwrap_or(registration_time);
    let new_id = Uuid::new_v4().to_string();

    let item = connection
        .query_row(
            "INSERT INTO items (
                id, item_type, title, relative_path, created_at_ms, updated_at_ms
            ) VALUES (?1, 'image', ?2, ?3, ?4, ?5)
            ON CONFLICT(relative_path) DO UPDATE SET
                title = excluded.title,
                updated_at_ms = excluded.updated_at_ms
            RETURNING id, item_type, title, relative_path, url,
                      preview_relative_path, favicon_relative_path, metadata_status,
                      created_at_ms, updated_at_ms, archived_at_ms, is_favorite",
            params![
                new_id,
                title,
                relative_path,
                registration_time,
                updated_at_ms
            ],
            database_item_from_row,
        )
        .map_err(|_| "The image could not be registered in the library.".to_string())?;

    library_item_from_database(paths, item)
}

fn register_image_with_space(
    store: &LibraryStore,
    image_path: &Path,
    active_space_id: Option<&str>,
    registration_time: Option<i64>,
) -> Result<LibraryItem, String> {
    let transaction = store
        .connection
        .unchecked_transaction()
        .map_err(|_| "The image registration could not start.".to_string())?;
    if let Some(space_id) = active_space_id {
        require_record(&transaction, "spaces", space_id, "Space")?;
    }
    let item = register_image(
        &transaction,
        &store.paths,
        image_path,
        registration_time.unwrap_or(now_ms()?),
    )?;
    if let Some(space_id) = active_space_id {
        transaction
            .execute(
                "INSERT OR IGNORE INTO item_spaces (item_id, space_id, created_at_ms)
                 VALUES (?1, ?2, ?3)",
                params![item.id, space_id, now_ms()?],
            )
            .map_err(|_| "The image could not be added to the active Space.".to_string())?;
    }
    transaction
        .commit()
        .map_err(|_| "The image registration could not be saved.".to_string())?;
    Ok(item)
}

fn library_image_details(
    paths: &LibraryPaths,
    image_path: &Path,
) -> Result<(String, String, fs::Metadata), String> {
    let metadata = fs::symlink_metadata(image_path)
        .map_err(|_| "The library image could not be accessed.".to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Only regular image files can be registered.".to_string());
    }

    let canonical_library = fs::canonicalize(&paths.library_directory)
        .map_err(|_| "The No. 8 Vault library directory could not be accessed.".to_string())?;
    let canonical_image = fs::canonicalize(image_path)
        .map_err(|_| "The library image could not be accessed.".to_string())?;
    if canonical_image.parent() != Some(canonical_library.as_path()) {
        return Err("The image is outside the No. 8 Vault library.".to_string());
    }

    let file_name = canonical_image
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The image filename is not supported.".to_string())?;
    if file_name.starts_with('.') || !has_supported_extension(&canonical_image) {
        return Err("The image is not a supported library file.".to_string());
    }

    let title = canonical_image
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| "The image title could not be read.".to_string())?
        .to_string();
    let relative_path = format!("{LIBRARY_DIRECTORY_NAME}/{file_name}");

    Ok((relative_path, title, metadata))
}

fn query_library_items(
    connection: &Connection,
    paths: &LibraryPaths,
    query: LibraryQuery,
) -> Result<Vec<LibraryItem>, String> {
    let sql = match query {
        LibraryQuery::Active => {
            "SELECT id, item_type, title, relative_path, url,
                    preview_relative_path, favicon_relative_path, metadata_status,
                    created_at_ms, updated_at_ms, archived_at_ms, is_favorite
             FROM items
             WHERE archived_at_ms IS NULL
             ORDER BY created_at_ms DESC, COALESCE(relative_path, url) ASC"
        }
        LibraryQuery::Favorites => {
            "SELECT id, item_type, title, relative_path, url,
                    preview_relative_path, favicon_relative_path, metadata_status,
                    created_at_ms, updated_at_ms, archived_at_ms, is_favorite
             FROM items
             WHERE is_favorite = 1 AND archived_at_ms IS NULL
             ORDER BY created_at_ms DESC, COALESCE(relative_path, url) ASC"
        }
        LibraryQuery::Archived => {
            "SELECT id, item_type, title, relative_path, url,
                    preview_relative_path, favicon_relative_path, metadata_status,
                    created_at_ms, updated_at_ms, archived_at_ms, is_favorite
             FROM items
             WHERE archived_at_ms IS NOT NULL
             ORDER BY archived_at_ms DESC, created_at_ms DESC,
                      COALESCE(relative_path, url) ASC"
        }
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|_| "The No. 8 library query could not be prepared.".to_string())?;
    let rows = statement
        .query_map([], database_item_from_row)
        .map_err(|_| "The No. 8 library could not be queried.".to_string())?;
    let mut items = Vec::new();

    for row in rows {
        let database_item =
            row.map_err(|_| "A No. 8 library item could not be read.".to_string())?;
        items.push(library_item_from_database(paths, database_item)?);
    }

    Ok(items)
}

fn query_recent_items(
    connection: &Connection,
    paths: &LibraryPaths,
    limit: usize,
) -> Result<Vec<LibraryItem>, String> {
    let limit = limit.min(MAX_RECENT_ITEMS);
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT id, item_type, title, relative_path, url,
                    preview_relative_path, favicon_relative_path, metadata_status,
                    created_at_ms, updated_at_ms, archived_at_ms, is_favorite
             FROM items
             WHERE archived_at_ms IS NULL
             ORDER BY created_at_ms DESC, COALESCE(relative_path, url) ASC, id ASC
             LIMIT ?1",
        )
        .map_err(|_| "The recent library query could not be prepared.".to_string())?;
    let rows = statement
        .query_map([limit as i64], database_item_from_row)
        .map_err(|_| "The recent library items could not be queried.".to_string())?;
    let mut items = Vec::new();
    for row in rows {
        let database_item =
            row.map_err(|_| "A recent library item could not be read.".to_string())?;
        items.push(library_item_from_database(paths, database_item)?);
    }
    Ok(items)
}

fn query_search_items(
    connection: &Connection,
    paths: &LibraryPaths,
    query: &str,
    limit: usize,
) -> Result<Vec<LibraryItem>, String> {
    let query = query.trim();
    let limit = limit.min(MAX_SEARCH_ITEMS);
    if query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let escaped = escape_like_pattern(query);
    let prefix = format!("{escaped}%");
    let contains = format!("%{escaped}%");
    let mut statement = connection
        .prepare(
            "SELECT id, item_type, title, relative_path, url,
                    preview_relative_path, favicon_relative_path, metadata_status,
                    created_at_ms, updated_at_ms, archived_at_ms, is_favorite
             FROM items
             WHERE title LIKE ?3 ESCAPE '\\' COLLATE NOCASE
                OR (item_type = 'image' AND
                    substr(relative_path, instr(relative_path, '/') + 1)
                        LIKE ?3 ESCAPE '\\' COLLATE NOCASE)
                OR (item_type = 'link' AND url LIKE ?3 ESCAPE '\\' COLLATE NOCASE)
             ORDER BY CASE
                 WHEN title = ?1 COLLATE NOCASE THEN 0
                 WHEN title LIKE ?2 ESCAPE '\\' COLLATE NOCASE THEN 1
                 WHEN title LIKE ?3 ESCAPE '\\' COLLATE NOCASE THEN 2
                 WHEN item_type = 'image' AND
                      substr(relative_path, instr(relative_path, '/') + 1)
                          LIKE ?2 ESCAPE '\\' COLLATE NOCASE THEN 3
                 WHEN item_type = 'image' AND
                      substr(relative_path, instr(relative_path, '/') + 1)
                          LIKE ?3 ESCAPE '\\' COLLATE NOCASE THEN 4
                 WHEN item_type = 'link' AND url LIKE ?2 ESCAPE '\\' COLLATE NOCASE THEN 5
                 ELSE 6
             END,
             created_at_ms DESC,
             id ASC
             LIMIT ?4",
        )
        .map_err(|_| "The library search query could not be prepared.".to_string())?;
    let rows = statement
        .query_map(
            params![query, prefix, contains, limit as i64],
            database_item_from_row,
        )
        .map_err(|_| "The library items could not be searched.".to_string())?;
    let mut items = Vec::new();
    for row in rows {
        let database_item =
            row.map_err(|_| "A searched library item could not be read.".to_string())?;
        items.push(library_item_from_database(paths, database_item)?);
    }
    Ok(items)
}

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn database_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseItem> {
    Ok(DatabaseItem {
        id: row.get(0)?,
        item_type: row.get(1)?,
        title: row.get(2)?,
        relative_path: row.get(3)?,
        url: row.get(4)?,
        preview_relative_path: row.get(5)?,
        favicon_relative_path: row.get(6)?,
        metadata_status: row.get(7)?,
        created_at_ms: row.get(8)?,
        updated_at_ms: row.get(9)?,
        archived_at_ms: row.get(10)?,
        is_favorite: row.get(11)?,
    })
}

fn library_item_from_database(
    paths: &LibraryPaths,
    item: DatabaseItem,
) -> Result<LibraryItem, String> {
    match item.item_type.as_str() {
        "image" => {
            let relative_path = item
                .relative_path
                .as_deref()
                .ok_or_else(|| "A stored image path is missing.".to_string())?;
            let relative_path = validate_image_relative_path(relative_path)?;
            let file_name = relative_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "A stored image filename is invalid.".to_string())?
                .to_string();
            let stored_path = paths.vault_directory.join(relative_path);

            Ok(LibraryItem {
                id: item.id,
                item_type: item.item_type,
                title: item.title,
                file_name: Some(file_name),
                stored_path: Some(stored_path.to_string_lossy().into_owned()),
                url: None,
                preview_path: None,
                favicon_path: None,
                metadata_status: None,
                created_at_ms: item.created_at_ms,
                modified_at_ms: Some(item.updated_at_ms),
                archived_at_ms: item.archived_at_ms,
                is_favorite: item.is_favorite,
            })
        }
        "link" => {
            let url = item
                .url
                .ok_or_else(|| "A stored link URL is missing.".to_string())?;
            let preview_path = item
                .preview_relative_path
                .as_deref()
                .map(|path| validate_link_asset_relative_path(path, &item.id, "preview.jpg"))
                .transpose()?
                .map(|path| {
                    paths
                        .vault_directory
                        .join(path)
                        .to_string_lossy()
                        .into_owned()
                });
            let favicon_path = item
                .favicon_relative_path
                .as_deref()
                .map(|path| validate_link_asset_relative_path(path, &item.id, "favicon.png"))
                .transpose()?
                .map(|path| {
                    paths
                        .vault_directory
                        .join(path)
                        .to_string_lossy()
                        .into_owned()
                });
            let metadata_status = item
                .metadata_status
                .filter(|status| matches!(status.as_str(), "pending" | "ready" | "failed"))
                .ok_or_else(|| "A stored link status is invalid.".to_string())?;

            Ok(LibraryItem {
                id: item.id,
                item_type: item.item_type,
                title: item.title,
                file_name: None,
                stored_path: None,
                url: Some(url),
                preview_path,
                favicon_path,
                metadata_status: Some(metadata_status),
                created_at_ms: item.created_at_ms,
                modified_at_ms: Some(item.updated_at_ms),
                archived_at_ms: item.archived_at_ms,
                is_favorite: item.is_favorite,
            })
        }
        _ => Err("A stored library item type is invalid.".to_string()),
    }
}

fn validate_image_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    let mut components = path.components();
    let valid_library = matches!(
        components.next(),
        Some(Component::Normal(component)) if component == OsStr::new(LIBRARY_DIRECTORY_NAME)
    );
    let file_name = match components.next() {
        Some(Component::Normal(component)) => component,
        _ => return Err("A stored image path is invalid.".to_string()),
    };

    if !valid_library || components.next().is_some() {
        return Err("A stored image path is invalid.".to_string());
    }

    let file_name = file_name
        .to_str()
        .ok_or_else(|| "A stored image filename is invalid.".to_string())?;
    if file_name.starts_with('.') || !has_supported_extension(Path::new(file_name)) {
        return Err("A stored image path is not supported.".to_string());
    }

    Ok(path.to_path_buf())
}

fn validate_link_asset_relative_path(
    relative_path: &str,
    item_id: &str,
    expected_file_name: &str,
) -> Result<PathBuf, String> {
    Uuid::parse_str(item_id).map_err(|_| "A stored link identifier is invalid.".to_string())?;
    let path = Path::new(relative_path);
    let expected = Path::new(DATABASE_DIRECTORY_NAME)
        .join("assets")
        .join("links")
        .join(item_id)
        .join(expected_file_name);

    if path != expected {
        return Err("A stored link asset path is invalid.".to_string());
    }

    Ok(path.to_path_buf())
}

fn validated_existing_image_path(
    paths: &LibraryPaths,
    item: &DatabaseItem,
) -> Result<PathBuf, String> {
    if item.item_type != "image" {
        return Err("The requested library item is not an image.".to_string());
    }
    let relative_path = item
        .relative_path
        .as_deref()
        .ok_or_else(|| "The stored image path is missing.".to_string())?;
    let relative_path = validate_image_relative_path(relative_path)?;
    let candidate = paths.vault_directory.join(relative_path);
    let metadata = fs::symlink_metadata(&candidate)
        .map_err(|_| "The stored image could not be accessed.".to_string())?;
    if !metadata.file_type().is_file() {
        return Err("The stored image is not a regular file.".to_string());
    }

    let canonical_library = fs::canonicalize(&paths.library_directory)
        .map_err(|_| "The No. 8 Vault library directory could not be accessed.".to_string())?;
    let canonical_image = fs::canonicalize(&candidate)
        .map_err(|_| "The stored image could not be accessed.".to_string())?;
    if canonical_image.parent() != Some(canonical_library.as_path()) {
        return Err("The stored image is outside the No. 8 Library.".to_string());
    }

    Ok(canonical_image)
}

fn stored_image_path(store: &LibraryStore, id: &str) -> Result<PathBuf, String> {
    let item = query_database_item_by_id(&store.connection, id)?
        .ok_or_else(|| "The library item could not be found.".to_string())?;
    validated_existing_image_path(&store.paths, &item)
}

fn library_open_target(store: &LibraryStore, id: &str) -> Result<LibraryOpenTarget, String> {
    let item = query_database_item_by_id(&store.connection, id)?
        .ok_or_else(|| "The library item could not be found.".to_string())?;
    match item.item_type.as_str() {
        "image" => validated_existing_image_path(&store.paths, &item).map(LibraryOpenTarget::Image),
        "link" => {
            let url = item
                .url
                .as_deref()
                .ok_or_else(|| "The stored link URL is missing.".to_string())?;
            let normalized = parse_normalized_link_url(url)?;
            Ok(LibraryOpenTarget::Link(normalized.into()))
        }
        _ => Err("The stored library item type is invalid.".to_string()),
    }
}

fn trimmed_title(raw_title: &str) -> Result<String, String> {
    let title = raw_title.trim();
    if title.is_empty() {
        return Err("Enter a name for this item.".to_string());
    }
    Ok(title.to_string())
}

fn validate_image_title(raw_title: &str) -> Result<String, String> {
    let title = trimmed_title(raw_title)?;
    if title.starts_with('.') || title.contains(['/', '\\', '\0']) {
        return Err("The image name contains unsupported characters.".to_string());
    }
    Ok(title)
}

fn create_rename_destination(source: &Path, requested_file_name: &str) -> io::Result<PathBuf> {
    let directory = source
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory"))?;
    let mut suffix = 1_u64;

    loop {
        let candidate = directory.join(collision_file_name(requested_file_name, suffix));
        if candidate == source {
            return Ok(candidate);
        }
        match fs::hard_link(source, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                suffix = suffix.checked_add(1).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::AlreadyExists, "No filename is available")
                })?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn restore_renamed_image(destination: &Path, source: &Path) {
    if fs::hard_link(destination, source).is_ok() {
        let _ = fs::remove_file(destination);
    }
}

fn rename_stored_item(
    store: &mut LibraryStore,
    id: &str,
    raw_title: &str,
) -> Result<LibraryItem, String> {
    let current = query_database_item_by_id(&store.connection, id)?
        .ok_or_else(|| "The library item could not be found.".to_string())?;

    if current.item_type == "link" {
        let title = trimmed_title(raw_title)?;
        store
            .connection
            .execute(
                "UPDATE items SET title = ?1, updated_at_ms = ?2
                 WHERE id = ?3 AND item_type = 'link'",
                params![title, now_ms()?, id],
            )
            .map_err(|_| "The link name could not be saved.".to_string())?;
        let updated = query_database_item_by_id(&store.connection, id)?
            .ok_or_else(|| "The renamed link could not be read.".to_string())?;
        return library_item_from_database(&store.paths, updated);
    }

    let title = validate_image_title(raw_title)?;
    let source = validated_existing_image_path(&store.paths, &current)?;
    let extension = source
        .extension()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "The image extension could not be read.".to_string())?;
    let requested_file_name = format!("{title}.{extension}");
    let destination = create_rename_destination(&source, &requested_file_name).map_err(|_| {
        "The image could not be renamed without overwriting another file.".to_string()
    })?;
    let moved = destination != source;
    if moved && fs::remove_file(&source).is_err() {
        let _ = fs::remove_file(&destination);
        return Err("The original image name could not be replaced.".to_string());
    }

    let destination_name = destination
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "The renamed image filename is invalid.".to_string())?;
    let relative_path = format!("{LIBRARY_DIRECTORY_NAME}/{destination_name}");
    let timestamp = now_ms()?;
    let update_result = (|| {
        let transaction = store
            .connection
            .transaction()
            .map_err(|_| "The image rename could not start.".to_string())?;
        transaction
            .execute(
                "UPDATE items
                 SET title = ?1, relative_path = ?2, updated_at_ms = ?3
                 WHERE id = ?4 AND item_type = 'image'",
                params![title, relative_path, timestamp, id],
            )
            .map_err(|_| "The image name could not be saved.".to_string())?;
        let updated = query_database_item_by_id(&transaction, id)?
            .ok_or_else(|| "The renamed image could not be read.".to_string())?;
        transaction
            .commit()
            .map_err(|_| "The image rename could not be saved.".to_string())?;
        Ok::<DatabaseItem, String>(updated)
    })();

    match update_result {
        Ok(updated) => library_item_from_database(&store.paths, updated),
        Err(error) => {
            if moved {
                restore_renamed_image(&destination, &source);
            }
            Err(error)
        }
    }
}

fn set_stored_item_archived(
    store: &LibraryStore,
    id: &str,
    archived: bool,
) -> Result<LibraryItem, String> {
    let timestamp = now_ms()?;
    let affected = if archived {
        store.connection.execute(
            "UPDATE items
             SET archived_at_ms = ?1, updated_at_ms = ?1
             WHERE id = ?2",
            params![timestamp, id],
        )
    } else {
        store.connection.execute(
            "UPDATE items
             SET archived_at_ms = NULL, updated_at_ms = ?1
             WHERE id = ?2",
            params![timestamp, id],
        )
    }
    .map_err(|_| "The item archive state could not be saved.".to_string())?;
    if affected != 1 {
        return Err("The library item could not be found.".to_string());
    }

    let updated = query_database_item_by_id(&store.connection, id)?
        .ok_or_else(|| "The updated library item could not be read.".to_string())?;
    library_item_from_database(&store.paths, updated)
}

fn set_stored_item_favorite(
    store: &LibraryStore,
    id: &str,
    is_favorite: bool,
) -> Result<LibraryItem, String> {
    let updated = store
        .connection
        .query_row(
            "UPDATE items
             SET is_favorite = ?1
             WHERE id = ?2
             RETURNING id, item_type, title, relative_path, url,
                       preview_relative_path, favicon_relative_path, metadata_status,
                       created_at_ms, updated_at_ms, archived_at_ms, is_favorite",
            params![is_favorite, id],
            database_item_from_row,
        )
        .optional()
        .map_err(|_| "The favorite state could not be saved.".to_string())?
        .ok_or_else(|| "The library item could not be found.".to_string())?;

    library_item_from_database(&store.paths, updated)
}

fn rollback_staged_directories(staged: &[(PathBuf, PathBuf)]) {
    for (original, destination) in staged.iter().rev() {
        if destination.exists() {
            let _ = fs::rename(destination, original);
        }
    }
}

fn stage_link_directories(
    paths: &LibraryPaths,
    item: &DatabaseItem,
) -> Result<(Option<PathBuf>, Vec<(PathBuf, PathBuf)>), String> {
    Uuid::parse_str(&item.id).map_err(|_| "The stored link identifier is invalid.".to_string())?;
    let url = item
        .url
        .as_deref()
        .ok_or_else(|| "The stored link URL is missing.".to_string())?;
    let normalized_url = parse_normalized_link_url(url)?;
    let asset_directory = paths.link_assets_directory.join(&item.id);
    let cache_directory = link_preview_cache_path(paths, &normalized_url)
        .parent()
        .ok_or_else(|| "The link preview cache path is invalid.".to_string())?
        .to_path_buf();
    let candidates = [asset_directory, cache_directory]
        .into_iter()
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok((None, Vec::new()));
    }

    for candidate in &candidates {
        let metadata = fs::symlink_metadata(candidate)
            .map_err(|_| "A link asset directory could not be accessed.".to_string())?;
        if !metadata.file_type().is_dir() {
            return Err("A link asset path is not an owned directory.".to_string());
        }
    }

    let staging_root = paths
        .database_directory
        .join("delete-staging")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&staging_root)
        .map_err(|_| "The link deletion staging directory could not be created.".to_string())?;
    let mut staged = Vec::new();
    for (index, original) in candidates.into_iter().enumerate() {
        let destination = staging_root.join(index.to_string());
        if fs::rename(&original, &destination).is_err() {
            rollback_staged_directories(&staged);
            let _ = fs::remove_dir_all(&staging_root);
            return Err("The link assets could not be prepared for deletion.".to_string());
        }
        staged.push((original, destination));
    }

    Ok((Some(staging_root), staged))
}

fn delete_stored_item(
    store: &mut LibraryStore,
    id: &str,
) -> Result<DeleteLibraryItemResult, String> {
    let item = query_database_item_by_id(&store.connection, id)?
        .ok_or_else(|| "The library item could not be found.".to_string())?;
    if item.item_type == "image" {
        let path = validated_existing_image_path(&store.paths, &item)?;
        trash::delete(&path).map_err(|_| "The image could not be moved to Trash.".to_string())?;
        let affected = store
            .connection
            .execute(
                "DELETE FROM items WHERE id = ?1 AND item_type = 'image'",
                [id],
            )
            .map_err(|_| "The trashed image could not be removed from the library.".to_string())?;
        if affected != 1 {
            return Err("The trashed image row could not be found.".to_string());
        }
        return Ok(DeleteLibraryItemResult {
            deleted: true,
            cleanup_warning: None,
        });
    }
    if item.item_type != "link" {
        return Err("The stored library item type is invalid.".to_string());
    }

    let (staging_root, staged) = stage_link_directories(&store.paths, &item)?;
    let delete_result = (|| {
        let transaction = store
            .connection
            .transaction()
            .map_err(|_| "The link deletion could not start.".to_string())?;
        let affected = transaction
            .execute(
                "DELETE FROM items WHERE id = ?1 AND item_type = 'link'",
                [id],
            )
            .map_err(|_| "The link could not be removed from the library.".to_string())?;
        if affected != 1 {
            return Err("The link row could not be found.".to_string());
        }
        transaction
            .commit()
            .map_err(|_| "The link deletion could not be saved.".to_string())
    })();
    if let Err(error) = delete_result {
        rollback_staged_directories(&staged);
        if let Some(root) = staging_root {
            let _ = fs::remove_dir_all(root);
        }
        return Err(error);
    }

    let cleanup_warning = staging_root.and_then(|root| {
        fs::remove_dir_all(root).err().map(|_| {
            "The link was deleted, but some isolated local assets could not be removed.".to_string()
        })
    });
    Ok(DeleteLibraryItemResult {
        deleted: true,
        cleanup_warning,
    })
}

fn create_link_item(
    store: &LibraryStore,
    raw_url: &str,
    active_space_id: Option<&str>,
) -> Result<LibraryItem, String> {
    let normalized_url = parse_normalized_link_url(raw_url)?;
    create_normalized_link_item(store, &normalized_url, active_space_id)
}

fn create_link_item_from_clipboard_text(
    store: &LibraryStore,
    clipboard_text: &str,
    active_space_id: Option<&str>,
) -> Result<Option<LibraryItem>, String> {
    let normalized_url = match parse_normalized_link_url(clipboard_text) {
        Ok(url) => url,
        Err(_) => return Ok(None),
    };
    create_normalized_link_item(store, &normalized_url, active_space_id).map(Some)
}

fn create_normalized_link_item(
    store: &LibraryStore,
    normalized_url: &Url,
    active_space_id: Option<&str>,
) -> Result<LibraryItem, String> {
    let normalized = normalized_url.as_str();
    let transaction = store
        .connection
        .unchecked_transaction()
        .map_err(|_| "The link creation could not start.".to_string())?;
    if let Some(space_id) = active_space_id {
        require_record(&transaction, "spaces", space_id, "Space")?;
    }
    let id = Uuid::new_v4().to_string();
    let title = normalized_url
        .host_str()
        .ok_or_else(|| "Enter a full web address.".to_string())?;
    let timestamp = now_ms()?;
    let mut item = transaction
        .query_row(
            "INSERT INTO items (
                id, item_type, title, relative_path, url,
                preview_relative_path, favicon_relative_path, metadata_status,
                created_at_ms, updated_at_ms
             ) VALUES (?1, 'link', ?2, NULL, ?3, NULL, NULL, 'pending', ?4, ?4)
             ON CONFLICT(url) DO UPDATE SET url = excluded.url
             RETURNING id, item_type, title, relative_path, url,
                       preview_relative_path, favicon_relative_path, metadata_status,
                       created_at_ms, updated_at_ms, archived_at_ms, is_favorite",
            params![id, title, normalized, timestamp],
            database_item_from_row,
        )
        .map_err(|_| "The link could not be added to the library.".to_string())?;
    if let Some(space_id) = active_space_id {
        transaction
            .execute(
                "UPDATE items SET archived_at_ms = NULL, updated_at_ms = ?1 WHERE id = ?2",
                params![timestamp, item.id],
            )
            .map_err(|_| "The existing link could not be restored.".to_string())?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO item_spaces (item_id, space_id, created_at_ms)
                 VALUES (?1, ?2, ?3)",
                params![item.id, space_id, timestamp],
            )
            .map_err(|_| "The link could not be added to the active Space.".to_string())?;
        item = query_database_item_by_id(&transaction, &item.id)?
            .ok_or_else(|| "The link could not be read.".to_string())?;
    }
    transaction
        .commit()
        .map_err(|_| "The link could not be saved.".to_string())?;
    library_item_from_database(&store.paths, item)
}

fn refresh_link_item(store: &LibraryStore, id: &str) -> Result<LibraryItem, String> {
    Uuid::parse_str(id).map_err(|_| "The link identifier is invalid.".to_string())?;
    let current = query_database_item_by_id(&store.connection, id)?
        .ok_or_else(|| "The link item could not be found.".to_string())?;
    if current.item_type != "link" {
        return Err("The requested library item is not a link.".to_string());
    }
    if current.metadata_status.as_deref() != Some("pending") {
        return library_item_from_database(&store.paths, current);
    }

    let Some(_guard) = begin_link_refresh(id)? else {
        return library_item_from_database(&store.paths, current);
    };
    let url = current
        .url
        .as_deref()
        .ok_or_else(|| "The stored link URL is missing.".to_string())?;
    let normalized_url = parse_normalized_link_url(url)?;
    let hostname = normalized_url
        .host_str()
        .ok_or_else(|| "The stored link URL is invalid.".to_string())?
        .to_string();

    match fetch_page_metadata(&normalized_url, &hostname) {
        Ok(metadata) => {
            let (preview_relative_path, favicon_relative_path) =
                download_link_assets(store, id, &metadata);
            store
                .connection
                .execute(
                    "UPDATE items
                     SET title = ?1,
                         preview_relative_path = ?2,
                         favicon_relative_path = ?3,
                         metadata_status = 'ready',
                         updated_at_ms = ?4
                     WHERE id = ?5 AND item_type = 'link'",
                    params![
                        metadata.title,
                        preview_relative_path,
                        favicon_relative_path,
                        now_ms()?,
                        id
                    ],
                )
                .map_err(|_| "The link metadata could not be saved.".to_string())?;
        }
        Err(_) => {
            store
                .connection
                .execute(
                    "UPDATE items
                     SET title = ?1,
                         preview_relative_path = NULL,
                         favicon_relative_path = NULL,
                         metadata_status = 'failed',
                         updated_at_ms = ?2
                     WHERE id = ?3 AND item_type = 'link'",
                    params![hostname, now_ms()?, id],
                )
                .map_err(|_| "The link failure status could not be saved.".to_string())?;
        }
    }

    let updated = query_database_item_by_id(&store.connection, id)?
        .ok_or_else(|| "The refreshed link item could not be read.".to_string())?;
    library_item_from_database(&store.paths, updated)
}

fn query_database_item_by_id(
    connection: &Connection,
    id: &str,
) -> Result<Option<DatabaseItem>, String> {
    query_database_item(connection, "id", id)
}

fn query_database_item(
    connection: &Connection,
    column: &str,
    value: &str,
) -> Result<Option<DatabaseItem>, String> {
    let sql = format!(
        "SELECT id, item_type, title, relative_path, url,
                preview_relative_path, favicon_relative_path, metadata_status,
                created_at_ms, updated_at_ms, archived_at_ms, is_favorite
         FROM items WHERE {column} = ?1"
    );
    connection
        .query_row(&sql, [value], database_item_from_row)
        .optional()
        .map_err(|_| "The library item could not be queried.".to_string())
}

fn parse_normalized_link_url(raw_url: &str) -> Result<Url, String> {
    let input = raw_url.trim();
    if input.is_empty() || input.chars().any(char::is_whitespace) {
        return Err("Enter a full web address.".to_string());
    }

    let mut url = match Url::parse(input) {
        Ok(url) => url,
        Err(ParseError::RelativeUrlWithoutBase) => Url::parse(&format!("https://{input}"))
            .map_err(|_| "Enter a full web address.".to_string())?,
        Err(_) => return Err("Enter a full web address.".to_string()),
    };
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Enter a full web address.".to_string());
    }

    if matches!(url.host(), Some(Host::Domain(host)) if !is_domain_like_host(host)) {
        return Err("Enter a full web address.".to_string());
    }
    reject_unsafe_literal_host(&url)?;
    url.set_fragment(None);
    Ok(url)
}

fn is_domain_like_host(host: &str) -> bool {
    let host = host.strip_suffix('.').unwrap_or(host);
    host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|character| character.is_ascii_alphanumeric() || character == b'-')
        })
}

fn reject_unsafe_literal_host(url: &Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "The URL does not contain a hostname.".to_string())?;
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return Err("The URL points to a local address.".to_string());
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        if !is_public_ip(address) {
            return Err("The URL points to a local address.".to_string());
        }
    }
    Ok(())
}

fn active_link_refreshes() -> &'static Mutex<HashSet<String>> {
    ACTIVE_LINK_REFRESHES.get_or_init(|| Mutex::new(HashSet::new()))
}

fn begin_link_refresh(id: &str) -> Result<Option<RefreshGuard>, String> {
    let mut active = active_link_refreshes()
        .lock()
        .map_err(|_| "The link refresh state is unavailable.".to_string())?;
    if !active.insert(id.to_string()) {
        return Ok(None);
    }
    Ok(Some(RefreshGuard { id: id.to_string() }))
}

struct FetchedResponse {
    final_url: Url,
    content_type: Option<String>,
    bytes: Vec<u8>,
}

fn fetch_page_metadata(url: &Url, hostname: &str) -> Result<PageMetadata, String> {
    let response = fetch_bounded(url, MAX_HTML_BYTES)?;
    if response
        .content_type
        .as_deref()
        .is_some_and(|content_type| {
            !content_type.starts_with("text/html")
                && !content_type.starts_with("application/xhtml+xml")
        })
    {
        return Err("The link did not return an HTML page.".to_string());
    }

    let html = String::from_utf8_lossy(&response.bytes);
    parse_page_metadata(&html, &response.final_url, hostname)
}

fn preview_link_metadata_file(
    store: &LibraryStore,
    raw_url: &str,
) -> Result<Option<String>, String> {
    let normalized_url = parse_normalized_link_url(raw_url)?;
    let destination = link_preview_cache_path(&store.paths, &normalized_url);

    if fs::symlink_metadata(&destination).is_ok_and(|metadata| metadata.file_type().is_file()) {
        return Ok(Some(destination.to_string_lossy().into_owned()));
    }

    let hostname = normalized_url
        .host_str()
        .ok_or_else(|| "The link preview hostname is invalid.".to_string())?;
    let metadata = match fetch_page_metadata(&normalized_url, hostname) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };
    let Some(preview_url) = metadata.preview_url else {
        return Ok(None);
    };

    let parent = destination
        .parent()
        .ok_or_else(|| "The link preview cache path is invalid.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "The link preview cache directory could not be created.".to_string())?;
    if download_image_asset(&preview_url, &destination, ImageFormat::Jpeg).is_err() {
        return Ok(None);
    }

    Ok(Some(destination.to_string_lossy().into_owned()))
}

fn link_preview_cache_path(paths: &LibraryPaths, normalized_url: &Url) -> PathBuf {
    let key = Uuid::new_v5(&Uuid::NAMESPACE_URL, normalized_url.as_str().as_bytes());
    paths
        .link_preview_cache_directory
        .join(key.to_string())
        .join("preview.jpg")
}

fn fetch_bounded(url: &Url, maximum_bytes: u64) -> Result<FetchedResponse, String> {
    let mut current_url = url.clone();

    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, addresses) = resolve_public_addresses(&current_url)?;
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(USER_AGENT)
            .resolve_to_addrs(&host, &addresses)
            .build()
            .map_err(|_| "The metadata client could not be created.".to_string())?;
        let response = client
            .get(current_url.clone())
            .send()
            .map_err(|_| "The remote resource could not be fetched.".to_string())?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("The remote resource redirected too many times.".to_string());
            }
            current_url = redirect_target(&current_url, &response)?;
            continue;
        }

        if !response.status().is_success() {
            return Err("The remote resource returned an error.".to_string());
        }
        if response
            .content_length()
            .is_some_and(|length| length > maximum_bytes)
        {
            return Err("The remote resource is too large.".to_string());
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_ascii_lowercase());
        let bytes = read_bounded_response(response, maximum_bytes)?;
        return Ok(FetchedResponse {
            final_url: current_url,
            content_type,
            bytes,
        });
    }

    Err("The remote resource could not be fetched.".to_string())
}

fn redirect_target(current_url: &Url, response: &Response) -> Result<Url, String> {
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "The redirect location is invalid.".to_string())?;
    let target = current_url
        .join(location)
        .map_err(|_| "The redirect location is invalid.".to_string())?;
    parse_normalized_link_url(target.as_str())
}

fn read_bounded_response(mut response: Response, maximum_bytes: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(maximum_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "The remote resource could not be read.".to_string())?;
    if bytes.len() as u64 > maximum_bytes {
        return Err("The remote resource is too large.".to_string());
    }
    Ok(bytes)
}

fn resolve_public_addresses(url: &Url) -> Result<(String, Vec<SocketAddr>), String> {
    reject_unsafe_literal_host(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| "The URL does not contain a hostname.".to_string())?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "The URL does not contain a usable port.".to_string())?;
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| "The hostname could not be resolved.".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("The URL points to a local address.".to_string());
    }
    Ok((host, addresses))
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_multicast()
                && !address.is_unspecified()
                && !address.is_broadcast()
        }
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            !address.is_loopback()
                && !address.is_unique_local()
                && !address.is_unicast_link_local()
                && !address.is_multicast()
                && !address.is_unspecified()
        }
    }
}

fn parse_page_metadata(html: &str, base_url: &Url, hostname: &str) -> Result<PageMetadata, String> {
    let document = Html::parse_document(html);
    let meta_selector = Selector::parse("meta")
        .map_err(|_| "The metadata selector could not be created.".to_string())?;
    let title_selector = Selector::parse("title")
        .map_err(|_| "The title selector could not be created.".to_string())?;
    let link_selector = Selector::parse("link")
        .map_err(|_| "The favicon selector could not be created.".to_string())?;

    let mut og_title = None;
    let mut twitter_title = None;
    let mut og_image = None;
    let mut twitter_image = None;
    for element in document.select(&meta_selector) {
        let value = element.value();
        let key = value
            .attr("property")
            .or_else(|| value.attr("name"))
            .unwrap_or_default();
        let content = value
            .attr("content")
            .map(str::trim)
            .filter(|value| !value.is_empty());
        match key.to_ascii_lowercase().as_str() {
            "og:title" if og_title.is_none() => og_title = content.map(ToOwned::to_owned),
            "twitter:title" if twitter_title.is_none() => {
                twitter_title = content.map(ToOwned::to_owned)
            }
            "og:image" if og_image.is_none() => og_image = content.map(ToOwned::to_owned),
            "twitter:image" if twitter_image.is_none() => {
                twitter_image = content.map(ToOwned::to_owned)
            }
            _ => {}
        }
    }

    let html_title = document
        .select(&title_selector)
        .next()
        .map(|element| collapse_whitespace(&element.text().collect::<String>()))
        .filter(|value| !value.is_empty());
    let title = og_title
        .or(twitter_title)
        .map(|value| collapse_whitespace(&value))
        .filter(|value| !value.is_empty())
        .or(html_title)
        .unwrap_or_else(|| hostname.to_string());
    let preview_url = og_image
        .or(twitter_image)
        .and_then(|value| resolve_metadata_url(base_url, &value));

    let mut favicon_candidates: [Option<String>; 3] = [None, None, None];
    for element in document.select(&link_selector) {
        let value = element.value();
        let Some(href) = value
            .attr("href")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let rel = value.attr("rel").unwrap_or_default().to_ascii_lowercase();
        let tokens = rel.split_whitespace().collect::<Vec<_>>();
        if tokens.contains(&"icon") && !tokens.contains(&"apple-touch-icon") {
            let index = if tokens.contains(&"shortcut") { 1 } else { 0 };
            favicon_candidates[index].get_or_insert_with(|| href.to_string());
        } else if tokens.contains(&"apple-touch-icon") {
            favicon_candidates[2].get_or_insert_with(|| href.to_string());
        }
    }
    let favicon_url = favicon_candidates
        .into_iter()
        .flatten()
        .find_map(|value| resolve_metadata_url(base_url, &value))
        .or_else(|| base_url.join("/favicon.ico").ok());

    Ok(PageMetadata {
        title,
        preview_url,
        favicon_url,
    })
}

fn resolve_metadata_url(base_url: &Url, raw_url: &str) -> Option<Url> {
    let url = base_url.join(raw_url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url)
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn download_link_assets(
    store: &LibraryStore,
    id: &str,
    metadata: &PageMetadata,
) -> (Option<String>, Option<String>) {
    let asset_directory = store.paths.link_assets_directory.join(id);
    if fs::create_dir_all(&asset_directory).is_err() {
        return (None, None);
    }

    let preview_relative_path = metadata.preview_url.as_ref().and_then(|url| {
        let destination = asset_directory.join("preview.jpg");
        download_image_asset(url, &destination, ImageFormat::Jpeg).ok()?;
        Some(format!(
            "{DATABASE_DIRECTORY_NAME}/{LINK_ASSETS_DIRECTORY_NAME}/{id}/preview.jpg"
        ))
    });
    let favicon_relative_path = metadata.favicon_url.as_ref().and_then(|url| {
        let destination = asset_directory.join("favicon.png");
        download_image_asset(url, &destination, ImageFormat::Png).ok()?;
        Some(format!(
            "{DATABASE_DIRECTORY_NAME}/{LINK_ASSETS_DIRECTORY_NAME}/{id}/favicon.png"
        ))
    });

    (preview_relative_path, favicon_relative_path)
}

fn download_image_asset(url: &Url, destination: &Path, format: ImageFormat) -> Result<(), String> {
    let response = fetch_bounded(url, MAX_IMAGE_BYTES)?;
    if !response
        .content_type
        .as_deref()
        .is_some_and(|content_type| content_type.starts_with("image/"))
    {
        return Err("The metadata asset is not an image.".to_string());
    }
    let mut reader = ImageReader::new(Cursor::new(response.bytes))
        .with_guessed_format()
        .map_err(|_| "The metadata image format could not be read.".to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_ALLOCATION);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "The metadata image could not be decoded.".to_string())?;
    write_image_atomically(destination, &image, format)
}

fn write_image_atomically(
    destination: &Path,
    image: &DynamicImage,
    format: ImageFormat,
) -> Result<(), String> {
    let temporary = destination.with_extension("tmp");
    let result = (|| {
        let mut file = File::create(&temporary)
            .map_err(|_| "The metadata image file could not be created.".to_string())?;
        match format {
            ImageFormat::Jpeg => JpegEncoder::new_with_quality(&mut file, 85)
                .encode_image(image)
                .map_err(|_| "The preview image could not be encoded.".to_string())?,
            ImageFormat::Png => image
                .write_to(&mut file, ImageFormat::Png)
                .map_err(|_| "The favicon image could not be encoded.".to_string())?,
            _ => return Err("The metadata image format is unsupported.".to_string()),
        }
        fs::rename(&temporary, destination)
            .map_err(|_| "The metadata image could not be saved.".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn import_files(
    store: &LibraryStore,
    paths: Vec<String>,
    active_space_id: Option<&str>,
) -> Result<ImportImageFilesResult, String> {
    let canonical_library = fs::canonicalize(&store.paths.library_directory)
        .map_err(|_| "The No. 8 Vault library directory could not be accessed.".to_string())?;
    let mut imported = Vec::new();
    let mut failed = Vec::new();
    let mut seen_inputs = HashSet::new();
    let mut seen_sources = HashSet::new();
    let batch_time = now_ms()?;

    for (input_index, raw_path) in paths.into_iter().enumerate() {
        let source = PathBuf::from(raw_path);
        if !seen_inputs.insert(source.clone()) {
            continue;
        }

        let source_file_name = display_file_name(&source);
        match validate_source(&source) {
            Ok(canonical_source) => {
                if !seen_sources.insert(canonical_source.clone()) {
                    continue;
                }

                match import_file(
                    store,
                    &canonical_source,
                    &canonical_library,
                    active_space_id,
                    batch_time.saturating_sub(i64::try_from(input_index).unwrap_or(i64::MAX)),
                ) {
                    Ok(item) => imported.push(item),
                    Err(reason) => failed.push(ImportFailure {
                        source_file_name,
                        reason,
                    }),
                }
            }
            Err(reason) => failed.push(ImportFailure {
                source_file_name,
                reason,
            }),
        }
    }

    sort_images(&mut imported);
    Ok(ImportImageFilesResult { imported, failed })
}

fn validate_source(source: &Path) -> Result<PathBuf, String> {
    if !source.is_absolute() {
        return Err("The selected path is not absolute.".to_string());
    }

    let metadata = fs::symlink_metadata(source)
        .map_err(|_| "The selected file does not exist or cannot be accessed.".to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Only regular image files can be imported.".to_string());
    }

    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The selected filename is not supported.".to_string())?;
    if file_name.starts_with('.') {
        return Err("Hidden files cannot be imported.".to_string());
    }
    if !has_supported_extension(source) {
        return Err("The selected file is not a supported image format.".to_string());
    }

    fs::canonicalize(source).map_err(|_| "The selected file could not be accessed.".to_string())
}

fn import_file(
    store: &LibraryStore,
    source: &Path,
    canonical_library: &Path,
    active_space_id: Option<&str>,
    registration_time: i64,
) -> Result<LibraryItem, String> {
    if source.parent() == Some(canonical_library) {
        return register_image_with_space(store, source, active_space_id, Some(registration_time));
    }

    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The selected filename is not supported.".to_string())?;
    let mut source_file =
        File::open(source).map_err(|_| "The selected image could not be opened.".to_string())?;
    let (destination, mut destination_file) =
        create_available_destination(&store.paths.library_directory, file_name)
            .map_err(|_| "A destination file could not be created.".to_string())?;

    if io::copy(&mut source_file, &mut destination_file).is_err() {
        drop(destination_file);
        let _ = fs::remove_file(&destination);
        return Err("The image could not be copied.".to_string());
    }
    drop(destination_file);

    match register_image_with_space(
        store,
        &destination,
        active_space_id,
        Some(registration_time),
    ) {
        Ok(item) => Ok(item),
        Err(reason) => {
            let _ = fs::remove_file(&destination);
            Err(reason)
        }
    }
}

fn save_clipboard_png(
    store: &LibraryStore,
    rgba: &[u8],
    width: u32,
    height: u32,
    active_space_id: Option<&str>,
) -> Result<LibraryItem, String> {
    validate_rgba_image(rgba, width, height)?;

    let (destination, destination_file) =
        create_available_destination(&store.paths.library_directory, PASTED_IMAGE_FILE_NAME)
            .map_err(|_| "A destination file could not be created.".to_string())?;

    if encode_png(destination_file, rgba, width, height).is_err() {
        let _ = fs::remove_file(&destination);
        return Err("The clipboard image could not be encoded.".to_string());
    }

    match register_image_with_space(store, &destination, active_space_id, None) {
        Ok(item) => Ok(item),
        Err(reason) => {
            let _ = fs::remove_file(&destination);
            Err(reason)
        }
    }
}

fn validate_rgba_image(rgba: &[u8], width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("The clipboard image has invalid dimensions.".to_string());
    }

    let expected_length = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "The clipboard image dimensions are too large.".to_string())?;

    if rgba.len() != expected_length {
        return Err("The clipboard image data is invalid.".to_string());
    }

    Ok(())
}

fn encode_png(file: File, rgba: &[u8], width: u32, height: u32) -> Result<(), png::EncodingError> {
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);

    let mut writer = encoder.write_header()?;
    writer.write_image_data(rgba)?;
    writer.finish()
}

fn is_clipboard_content_unavailable(error: &ClipboardError) -> bool {
    matches!(
        error,
        ClipboardError::Clipboard(message) if message == CLIPBOARD_CONTENT_NOT_AVAILABLE
    )
}

fn create_available_destination(
    library_directory: &Path,
    original_file_name: &str,
) -> io::Result<(PathBuf, File)> {
    let mut suffix = 1_u64;

    loop {
        let candidate_name = collision_file_name(original_file_name, suffix);
        let destination = library_directory.join(candidate_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(file) => return Ok((destination, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                suffix = suffix.checked_add(1).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::AlreadyExists, "No filename is available")
                })?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn collision_file_name(original_file_name: &str, suffix: u64) -> String {
    if suffix == 1 {
        return original_file_name.to_string();
    }

    let path = Path::new(original_file_name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(original_file_name);

    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) => format!("{stem}-{suffix}.{extension}"),
        None => format!("{stem}-{suffix}"),
    }
}

fn has_supported_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            SUPPORTED_EXTENSIONS
                .iter()
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}

fn display_file_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
}

fn now_ms() -> Result<i64, String> {
    system_time_ms(SystemTime::now())
        .ok_or_else(|| "The current time could not be read.".to_string())
}

fn modified_at_ms(metadata: &fs::Metadata) -> Option<i64> {
    metadata.modified().ok().and_then(system_time_ms)
}

fn system_time_ms(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn sort_images(images: &mut [LibraryItem]) {
    images.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "no8-library-test-{}-{}",
                std::process::id(),
                Uuid::new_v4()
            ));
            fs::create_dir_all(&path).expect("test directory should be created");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn insert_search_test_item(
        store: &LibraryStore,
        id: &str,
        item_type: &str,
        title: &str,
        relative_path: Option<&str>,
        url: Option<&str>,
        created_at_ms: i64,
        archived_at_ms: Option<i64>,
    ) {
        store
            .connection
            .execute(
                "INSERT INTO items (
                    id, item_type, title, relative_path, url,
                    preview_relative_path, favicon_relative_path, metadata_status,
                    created_at_ms, updated_at_ms, archived_at_ms, is_favorite
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, NULL, NULL,
                    CASE WHEN ?2 = 'link' THEN 'ready' ELSE NULL END,
                    ?6, ?6, ?7, 0
                 )",
                params![
                    id,
                    item_type,
                    title,
                    relative_path,
                    url,
                    created_at_ms,
                    archived_at_ms
                ],
            )
            .expect("search test item should be inserted");
    }

    #[test]
    fn search_ranks_titles_before_filenames_and_uses_stable_ties() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        insert_search_test_item(
            &store,
            "exact",
            "link",
            "Alpha",
            None,
            Some("https://example.com/exact"),
            10,
            None,
        );
        insert_search_test_item(
            &store,
            "prefix",
            "link",
            "Alphabet",
            None,
            Some("https://example.com/prefix"),
            50,
            None,
        );
        insert_search_test_item(
            &store,
            "contains-b",
            "link",
            "An alpha note",
            None,
            Some("https://example.com/contains-b"),
            100,
            None,
        );
        insert_search_test_item(
            &store,
            "contains-a",
            "link",
            "An alpha card",
            None,
            Some("https://example.com/contains-a"),
            100,
            None,
        );
        insert_search_test_item(
            &store,
            "filename",
            "image",
            "Unrelated",
            Some("Library/alpha-file.png"),
            None,
            200,
            None,
        );

        let results = query_search_items(&store.connection, &store.paths, "ALPHA", 30)
            .expect("search should succeed");
        assert_eq!(
            results
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["exact", "prefix", "contains-a", "contains-b", "filename"]
        );
    }

    #[test]
    fn search_matches_literal_wildcards_filenames_urls_and_archived_items() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        insert_search_test_item(
            &store,
            "percent",
            "link",
            "100% Pure",
            None,
            Some("https://example.com/percent"),
            1,
            None,
        );
        insert_search_test_item(
            &store,
            "underscore",
            "link",
            "under_score",
            None,
            Some("https://example.com/underscore"),
            2,
            None,
        );
        insert_search_test_item(
            &store,
            "backslash",
            "link",
            "back\\slash",
            None,
            Some("https://example.com/backslash"),
            3,
            None,
        );
        insert_search_test_item(
            &store,
            "wildcard-decoy",
            "link",
            "100X Pure",
            None,
            Some("https://example.com/decoy"),
            4,
            None,
        );
        insert_search_test_item(
            &store,
            "filename",
            "image",
            "Photo",
            Some("Library/Current-File.PNG"),
            None,
            5,
            None,
        );
        insert_search_test_item(
            &store,
            "archived-url",
            "link",
            "Archived website",
            None,
            Some("https://search.example.com/path"),
            6,
            Some(20),
        );

        for (query, expected) in [
            ("%", "percent"),
            ("_", "underscore"),
            ("\\", "backslash"),
            ("current-file", "filename"),
            ("search.example", "archived-url"),
        ] {
            let results = query_search_items(&store.connection, &store.paths, query, 30)
                .expect("search should succeed");
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].id, expected);
        }
        let archived = query_search_items(&store.connection, &store.paths, "ARCHIVED", 30)
            .expect("archived search should succeed");
        assert_eq!(archived[0].archived_at_ms, Some(20));
    }

    #[test]
    fn recent_and_search_limits_are_enforced() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        for index in 0..35 {
            let id = format!("item-{index:02}");
            let title = format!("Limit result {index:02}");
            let url = format!("https://example.com/{index:02}");
            insert_search_test_item(
                &store,
                &id,
                "link",
                &title,
                None,
                Some(&url),
                index,
                (index == 34).then_some(100),
            );
        }

        let search = query_search_items(&store.connection, &store.paths, "limit", 100)
            .expect("search should succeed");
        assert_eq!(search.len(), MAX_SEARCH_ITEMS);
        let recent = query_recent_items(&store.connection, &store.paths, 100)
            .expect("recent query should succeed");
        assert_eq!(recent.len(), MAX_RECENT_ITEMS);
        assert_eq!(recent[0].id, "item-33");
        assert!(recent.iter().all(|item| item.archived_at_ms.is_none()));
    }

    #[test]
    fn creates_versioned_database_schema() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let version: i64 = store
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("schema version should be readable");
        let table_count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'items'",
                [],
                |row| row.get(0),
            )
            .expect("items table should be queryable");

        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        assert_eq!(table_count, 1);
        assert!(store.paths.database_path.exists());
    }

    #[test]
    fn personal_and_many_to_many_memberships_are_persistent_and_idempotent() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let personal = query_spaces(&store.connection, None).expect("Spaces should query");
        assert_eq!(personal.len(), 1);
        assert_eq!(personal[0].id, PERSONAL_SPACE_ID);

        let item = create_link_item(&store, "https://example.com/organized", None)
            .expect("item should be created");
        let work = create_space_record(&store.connection, "Work", "blue", "folder", None)
            .expect("Work should be created");
        let ideas = create_space_record(&store.connection, "Ideas", "purple", "brain", None)
            .expect("Ideas should be created");
        assert!(create_space_record(&store.connection, "work", "gray", "heart", None).is_err());

        for _ in 0..2 {
            set_membership(
                &store.connection,
                "spaces",
                "item_spaces",
                "space_id",
                &item.id,
                &work.id,
                true,
            )
            .expect("Work should assign idempotently");
        }
        set_membership(
            &store.connection,
            "spaces",
            "item_spaces",
            "space_id",
            &item.id,
            &ideas.id,
            true,
        )
        .expect("Ideas should assign");
        assert_eq!(
            query_spaces(&store.connection, Some(&item.id))
                .unwrap()
                .len(),
            2
        );
        set_membership(
            &store.connection,
            "spaces",
            "item_spaces",
            "space_id",
            &item.id,
            &work.id,
            false,
        )
        .expect("Work should remove");
        assert_eq!(
            query_spaces(&store.connection, Some(&item.id)).unwrap()[0].id,
            ideas.id
        );

        let urgent = create_label_record(&store.connection, "Urgent", "red", Some(&item.id))
            .expect("Urgent should create and assign");
        let later = create_label_record(&store.connection, "Later", "gray", Some(&item.id))
            .expect("Later should create and assign");
        assert!(create_label_record(&store.connection, "urgent", "blue", None).is_err());
        assert_eq!(
            query_labels(&store.connection, Some(&item.id))
                .unwrap()
                .len(),
            2
        );
        set_membership(
            &store.connection,
            "labels",
            "item_labels",
            "label_id",
            &item.id,
            &urgent.id,
            false,
        )
        .expect("Urgent should remove");
        assert_eq!(
            query_labels(&store.connection, Some(&item.id)).unwrap()[0].id,
            later.id
        );

        store
            .connection
            .execute("DELETE FROM items WHERE id = ?1", [&item.id])
            .unwrap();
        let space_rows: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM item_spaces WHERE item_id = ?1",
                [&item.id],
                |row| row.get(0),
            )
            .unwrap();
        let label_rows: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM item_labels WHERE item_id = ?1",
                [&item.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((space_rows, label_rows), (0, 0));

        drop(store);
        let reopened = LibraryStore::open(&root.0).expect("store should reopen");
        let personal_count: i64 = reopened
            .connection
            .query_row(
                "SELECT COUNT(*) FROM spaces WHERE id = ?1",
                [PERSONAL_SPACE_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(personal_count, 1);
    }

    #[test]
    fn label_item_views_are_ordered_unique_active_and_preserve_item_state() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let older = create_link_item(&store, "https://example.com/label-older", None)
            .expect("older item should be created");
        let newer = create_link_item(&store, "https://example.com/label-newer", None)
            .expect("newer item should be created");
        let archived = create_link_item(&store, "https://example.com/label-archived", None)
            .expect("archived item should be created");
        store
            .connection
            .execute(
                "UPDATE items SET created_at_ms = CASE id
                    WHEN ?1 THEN 10 WHEN ?2 THEN 20 WHEN ?3 THEN 30 END",
                params![older.id, newer.id, archived.id],
            )
            .unwrap();

        let primary = create_label_record(&store.connection, "Primary", "blue", Some(&older.id))
            .expect("primary Label should create");
        let secondary =
            create_label_record(&store.connection, "Secondary", "green", Some(&older.id))
                .expect("secondary Label should create");
        for _ in 0..2 {
            set_membership(
                &store.connection,
                "labels",
                "item_labels",
                "label_id",
                &newer.id,
                &primary.id,
                true,
            )
            .expect("membership should be idempotent");
        }
        set_membership(
            &store.connection,
            "labels",
            "item_labels",
            "label_id",
            &archived.id,
            &primary.id,
            true,
        )
        .unwrap();
        set_stored_item_favorite(&store, &older.id, true).unwrap();
        create_space_record(
            &store.connection,
            "Label Space",
            "purple",
            "folder",
            Some(&older.id),
        )
        .unwrap();
        set_stored_item_archived(&store, &archived.id, true).unwrap();

        let items = query_items_for_label(&store.connection, &store.paths, &primary.id).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [newer.id.as_str(), older.id.as_str()]
        );
        assert!(
            items
                .iter()
                .find(|item| item.id == older.id)
                .unwrap()
                .is_favorite
        );
        assert_eq!(
            query_spaces(&store.connection, Some(&older.id))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            query_items_for_label(&store.connection, &store.paths, &secondary.id).unwrap()[0].id,
            older.id
        );

        set_stored_item_archived(&store, &archived.id, false).unwrap();
        let restored = query_items_for_label(&store.connection, &store.paths, &primary.id).unwrap();
        assert_eq!(restored[0].id, archived.id);
        assert!(query_items_for_label(&store.connection, &store.paths, "missing").is_err());
    }

    #[test]
    fn label_names_are_limited_without_changing_internal_spacing() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let label = create_label_record(&store.connection, "  Product   Ideas  ", "mint", None)
            .expect("valid Label should create");
        assert_eq!(label.name, "Product   Ideas");
        assert!(create_label_record(
            &store.connection,
            &"x".repeat(MAX_LABEL_NAME_LENGTH + 1),
            "gray",
            None,
        )
        .is_err());
    }

    #[test]
    fn updating_and_deleting_a_space_preserves_items_and_other_memberships() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let item = create_link_item(&store, "https://example.com/space-edit", None)
            .expect("item should be created");
        set_stored_item_favorite(&store, &item.id, true).expect("item should favorite");
        set_stored_item_archived(&store, &item.id, true).expect("item should archive");
        let label = create_label_record(&store.connection, "Reference", "teal", Some(&item.id))
            .expect("Label should create and assign");
        let space = create_space_record(
            &store.connection,
            "Projects",
            "blue",
            "folder",
            Some(&item.id),
        )
        .expect("Space should create and assign");

        let updated = update_space_record(
            &store.connection,
            &space.id,
            "  Projects 2026  ",
            "purple",
            "target",
        )
        .expect("Space should update");
        assert_eq!(updated.id, space.id);
        assert_eq!(updated.name, "Projects 2026");
        assert_eq!(updated.color_key, "purple");
        assert_eq!(updated.icon_key, "target");
        assert_eq!(
            query_spaces(&store.connection, Some(&item.id)).unwrap()[0].id,
            space.id
        );
        create_space_record(&store.connection, "Other", "gray", "heart", None)
            .expect("another Space should be created");
        assert!(
            update_space_record(&store.connection, &space.id, "other", "gray", "heart").is_err()
        );

        assert!(delete_space_record(&store.connection, &space.id).unwrap());
        assert!(query_spaces(&store.connection, Some(&item.id))
            .unwrap()
            .is_empty());
        assert_eq!(
            query_labels(&store.connection, Some(&item.id)).unwrap()[0].id,
            label.id
        );
        let persisted = query_database_item_by_id(&store.connection, &item.id)
            .unwrap()
            .expect("item should remain");
        assert!(persisted.is_favorite);
        assert!(persisted.archived_at_ms.is_some());
    }

    #[test]
    fn deleting_the_final_space_does_not_recreate_personal_on_reopen() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        assert!(delete_space_record(&store.connection, PERSONAL_SPACE_ID).unwrap());
        assert!(query_spaces(&store.connection, None).unwrap().is_empty());
        drop(store);

        let reopened = LibraryStore::open(&root.0).expect("store should reopen");
        assert!(query_spaces(&reopened.connection, None).unwrap().is_empty());
    }

    #[test]
    fn batch_imports_preserve_input_order_after_reload() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let source_directory = root.0.join("incoming");
        fs::create_dir_all(&source_directory).unwrap();
        let first = source_directory.join("z-first.png");
        let second = source_directory.join("a-second.png");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();

        let result = import_files(
            &store,
            vec![
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            None,
        )
        .expect("batch should import");
        assert_eq!(
            result
                .imported
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            ["z-first", "a-second"]
        );
        let reloaded = query_library_items(&store.connection, &store.paths, LibraryQuery::Active)
            .expect("items should reload");
        assert_eq!(
            reloaded
                .iter()
                .map(|item| item.title.as_str())
                .collect::<Vec<_>>(),
            ["z-first", "a-second"]
        );
    }

    #[test]
    fn active_space_imports_assign_images_and_restore_duplicate_links() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let image = save_clipboard_png(&store, &[255, 0, 0, 255], 1, 1, Some(PERSONAL_SPACE_ID))
            .expect("clipboard image should assign");
        assert_eq!(
            query_spaces(&store.connection, Some(&image.id))
                .unwrap()
                .len(),
            1
        );

        let link = create_link_item(&store, "https://example.com/reuse", None)
            .expect("link should create");
        set_stored_item_archived(&store, &link.id, true).expect("link should archive");
        let reused = create_link_item(
            &store,
            "HTTPS://EXAMPLE.COM/reuse#fragment",
            Some(PERSONAL_SPACE_ID),
        )
        .expect("duplicate should restore and assign");
        assert_eq!(reused.id, link.id);
        assert!(reused.archived_at_ms.is_none());
        assert_eq!(
            query_spaces(&store.connection, Some(&link.id))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn migrates_v1_images_without_changing_identity_or_timestamps() {
        let root = TestDirectory::new();
        let vault = root.0.join(VAULT_DIRECTORY_NAME);
        let database_directory = vault.join(DATABASE_DIRECTORY_NAME);
        fs::create_dir_all(vault.join(LIBRARY_DIRECTORY_NAME)).expect("library should be created");
        fs::create_dir_all(&database_directory).expect("database directory should be created");
        let database_path = database_directory.join(DATABASE_FILE_NAME);
        let connection = Connection::open(&database_path).expect("v1 database should open");
        connection
            .execute_batch(
                "CREATE TABLE items (
                    id TEXT PRIMARY KEY NOT NULL,
                    item_type TEXT NOT NULL CHECK (item_type IN ('image')),
                    title TEXT NOT NULL,
                    relative_path TEXT NOT NULL UNIQUE,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                INSERT INTO items VALUES (
                    'stable-image-id', 'image', 'Existing', 'Library/existing.png', 1000, 2000
                );
                PRAGMA user_version = 1;",
            )
            .expect("v1 schema should be created");
        drop(connection);

        let store = LibraryStore::open(&root.0).expect("v1 store should migrate");
        let item = query_database_item_by_id(&store.connection, "stable-image-id")
            .expect("item query should succeed")
            .expect("image should remain");
        let version: i64 = store
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version should be readable");

        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        assert_eq!(item.id, "stable-image-id");
        assert_eq!(item.relative_path.as_deref(), Some("Library/existing.png"));
        assert_eq!(item.created_at_ms, 1_000);
        assert_eq!(item.updated_at_ms, 2_000);
        assert!(item.url.is_none());
        assert!(item.archived_at_ms.is_none());
        assert!(!item.is_favorite);

        drop(store);
        LibraryStore::open(&root.0).expect("the migrated store should reopen idempotently");
    }

    #[test]
    fn migrates_v2_items_to_active_v4_rows_without_changing_identity() {
        let root = TestDirectory::new();
        let vault = root.0.join(VAULT_DIRECTORY_NAME);
        let database_directory = vault.join(DATABASE_DIRECTORY_NAME);
        fs::create_dir_all(vault.join(LIBRARY_DIRECTORY_NAME)).expect("library should be created");
        fs::create_dir_all(&database_directory).expect("database directory should be created");
        let connection = Connection::open(database_directory.join(DATABASE_FILE_NAME))
            .expect("v2 database should open");
        connection
            .execute_batch(
                "CREATE TABLE items (
                    id TEXT PRIMARY KEY NOT NULL,
                    item_type TEXT NOT NULL CHECK (item_type IN ('image', 'link')),
                    title TEXT NOT NULL,
                    relative_path TEXT UNIQUE,
                    url TEXT UNIQUE,
                    preview_relative_path TEXT,
                    favicon_relative_path TEXT,
                    metadata_status TEXT CHECK (
                        metadata_status IS NULL OR metadata_status IN ('pending', 'ready', 'failed')
                    ),
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    CHECK (
                        (item_type = 'image' AND relative_path IS NOT NULL AND url IS NULL
                            AND preview_relative_path IS NULL AND favicon_relative_path IS NULL
                            AND metadata_status IS NULL)
                        OR
                        (item_type = 'link' AND relative_path IS NULL AND url IS NOT NULL
                            AND metadata_status IS NOT NULL)
                    )
                );
                INSERT INTO items VALUES (
                    'stable-link-id', 'link', 'Existing Link', NULL,
                    'https://example.com/', NULL, NULL, 'pending', 1000, 2000
                );
                PRAGMA user_version = 2;",
            )
            .expect("v2 schema should be created");
        drop(connection);

        let store = LibraryStore::open(&root.0).expect("v2 store should migrate");
        let item = query_database_item_by_id(&store.connection, "stable-link-id")
            .expect("item query should succeed")
            .expect("link should remain");
        let version: i64 = store
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version should be readable");

        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        assert_eq!(item.id, "stable-link-id");
        assert_eq!(item.url.as_deref(), Some("https://example.com/"));
        assert!(item.archived_at_ms.is_none());
        assert!(!item.is_favorite);

        drop(store);
        LibraryStore::open(&root.0).expect("the migrated store should reopen idempotently");
    }

    #[test]
    fn migrates_v3_rows_without_losing_archive_or_link_metadata() {
        let root = TestDirectory::new();
        let vault = root.0.join(VAULT_DIRECTORY_NAME);
        let database_directory = vault.join(DATABASE_DIRECTORY_NAME);
        fs::create_dir_all(vault.join(LIBRARY_DIRECTORY_NAME)).expect("library should be created");
        fs::create_dir_all(&database_directory).expect("database directory should be created");
        let connection = Connection::open(database_directory.join(DATABASE_FILE_NAME))
            .expect("v3 database should open");
        connection
            .execute_batch(
                "CREATE TABLE items (
                    id TEXT PRIMARY KEY NOT NULL,
                    item_type TEXT NOT NULL CHECK (item_type IN ('image', 'link')),
                    title TEXT NOT NULL,
                    relative_path TEXT UNIQUE,
                    url TEXT UNIQUE,
                    preview_relative_path TEXT,
                    favicon_relative_path TEXT,
                    metadata_status TEXT CHECK (
                        metadata_status IS NULL OR metadata_status IN ('pending', 'ready', 'failed')
                    ),
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    archived_at_ms INTEGER,
                    CHECK (
                        (item_type = 'image' AND relative_path IS NOT NULL AND url IS NULL
                            AND preview_relative_path IS NULL AND favicon_relative_path IS NULL
                            AND metadata_status IS NULL)
                        OR
                        (item_type = 'link' AND relative_path IS NULL AND url IS NOT NULL
                            AND metadata_status IS NOT NULL)
                    )
                );
                INSERT INTO items VALUES (
                    'archived-link-id', 'link', 'Archived Link', NULL,
                    'https://example.com/archived',
                    '.no8/assets/links/archived-link-id/preview.jpg',
                    '.no8/assets/links/archived-link-id/favicon.png',
                    'ready', 1000, 2000, 3000
                );
                PRAGMA user_version = 3;",
            )
            .expect("v3 schema should be created");
        drop(connection);

        let store = LibraryStore::open(&root.0).expect("v3 store should migrate");
        let item = query_database_item_by_id(&store.connection, "archived-link-id")
            .expect("item query should succeed")
            .expect("link should remain");
        let version: i64 = store
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version should be readable");

        assert_eq!(version, DATABASE_SCHEMA_VERSION);
        assert_eq!(item.id, "archived-link-id");
        assert_eq!(item.title, "Archived Link");
        assert_eq!(item.url.as_deref(), Some("https://example.com/archived"));
        assert_eq!(item.metadata_status.as_deref(), Some("ready"));
        assert_eq!(item.archived_at_ms, Some(3_000));
        assert_eq!(item.created_at_ms, 1_000);
        assert_eq!(item.updated_at_ms, 2_000);
        assert!(!item.is_favorite);
    }

    #[test]
    fn favorite_column_rejects_values_outside_boolean_range() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let item = create_link_item(&store, "https://example.com/check", None)
            .expect("link should be created");

        let result = store
            .connection
            .execute("UPDATE items SET is_favorite = 2 WHERE id = ?1", [&item.id]);

        assert!(result.is_err());
    }

    #[test]
    fn normalizes_full_and_scheme_less_links() {
        let normalized = parse_normalized_link_url("  HTTPS://Example.COM/path?q=1#section  ")
            .expect("full URL should normalize");
        let domain =
            parse_normalized_link_url("vercel.com").expect("scheme-less domain should normalize");
        let nested = parse_normalized_link_url("docs.example.com/path?q=1#section")
            .expect("scheme-less path should normalize");

        assert_eq!(normalized.as_str(), "https://example.com/path?q=1");
        assert_eq!(domain.as_str(), "https://vercel.com/");
        assert_eq!(nested.as_str(), "https://docs.example.com/path?q=1");
    }

    #[test]
    fn rejects_invalid_link_inputs() {
        for input in [
            "Vercel",
            "https://example.com/a path",
            "ftp://example.com",
            "https://user:pass@example.com",
            "http://127.0.0.1",
            "http://localhost",
            "example..com",
        ] {
            assert!(
                parse_normalized_link_url(input).is_err(),
                "{input} should be rejected"
            );
        }
    }

    #[test]
    fn duplicate_normalized_links_keep_one_stable_row() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");

        let first = create_link_item(&store, "https://example.com/page#first", None)
            .expect("first link should be created");
        let second = create_link_item(&store, "HTTPS://EXAMPLE.COM/page#second", None)
            .expect("duplicate link should be returned");
        let count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM items WHERE item_type = 'link'",
                [],
                |row| row.get(0),
            )
            .expect("link count should be readable");

        assert_eq!(first.id, second.id);
        assert_eq!(count, 1);
        assert_eq!(first.url.as_deref(), Some("https://example.com/page"));
    }

    #[test]
    fn clipboard_text_ignores_invalid_values_and_reuses_link_rows() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");

        assert!(
            create_link_item_from_clipboard_text(&store, "not a url", None)
                .expect("invalid clipboard text should be ignored")
                .is_none()
        );

        let first = create_link_item_from_clipboard_text(&store, "example.com/page#first", None)
            .expect("valid clipboard text should create a link")
            .expect("link should be returned");
        let second =
            create_link_item_from_clipboard_text(&store, "https://example.com/page#second", None)
                .expect("duplicate clipboard text should be accepted")
                .expect("existing link should be returned");

        assert_eq!(first.id, second.id);
        assert_eq!(first.url.as_deref(), Some("https://example.com/page"));
    }

    #[test]
    fn blocks_private_and_special_ip_destinations() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "::",
        ] {
            assert!(!is_public_ip(address.parse().expect("IP should parse")));
        }
        assert!(is_public_ip("1.1.1.1".parse().expect("IP should parse")));
        assert!(is_public_ip(
            "2606:4700:4700::1111".parse().expect("IP should parse")
        ));
    }

    #[test]
    fn parses_metadata_priority_and_resolves_relative_assets() {
        let base = Url::parse("https://example.com/articles/page").expect("base URL should parse");
        let metadata = parse_page_metadata(
            r#"
                <html><head>
                  <title>HTML title</title>
                  <meta name="twitter:title" content="Twitter title">
                  <meta property="og:title" content="Open Graph title">
                  <meta name="twitter:image" content="/twitter.jpg">
                  <meta property="og:image" content="../preview.webp">
                  <link rel="apple-touch-icon" href="/apple.png">
                  <link rel="shortcut icon" href="/shortcut.ico">
                  <link rel="icon" href="icons/favicon.png">
                </head></html>
            "#,
            &base,
            "example.com",
        )
        .expect("metadata should parse");

        assert_eq!(metadata.title, "Open Graph title");
        assert_eq!(
            metadata.preview_url.as_ref().map(Url::as_str),
            Some("https://example.com/preview.webp")
        );
        assert_eq!(
            metadata.favicon_url.as_ref().map(Url::as_str),
            Some("https://example.com/articles/icons/favicon.png")
        );
    }

    #[test]
    fn link_preview_cache_paths_are_deterministic_and_scoped() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let first = parse_normalized_link_url("example.com/path?q=1#first")
            .expect("first URL should normalize");
        let second = parse_normalized_link_url("https://example.com/path?q=1#second")
            .expect("second URL should normalize");
        let first_path = link_preview_cache_path(&store.paths, &first);
        let second_path = link_preview_cache_path(&store.paths, &second);

        assert_eq!(first_path, second_path);
        assert!(first_path.starts_with(&store.paths.link_preview_cache_directory));
        assert_eq!(
            first_path.file_name().and_then(|name| name.to_str()),
            Some("preview.jpg")
        );
        let key = first_path
            .parent()
            .and_then(Path::file_name)
            .and_then(OsStr::to_str)
            .expect("cache key should exist");
        assert!(Uuid::parse_str(key).is_ok());
        assert!(!first_path.to_string_lossy().contains("?q=1"));
    }

    #[test]
    fn link_preview_reuses_an_existing_cached_file() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let normalized = parse_normalized_link_url("example.com").expect("URL should normalize");
        let destination = link_preview_cache_path(&store.paths, &normalized);
        fs::create_dir_all(destination.parent().expect("cache parent should exist"))
            .expect("cache directory should be created");
        fs::write(&destination, b"cached preview").expect("cached preview should be written");

        let result = preview_link_metadata_file(&store, "https://example.com/#ignored")
            .expect("cached preview should be returned")
            .expect("cached preview path should exist");

        assert_eq!(Path::new(&result), destination);
    }

    #[test]
    fn metadata_without_a_preview_candidate_stays_previewless() {
        let base = Url::parse("https://example.com/page").expect("base URL should parse");
        let metadata = parse_page_metadata(
            "<html><head><title>Example</title></head></html>",
            &base,
            "example.com",
        )
        .expect("metadata should parse");

        assert!(metadata.preview_url.is_none());
    }

    #[test]
    fn validates_link_asset_paths_for_their_own_item_only() {
        let id = Uuid::new_v4().to_string();
        let valid = format!(".no8/assets/links/{id}/preview.jpg");
        let wrong_file = format!(".no8/assets/links/{id}/other.jpg");
        let other_id = Uuid::new_v4().to_string();

        assert!(validate_link_asset_relative_path(&valid, &id, "preview.jpg").is_ok());
        assert!(validate_link_asset_relative_path(&wrong_file, &id, "preview.jpg").is_err());
        assert!(validate_link_asset_relative_path(&valid, &other_id, "preview.jpg").is_err());
    }

    #[test]
    fn repeated_indexing_keeps_one_row_and_stable_id() {
        let root = TestDirectory::new();
        let mut store = LibraryStore::open(&root.0).expect("store should open");
        fs::write(
            store.paths.library_directory.join("visible.png"),
            b"visible",
        )
        .expect("visible image should be written");
        fs::write(
            store.paths.library_directory.join(".temporary.gif"),
            b"hidden",
        )
        .expect("hidden image should be written");
        fs::create_dir_all(store.paths.library_directory.join("nested"))
            .expect("nested directory should be created");
        fs::write(
            store.paths.library_directory.join("nested/nested.jpg"),
            b"nested",
        )
        .expect("nested image should be written");

        reconcile_library(&mut store).expect("first indexing should succeed");
        let first = query_library_items(&store.connection, &store.paths, LibraryQuery::Active)
            .expect("first query should succeed");
        reconcile_library(&mut store).expect("second indexing should succeed");
        let second = query_library_items(&store.connection, &store.paths, LibraryQuery::Active)
            .expect("second query should succeed");

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].id, second[0].id);
        assert_eq!(first[0].file_name.as_deref(), Some("visible.png"));
    }

    #[test]
    fn registering_same_relative_path_twice_preserves_uuid_and_creation_time() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let image_path = store.paths.library_directory.join("same.jpg");
        fs::write(&image_path, b"same").expect("image should be written");

        let first = register_image(&store.connection, &store.paths, &image_path, 1_000)
            .expect("first registration should succeed");
        let second = register_image(&store.connection, &store.paths, &image_path, 2_000)
            .expect("second registration should succeed");
        let count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .expect("row count should be readable");

        assert_eq!(first.id, second.id);
        assert_eq!(second.created_at_ms, 1_000);
        assert_eq!(count, 1);
    }

    #[test]
    fn database_ids_remain_stable_after_reopening() {
        let root = TestDirectory::new();
        let stable_id = {
            let store = LibraryStore::open(&root.0).expect("store should open");
            let image_path = store.paths.library_directory.join("stable.webp");
            fs::write(&image_path, b"stable").expect("image should be written");
            register_image(&store.connection, &store.paths, &image_path, 1_000)
                .expect("image should register")
                .id
        };

        let reopened = LibraryStore::open(&root.0).expect("store should reopen");
        let items =
            query_library_items(&reopened.connection, &reopened.paths, LibraryQuery::Active)
                .expect("items should query after reopening");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, stable_id);
    }

    #[test]
    fn queries_newest_items_first_with_filename_tie_breaker() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        for (file_name, created_at_ms) in [("z.png", 1_000), ("b.png", 2_000), ("a.png", 2_000)] {
            let path = store.paths.library_directory.join(file_name);
            fs::write(&path, file_name).expect("image should be written");
            register_image(&store.connection, &store.paths, &path, created_at_ms)
                .expect("image should register");
        }

        let items = query_library_items(&store.connection, &store.paths, LibraryQuery::Active)
            .expect("items should be queried");
        let names = items
            .iter()
            .filter_map(|item| item.file_name.as_deref())
            .collect::<Vec<_>>();

        assert_eq!(names, ["a.png", "b.png", "z.png"]);
    }

    #[test]
    fn imports_partial_batches_without_overwriting_or_duplicate_rows() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let first_source_directory = root.0.join("first");
        let second_source_directory = root.0.join("second");
        fs::create_dir_all(&first_source_directory)
            .expect("first source directory should be created");
        fs::create_dir_all(&second_source_directory)
            .expect("second source directory should be created");

        let first_source = first_source_directory.join("photo.JPG");
        let second_source = second_source_directory.join("photo.JPG");
        let unsupported_source = second_source_directory.join("notes.txt");
        fs::write(&first_source, b"first").expect("first source should be written");
        fs::write(&second_source, b"second").expect("second source should be written");
        fs::write(&unsupported_source, b"unsupported")
            .expect("unsupported source should be written");

        let result = import_files(
            &store,
            vec![
                first_source.to_string_lossy().into_owned(),
                first_source.to_string_lossy().into_owned(),
                second_source.to_string_lossy().into_owned(),
                unsupported_source.to_string_lossy().into_owned(),
            ],
            None,
        )
        .expect("batch import should complete");

        assert_eq!(result.imported.len(), 2);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(
            fs::read(store.paths.library_directory.join("photo.JPG")).unwrap(),
            b"first"
        );
        assert_eq!(
            fs::read(store.paths.library_directory.join("photo-2.JPG")).unwrap(),
            b"second"
        );

        let existing_path = store.paths.library_directory.join("photo.JPG");
        let existing_result = import_files(
            &store,
            vec![existing_path.to_string_lossy().into_owned()],
            None,
        )
        .expect("existing library image should register");
        let count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .expect("row count should be readable");

        assert_eq!(existing_result.imported.len(), 1);
        assert_eq!(count, 2);
        assert!(!store.paths.library_directory.join("photo-3.JPG").exists());
    }

    #[test]
    fn saves_clipboard_pngs_with_collision_names_and_database_rows() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let rgba = [255, 0, 0, 255, 0, 255, 0, 255];

        let first = save_clipboard_png(&store, &rgba, 2, 1, None)
            .expect("first clipboard image should be saved");
        let second = save_clipboard_png(&store, &rgba, 2, 1, None)
            .expect("second clipboard image should be saved");

        assert_eq!(first.file_name.as_deref(), Some("Pasted Image.png"));
        assert_eq!(second.file_name.as_deref(), Some("Pasted Image-2.png"));
        assert_ne!(first.id, second.id);

        let decoder = png::Decoder::new(BufReader::new(
            File::open(store.paths.library_directory.join("Pasted Image.png"))
                .expect("saved PNG should open"),
        ));
        let reader = decoder.read_info().expect("saved PNG should decode");
        assert_eq!(reader.info().width, 2);
        assert_eq!(reader.info().height, 1);
        assert_eq!(reader.info().color_type, png::ColorType::Rgba);
    }

    #[test]
    fn invalid_clipboard_data_leaves_no_file_or_database_row() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");

        let result = save_clipboard_png(&store, &[255, 0, 0], 1, 1, None);
        let count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .expect("row count should be readable");

        assert!(result.is_err());
        assert!(!store
            .paths
            .library_directory
            .join(PASTED_IMAGE_FILE_NAME)
            .exists());
        assert_eq!(count, 0);
    }

    #[test]
    fn validates_supported_extensions_and_collision_names() {
        for file_name in [
            "image.png",
            "image.JPG",
            "image.Jpeg",
            "image.webp",
            "image.GIF",
        ] {
            assert!(has_supported_extension(Path::new(file_name)));
        }
        for file_name in ["image.svg", "image.heic", "image.pdf", "image"] {
            assert!(!has_supported_extension(Path::new(file_name)));
        }

        assert_eq!(collision_file_name("photo.jpg", 1), "photo.jpg");
        assert_eq!(collision_file_name("photo.jpg", 2), "photo-2.jpg");
        assert_eq!(
            collision_file_name("archive.preview.PNG", 3),
            "archive.preview-3.PNG"
        );
    }

    #[test]
    fn image_and_link_favorites_persist_and_repeated_updates_preserve_other_fields() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let image_path = store.paths.library_directory.join("favorite.png");
        fs::write(&image_path, b"image bytes").expect("image should be written");
        let image = register_image(&store.connection, &store.paths, &image_path, 1_000)
            .expect("image should register");
        let link = create_link_item(&store, "https://example.com/favorite", None)
            .expect("link should be created");
        let image_before = query_database_item_by_id(&store.connection, &image.id)
            .expect("image should query")
            .expect("image should exist");
        let link_before = query_database_item_by_id(&store.connection, &link.id)
            .expect("link should query")
            .expect("link should exist");

        let favorite_image =
            set_stored_item_favorite(&store, &image.id, true).expect("image should favorite");
        let repeated_image = set_stored_item_favorite(&store, &image.id, true)
            .expect("repeated image favorite should succeed");
        let favorite_link =
            set_stored_item_favorite(&store, &link.id, true).expect("link should favorite");

        assert!(favorite_image.is_favorite);
        assert!(repeated_image.is_favorite);
        assert!(favorite_link.is_favorite);
        let image_after = query_database_item_by_id(&store.connection, &image.id)
            .expect("image should query")
            .expect("image should exist");
        let link_after = query_database_item_by_id(&store.connection, &link.id)
            .expect("link should query")
            .expect("link should exist");
        assert_eq!(image_after.updated_at_ms, image_before.updated_at_ms);
        assert_eq!(image_after.relative_path, image_before.relative_path);
        assert_eq!(link_after.updated_at_ms, link_before.updated_at_ms);
        assert_eq!(link_after.url, link_before.url);

        let active = query_library_items(&store.connection, &store.paths, LibraryQuery::Active)
            .expect("active items should query");
        let favorites =
            query_library_items(&store.connection, &store.paths, LibraryQuery::Favorites)
                .expect("favorites should query");
        assert_eq!(
            favorites.iter().map(|item| &item.id).collect::<Vec<_>>(),
            active
                .iter()
                .filter(|item| item.is_favorite)
                .map(|item| &item.id)
                .collect::<Vec<_>>()
        );

        let unfavorite_link =
            set_stored_item_favorite(&store, &link.id, false).expect("link should unfavorite");
        assert!(!unfavorite_link.is_favorite);
        assert_eq!(
            query_library_items(&store.connection, &store.paths, LibraryQuery::Favorites)
                .expect("favorites should query")
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [image.id.as_str()]
        );
        assert!(set_stored_item_favorite(&store, "missing-item", true).is_err());
    }

    #[test]
    fn archive_and_restore_preserve_favorite_membership() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let item = create_link_item(&store, "https://example.com/archive-favorite", None)
            .expect("link should be created");
        set_stored_item_favorite(&store, &item.id, true).expect("link should favorite");

        let archived =
            set_stored_item_archived(&store, &item.id, true).expect("link should archive");
        assert!(archived.is_favorite);
        assert!(
            query_library_items(&store.connection, &store.paths, LibraryQuery::Favorites)
                .expect("favorites should query")
                .is_empty()
        );
        let archived_items =
            query_library_items(&store.connection, &store.paths, LibraryQuery::Archived)
                .expect("archive should query");
        assert_eq!(archived_items[0].id, item.id);
        assert!(archived_items[0].is_favorite);

        let restored =
            set_stored_item_archived(&store, &item.id, false).expect("link should restore");
        assert_eq!(restored.id, item.id);
        assert!(restored.is_favorite);
        assert_eq!(
            query_library_items(&store.connection, &store.paths, LibraryQuery::Favorites)
                .expect("favorites should query")[0]
                .id,
            item.id
        );
    }

    #[test]
    fn active_and_archived_queries_are_separate_and_restore_keeps_the_id() {
        let root = TestDirectory::new();
        let store = LibraryStore::open(&root.0).expect("store should open");
        let first = create_link_item(&store, "https://example.com/first", None)
            .expect("first link should be created");
        let second = create_link_item(&store, "https://example.com/second", None)
            .expect("second link should be created");

        set_stored_item_archived(&store, &first.id, true).expect("first item should archive");
        store
            .connection
            .execute(
                "UPDATE items SET archived_at_ms = 1000 WHERE id = ?1",
                [&first.id],
            )
            .expect("first archive timestamp should update");
        set_stored_item_archived(&store, &second.id, true).expect("second item should archive");
        store
            .connection
            .execute(
                "UPDATE items SET archived_at_ms = 2000 WHERE id = ?1",
                [&second.id],
            )
            .expect("second archive timestamp should update");

        assert!(
            query_library_items(&store.connection, &store.paths, LibraryQuery::Active)
                .expect("active items should query")
                .is_empty()
        );
        let archived = query_library_items(&store.connection, &store.paths, LibraryQuery::Archived)
            .expect("archived items should query");
        assert_eq!(
            archived
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [&second.id, &first.id]
        );

        let restored =
            set_stored_item_archived(&store, &first.id, false).expect("first item should restore");
        assert_eq!(restored.id, first.id);
        assert!(restored.archived_at_ms.is_none());
        assert_eq!(
            query_library_items(&store.connection, &store.paths, LibraryQuery::Active)
                .expect("active items should query after restore")[0]
                .id,
            first.id
        );
    }

    #[test]
    fn image_rename_preserves_extension_and_does_not_overwrite_collisions() {
        let root = TestDirectory::new();
        let mut store = LibraryStore::open(&root.0).expect("store should open");
        let source = store.paths.library_directory.join("Original.JPG");
        let collision = store.paths.library_directory.join("Renamed.JPG");
        fs::write(&source, b"source bytes").expect("source should be written");
        fs::write(&collision, b"collision bytes").expect("collision should be written");
        let original = register_image(&store.connection, &store.paths, &source, 1_000)
            .expect("source should register");

        let renamed = rename_stored_item(&mut store, &original.id, "  Renamed  ")
            .expect("image should rename");

        assert_eq!(renamed.id, original.id);
        assert_eq!(renamed.title, "Renamed");
        assert_eq!(renamed.file_name.as_deref(), Some("Renamed-2.JPG"));
        assert!(!source.exists());
        assert_eq!(
            fs::read(collision).expect("collision should remain"),
            b"collision bytes"
        );
        assert_eq!(
            fs::read(store.paths.library_directory.join("Renamed-2.JPG"))
                .expect("renamed image should exist"),
            b"source bytes"
        );
    }

    #[test]
    fn link_rename_changes_only_the_display_title() {
        let root = TestDirectory::new();
        let mut store = LibraryStore::open(&root.0).expect("store should open");
        let original = create_link_item(&store, "https://example.com/unchanged", None)
            .expect("link should be created");

        let renamed = rename_stored_item(&mut store, &original.id, "  New title  ")
            .expect("link should rename");

        assert_eq!(renamed.id, original.id);
        assert_eq!(renamed.title, "New title");
        assert_eq!(renamed.url, original.url);
        assert_eq!(renamed.preview_path, original.preview_path);
        assert_eq!(renamed.favicon_path, original.favicon_path);
    }

    #[test]
    fn image_paths_cannot_escape_or_target_nested_library_content() {
        assert!(validate_image_relative_path("Library/photo.png").is_ok());
        for path in [
            "Library/../outside.png",
            "Library/nested/photo.png",
            "/tmp/photo.png",
            ".no8/library.png",
        ] {
            assert!(
                validate_image_relative_path(path).is_err(),
                "{path} should be rejected"
            );
        }
    }

    #[test]
    fn deleting_one_link_removes_only_its_owned_assets() {
        let root = TestDirectory::new();
        let mut store = LibraryStore::open(&root.0).expect("store should open");
        let first = create_link_item(&store, "https://example.com/first-delete", None)
            .expect("first link should be created");
        let second = create_link_item(&store, "https://example.com/second-keep", None)
            .expect("second link should be created");
        let first_asset = store.paths.link_assets_directory.join(&first.id);
        let second_asset = store.paths.link_assets_directory.join(&second.id);
        fs::create_dir_all(&first_asset).expect("first asset directory should exist");
        fs::create_dir_all(&second_asset).expect("second asset directory should exist");
        fs::write(first_asset.join("preview.jpg"), b"first").expect("first preview should exist");
        fs::write(second_asset.join("preview.jpg"), b"second")
            .expect("second preview should exist");
        set_stored_item_favorite(&store, &first.id, true)
            .expect("deleted link should favorite first");

        let result = delete_stored_item(&mut store, &first.id).expect("first link should delete");

        assert!(result.deleted);
        assert!(result.cleanup_warning.is_none());
        assert!(!first_asset.exists());
        assert!(second_asset.exists());
        assert!(query_database_item_by_id(&store.connection, &first.id)
            .expect("first row should query")
            .is_none());
        assert!(query_database_item_by_id(&store.connection, &second.id)
            .expect("second row should query")
            .is_some());
    }

    #[test]
    fn recognizes_only_the_clipboard_content_unavailable_error() {
        let no_image = ClipboardError::Clipboard(CLIPBOARD_CONTENT_NOT_AVAILABLE.to_string());
        let genuine_failure = ClipboardError::Clipboard("Clipboard access failed".to_string());

        assert!(is_clipboard_content_unavailable(&no_image));
        assert!(!is_clipboard_content_unavailable(&genuine_failure));
    }
}
