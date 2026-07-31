mod library;
mod native_menu;
mod settings;
mod vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder
        .menu(native_menu::build_native_menu)
        .on_menu_event(native_menu::handle_menu_event);

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
            use tauri::Manager;

            let settings = settings::SettingsState::load(app.handle())?;
            let stored = settings.get()?;
            settings::apply_native_theme(app.handle(), &stored.theme)?;
            let runtime =
                vault::VaultRuntime::initialize(app.handle(), stored.vault_root.as_deref())?;
            app.manage(settings);
            app.manage(runtime);

            #[cfg(desktop)]
            {
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
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
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
            library::list_items_for_label,
            library::list_items_for_space,
            library::list_labels,
            library::list_labels_for_item,
            library::list_library_items,
            library::list_recent_items,
            library::list_spaces,
            library::list_spaces_for_item,
            library::normalize_link_url,
            library::native_share_available,
            library::open_library_item,
            library::preview_link_metadata,
            library::refresh_link_metadata,
            library::rename_library_item,
            library::reveal_library_image,
            library::search_items,
            library::set_library_item_archived,
            library::set_library_item_favorite,
            library::set_item_label_membership,
            library::set_item_space_membership,
            library::share_item,
            library::update_space,
            settings::get_app_bootstrap,
            settings::update_app_preferences,
            settings::reset_window_layout,
            vault::get_vault_summary,
            vault::reveal_active_vault,
            vault::open_source_repository,
            vault::choose_vault_destination,
            vault::back_up_vault,
            vault::execute_vault_change,
            vault::cancel_vault_migration,
            vault::retry_active_vault,
            vault::locate_unavailable_vault,
            vault::switch_to_default_vault,
            native_menu::sync_native_menu_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running No. 8");
}
