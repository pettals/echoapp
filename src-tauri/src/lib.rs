mod audio;
mod config;
mod focus;
mod groq;
mod history;
mod input;
mod model_download;
mod whisper;

use audio::RecorderHandle;
use config::AppConfig;
use focus::FocusTarget;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct AppState {
    recorder: Mutex<RecorderHandle>,
    focus_target: Mutex<FocusTarget>,
    recording_level: Arc<audio::SharedLevel>,
    recording_active: Arc<AtomicBool>,
    download_state: Arc<model_download::DownloadState>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

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
fn start_recording(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let cfg = AppConfig::load();
    let mut recorder = state.recorder.lock().map_err(|e| format!("Lock error: {e}"))?;
    recorder.start(cfg.input_device.as_deref(), Arc::clone(&state.recording_level))?;
    state.recording_active.store(true, Ordering::SeqCst);
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
fn paste_transcript(text: String, state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<String, String> {
    input::write_clipboard(&text)?;

    let target = state
        .focus_target
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?
        .clone();

    if target.is_self_app() {
        return Ok("copied".to_string());
    }

    // Hide our window so it doesn't interfere with focus
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
        // We don't actually minimize, just let focus go
    }

    // Restore focus to the target app
    if let Err(e) = target.restore() {
        eprintln!("Focus restore warning: {e}");
    }

    // Wait for focus to settle
    std::thread::sleep(std::time::Duration::from_millis(250));

    // Simulate Cmd+V / Ctrl+V
    input::simulate_paste().map_err(|e| {
        format!("Paste failed (is Accessibility permission granted?): {e}")
    })?;

    Ok("pasted".to_string())
}

#[tauri::command]
fn play_chime() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Pick a pleasant built-in macOS sound. Run detached so we never block
        // the UI thread; fall through if the binary isn't found for some reason.
        let candidates = [
            "/System/Library/Sounds/Glass.aiff",
            "/System/Library/Sounds/Tink.aiff",
            "/System/Library/Sounds/Pop.aiff",
        ];
        let sound = candidates
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .copied()
            .unwrap_or("/System/Library/Sounds/Glass.aiff");
        std::process::Command::new("afplay")
            .arg(sound)
            .spawn()
            .map_err(|e| format!("afplay error: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "[System.Media.SystemSounds]::Asterisk.Play()",
            ])
            .spawn()
            .map_err(|e| format!("powershell error: {e}"))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(())
    }
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
    history::add(&text, &paste_result)
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
        })
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_always_on_top(true).ok();

            if let Some(indicator) = app.get_webview_window("indicator") {
                indicator.set_always_on_top(true).ok();
                if let Ok(Some(monitor)) = app.primary_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_w = size.width as f64 / scale;
                    let logical_h = size.height as f64 / scale;
                    let ind_size = 64.0;
                    let x = (logical_w - ind_size) / 2.0;
                    let y = logical_h - ind_size - 80.0;
                    let _ = indicator.set_size(tauri::LogicalSize::new(ind_size, ind_size));
                    let _ = indicator.set_position(tauri::LogicalPosition::new(x, y));
                }
                indicator.show().ok();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
