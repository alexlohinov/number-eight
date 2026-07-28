mod library;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_filter(|label| label == "main")
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::SIZE
                    | tauri_plugin_window_state::StateFlags::POSITION
                    | tauri_plugin_window_state::StateFlags::MAXIMIZED,
            )
            .build(),
    );

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::Manager;

                let main_window = app.get_webview_window("main").ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "main application window was not created",
                    )
                })?;
                main_window.show()?;
                main_window.set_focus()?;
            }
            Ok(())
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            library::copy_library_image,
            library::create_label,
            library::create_label_and_assign,
            library::create_link,
            library::create_space,
            library::create_space_and_assign,
            library::delete_space,
            library::delete_library_item,
            library::import_clipboard_item,
            library::import_image_files,
            library::list_favorite_items,
            library::list_items_for_space,
            library::list_labels,
            library::list_labels_for_item,
            library::list_library_items,
            library::list_spaces,
            library::list_spaces_for_item,
            library::normalize_link_url,
            library::native_share_available,
            library::open_library_item,
            library::preview_link_metadata,
            library::refresh_link_metadata,
            library::rename_library_item,
            library::reveal_library_image,
            library::set_library_item_archived,
            library::set_library_item_favorite,
            library::set_item_label_membership,
            library::set_item_space_membership,
            library::share_item,
            library::update_space
        ])
        .run(tauri::generate_context!())
        .expect("error while running No. 8");
}
