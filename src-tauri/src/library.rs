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
use url::{Host, ParseError, Url};
use uuid::Uuid;

const SUPPORTED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];
const VAULT_DIRECTORY_NAME: &str = "No. 8 Vault";
const LIBRARY_DIRECTORY_NAME: &str = "Library";
const DATABASE_DIRECTORY_NAME: &str = ".no8";
const DATABASE_FILE_NAME: &str = "no8.sqlite";
const LINK_ASSETS_DIRECTORY_NAME: &str = "assets/links";
const LINK_PREVIEW_CACHE_DIRECTORY_NAME: &str = "cache/link-previews";
const DATABASE_SCHEMA_VERSION: i64 = 2;
const PASTED_IMAGE_FILE_NAME: &str = "Pasted Image.png";
const MAX_REDIRECTS: usize = 5;
const MAX_HTML_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 8_192;
const MAX_IMAGE_ALLOCATION: u64 = 128 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "no8/0.1";
const CLIPBOARD_CONTENT_NOT_AVAILABLE: &str =
    "The clipboard contents were not available in the requested format or the clipboard is empty.";
static ACTIVE_LINK_REFRESHES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

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
pub struct ListImportedImagesResult {
    items: Vec<LibraryItem>,
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
pub async fn import_clipboard_item(app: AppHandle) -> Result<Option<LibraryItem>, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open(&documents_directory)?;
        let clipboard = app.clipboard();
        match clipboard.read_image() {
            Ok(image) => {
                return save_clipboard_png(&store, image.rgba(), image.width(), image.height())
                    .map(Some)
            }
            Err(error) if is_clipboard_content_unavailable(&error) => {}
            Err(_) => return Err("The clipboard image could not be read.".to_string()),
        }

        match clipboard.read_text() {
            Ok(text) => create_link_item_from_clipboard_text(&store, &text),
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
) -> Result<ImportImageFilesResult, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open(&documents_directory)?;
        import_files(&store, paths)
    })
    .await
    .map_err(|_| "The image import task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn list_imported_images(app: AppHandle) -> Result<ListImportedImagesResult, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut store = LibraryStore::open(&documents_directory)?;
        reconcile_library(&mut store)?;
        let items = query_library_items(&store.connection, &store.paths)?;

        Ok(ListImportedImagesResult { items })
    })
    .await
    .map_err(|_| "The image library could not be read.".to_string())?
}

#[tauri::command]
pub async fn create_link(app: AppHandle, url: String) -> Result<LibraryItem, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open(&documents_directory)?;
        create_link_item(&store, &url)
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
        let store = LibraryStore::open(&documents_directory)?;
        preview_link_metadata_file(&store, &url)
    })
    .await
    .map_err(|_| "The link preview task could not be completed.".to_string())?
}

#[tauri::command]
pub async fn refresh_link_metadata(app: AppHandle, id: String) -> Result<LibraryItem, String> {
    let documents_directory = documents_directory_path(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let store = LibraryStore::open(&documents_directory)?;
        refresh_link_item(&store, &id)
    })
    .await
    .map_err(|_| "The link metadata task could not be completed.".to_string())?
}

impl LibraryStore {
    fn open(documents_directory: &Path) -> Result<Self, String> {
        let paths = resolve_library_paths(documents_directory);
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
        migrate_database(&mut connection)?;

        Ok(Self { paths, connection })
    }
}

fn documents_directory_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .document_dir()
        .map_err(|_| "The Documents directory is unavailable.".to_string())
}

fn resolve_library_paths(documents_directory: &Path) -> LibraryPaths {
    let vault_directory = documents_directory.join(VAULT_DIRECTORY_NAME);
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
                .execute_batch(V2_SCHEMA)
                .map_err(|_| "The No. 8 database schema could not be created.".to_string())?;
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
                    "{V2_SCHEMA_TEMP}
                     INSERT INTO items_v2 (
                         id, item_type, title, relative_path, url,
                         preview_relative_path, favicon_relative_path, metadata_status,
                         created_at_ms, updated_at_ms
                     )
                     SELECT id, item_type, title, relative_path, NULL,
                            NULL, NULL, NULL, created_at_ms, updated_at_ms
                     FROM items;
                     DROP TABLE items;
                     ALTER TABLE items_v2 RENAME TO items;"
                ))
                .map_err(|_| "The No. 8 database schema could not be upgraded.".to_string())?;
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

const V2_SCHEMA: &str = "CREATE TABLE items (
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
);";

const V2_SCHEMA_TEMP: &str = "CREATE TABLE items_v2 (
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
);";

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
                      created_at_ms, updated_at_ms",
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
) -> Result<Vec<LibraryItem>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, item_type, title, relative_path, url,
                    preview_relative_path, favicon_relative_path, metadata_status,
                    created_at_ms, updated_at_ms
             FROM items
             ORDER BY created_at_ms DESC, COALESCE(relative_path, url) ASC",
        )
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

fn create_link_item(store: &LibraryStore, raw_url: &str) -> Result<LibraryItem, String> {
    let normalized_url = parse_normalized_link_url(raw_url)?;
    create_normalized_link_item(store, &normalized_url)
}

