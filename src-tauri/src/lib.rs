mod app_error;
mod audio;
mod config;
mod diagnostics;
mod focus;
mod groq;
mod history;
mod input;
mod media;
mod model_download;
mod notepad;
mod secure;
mod setup;
mod stats;
mod whisper;

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

#[cfg(target_os = "windows")]
use window_vibrancy::apply_mica;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

use app_error::AppError;
use audio::RecorderHandle;
use config::{AppConfig, ConfigSaveError, ConfigSaveResult};
use focus::{FocusTarget, FocusTargetInfo};
use groq::{GroqApiError, GroqReadiness};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const INDICATOR_COMPACT_WIDTH: f64 = 56.0;
const INDICATOR_COMPACT_HEIGHT: f64 = 14.0;
const INDICATOR_HOVER_WIDTH: f64 = 264.0;
const INDICATOR_HOVER_HEIGHT: f64 = 74.0;
const INDICATOR_HOVER_PILL_WIDTH: f64 = 252.0;
const INDICATOR_HOVER_PILL_HEIGHT: f64 = 46.0;
const INDICATOR_HOVER_TOLERANCE: f64 = 1.0;
const INDICATOR_COLLAPSE_RESIZE_DELAY_MS: u64 = 630;
const INDICATOR_MAIN_THREAD_TIMEOUT_MS: u64 = 180;
const INDICATOR_DOCK_CLEARANCE: f64 = 12.0;
const INDICATOR_RECORDING_WIDTH: f64 = 420.0;
const INDICATOR_RECORDING_COMPACT_HEIGHT: f64 = 52.0;

struct AppState {
    recorder: Mutex<RecorderHandle>,
    focus_target: Mutex<FocusTarget>,
    focus_target_info: Mutex<Option<FocusTargetInfo>>,
    live_transcription_session: Mutex<Option<LiveTranscriptionSession>>,
    recording_level: Arc<audio::SharedLevel>,
    recording_active: Arc<AtomicBool>,
    download_state: Arc<model_download::DownloadState>,
    quit_requested: Arc<AtomicBool>,
    indicator_hovered: Arc<AtomicBool>,
    indicator_hover_enabled: Arc<AtomicBool>,
    indicator_hover_generation: Arc<AtomicU64>,
    indicator_collapse_generation: Arc<AtomicU64>,
    indicator_geometry: Mutex<Option<IndicatorGeometry>>,
    app_shortcut: Mutex<Option<String>>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

struct LiveTranscriptionSession {
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Copy)]
struct IndicatorGeometry {
    width: f64,
    height: f64,
}

fn indicator_geometry_matches(geometry: IndicatorGeometry, width: f64, height: f64) -> bool {
    (geometry.width - width).abs() < 0.5 && (geometry.height - height).abs() < 0.5
}

fn remember_indicator_geometry(app: &tauri::AppHandle, width: f64, height: f64) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut geometry) = state.indicator_geometry.lock() {
            *geometry = Some(IndicatorGeometry { width, height });
        }
    }
}

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
        let y = mon_y + mon_h - ind_h - INDICATOR_DOCK_CLEARANCE;

        let _ = indicator.set_size(tauri::LogicalSize::new(ind_w, ind_h));
        let _ = indicator.set_position(tauri::LogicalPosition::new(x, y));
    }
}

