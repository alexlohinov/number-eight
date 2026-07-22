mod library;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            library::create_link,
            library::import_clipboard_item,
            library::import_image_files,
            library::list_imported_images,
            library::normalize_link_url,
            library::preview_link_metadata,
            library::refresh_link_metadata
        ])
        .run(tauri::generate_context!())
        .expect("error while running No. 8");
}
