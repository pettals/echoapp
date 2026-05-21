mod audio;
mod config;
mod focus;
mod groq;
mod history;
mod input;
mod media;
mod model_download;
mod secure;
mod setup;
mod whisper;

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

use audio::RecorderHandle;
use config::AppConfig;
use focus::FocusTarget;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

const NO_SPEECH_DETECTED: &str = "NO_SPEECH_DETECTED";
const INDICATOR_COMPACT_WIDTH: f64 = 68.0;
const INDICATOR_COMPACT_HEIGHT: f64 = 16.0;
const INDICATOR_BOTTOM_OFFSET: f64 = 34.0;

struct AppState {
    recorder: Mutex<RecorderHandle>,
    focus_target: Mutex<FocusTarget>,
    recording_level: Arc<audio::SharedLevel>,
    recording_active: Arc<AtomicBool>,
    download_state: Arc<model_download::DownloadState>,
    quit_requested: Arc<AtomicBool>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

fn place_indicator_in_work_area(
    indicator: &tauri::WebviewWindow,
    monitor: Option<tauri::Monitor>,
    ind_w: f64,
    ind_h: f64,
) {
    if let Some(monitor) = monitor {
        let work_area = monitor.work_area();
        let size = work_area.size;
        let pos = work_area.position;
        let scale = monitor.scale_factor();

        let mon_x = pos.x as f64 / scale;
        let mon_y = pos.y as f64 / scale;
        let mon_w = size.width as f64 / scale;
        let mon_h = size.height as f64 / scale;
        let x = mon_x + (mon_w - ind_w) / 2.0;
        let y = mon_y + mon_h - ind_h - INDICATOR_BOTTOM_OFFSET;

        let _ = indicator.set_size(tauri::LogicalSize::new(ind_w, ind_h));
        let _ = indicator.set_position(tauri::LogicalPosition::new(x, y));
    }
}

fn ensure_indicator_visible(app: &tauri::AppHandle) {
    // Capture the frontmost app NOW, before showing the indicator, so that
    // a later HUD-click can paste back into the correct target.
    if let Some(state) = app.try_state::<AppState>() {
        let target = FocusTarget::capture();
        if !target.is_self_app() {
            if let Ok(mut ft) = state.focus_target.lock() {
                *ft = target;
            }
        }
    }

    if let Some(indicator) = app.get_webview_window("indicator") {
        indicator.set_always_on_top(true).ok();

        // Use the primary monitor so the HUD stays on the active
        // display and never pulls the user to the main window's space.
        let monitor = app.primary_monitor().ok().flatten();

        place_indicator_in_work_area(
            &indicator,
            monitor,
            INDICATOR_COMPACT_WIDTH,
            INDICATOR_COMPACT_HEIGHT,
        );

        // Apply non-activating setup BEFORE showing so the window never
        // triggers activation, even on the initial show().
        #[cfg(target_os = "macos")]
        unsafe {
            make_indicator_non_activating(&indicator);
            let ns_win = indicator.ns_window().unwrap() as *mut objc::runtime::Object;
            // Keep the HUD with the active Space instead of pulling the user
            // back to the Space where the app window last lived.
            let _: () = objc::msg_send![ns_win, setCollectionBehavior: 1u64 << 1 | 1u64 << 4];
        }

        indicator.show().ok();
    }
}

#[tauri::command]
fn reposition_indicator(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    let indicator = app
        .get_webview_window("indicator")
        .ok_or_else(|| "Indicator window not found".to_string())?;
    let monitor = app.primary_monitor().map_err(|e| e.to_string())?;

    place_indicator_in_work_area(&indicator, monitor, width, height);
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_main_vibrancy(window: &tauri::WebviewWindow) {
    let _ = apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        Some(34.0),
    );
}

#[cfg(target_os = "macos")]
unsafe fn make_indicator_non_activating(window: &tauri::WebviewWindow) {
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel, BOOL, NO, YES};

    extern "C" {
        fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
    }

    let ns_window_ptr = match window.ns_window() {
        Ok(ptr) => ptr as *mut Object,
        Err(_) => return,
    };
    if ns_window_ptr.is_null() {
        return;
    }