#[cfg(target_os = "macos")]
fn configure_indicator_window_on_main(
    app: &tauri::AppHandle,
    width: Option<f64>,
    height: Option<f64>,
    emit_hover: Option<bool>,
    show: bool,
    collection_behavior: bool,
) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(indicator) = app_handle.get_webview_window("indicator") {
            indicator.set_always_on_top(true).ok();
            indicator.set_shadow(false).ok();

            if let (Some(width), Some(height)) = (width, height) {
                let monitor = app_handle.primary_monitor().ok().flatten();
                place_indicator_in_work_area(&indicator, monitor, width, height);
                remember_indicator_geometry(&app_handle, width, height);
            }

            unsafe {
                make_indicator_non_activating(&indicator);
                if collection_behavior {
                    apply_indicator_collection_behavior(&indicator);
                }
            }

            if let Some(expanded) = emit_hover {
                let _ = indicator.emit("indicator-hover", IndicatorHoverPayload { expanded });
            }

            if show {
                indicator.show().ok();
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn configure_indicator_window_on_main(
    app: &tauri::AppHandle,
    width: Option<f64>,
    height: Option<f64>,
    emit_hover: Option<bool>,
    show: bool,
    _collection_behavior: bool,
) -> Result<(), String> {
    if let Some(indicator) = app.get_webview_window("indicator") {
        indicator.set_always_on_top(true).ok();
        indicator.set_shadow(false).ok();

        if let (Some(width), Some(height)) = (width, height) {
            let monitor = app.primary_monitor().ok().flatten();
            place_indicator_in_work_area(&indicator, monitor, width, height);
            remember_indicator_geometry(app, width, height);
        }

        if let Some(expanded) = emit_hover {
            let _ = indicator.emit("indicator-hover", IndicatorHoverPayload { expanded });
        }

        if show {
            indicator.show().ok();
        }
    }

    Ok(())
}

fn update_indicator_window_on_main(
    app: &tauri::AppHandle,
    width: f64,
    height: f64,
    emit_hover: Option<bool>,
) -> Result<(), String> {
    configure_indicator_window_on_main(
        app,
        Some(width),
        Some(height),
        emit_hover,
        false,
        false,
    )
}

fn emit_indicator_hover_on_main(app: &tauri::AppHandle, expanded: bool) -> Result<(), String> {
    configure_indicator_window_on_main(app, None, None, Some(expanded), false, false)
}

fn is_indicator_compact_size(width: f64, height: f64) -> bool {
    (width - INDICATOR_COMPACT_WIDTH).abs() < 0.5 && (height - INDICATOR_COMPACT_HEIGHT).abs() < 0.5
}

fn emit_indicator_target(app: &tauri::AppHandle, info: Option<&FocusTargetInfo>) {
    let _ = app.emit(
        "indicator-target",
        IndicatorTargetPayload {
            target_icon_url: info.and_then(|target| target.icon_data_url.clone()),
        },
    );
}

fn capture_focus_target(
    app: &tauri::AppHandle,
    state: &AppState,
    external_only: bool,
) -> Result<(), String> {
    let (target, info) = FocusTarget::capture_with_info();
    if external_only && target.is_self_app() {
        emit_indicator_target(app, None);
        return Ok(());
    }

    *state
        .focus_target
        .lock()
        .map_err(|e| format!("Lock error: {e}"))? = target;
    *state
        .focus_target_info
        .lock()
        .map_err(|e| format!("Lock error: {e}"))? = info.clone();
    emit_indicator_target(app, info.as_ref());
    Ok(())
}

fn reset_indicator_hover_transition(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.indicator_hovered.store(false, Ordering::SeqCst);
        state.indicator_collapse_generation.store(0, Ordering::SeqCst);
        state.indicator_hover_generation.fetch_add(1, Ordering::SeqCst);
    }
}

fn show_indicator_window(
    app: &tauri::AppHandle,
    capture_target: bool,
    geometry: Option<(f64, f64)>,
) {
    if capture_target {
        // Capture the frontmost app NOW, before showing the indicator, so that
        // a later HUD-click can paste back into the correct target.
        if let Some(state) = app.try_state::<AppState>() {
            let _ = capture_focus_target(app, &state, true);
        }
    }

    let (width, height) = geometry
        .map(|(width, height)| (Some(width), Some(height)))
        .unwrap_or((None, None));
    let _ = configure_indicator_window_on_main(app, width, height, None, true, true);
}

#[derive(Clone, Copy, Serialize)]
struct IndicatorHoverPayload {
    expanded: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndicatorTargetPayload {
    target_icon_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndicatorLiveTranscriptPayload {
    transcript: String,
    target_icon_url: Option<String>,
    is_final: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PasteTranscriptResult {
    status: String,
    warning: Option<AppError>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppShortcutPayload {
    shortcut: String,
    state: String,
}

fn set_indicator_hover_state(app: &tauri::AppHandle, expanded: bool) {
    if app.get_webview_window("indicator").is_some() {
        if let Some(state) = app.try_state::<AppState>() {
            let generation = state
                .indicator_hover_generation
                .fetch_add(1, Ordering::SeqCst)
                + 1;

            if expanded {
                state
                    .indicator_collapse_generation
                    .store(0, Ordering::SeqCst);
                let _ = update_indicator_window_on_main(
                    app,
                    INDICATOR_HOVER_WIDTH,
                    INDICATOR_HOVER_HEIGHT,
                    Some(expanded),
                );
                return;
            }

            state
                .indicator_collapse_generation
                .store(generation, Ordering::SeqCst);
            let _ = emit_indicator_hover_on_main(app, expanded);
            let app_handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(
                    INDICATOR_COLLAPSE_RESIZE_DELAY_MS,
                ));

                let Some(state) = app_handle.try_state::<AppState>() else {
                    return;
                };
                if state.indicator_hover_generation.load(Ordering::SeqCst) != generation
                    || state.indicator_collapse_generation.load(Ordering::SeqCst) != generation
                    || state.indicator_hovered.load(Ordering::SeqCst)
                {
                    return;
                }

                let _ = update_indicator_window_on_main(
                    &app_handle,
                    INDICATOR_COMPACT_WIDTH,
                    INDICATOR_COMPACT_HEIGHT,
                    None,
                );
                state
                    .indicator_collapse_generation
                    .store(0, Ordering::SeqCst);
            });
            return;
        }

        let (width, height) = if expanded {
            (INDICATOR_HOVER_WIDTH, INDICATOR_HOVER_HEIGHT)
        } else {
            (INDICATOR_COMPACT_WIDTH, INDICATOR_COMPACT_HEIGHT)
        };

        let _ = update_indicator_window_on_main(app, width, height, Some(expanded));
    }
}

fn ensure_indicator_visible(app: &tauri::AppHandle) {
    reset_indicator_hover_transition(app);
    show_indicator_window(
        app,
        true,
        Some((INDICATOR_RECORDING_WIDTH, INDICATOR_RECORDING_COMPACT_HEIGHT)),
    );
}

fn capture_external_focus_target(app: &tauri::AppHandle, state: &AppState) -> Result<(), String> {
    capture_focus_target(app, state, true)
}

fn cancel_live_transcription(state: &AppState) {
    if let Ok(mut session) = state.live_transcription_session.lock() {
        if let Some(session) = session.take() {
            session.cancel.store(true, Ordering::SeqCst);
        }
    }
}

fn target_icon_url(state: &AppState) -> Option<String> {
    state.focus_target_info.lock().ok().and_then(|info| {
        info.as_ref()
            .and_then(|target| target.icon_data_url.clone())
    })
}

fn start_live_transcription_session(
    app: tauri::AppHandle,
    state: &AppState,
    cfg: &AppConfig,
) -> Option<audio::LiveChunkSender> {
    if cfg.model_provider != "api" || cfg.groq_api_key.trim().is_empty() {
        return None;
    }

    cancel_live_transcription(state);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<audio::LiveAudioChunk>();
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let api_key = cfg.groq_api_key.clone();
    let model = cfg.transcription_model.clone();
    let target_icon_url = target_icon_url(state);

    tauri::async_runtime::spawn(async move {
        let mut transcript = String::new();

        while let Some(chunk) = rx.recv().await {
            if worker_cancel.load(Ordering::SeqCst) {
                break;
            }

            let chunk_path_result = tokio::task::spawn_blocking(move || {
                audio::write_i16_wav_chunk(&chunk.samples, chunk.sample_rate, chunk.channels)
            })
            .await;

            let chunk_path = match chunk_path_result {
                Ok(Ok(path)) => path,
                Ok(Err(e)) => {
                    eprintln!("Live transcript chunk write failed: {e}");
                    continue;
                }
                Err(e) => {
                    eprintln!("Live transcript chunk task failed: {e}");
                    continue;
                }
            };

            let has_speech_path = chunk_path.clone();
            let has_speech =
                tokio::task::spawn_blocking(move || audio::has_speech(&has_speech_path))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or(false);

            if !has_speech {
                let _ = tokio::fs::remove_file(&chunk_path).await;
                continue;
            }

            let chunk_text = match groq::transcribe(&api_key, &chunk_path, &model).await {
                Ok(text) => text,
                Err(e) => {
                    eprintln!(
                        "Live transcript chunk {} failed: {}",
                        chunk.sequence, e.message
                    );
                    let _ = tokio::fs::remove_file(&chunk_path).await;
                    continue;
                }
            };
            let _ = tokio::fs::remove_file(&chunk_path).await;

            if worker_cancel.load(Ordering::SeqCst) {
                break;
            }

            transcript = merge_partial_transcript(&transcript, &chunk_text);
            if !transcript.trim().is_empty() {
                let _ = app.emit(
                    "indicator-live-transcript",
                    IndicatorLiveTranscriptPayload {
                        transcript: transcript.clone(),
                        target_icon_url: target_icon_url.clone(),
                        is_final: false,
                    },
                );
            }
        }
    });

    if let Ok(mut session) = state.live_transcription_session.lock() {
        *session = Some(LiveTranscriptionSession { cancel });
    }

    Some(tx)
}

fn normalized_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

fn merge_partial_transcript(current: &str, next: &str) -> String {
    let current = current.trim();
    let next = next.trim();
    if current.is_empty() {
        return next.to_string();
    }
    if next.is_empty() || current.contains(next) {
        return current.to_string();
    }
    if next.starts_with(current) {
        return next.to_string();
    }

    let next_words: Vec<&str> = next.split_whitespace().collect();
    let normalized_current = normalized_words(current);
    let normalized_next = normalized_words(next);
    let max_overlap = normalized_current.len().min(normalized_next.len()).min(14);

    for overlap in (1..=max_overlap).rev() {
        if normalized_current[normalized_current.len() - overlap..] == normalized_next[..overlap] {
            let suffix = next_words[overlap..].join(" ");
            if suffix.is_empty() {
                return current.to_string();
            }
            return format!("{current} {suffix}");
        }
    }

    format!("{current} {next}")
}

fn start_recorder(state: &AppState, app: &tauri::AppHandle) -> Result<(), AppError> {
    if state.recording_active.load(Ordering::SeqCst) {
        return Ok(());
    }

    let cfg = AppConfig::load();
    let live_chunk_sender = start_live_transcription_session(app.clone(), state, &cfg);
    let mut recorder = state
        .recorder
        .lock()
        .map_err(|e| AppError::mic_unavailable(format!("Recorder lock error: {e}")))?;
    if let Err(e) = recorder.start(
        cfg.input_device.as_deref(),
        Arc::clone(&state.recording_level),
        live_chunk_sender,
    ) {
        cancel_live_transcription(state);
        return Err(AppError::mic_unavailable(e));
    }
    state.recording_active.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn show_idle_indicator(app: tauri::AppHandle) {
    show_indicator_window(
        &app,
        false,
        Some((INDICATOR_COMPACT_WIDTH, INDICATOR_COMPACT_HEIGHT)),
    );
}

#[tauri::command]
fn set_indicator_hover_tracking_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) {
    state
        .indicator_hover_enabled
        .store(enabled, Ordering::SeqCst);

    if !enabled && state.indicator_hovered.swap(false, Ordering::SeqCst) {
        set_indicator_hover_state(&app, false);
    }
    if !enabled {
        state
            .indicator_collapse_generation
            .store(0, Ordering::SeqCst);
    }
}

#[tauri::command]
fn reposition_indicator(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    force: Option<bool>,
) -> Result<(), String> {
    let force = force.unwrap_or(false);

    if !force {
        if let Some(state) = app.try_state::<AppState>() {
            if state
                .indicator_geometry
                .lock()
                .ok()
                .and_then(|geometry| *geometry)
                .is_some_and(|geometry| indicator_geometry_matches(geometry, width, height))
            {
                return Ok(());
            }
        }
    }

    if app.get_webview_window("indicator").is_none() {
        return Err("Indicator window not found".to_string());
    }

    #[cfg(target_os = "macos")]
    if let Some(state) = app.try_state::<AppState>() {
        if is_indicator_compact_size(width, height)
            && state.indicator_collapse_generation.load(Ordering::SeqCst) != 0
        {
            return Ok(());
        }

        if !is_indicator_compact_size(width, height) {
            state
                .indicator_collapse_generation
                .store(0, Ordering::SeqCst);
            state
                .indicator_hover_generation
                .fetch_add(1, Ordering::SeqCst);
        }
    }

    update_indicator_window_on_main(&app, width, height, None)
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CocoaPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CocoaSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CocoaRect {
    origin: CocoaPoint,
    size: CocoaSize,
}

#[cfg(target_os = "macos")]
fn indicator_contains_mouse(indicator: &tauri::WebviewWindow, expanded: bool) -> Option<bool> {
    use objc::runtime::{Class, Object};

    unsafe {
        let ns_window = indicator.ns_window().ok()? as *mut Object;
        if ns_window.is_null() {
            return None;
        }

        let ns_event_class = Class::get("NSEvent")?;
        let mouse: CocoaPoint = objc::msg_send![ns_event_class, mouseLocation];
        let frame: CocoaRect = objc::msg_send![ns_window, frame];
        let (pill_width, pill_height) = if expanded {
            (INDICATOR_HOVER_PILL_WIDTH, INDICATOR_HOVER_PILL_HEIGHT)
        } else {
            (INDICATOR_COMPACT_WIDTH, INDICATOR_COMPACT_HEIGHT)
        };
        let min_x =
            frame.origin.x + (frame.size.width - pill_width) / 2.0 - INDICATOR_HOVER_TOLERANCE;
        let max_x = min_x + pill_width + INDICATOR_HOVER_TOLERANCE * 2.0;
        let min_y = frame.origin.y - INDICATOR_HOVER_TOLERANCE;
        let max_y = min_y + pill_height + INDICATOR_HOVER_TOLERANCE * 2.0;

        Some(mouse.x >= min_x && mouse.x <= max_x && mouse.y >= min_y && mouse.y <= max_y)
    }
}

#[cfg(target_os = "macos")]
fn indicator_contains_mouse_on_main(app: &tauri::AppHandle, expanded: bool) -> Option<bool> {
    let (tx, rx) = mpsc::channel();
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let result = app_handle
            .get_webview_window("indicator")
            .and_then(|indicator| indicator_contains_mouse(&indicator, expanded));
        let _ = tx.send(result);
    })
    .ok()?;

    rx.recv_timeout(std::time::Duration::from_millis(
        INDICATOR_MAIN_THREAD_TIMEOUT_MS,
    ))
    .ok()
    .flatten()
}

#[cfg(target_os = "macos")]
fn start_indicator_hover_tracker(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    let hover_enabled = Arc::clone(&state.indicator_hover_enabled);
    let hover_state = Arc::clone(&state.indicator_hovered);
    let collapse_generation = Arc::clone(&state.indicator_collapse_generation);
    let recording_active = Arc::clone(&state.recording_active);

    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(45));

        if !hover_enabled.load(Ordering::SeqCst) || recording_active.load(Ordering::SeqCst) {
            if hover_state.swap(false, Ordering::SeqCst) {
                set_indicator_hover_state(&app, false);
            }
            continue;
        }

        let currently_expanded =
            hover_state.load(Ordering::SeqCst) || collapse_generation.load(Ordering::SeqCst) != 0;
        let hovered = indicator_contains_mouse_on_main(&app, currently_expanded).unwrap_or(false);

        let previous = hover_state.swap(hovered, Ordering::SeqCst);
        if hovered != previous {
            set_indicator_hover_state(&app, hovered);
        }
    });
}

