use tauri::Manager;
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::Emitter;

mod ffmpeg;
mod logging;
mod asset;
pub use ffmpeg::{ffmpeg_probe, ffmpeg_download_clip, ffmpeg_compose_clips, ffmpeg_merge_audio, ffmpeg_write_data_uri, ffmpeg_export};
pub use logging::{log_write, log_path, log_open_dir};
pub use asset::{asset_stats_project, asset_clean_project, asset_clean_all, asset_read_as_data_uri, asset_stat_path};

#[tauri::command]
async fn write_export_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            write_export_file,
            ffmpeg_probe,
            ffmpeg_download_clip,
            ffmpeg_compose_clips,
            ffmpeg_merge_audio,
            ffmpeg_write_data_uri,
            ffmpeg_export,
            log_write,
            log_path,
            log_open_dir,
            asset_stats_project,
            asset_clean_project,
            asset_clean_all,
            asset_read_as_data_uri,
            asset_stat_path
        ])
        .setup(|app| {
            // System tray
            let show_item = MenuItemBuilder::with_id("show", "Show MoJing").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&show_item, &quit_item])
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("MoJing 墨境")
                .menu(&tray_menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Handle window close — emit event to frontend, let it decide
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = app_handle.emit("close-requested", ());
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MoJing");
}