    static REGISTER: std::sync::Once = std::sync::Once::new();
    REGISTER.call_once(|| {
        let superclass = Class::get("NSWindow").unwrap();
        let mut decl = ClassDecl::new("EchoIndicatorWindow", superclass).unwrap();

        extern "C" fn no(_this: &Object, _cmd: Sel) -> BOOL {
            NO
        }
        extern "C" fn yes(_this: &Object, _cmd: Sel) -> BOOL {
            YES
        }
        extern "C" fn yes_event(_this: &Object, _cmd: Sel, _event: *mut Object) -> BOOL {
            YES
        }

        unsafe {
            decl.add_method(
                sel!(canBecomeKeyWindow),
                no as extern "C" fn(&Object, Sel) -> BOOL,
            );
            decl.add_method(
                sel!(canBecomeMainWindow),
                no as extern "C" fn(&Object, Sel) -> BOOL,
            );
            decl.add_method(
                sel!(_preventsActivation),
                yes as extern "C" fn(&Object, Sel) -> BOOL,
            );
            // Deliver the first click directly without requiring activation.
            decl.add_method(
                sel!(acceptsFirstMouse:),
                yes_event as extern "C" fn(&Object, Sel, *mut Object) -> BOOL,
            );
            // Prevent AppKit from reordering windows (and activating) on click.
            decl.add_method(
                sel!(shouldDelayWindowOrderingForEvent:),
                yes_event as extern "C" fn(&Object, Sel, *mut Object) -> BOOL,
            );
        }
        decl.register();
    });

    let cls = Class::get("EchoIndicatorWindow").unwrap();
    object_setClass(ns_window_ptr, cls);

    let ns_color_class = Class::get("NSColor").unwrap();
    let clear_color: *mut Object = objc::msg_send![ns_color_class, clearColor];
    let _: () = objc::msg_send![ns_window_ptr, setBackgroundColor: clear_color];
    let _: () = objc::msg_send![ns_window_ptr, setOpaque: false];

    // NSStatusWindowLevel (25) keeps the HUD reliably above all normal and
    // floating windows so it never falls behind the focused app.
    let _: () = objc::msg_send![ns_window_ptr, setLevel: 25i64];
    let _: () = objc::msg_send![ns_window_ptr, setIgnoresMouseEvents: false];
    let _: () = objc::msg_send![ns_window_ptr, setHidesOnDeactivate: false];
}

#[derive(Serialize)]
struct ScreenSize {
    width: u32,
    height: u32,
}

#[tauri::command]
fn get_config() -> AppConfig {
    AppConfig::load()
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    config.save()
}

#[tauri::command]
fn get_setup_status() -> setup::SetupStatus {
    let cfg = AppConfig::load();
    setup::get_status(&cfg)
}

#[tauri::command]
fn validate_shortcut(shortcut: String) -> setup::ShortcutValidation {
    setup::validate_shortcut(&shortcut)
}

#[tauri::command]
fn open_setup_help(target: String) -> Result<(), String> {
    setup::open_help(&target)
}

#[tauri::command]
fn request_accessibility_permission() -> Result<bool, String> {
    setup::request_accessibility_permission()
}

#[tauri::command]
fn get_screen_size(app: tauri::AppHandle) -> Result<ScreenSize, String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("Monitor error: {e}"))?
        .ok_or("No primary monitor")?;
    let size = monitor.size();
    Ok(ScreenSize {
        width: size.width,
        height: size.height,
    })
}

#[tauri::command]
fn capture_focus(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let target = FocusTarget::capture();
    *state
        .focus_target
        .lock()
        .map_err(|e| format!("Lock error: {e}"))? = target;
    Ok(())
}