#[cfg(target_os = "macos")]
fn apply_main_vibrancy(window: &tauri::WebviewWindow) {
    let _ = apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    );
}

#[cfg(target_os = "windows")]
fn apply_windows_backdrop(window: &tauri::WebviewWindow) {
    let _ = apply_mica(window, Some(true));
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
    let _: () = objc::msg_send![ns_window_ptr, _setPreventsActivation: YES];

    // NSStatusWindowLevel (25) keeps the HUD reliably above all normal and
    // floating windows so it never falls behind the focused app.
    let _: () = objc::msg_send![ns_window_ptr, setLevel: 25i64];
    let _: () = objc::msg_send![ns_window_ptr, setIgnoresMouseEvents: false];
    let _: () = objc::msg_send![ns_window_ptr, setHidesOnDeactivate: false];
}

#[cfg(target_os = "macos")]
unsafe fn apply_indicator_collection_behavior(window: &tauri::WebviewWindow) {
    let Ok(ns_win) = window.ns_window() else {
        return;
    };
    let ns_win = ns_win as *mut objc::runtime::Object;
    if ns_win.is_null() {
        return;
    }

    // Keep the HUD visible across Spaces, including fullscreen Spaces,
    // without pulling the user back to the app window's Space.
    let _: () =
        objc::msg_send![ns_win, setCollectionBehavior: 1u64 << 0 | 1u64 << 4 | 1u64 << 8];
}