fn create_link_item_from_clipboard_text(
    store: &LibraryStore,
    clipboard_text: &str,
) -> Result<Option<LibraryItem>, String> {
    let normalized_url = match parse_normalized_link_url(clipboard_text) {
        Ok(url) => url,
        Err(_) => return Ok(None),
    };
    create_normalized_link_item(store, &normalized_url).map(Some)
}

fn create_normalized_link_item(
    store: &LibraryStore,
    normalized_url: &Url,
) -> Result<LibraryItem, String> {
    let normalized = normalized_url.as_str();

    if let Some(existing) = query_database_item_by_url(&store.connection, normalized)? {
        return library_item_from_database(&store.paths, existing);
    }

    let id = Uuid::new_v4().to_string();
    let title = normalized_url
        .host_str()
        .ok_or_else(|| "Enter a full web address.".to_string())?;
    let timestamp = now_ms()?;
    let item = store
        .connection
        .query_row(
            "INSERT INTO items (
                id, item_type, title, relative_path, url,
                preview_relative_path, favicon_relative_path, metadata_status,
                created_at_ms, updated_at_ms
             ) VALUES (?1, 'link', ?2, NULL, ?3, NULL, NULL, 'pending', ?4, ?4)
             ON CONFLICT(url) DO UPDATE SET url = excluded.url
             RETURNING id, item_type, title, relative_path, url,
                       preview_relative_path, favicon_relative_path, metadata_status,
                       created_at_ms, updated_at_ms",
            params![id, title, normalized, timestamp],
            database_item_from_row,
        )
        .map_err(|_| "The link could not be added to the library.".to_string())?;

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

fn query_database_item_by_url(
    connection: &Connection,
    url: &str,
) -> Result<Option<DatabaseItem>, String> {
    query_database_item(connection, "url", url)
}

fn query_database_item(
    connection: &Connection,
    column: &str,
    value: &str,
) -> Result<Option<DatabaseItem>, String> {
    let sql = format!(
        "SELECT id, item_type, title, relative_path, url,
                preview_relative_path, favicon_relative_path, metadata_status,
                created_at_ms, updated_at_ms
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
) -> Result<ImportImageFilesResult, String> {
    let canonical_library = fs::canonicalize(&store.paths.library_directory)
        .map_err(|_| "The No. 8 Vault library directory could not be accessed.".to_string())?;
    let mut imported = Vec::new();
    let mut failed = Vec::new();
    let mut seen_inputs = HashSet::new();
    let mut seen_sources = HashSet::new();

    for raw_path in paths {
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

                match import_file(store, &canonical_source, &canonical_library) {
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
) -> Result<LibraryItem, String> {
    if source.parent() == Some(canonical_library) {
        return register_image(&store.connection, &store.paths, source, now_ms()?);
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

    match register_image(&store.connection, &store.paths, &destination, now_ms()?) {
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
) -> Result<LibraryItem, String> {
    validate_rgba_image(rgba, width, height)?;

    let (destination, destination_file) =
        create_available_destination(&store.paths.library_directory, PASTED_IMAGE_FILE_NAME)
            .map_err(|_| "A destination file could not be created.".to_string())?;

    if encode_png(destination_file, rgba, width, height).is_err() {
        let _ = fs::remove_file(&destination);
        return Err("The clipboard image could not be encoded.".to_string());
    }

    match register_image(&store.connection, &store.paths, &destination, now_ms()?) {
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

        assert_eq!(version, 2);
        assert_eq!(item.id, "stable-image-id");
        assert_eq!(item.relative_path.as_deref(), Some("Library/existing.png"));
        assert_eq!(item.created_at_ms, 1_000);
        assert_eq!(item.updated_at_ms, 2_000);
        assert!(item.url.is_none());
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

        let first = create_link_item(&store, "https://example.com/page#first")
            .expect("first link should be created");
        let second = create_link_item(&store, "HTTPS://EXAMPLE.COM/page#second")
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

        assert!(create_link_item_from_clipboard_text(&store, "not a url")
            .expect("invalid clipboard text should be ignored")
            .is_none());

        let first = create_link_item_from_clipboard_text(&store, "example.com/page#first")
            .expect("valid clipboard text should create a link")
            .expect("link should be returned");
        let second =
            create_link_item_from_clipboard_text(&store, "https://example.com/page#second")
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
        let first = query_library_items(&store.connection, &store.paths)
            .expect("first query should succeed");
        reconcile_library(&mut store).expect("second indexing should succeed");
        let second = query_library_items(&store.connection, &store.paths)
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
        let items = query_library_items(&reopened.connection, &reopened.paths)
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

        let items =
            query_library_items(&store.connection, &store.paths).expect("items should be queried");
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
        let existing_result =
            import_files(&store, vec![existing_path.to_string_lossy().into_owned()])
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

        let first =
            save_clipboard_png(&store, &rgba, 2, 1).expect("first clipboard image should be saved");
        let second = save_clipboard_png(&store, &rgba, 2, 1)
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

        let result = save_clipboard_png(&store, &[255, 0, 0], 1, 1);
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
    fn recognizes_only_the_clipboard_content_unavailable_error() {
        let no_image = ClipboardError::Clipboard(CLIPBOARD_CONTENT_NOT_AVAILABLE.to_string());
        let genuine_failure = ClipboardError::Clipboard("Clipboard access failed".to_string());

        assert!(is_clipboard_content_unavailable(&no_image));
        assert!(!is_clipboard_content_unavailable(&genuine_failure));
    }
}