#[tauri::command]
fn start_recording(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    let cfg = AppConfig::load();
    let mut recorder = state.recorder.lock().map_err(|e| format!("Lock error: {e}"))?;
    recorder.start(cfg.input_device.as_deref(), Arc::clone(&state.recording_level))?;
    state.recording_active.store(true, Ordering::SeqCst);
    ensure_indicator_visible(&app);
    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.recording_active.store(false, Ordering::SeqCst);
    let mut recorder = state.recorder.lock().map_err(|e| format!("Lock error: {e}"))?;
    let path = recorder.stop()?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn is_recording(state: tauri::State<'_, AppState>) -> bool {
    state
        .recorder
        .lock()
        .map(|r| r.is_recording())
        .unwrap_or(false)
}

#[tauri::command]
fn get_recording_level(state: tauri::State<'_, AppState>) -> f32 {
    if !state.recording_active.load(Ordering::SeqCst) {
        return 0.0;
    }
    state.recording_level.take()
}

#[tauri::command]
async fn transcribe_audio(audio_path: String) -> Result<String, String> {
    let cfg = AppConfig::load();
    let path = std::path::PathBuf::from(&audio_path);

    let speech_path = path.clone();
    let has_speech = tokio::task::spawn_blocking(move || audio::has_speech(&speech_path))
        .await
        .map_err(|e| format!("Task error: {e}"))??;

    if !has_speech {
        return Err(NO_SPEECH_DETECTED.to_string());
    }

    match cfg.model_provider.as_str() {
        "local" => {
            let model_size = cfg.local_model_size.clone();
            tokio::task::spawn_blocking(move || whisper::transcribe_local(&path, &model_size))
                .await
                .map_err(|e| format!("Task error: {e}"))?
        }
        _ => {
            if cfg.groq_api_key.is_empty() {
                return Err("Groq API key not configured".to_string());
            }
            groq::transcribe(&cfg.groq_api_key, &path, &cfg.transcription_model).await
        }
    }
}

#[tauri::command]
async fn cleanup_text(text: String) -> Result<String, String> {
    let cfg = AppConfig::load();
    if cfg.groq_api_key.is_empty() {
        return Err("Groq API key not configured".to_string());
    }
    if !cfg.cleanup_enabled {
        return Ok(text);
    }
    groq::cleanup(&cfg.groq_api_key, &text, &cfg.cleanup_model).await
}

#[tauri::command]
fn paste_transcript(text: String, state: tauri::State<'_, AppState>, _app: tauri::AppHandle) -> Result<String, String> {
    input::write_clipboard(&text)?;

    if !setup::is_accessibility_trusted() {
        eprintln!("Paste simulation skipped: Echo is not trusted for Accessibility.");
        return Ok("copied_accessibility".to_string());
    }

    let target = state
        .focus_target
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?
        .clone();

    if target.is_self_app() || !target.has_target() {
        return Ok("copied".to_string());
    }

    if let Err(e) = target.restore() {
        eprintln!("Focus restore failed, falling back to clipboard: {e}");
        return Ok("copied".to_string());
    }

    std::thread::sleep(std::time::Duration::from_millis(250));

    match input::simulate_paste() {
        Ok(()) => Ok("pasted".to_string()),
        Err(e) => {
            eprintln!("Paste simulation failed, text is on clipboard: {e}");
            Ok("copied_accessibility".to_string())
        }
    }
}

#[cfg(target_os = "macos")]
fn sound_name_to_path(name: &str) -> Option<&'static str> {
    match name {
        "glass" => Some("/System/Library/Sounds/Glass.aiff"),
        "tink" => Some("/System/Library/Sounds/Tink.aiff"),
        "pop" => Some("/System/Library/Sounds/Pop.aiff"),
        "hero" => Some("/System/Library/Sounds/Hero.aiff"),
        "purr" => Some("/System/Library/Sounds/Purr.aiff"),
        "morse" => Some("/System/Library/Sounds/Morse.aiff"),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn sound_name_to_ps(name: &str) -> &'static str {
    match name {
        "glass" => "[System.Media.SystemSounds]::Asterisk.Play()",
        "tink" => "[System.Media.SystemSounds]::Exclamation.Play()",
        "pop" => "[System.Media.SystemSounds]::Asterisk.Play()",
        "hero" => "[System.Media.SystemSounds]::Hand.Play()",
        "purr" => "[System.Media.SystemSounds]::Beep.Play()",
        "morse" => "[System.Media.SystemSounds]::Question.Play()",
        _ => "[System.Media.SystemSounds]::Asterisk.Play()",
    }
}

fn play_sound_by_name(name: &str) -> Result<(), String> {
    if name == "none" {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let path = sound_name_to_path(name)
            .unwrap_or("/System/Library/Sounds/Glass.aiff");
        std::process::Command::new("afplay")
            .arg(path)
            .spawn()
            .map_err(|e| format!("afplay error: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let cmd = sound_name_to_ps(name);
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", cmd])
            .spawn()
            .map_err(|e| format!("powershell error: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = name;
        Ok(())
    }
}

#[tauri::command]
fn play_chime() -> Result<(), String> {
    let cfg = AppConfig::load();
    if !cfg.sounds_enabled || cfg.success_sound == "none" {
        return Ok(());
    }
    play_sound_by_name(&cfg.success_sound)
}

#[tauri::command]
fn play_indicator_sound(kind: String) -> Result<(), String> {
    let cfg = AppConfig::load();
    if !cfg.sounds_enabled || cfg.indicator_sound == "none" {
        return Ok(());
    }
    let _ = kind;
    play_sound_by_name(&cfg.indicator_sound)
}

#[tauri::command]
fn play_sound_preview(sound: String) -> Result<(), String> {
    play_sound_by_name(&sound)
}

#[tauri::command]
fn pause_media() -> Result<(), String> {
    media::pause_media()
}

#[tauri::command]
fn resume_media() -> Result<(), String> {
    media::resume_media()
}

#[tauri::command]
fn check_model_status(model_size: String, state: tauri::State<'_, AppState>) -> model_download::ModelStatus {
    model_download::check_model_status(&model_size, &state.download_state)
}

#[tauri::command]
async fn download_whisper_model(model_size: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let dl_state = Arc::clone(&state.download_state);
    model_download::download_model(&model_size, dl_state).await
}

#[tauri::command]
fn get_model_download_progress(state: tauri::State<'_, AppState>) -> model_download::DownloadProgress {
    state.download_state.progress()
}

#[tauri::command]
async fn delete_whisper_model(model_size: String) -> Result<(), String> {
    model_download::delete_model(&model_size).await
}

#[tauri::command]
fn list_audio_devices() -> Result<Vec<String>, String> {
    audio::list_devices()
}

#[tauri::command]
fn test_microphone(device_name: Option<String>) -> Result<f32, String> {
    audio::test_mic(device_name.as_deref())
}

#[tauri::command]
fn list_transcript_history() -> Vec<history::HistoryItem> {
    history::load_all()
}

#[tauri::command]
fn add_transcript_history(text: String, paste_result: String) -> Result<history::HistoryItem, String> {
    let cfg = AppConfig::load();
    if !cfg.history_enabled {
        return Err("History is disabled".to_string());
    }
    history::add(&text, &paste_result, cfg.history_limit)
}

#[tauri::command]
fn copy_transcript(text: String) -> Result<(), String> {
    input::write_clipboard(&text)
}

#[tauri::command]
fn delete_transcript_history(id: String) -> Result<(), String> {
    history::delete(&id)
}

#[tauri::command]
fn clear_transcript_history() -> Result<(), String> {
    history::clear()
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    show_main_window_internal(&app);
}

fn show_main_window_internal(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if let Some(indicator) = app.get_webview_window("indicator") {
        let _ = indicator.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            recorder: Mutex::new(RecorderHandle::new()),
            focus_target: Mutex::new(FocusTarget::None),
            recording_level: Arc::new(audio::SharedLevel::new()),
            recording_active: Arc::new(AtomicBool::new(false)),
            download_state: Arc::new(model_download::DownloadState::new()),
            quit_requested: Arc::new(AtomicBool::new(false)),
        })
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_always_on_top(false).ok();

            #[cfg(target_os = "macos")]
            unsafe {
                use objc::runtime::{Class, Object};
                if let Ok(ns_win) = window.ns_window() {
                    let ns_window_ptr = ns_win as *mut Object;
                    if !ns_window_ptr.is_null() {
                        let ns_color_class = Class::get("NSColor").unwrap();
                        let clear_color: *mut Object = objc::msg_send![ns_color_class, clearColor];
                        let _: () = objc::msg_send![ns_window_ptr, setBackgroundColor: clear_color];
                        let _: () = objc::msg_send![ns_window_ptr, setOpaque: false];
                    }
                }
                apply_main_vibrancy(&window);
            }

            // Hide instead of close when the user clicks the red traffic light.
            // We use hide() to remove the window from the dock / Cmd-Tab, but
            // the webview stays alive so global-shortcut IPC keeps working.
            let main_for_close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = main_for_close.hide();
                    #[cfg(target_os = "macos")]
                    let _ = main_for_close.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            });

            // --- System tray / menu bar icon ---
            let open_i = MenuItem::with_id(app, "open_app", "Open Echo", true, None::<&str>)?;
            let start_i = MenuItem::with_id(app, "start_recording", "Start Recording", true, None::<&str>)?;
            let stop_i = MenuItem::with_id(app, "stop_recording", "Stop Recording", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Completely Close Echo", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[&open_i, &sep, &start_i, &stop_i, &sep2, &settings_i, &quit_i],
            )?;

            let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("Echo")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open_app" => {
                        show_main_window_internal(app);
                    }
                    "start_recording" => {
                        let _ = app.emit("tray-start-recording", ());
                    }
                    "stop_recording" => {
                        let _ = app.emit("tray-stop-recording", ());
                    }
                    "settings" => {
                        show_main_window_internal(app);
                        let _ = app.emit("tray-open-settings", ());
                    }
                    "quit" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            state.quit_requested.store(true, Ordering::SeqCst);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_setup_status,
            validate_shortcut,
            open_setup_help,
            request_accessibility_permission,
            reposition_indicator,
            get_screen_size,
            capture_focus,
            start_recording,
            stop_recording,
            is_recording,
            get_recording_level,
            transcribe_audio,
            cleanup_text,
            paste_transcript,
            play_chime,
            play_indicator_sound,
            play_sound_preview,
            pause_media,
            resume_media,
            check_model_status,
            download_whisper_model,
            get_model_download_progress,
            delete_whisper_model,
            list_audio_devices,
            test_microphone,
            list_transcript_history,
            add_transcript_history,
            copy_transcript,
            delete_transcript_history,
            clear_transcript_history,
            show_main_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let should_quit = app
                    .try_state::<AppState>()
                    .map(|s| s.quit_requested.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if !should_quit {
                    api.prevent_exit();
                }
            }
        });
}