#[derive(Serialize)]
struct ScreenSize {
    width: u32,
    height: u32,
}

#[tauri::command]
fn get_config() -> Result<AppConfig, String> {
    AppConfig::try_load()
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<ConfigSaveResult, ConfigSaveError> {
    config.save_with_status()
}

#[tauri::command]
fn get_launch_at_login(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_launch_at_login(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())?;
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }
    autolaunch.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_groq_connection(config: Option<AppConfig>) -> Result<GroqReadiness, GroqApiError> {
    let cfg = match config {
        Some(mut cfg) => {
            if cfg.groq_api_key.trim().is_empty() {
                if let Ok(saved) = AppConfig::try_load() {
                    cfg.groq_api_key = saved.groq_api_key;
                }
            }
            cfg
        }
        None => AppConfig::try_load().map_err(|e| GroqApiError {
            status: None,
            code: "config_load_failed".to_string(),
            message: format!("Could not load Groq settings: {e}"),
            retryable: false,
        })?,
    };

    groq::validate_api_key(
        &cfg.groq_api_key,
        &cfg.transcription_model,
        &cfg.cleanup_model,
        cfg.cleanup_enabled,
    )
    .await
}

#[tauri::command]
fn get_setup_status() -> setup::SetupStatus {
    match AppConfig::try_load() {
        Ok(cfg) => setup::get_status(&cfg),
        Err(e) => {
            eprintln!("Setup status config load failed: {e}");
            let cfg = AppConfig::load();
            setup::get_status_with_credential_error(&cfg, &e)
        }
    }
}

#[tauri::command]
fn validate_shortcut(shortcut: String) -> setup::ShortcutValidation {
    setup::validate_shortcut(&shortcut)
}

#[tauri::command]
fn register_app_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    shortcut: String,
) -> Result<(), String> {
    let validation = setup::validate_shortcut(&shortcut);
    if !validation.valid {
        return Err(validation.message);
    }

    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    if let Ok(mut registered) = state.app_shortcut.lock() {
        *registered = None;
    }

    let shortcut_for_event = shortcut.clone();
    app.global_shortcut()
        .on_shortcut(shortcut.as_str(), move |app, _shortcut, event| {
            let event_state = match event.state {
                ShortcutState::Pressed => "Pressed",
                ShortcutState::Released => "Released",
            };
            let _ = app.emit(
                "app-shortcut",
                AppShortcutPayload {
                    shortcut: shortcut_for_event.clone(),
                    state: event_state.to_string(),
                },
            );
        })
        .map_err(|e| e.to_string())?;

    *state
        .app_shortcut
        .lock()
        .map_err(|e| format!("Shortcut state lock error: {e}"))? = Some(shortcut);
    Ok(())
}

#[tauri::command]
fn unregister_app_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    *state
        .app_shortcut
        .lock()
        .map_err(|e| format!("Shortcut state lock error: {e}"))? = None;
    Ok(())
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
fn capture_focus(state: tauri::State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    capture_focus_target(&app, &state, false)
}

#[tauri::command]
fn start_recording(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    start_recorder(&state, &app)?;
    ensure_indicator_visible(&app);
    Ok(())
}

#[tauri::command]
fn start_recording_from_indicator(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    capture_external_focus_target(&app, &state).map_err(|e| {
        AppError::new(
            "focus_capture_failed",
            format!("Could not capture the target app: {e}"),
            true,
            None,
        )
    })?;
    start_recorder(&state, &app)?;
    let _ = media::pause_media();
    reset_indicator_hover_transition(&app);
    show_indicator_window(
        &app,
        false,
        Some((INDICATOR_RECORDING_WIDTH, INDICATOR_RECORDING_COMPACT_HEIGHT)),
    );
    let _ = app.emit("indicator-mode", "recording");
    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<'_, AppState>) -> Result<String, AppError> {
    let mut recorder = state
        .recorder
        .lock()
        .map_err(|e| AppError::mic_unavailable(format!("Recorder lock error: {e}")))?;
    if !recorder.is_recording() {
        state.recording_active.store(false, Ordering::SeqCst);
        cancel_live_transcription(&state);
        return Err(AppError::not_recording());
    }

    state.recording_active.store(false, Ordering::SeqCst);
    cancel_live_transcription(&state);
    let path = recorder.stop().map_err(|e| {
        if e == "Not recording" {
            AppError::not_recording()
        } else {
            AppError::mic_unavailable(e)
        }
    })?;
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
async fn transcribe_audio(audio_path: String) -> Result<String, AppError> {
    let cfg = AppConfig::try_load().map_err(|e| {
        AppError::new(
            "config_load_failed",
            format!("Could not load settings: {e}"),
            false,
            Some("Open Settings"),
        )
    })?;
    let path = std::path::PathBuf::from(&audio_path);

    let speech_path = path.clone();
    let has_speech = tokio::task::spawn_blocking(move || audio::has_speech(&speech_path))
        .await
        .map_err(|e| {
            AppError::new(
                "speech_check_failed",
                format!("Task error: {e}"),
                true,
                None,
            )
        })?
        .map_err(|e| {
            AppError::new(
                "speech_check_failed",
                format!("Could not inspect the recording: {e}"),
                true,
                None,
            )
        })?;

    if !has_speech {
        return Err(AppError::empty_speech());
    }

    match cfg.model_provider.as_str() {
        "local" => {
            let model_size = cfg.local_model_size.clone();
            tokio::task::spawn_blocking(move || whisper::transcribe_local(&path, &model_size))
                .await
                .map_err(|e| {
                    AppError::new(
                        "local_transcription_failed",
                        format!("Task error: {e}"),
                        true,
                        None,
                    )
                })?
        }
        _ => {
            if cfg.groq_api_key.is_empty() {
                return Err(AppError::new(
                    "missing_api_key",
                    "Enter a Groq API key or switch to a downloaded local Whisper model.",
                    false,
                    Some("Open Settings"),
                ));
            }
            groq::transcribe(&cfg.groq_api_key, &path, &cfg.transcription_model)
                .await
                .map_err(|e| AppError::new(e.code, e.message, e.retryable, None))
        }
    }
}

#[tauri::command]
async fn cleanup_text(text: String) -> Result<String, String> {
    let cfg = AppConfig::try_load()?;
    if cfg.groq_api_key.is_empty() {
        return Err("Groq API key not configured".to_string());
    }
    if !cfg.cleanup_enabled {
        return Ok(text);
    }
    groq::cleanup(&cfg.groq_api_key, &text, &cfg.cleanup_model)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
fn paste_transcript(
    text: String,
    state: tauri::State<'_, AppState>,
    _app: tauri::AppHandle,
) -> Result<PasteTranscriptResult, AppError> {
    input::write_clipboard(&text)
        .map_err(|e| AppError::paste_denied(format!("Clipboard write failed: {e}")))?;

    if !setup::is_accessibility_trusted() {
        eprintln!("Paste simulation skipped: Echo is not trusted for Accessibility.");
        return Ok(PasteTranscriptResult {
            status: "copied_accessibility".to_string(),
            warning: Some(AppError::paste_denied(
                "Enable Echo in Accessibility for automatic paste.",
            )),
        });
    }

    let target = state
        .focus_target
        .lock()
        .map_err(|e| AppError::paste_denied(format!("Target lock failed: {e}")))?
        .clone();

    if target.is_self_app() || !target.has_target() {
        return Ok(PasteTranscriptResult {
            status: "copied_no_target".to_string(),
            warning: None,
        });
    }

    if let Err(e) = target.restore() {
        eprintln!("Focus restore failed, falling back to clipboard: {e}");
        return Ok(PasteTranscriptResult {
            status: "copied".to_string(),
            warning: Some(AppError::paste_denied(format!(
                "Could not restore the target app: {e}"
            ))),
        });
    }

    std::thread::sleep(std::time::Duration::from_millis(250));

    match input::simulate_paste() {
        Ok(()) => Ok(PasteTranscriptResult {
            status: "pasted".to_string(),
            warning: None,
        }),
        Err(e) => {
            eprintln!("Paste simulation failed, text is on clipboard: {e}");
            Ok(PasteTranscriptResult {
                status: "copied_accessibility".to_string(),
                warning: Some(AppError::paste_denied(format!(
                    "Paste simulation failed: {e}"
                ))),
            })
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
        let path = sound_name_to_path(name).unwrap_or("/System/Library/Sounds/Glass.aiff");
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
fn check_model_status(
    model_size: String,
    state: tauri::State<'_, AppState>,
) -> model_download::ModelStatus {
    model_download::check_model_status(&model_size, &state.download_state)
}

#[tauri::command]
fn verify_model_status(
    model_size: String,
    state: tauri::State<'_, AppState>,
) -> model_download::ModelStatus {
    model_download::verify_model_status(&model_size, &state.download_state)
}

#[tauri::command]
async fn download_whisper_model(
    model_size: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let dl_state = Arc::clone(&state.download_state);
    model_download::download_model(&model_size, dl_state).await
}

#[tauri::command]
fn get_model_download_progress(
    state: tauri::State<'_, AppState>,
) -> model_download::DownloadProgress {
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
fn add_transcript_history(
    text: String,
    paste_result: String,
) -> Result<history::HistoryItem, String> {
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
fn get_dictation_stats(local_date: String) -> Result<stats::DictationStats, String> {
    stats::view(&local_date)
}

#[tauri::command]
fn get_support_diagnostics(state: tauri::State<'_, AppState>) -> diagnostics::SupportDiagnostics {
    diagnostics::current_support_diagnostics(&state.download_state)
}

#[tauri::command]
fn get_support_diagnostics_json(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let report = diagnostics::current_support_diagnostics(&state.download_state);
    diagnostics::diagnostics_to_pretty_json(&report)
}

#[tauri::command]
fn record_dictation_stats(
    word_count: u64,
    duration_ms: u64,
    local_date: String,
) -> Result<stats::DictationStatsUpdate, String> {
    stats::record(word_count, duration_ms, &local_date)
}

#[tauri::command]
fn list_notepad_notes() -> Vec<notepad::NotepadNote> {
    notepad::load_all()
}

#[tauri::command]
fn create_notepad_note() -> Result<notepad::NotepadNote, String> {
    notepad::create()
}

#[tauri::command]
fn update_notepad_note(id: String, body: String) -> Result<notepad::NotepadNote, String> {
    notepad::update(&id, &body)
}

#[tauri::command]
fn delete_notepad_note(id: String) -> Result<(), String> {
    notepad::delete(&id)
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    show_main_window_internal(&app);
}

#[tauri::command]
fn show_notepad_window(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window("notepad") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn show_main_window_internal(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            recorder: Mutex::new(RecorderHandle::new()),
            focus_target: Mutex::new(FocusTarget::None),
            focus_target_info: Mutex::new(None),
            live_transcription_session: Mutex::new(None),
            recording_level: Arc::new(audio::SharedLevel::new()),
            recording_active: Arc::new(AtomicBool::new(false)),
            download_state: Arc::new(model_download::DownloadState::new()),
            quit_requested: Arc::new(AtomicBool::new(false)),
            indicator_hovered: Arc::new(AtomicBool::new(false)),
            indicator_hover_enabled: Arc::new(AtomicBool::new(false)),
            indicator_hover_generation: Arc::new(AtomicU64::new(0)),
            indicator_collapse_generation: Arc::new(AtomicU64::new(0)),
            indicator_geometry: Mutex::new(None),
            app_shortcut: Mutex::new(None),
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

            #[cfg(target_os = "windows")]
            apply_windows_backdrop(&window);

            // Hide instead of close when the user clicks the red traffic light.
            // We use hide() to remove the window from the dock / Cmd-Tab, but
            // the webview stays alive so global-shortcut IPC keeps working.
            let main_for_close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = main_for_close.hide();
                    #[cfg(target_os = "macos")]
                    let _ = main_for_close
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            });

            // --- Native app menu ---
            let app_settings_i = MenuItem::with_id(
                app,
                "menu_open_settings",
                "Settings",
                true,
                Some("CmdOrCtrl+,"),
            )?;
            let app_check_setup_i = MenuItem::with_id(
                app,
                "menu_check_setup",
                "Check Setup",
                true,
                Some("CmdOrCtrl+R"),
            )?;
            let app_hide_i =
                MenuItem::with_id(app, "menu_hide", "Hide Echo", true, Some("CmdOrCtrl+H"))?;
            let app_quit_i =
                MenuItem::with_id(app, "menu_quit", "Quit Echo", true, Some("CmdOrCtrl+Q"))?;
            let app_sep_1 = PredefinedMenuItem::separator(app)?;
            let app_sep_2 = PredefinedMenuItem::separator(app)?;

            let dictate_start_i = MenuItem::with_id(
                app,
                "menu_start_recording",
                "Start Dictation",
                true,
                None::<&str>,
            )?;
            let dictate_stop_i = MenuItem::with_id(
                app,
                "menu_stop_recording",
                "Stop Dictation",
                true,
                None::<&str>,
            )?;

            let view_dictate_i = MenuItem::with_id(
                app,
                "menu_open_dictate",
                "Home",
                true,
                Some("CmdOrCtrl+1"),
            )?;
            let view_history_i = MenuItem::with_id(
                app,
                "menu_open_history",
                "History",
                true,
                Some("CmdOrCtrl+2"),
            )?;

            let app_submenu = Submenu::with_items(
                app,
                "Echo",
                true,
                &[
                    &app_settings_i,
                    &app_check_setup_i,
                    &app_sep_1,
                    &app_hide_i,
                    &app_sep_2,
                    &app_quit_i,
                ],
            )?;
            let dictation_submenu =
                Submenu::with_items(app, "Dictation", true, &[&dictate_start_i, &dictate_stop_i])?;
            let view_submenu =
                Submenu::with_items(app, "View", true, &[&view_dictate_i, &view_history_i])?;
            let app_menu =
                Menu::with_items(app, &[&app_submenu, &dictation_submenu, &view_submenu])?;
            app.set_menu(app_menu)?;

            app.on_menu_event(|app, event| match event.id().as_ref() {
                "menu_open_settings" => {
                    show_main_window_internal(app);
                    let _ = app.emit("tray-open-settings", ());
                }
                "menu_check_setup" => {
                    show_main_window_internal(app);
                    let _ = app.emit("menu-check-setup", ());
                }
                "menu_hide" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    #[cfg(target_os = "macos")]
                    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
                "menu_quit" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.quit_requested.store(true, Ordering::SeqCst);
                    }
                    app.exit(0);
                }
                "menu_start_recording" => {
                    let _ = app.emit("tray-start-recording", ());
                }
                "menu_stop_recording" => {
                    let _ = app.emit("tray-stop-recording", ());
                }
                "menu_open_dictate" => {
                    show_main_window_internal(app);
                    let _ = app.emit("menu-open-dictate", ());
                }
                "menu_open_history" => {
                    show_main_window_internal(app);
                    let _ = app.emit("menu-open-history", ());
                }
                _ => {}
            });

            // --- System tray / menu bar icon ---
            let open_i = MenuItem::with_id(app, "open_app", "Open Echo", true, None::<&str>)?;
            let start_i = MenuItem::with_id(
                app,
                "start_recording",
                "Start Dictation",
                true,
                None::<&str>,
            )?;
            let stop_i =
                MenuItem::with_id(app, "stop_recording", "Stop Dictation", true, None::<&str>)?;
            let history_i =
                MenuItem::with_id(app, "view_history", "View History", true, None::<&str>)?;
            let settings_i = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let sep3 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Echo", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &open_i,
                    &sep,
                    &start_i,
                    &stop_i,
                    &sep2,
                    &history_i,
                    &settings_i,
                    &sep3,
                    &quit_i,
                ],
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
                    "view_history" => {
                        show_main_window_internal(app);
                        let _ = app.emit("menu-open-history", ());
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

            show_indicator_window(
                app.handle(),
                false,
                Some((INDICATOR_COMPACT_WIDTH, INDICATOR_COMPACT_HEIGHT)),
            );
            #[cfg(target_os = "macos")]
            start_indicator_hover_tracker(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_launch_at_login,
            set_launch_at_login,
            test_groq_connection,
            get_setup_status,
            validate_shortcut,
            register_app_shortcut,
            unregister_app_shortcut,
            open_setup_help,
            request_accessibility_permission,
            show_idle_indicator,
            set_indicator_hover_tracking_enabled,
            reposition_indicator,
            get_screen_size,
            capture_focus,
            start_recording,
            start_recording_from_indicator,
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
            verify_model_status,
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
            get_dictation_stats,
            get_support_diagnostics,
            get_support_diagnostics_json,
            record_dictation_stats,
            list_notepad_notes,
            create_notepad_note,
            update_notepad_note,
            delete_notepad_note,
            show_main_window,
            show_notepad_window,
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
