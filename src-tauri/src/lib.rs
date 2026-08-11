mod app_error;
mod audio;
mod config;
mod diagnostics;
mod entitlement;
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
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const INDICATOR_COMPACT_WIDTH: f64 = 56.0;
const INDICATOR_COMPACT_HEIGHT: f64 = 14.0;
const INDICATOR_HOVER_WIDTH: f64 = 264.0;
const INDICATOR_HOVER_HEIGHT: f64 = 74.0;
const INDICATOR_HOVER_PILL_WIDTH: f64 = 252.0;
const INDICATOR_HOVER_PILL_HEIGHT: f64 = 46.0;
const INDICATOR_HOVER_TOLERANCE: f64 = 1.0;
const INDICATOR_COLLAPSE_RESIZE_DELAY_MS: u64 = 680;
const INDICATOR_MAIN_THREAD_TIMEOUT_MS: u64 = 180;
const INDICATOR_DOCK_CLEARANCE: f64 = 12.0;
const INDICATOR_RECORDING_WIDTH: f64 = 420.0;
const INDICATOR_RECORDING_COMPACT_HEIGHT: f64 = 52.0;
const NOTEPAD_WINDOW_WIDTH: f64 = 720.0;
const NOTEPAD_WINDOW_HEIGHT: f64 = 540.0;

struct AppState {
    recorder: Mutex<RecorderHandle>,
    focus_target: Mutex<FocusTarget>,
    focus_target_info: Mutex<Option<FocusTargetInfo>>,
    live_transcription_session: Mutex<Option<LiveTranscriptionSession>>,
    recording_level: Arc<audio::SharedLevel>,
    recording_active: Arc<AtomicBool>,
    download_state: Arc<model_download::DownloadState>,
    quit_requested: Arc<AtomicBool>,
    indicator_hovered: Arc<Mutex<HashMap<String, bool>>>,
    indicator_hover_enabled: Arc<AtomicBool>,
    indicator_hover_generation: Arc<AtomicU64>,
    indicator_collapse_generation: Arc<AtomicU64>,
    indicator_geometry: Mutex<HashMap<String, IndicatorGeometry>>,
    indicator_window_count: Mutex<usize>,
    app_shortcut: Mutex<Option<String>>,
    config: Mutex<AppConfig>,
    shortcut_recording_started_at: Mutex<Option<Instant>>,
    shortcut_session_counter: AtomicU64,
    active_shortcut_session_id: Mutex<Option<u64>>,
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
    monitor: IndicatorMonitorGeometry,
}

#[derive(Clone, Copy)]
struct IndicatorMonitorGeometry {
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    scale_bits: u64,
}

fn indicator_monitor_geometry(monitor: &tauri::Monitor) -> IndicatorMonitorGeometry {
    let work_area = monitor.work_area();
    IndicatorMonitorGeometry {
        work_x: work_area.position.x,
        work_y: work_area.position.y,
        work_width: work_area.size.width,
        work_height: work_area.size.height,
        scale_bits: monitor.scale_factor().to_bits(),
    }
}

fn indicator_geometry_matches(
    geometry: IndicatorGeometry,
    width: f64,
    height: f64,
    monitor: &tauri::Monitor,
) -> bool {
    let monitor_geometry = indicator_monitor_geometry(monitor);
    (geometry.width - width).abs() < 0.5
        && (geometry.height - height).abs() < 0.5
        && geometry.monitor.work_x == monitor_geometry.work_x
        && geometry.monitor.work_y == monitor_geometry.work_y
        && geometry.monitor.work_width == monitor_geometry.work_width
        && geometry.monitor.work_height == monitor_geometry.work_height
        && geometry.monitor.scale_bits == monitor_geometry.scale_bits
}

fn remember_indicator_geometry(
    app: &tauri::AppHandle,
    label: &str,
    width: f64,
    height: f64,
    monitor: &tauri::Monitor,
) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut geometry) = state.indicator_geometry.lock() {
            geometry.insert(
                label.to_string(),
                IndicatorGeometry {
                    width,
                    height,
                    monitor: indicator_monitor_geometry(monitor),
                },
            );
        }
    }
}

fn primary_indicator_monitor(app: &tauri::AppHandle) -> Option<tauri::Monitor> {
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok()?.into_iter().next())
}

fn indicator_monitors(app: &tauri::AppHandle) -> Vec<tauri::Monitor> {
    primary_indicator_monitor(app)
        .map(|monitor| vec![monitor])
        .unwrap_or_default()
}

fn indicator_label(index: usize) -> String {
    if index == 0 {
        "indicator".to_string()
    } else {
        format!("indicator-{index}")
    }
}

fn indicator_label_index(label: &str) -> Option<usize> {
    if label == "indicator" {
        Some(0)
    } else {
        label
            .strip_prefix("indicator-")
            .and_then(|suffix| suffix.parse::<usize>().ok())
    }
}

fn ensure_indicator_window(app: &tauri::AppHandle, label: &str) -> Option<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window(label) {
        return Some(window);
    }

    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("")
        .inner_size(INDICATOR_COMPACT_WIDTH, INDICATOR_COMPACT_HEIGHT)
        .resizable(false)
        .always_on_top(true)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .shadow(false)
        .build()
        .ok()
}

fn apply_indicator_window_chrome(indicator: &tauri::WebviewWindow, collection_behavior: bool) {
    indicator.set_always_on_top(true).ok();
    indicator.set_shadow(false).ok();

    #[cfg(target_os = "macos")]
    unsafe {
        make_indicator_non_activating(indicator);
        if collection_behavior {
            apply_indicator_collection_behavior(indicator);
        }
    }
}

fn place_indicator_in_work_area(
    indicator: &tauri::WebviewWindow,
    monitor: &tauri::Monitor,
    ind_w: f64,
    ind_h: f64,
) {
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

fn hide_stale_indicator_windows(app: &tauri::AppHandle, active_count: usize) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    let previous_count = state
        .indicator_window_count
        .lock()
        .map(|mut count| {
            let previous = *count;
            *count = active_count;
            previous
        })
        .unwrap_or(active_count);

    let mut stale_labels = (active_count..previous_count)
        .map(indicator_label)
        .collect::<Vec<_>>();
    for label in app.webview_windows().into_keys() {
        let is_stale_indicator = indicator_label_index(&label)
            .map(|index| index >= active_count)
            .unwrap_or(false);
        if is_stale_indicator && !stale_labels.iter().any(|candidate| candidate == &label) {
            stale_labels.push(label);
        }
    }

    for label in stale_labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.hide();
        }
        if let Ok(mut geometry) = state.indicator_geometry.lock() {
            geometry.remove(&label);
        }
        if let Ok(mut hovered) = state.indicator_hovered.lock() {
            hovered.remove(&label);
        }
    }
}

fn monitor_for_indicator_label(app: &tauri::AppHandle, label: &str) -> Option<tauri::Monitor> {
    let index = indicator_label_index(label)?;
    if index == 0 {
        primary_indicator_monitor(app)
    } else {
        None
    }
}

fn update_indicator_label_on_main(
    app: &tauri::AppHandle,
    label: String,
    width: f64,
    height: f64,
    emit_hover: Option<bool>,
) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let hover_label = label.clone();
        let Some(indicator) = app_handle.get_webview_window(&label) else {
            return;
        };
        apply_indicator_window_chrome(&indicator, false);
        if let Some(monitor) = monitor_for_indicator_label(&app_handle, &label) {
            place_indicator_in_work_area(&indicator, &monitor, width, height);
            remember_indicator_geometry(&app_handle, &label, width, height, &monitor);
        }
        if let Some(expanded) = emit_hover {
            let _ = indicator.emit(
                "indicator-hover",
                IndicatorHoverPayload {
                    expanded,
                    label: Some(hover_label),
                },
            );
        }
    })
    .map_err(|e| e.to_string())
}

fn place_primary_indicator_window(
    app: &tauri::AppHandle,
    ind_w: f64,
    ind_h: f64,
    show: bool,
    collection_behavior: bool,
) {
    let Some(monitor) = primary_indicator_monitor(app) else {
        hide_stale_indicator_windows(app, 1);
        return;
    };
    let Some(indicator) = ensure_indicator_window(app, "indicator") else {
        hide_stale_indicator_windows(app, 1);
        return;
    };

    apply_indicator_window_chrome(&indicator, collection_behavior);
    place_indicator_in_work_area(&indicator, &monitor, ind_w, ind_h);
    remember_indicator_geometry(app, "indicator", ind_w, ind_h, &monitor);
    if show {
        indicator.show().ok();
    }

    hide_stale_indicator_windows(app, 1);
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
            if let (Some(width), Some(height)) = (width, height) {
                let should_show = show || indicator.is_visible().unwrap_or(false);
                place_primary_indicator_window(
                    &app_handle,
                    width,
                    height,
                    should_show,
                    collection_behavior,
                );
            } else {
                apply_indicator_window_chrome(&indicator, collection_behavior);
                if show {
                    indicator.show().ok();
                }
                hide_stale_indicator_windows(&app_handle, 1);
            }

            if let Some(expanded) = emit_hover {
                let _ = indicator.emit(
                    "indicator-hover",
                    IndicatorHoverPayload {
                        expanded,
                        label: None,
                    },
                );
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
        apply_indicator_window_chrome(&indicator, _collection_behavior);

        if let (Some(width), Some(height)) = (width, height) {
            let monitor = app.primary_monitor().ok().flatten();
            if let Some(monitor) = monitor {
                place_indicator_in_work_area(&indicator, &monitor, width, height);
                remember_indicator_geometry(app, "indicator", width, height, &monitor);
            }
        }

        if let Some(expanded) = emit_hover {
            let _ = indicator.emit(
                "indicator-hover",
                IndicatorHoverPayload {
                    expanded,
                    label: None,
                },
            );
        }

        if show {
            indicator.show().ok();
        }

        hide_stale_indicator_windows(app, 1);
    }

    Ok(())
}

fn update_indicator_window_on_main(
    app: &tauri::AppHandle,
    width: f64,
    height: f64,
    emit_hover: Option<bool>,
) -> Result<(), String> {
    configure_indicator_window_on_main(app, Some(width), Some(height), emit_hover, false, false)
}

fn emit_indicator_hover_label_on_main(
    app: &tauri::AppHandle,
    label: String,
    expanded: bool,
) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(indicator) = app_handle.get_webview_window(&label) {
            let _ = indicator.emit(
                "indicator-hover",
                IndicatorHoverPayload {
                    expanded,
                    label: Some(label),
                },
            );
        }
    })
    .map_err(|e| e.to_string())
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
    let target = FocusTarget::capture();
    if external_only && target.is_self_app() {
        emit_indicator_target(app, None);
        return Ok(());
    }

    let info = target.basic_info();
    *state
        .focus_target
        .lock()
        .map_err(|e| format!("Lock error: {e}"))? = target.clone();
    *state
        .focus_target_info
        .lock()
        .map_err(|e| format!("Lock error: {e}"))? = info.clone();
    emit_indicator_target(app, info.as_ref());
    refresh_focus_target_info(app.clone(), target);
    Ok(())
}

fn refresh_focus_target_info(app: tauri::AppHandle, target: FocusTarget) {
    std::thread::spawn(move || {
        let info = target.info();
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };

        let still_current = state
            .focus_target
            .lock()
            .map(|current| *current == target)
            .unwrap_or(false);
        if !still_current {
            return;
        }

        if let Ok(mut target_info) = state.focus_target_info.lock() {
            *target_info = info.clone();
        }
        emit_indicator_target(&app, info.as_ref());
    });
}

fn reset_indicator_hover_transition(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut hovered) = state.indicator_hovered.lock() {
            hovered.clear();
        }
        state
            .indicator_collapse_generation
            .store(0, Ordering::SeqCst);
        state
            .indicator_hover_generation
            .fetch_add(1, Ordering::SeqCst);
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

#[derive(Clone, Serialize)]
struct IndicatorHoverPayload {
    expanded: bool,
    label: Option<String>,
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
struct DictationPerformancePayload {
    phase: String,
    provider: String,
    model: Option<String>,
    local_model_size: Option<String>,
    audio_duration_ms: Option<u64>,
    audio_bytes: Option<u64>,
    speech_check_ms: Option<u64>,
    speech_detected: Option<bool>,
    model_cache_hit: Option<bool>,
    model_load_ms: Option<u64>,
    audio_decode_ms: Option<u64>,
    inference_ms: Option<u64>,
    cloud_transcribe_ms: Option<u64>,
    cleanup_ms: Option<u64>,
    paste_ms: Option<u64>,
    total_ms: u64,
    thread_count: Option<i32>,
    error_code: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppShortcutPayload {
    shortcut: String,
    state: String,
    session_id: Option<u64>,
    audio_path: Option<String>,
    duration_ms: Option<u64>,
    error: Option<AppError>,
}

fn set_indicator_hover_state(app: &tauri::AppHandle, label: String, expanded: bool) {
    if app.get_webview_window(&label).is_some() {
        if let Some(state) = app.try_state::<AppState>() {
            let generation = state
                .indicator_hover_generation
                .fetch_add(1, Ordering::SeqCst)
                + 1;

            if expanded {
                state
                    .indicator_collapse_generation
                    .store(0, Ordering::SeqCst);
                let _ = update_indicator_label_on_main(
                    app,
                    label,
                    INDICATOR_HOVER_WIDTH,
                    INDICATOR_HOVER_HEIGHT,
                    Some(expanded),
                );
                return;
            }

            state
                .indicator_collapse_generation
                .store(generation, Ordering::SeqCst);
            let _ = emit_indicator_hover_label_on_main(app, label.clone(), expanded);
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
                    || state
                        .indicator_hovered
                        .lock()
                        .ok()
                        .and_then(|hovered| hovered.get(&label).copied())
                        .unwrap_or(false)
                {
                    return;
                }

                let _ = update_indicator_label_on_main(
                    &app_handle,
                    label,
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
        Some((
            INDICATOR_RECORDING_WIDTH,
            INDICATOR_RECORDING_COMPACT_HEIGHT,
        )),
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

async fn transcribe_cloud_chunked(
    api_key: &str,
    audio_path: &std::path::Path,
    model: &str,
) -> Result<String, GroqApiError> {
    let chunk_paths = audio::split_wav_for_cloud(audio_path, groq::GROQ_DIRECT_UPLOAD_LIMIT_BYTES)
        .map_err(|message| GroqApiError {
            status: None,
            code: "audio_chunking_failed".to_string(),
            message,
            retryable: false,
        })?;
    let owns_chunks = !(chunk_paths.len() == 1 && chunk_paths[0] == audio_path);
    let mut transcript = String::new();
    let mut first_error: Option<GroqApiError> = None;

    for chunk_path in &chunk_paths {
        match groq::transcribe(api_key, chunk_path, model).await {
            Ok(chunk_text) => {
                transcript = merge_partial_transcript(&transcript, &chunk_text);
            }
            Err(e) => {
                first_error = Some(e);
                break;
            }
        }
    }

    if owns_chunks {
        for chunk_path in &chunk_paths {
            let _ = tokio::fs::remove_file(chunk_path).await;
        }
    }

    if let Some(error) = first_error {
        return Err(error);
    }

    if transcript.trim().is_empty() {
        return Err(GroqApiError {
            status: None,
            code: "empty_response".to_string(),
            message: "Groq returned no transcript. Try again.".to_string(),
            retryable: true,
        });
    }

    Ok(transcript)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_partial_transcript_removes_overlapping_words() {
        let merged = merge_partial_transcript(
            "The quick brown fox jumps over the lazy dog",
            "over the lazy dog and lands softly",
        );

        assert_eq!(
            merged,
            "The quick brown fox jumps over the lazy dog and lands softly"
        );
    }

    #[test]
    fn merge_partial_transcript_appends_distinct_chunks() {
        let merged = merge_partial_transcript("First sentence.", "Second sentence.");

        assert_eq!(merged, "First sentence. Second sentence.");
    }
}

fn start_recorder(state: &AppState, app: &tauri::AppHandle) -> Result<(), AppError> {
    if state.recording_active.load(Ordering::SeqCst) {
        return Ok(());
    }

    let cfg = state
        .config
        .lock()
        .map_err(|e| {
            AppError::new(
                "config_lock_failed",
                format!("Settings lock error: {e}"),
                true,
                None,
            )
        })?
        .clone();
    if cfg.model_provider == "api" && cfg.groq_api_key.trim().is_empty() {
        return Err(AppError::new(
            "missing_api_key",
            "Enter a Groq API key or switch to a downloaded local Whisper model.",
            false,
            Some("Open Settings"),
        ));
    }
    if cfg.model_provider == "api" && !entitlement::active_status().features.cloud_provider {
        if model_download::is_model_available(&cfg.local_model_size) {
            let _ = app.emit(
                "entitlement-offline-fallback",
                "No internet connection. Echo is using local transcription until Pro can be verified.",
            );
        } else {
            return Err(AppError::new(
                "pro_verification_offline",
                "No internet connection. Reconnect to verify Echo Pro, or download a local Whisper model before dictating offline.",
                false,
                Some("Open Settings"),
            ));
        }
    }
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

    if !enabled {
        let labels = state
            .indicator_hovered
            .lock()
            .map(|mut hovered| {
                let labels = hovered
                    .iter()
                    .filter_map(|(label, expanded)| expanded.then(|| label.clone()))
                    .collect::<Vec<_>>();
                hovered.clear();
                labels
            })
            .unwrap_or_default();
        for label in labels {
            set_indicator_hover_state(&app, label, false);
        }
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
    let monitor = primary_indicator_monitor(&app).ok_or("No primary monitor")?;

    if !force {
        if let Some(state) = app.try_state::<AppState>() {
            let unchanged = state
                .indicator_geometry
                .lock()
                .ok()
                .is_some_and(|geometry| {
                    geometry.len() == 1
                        && geometry.get("indicator").is_some_and(|stored| {
                            indicator_geometry_matches(*stored, width, height, &monitor)
                        })
                });
            if unchanged {
                hide_stale_indicator_windows(&app, 1);
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
fn indicator_hover_snapshot_on_main(
    app: &tauri::AppHandle,
    expanded_by_label: HashMap<String, bool>,
    collapse_active: bool,
) -> Option<Vec<(String, bool)>> {
    let (tx, rx) = mpsc::channel();
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let monitors = indicator_monitors(&app_handle);
        let mut result = Vec::with_capacity(monitors.len());

        for index in 0..monitors.len() {
            let label = indicator_label(index);
            let Some(indicator) = app_handle.get_webview_window(&label) else {
                continue;
            };
            let expanded =
                expanded_by_label.get(&label).copied().unwrap_or(false) || collapse_active;
            if let Some(hovered) = indicator_contains_mouse(&indicator, expanded) {
                result.push((label, hovered));
            }
        }

        let _ = tx.send(result);
    })
    .ok()?;

    rx.recv_timeout(std::time::Duration::from_millis(
        INDICATOR_MAIN_THREAD_TIMEOUT_MS,
    ))
    .ok()
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
            let labels = hover_state
                .lock()
                .map(|mut hovered| {
                    let labels = hovered
                        .iter()
                        .filter_map(|(label, expanded)| expanded.then(|| label.clone()))
                        .collect::<Vec<_>>();
                    hovered.clear();
                    labels
                })
                .unwrap_or_default();
            for label in labels {
                set_indicator_hover_state(&app, label, false);
            }
            continue;
        }

        let expanded_by_label = hover_state
            .lock()
            .map(|hovered| hovered.clone())
            .unwrap_or_default();
        let collapse_active = collapse_generation.load(Ordering::SeqCst) != 0;
        let Some(snapshot) =
            indicator_hover_snapshot_on_main(&app, expanded_by_label, collapse_active)
        else {
            continue;
        };

        let mut changes = Vec::new();
        if let Ok(mut hover_state) = hover_state.lock() {
            for (label, hovered) in snapshot {
                let previous = hover_state.insert(label.clone(), hovered).unwrap_or(false);
                if hovered != previous {
                    changes.push((label, hovered));
                }
            }
        }

        for (label, hovered) in changes {
            set_indicator_hover_state(&app, label, hovered);
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
    let _: () = objc::msg_send![ns_win, setCollectionBehavior: 1u64 << 0 | 1u64 << 4 | 1u64 << 8];
}

#[derive(Serialize)]
struct ScreenSize {
    width: u32,
    height: u32,
}

#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> Result<AppConfig, String> {
    let config = AppConfig::try_load()?;
    if let Ok(mut cached_config) = state.config.lock() {
        *cached_config = config.clone();
    }
    Ok(config)
}

#[tauri::command]
fn save_config(
    state: tauri::State<'_, AppState>,
    config: AppConfig,
) -> Result<ConfigSaveResult, ConfigSaveError> {
    if config.model_provider == "api" && !entitlement::active_status().features.cloud_provider {
        return Err(ConfigSaveError::paywall_required(
            "Unlock Echo Pro to save cloud transcription settings.",
        ));
    }
    let save_result = config.save_with_status()?;
    if let Ok(mut cached_config) = state.config.lock() {
        *cached_config = save_result.config.clone();
    }
    Ok(save_result)
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
    if !entitlement::active_status().features.cloud_provider {
        return Err(GroqApiError {
            status: None,
            code: "paywall_required".to_string(),
            message: "Unlock Echo Pro to test cloud transcription.".to_string(),
            retryable: false,
        });
    }
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
        Ok(cfg)
            if cfg.model_provider == "api"
                && !entitlement::active_status().features.cloud_provider =>
        {
            setup::get_status_with_provider_error(
                &cfg,
                "Unlock Echo Pro to use cloud transcription, or switch to a local Whisper model.",
            )
        }
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

fn emit_app_shortcut(
    app: &tauri::AppHandle,
    shortcut: String,
    state: &str,
    session_id: Option<u64>,
    audio_path: Option<String>,
    duration_ms: Option<u64>,
    error: Option<AppError>,
) {
    let _ = app.emit_to(
        "main",
        "app-shortcut",
        AppShortcutPayload {
            shortcut,
            state: state.to_string(),
            session_id,
            audio_path,
            duration_ms,
            error,
        },
    );
}

fn emit_main_event(app: &tauri::AppHandle, event: &str) {
    let _ = app.emit_to("main", event, ());
}

fn begin_stop_recorder(state: &AppState) -> Result<audio::RecordingResultReceiver, AppError> {
    let mut recorder = state
        .recorder
        .lock()
        .map_err(|e| AppError::mic_unavailable(format!("Recorder lock error: {e}")))?;
    if !recorder.is_recording() {
        state.recording_active.store(false, Ordering::SeqCst);
        cancel_live_transcription(state);
        return Err(AppError::not_recording());
    }

    state.recording_active.store(false, Ordering::SeqCst);
    cancel_live_transcription(state);
    recorder.begin_stop().map_err(|e| {
        if e == "Not recording" {
            AppError::not_recording()
        } else {
            AppError::mic_unavailable(e)
        }
    })
}

fn wav_duration_ms(audio_path: &std::path::Path) -> Option<u64> {
    let reader = hound::WavReader::open(audio_path).ok()?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return None;
    }
    let frames = u64::from(reader.duration()) / u64::from(spec.channels.max(1));
    Some(frames.saturating_mul(1_000) / u64::from(spec.sample_rate))
}

fn audio_bytes(audio_path: &std::path::Path) -> Option<u64> {
    std::fs::metadata(audio_path)
        .ok()
        .map(|metadata| metadata.len())
}

fn cleanup_recording_file(audio_path: &std::path::Path) {
    if let Err(e) = std::fs::remove_file(audio_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("Recording temp cleanup failed: {e}");
        }
    }
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod cleanup_tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn cleanup_recording_file_removes_existing_file_and_allows_missing_file() {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        drop(file);

        cleanup_recording_file(&path);
        assert!(!path.exists());

        cleanup_recording_file(&path);
    }
}

fn handle_native_shortcut_pressed(app: tauri::AppHandle, shortcut: String) {
    let Some(state) = app.try_state::<AppState>() else {
        emit_app_shortcut(
            &app,
            shortcut,
            "StartFailed",
            None,
            None,
            None,
            Some(AppError::new(
                "state_unavailable",
                "Echo is still starting up. Try the shortcut again.",
                true,
                None,
            )),
        );
        return;
    };

    if state.recording_active.load(Ordering::SeqCst) {
        return;
    }

    let started_at = Instant::now();
    match start_recorder(&state, &app) {
        Ok(()) => {
            let session_id = state
                .shortcut_session_counter
                .fetch_add(1, Ordering::SeqCst)
                + 1;
            if let Ok(mut active_session_id) = state.active_shortcut_session_id.lock() {
                *active_session_id = Some(session_id);
            }
            if let Ok(mut recorded_at) = state.shortcut_recording_started_at.lock() {
                *recorded_at = Some(started_at);
            }
            emit_app_shortcut(
                &app,
                shortcut,
                "Started",
                Some(session_id),
                None,
                None,
                None,
            );
            let _ = app.emit("indicator-mode", "recording");

            let app_handle = app.clone();
            std::thread::spawn(move || {
                let _ = media::pause_media();
                reset_indicator_hover_transition(&app_handle);
                show_indicator_window(
                    &app_handle,
                    false,
                    Some((
                        INDICATOR_RECORDING_WIDTH,
                        INDICATOR_RECORDING_COMPACT_HEIGHT,
                    )),
                );
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let _ = capture_focus_target(&app_handle, &state, true);
                }
            });
        }
        Err(error) => {
            emit_app_shortcut(&app, shortcut, "StartFailed", None, None, None, Some(error));
        }
    }
}

fn handle_native_shortcut_released(app: tauri::AppHandle, shortcut: String) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    if !state.recording_active.load(Ordering::SeqCst) {
        return;
    }

    let duration_ms = state
        .shortcut_recording_started_at
        .lock()
        .ok()
        .and_then(|mut recorded_at| recorded_at.take())
        .map(|started_at| started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
    let session_id = state
        .active_shortcut_session_id
        .lock()
        .ok()
        .and_then(|active_session_id| *active_session_id);

    match begin_stop_recorder(&state) {
        Ok(result_rx) => {
            emit_app_shortcut(
                &app,
                shortcut.clone(),
                "Stopping",
                session_id,
                None,
                duration_ms,
                None,
            );
            let _ = app.emit("indicator-mode", "transcribing");
            let app_handle = app.clone();
            std::thread::spawn(move || {
                let _ = media::resume_media();
                match result_rx.recv().map_err(|e| format!("Recv error: {e}")) {
                    Ok(Ok(path)) => emit_app_shortcut(
                        &app_handle,
                        shortcut,
                        "Stopped",
                        session_id,
                        Some(path.to_string_lossy().to_string()),
                        duration_ms,
                        None,
                    ),
                    Ok(Err(e)) | Err(e) => emit_app_shortcut(
                        &app_handle,
                        shortcut,
                        "StopFailed",
                        session_id,
                        None,
                        duration_ms,
                        Some(AppError::mic_unavailable(e)),
                    ),
                }
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut active_session_id) = state.active_shortcut_session_id.lock() {
                        if *active_session_id == session_id {
                            *active_session_id = None;
                        }
                    }
                }
            });
        }
        Err(error) => {
            if let Ok(mut active_session_id) = state.active_shortcut_session_id.lock() {
                *active_session_id = None;
            }
            std::thread::spawn(|| {
                let _ = media::resume_media();
            });
            emit_app_shortcut(
                &app,
                shortcut,
                "StopFailed",
                session_id,
                None,
                duration_ms,
                Some(error),
            );
        }
    }
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
            let app = app.clone();
            let shortcut = shortcut_for_event.clone();
            match event.state {
                ShortcutState::Pressed => handle_native_shortcut_pressed(app, shortcut),
                ShortcutState::Released => handle_native_shortcut_released(app, shortcut),
            }
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
        Some((
            INDICATOR_RECORDING_WIDTH,
            INDICATOR_RECORDING_COMPACT_HEIGHT,
        )),
    );
    let _ = app.emit("indicator-mode", "recording");
    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<'_, AppState>) -> Result<String, AppError> {
    let result_rx = begin_stop_recorder(&state)?;
    let path = result_rx
        .recv()
        .map_err(|e| AppError::mic_unavailable(format!("Recv error: {e}")))?
        .map_err(AppError::mic_unavailable)?;
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

async fn transcribe_local_for_run(
    app: &tauri::AppHandle,
    cfg: &AppConfig,
    path: &std::path::Path,
    provider: &str,
    total_start: Instant,
    audio_duration_ms: Option<u64>,
    audio_bytes: Option<u64>,
    speech_check_ms: u64,
    has_speech: bool,
) -> Result<String, AppError> {
    let model_size = cfg.local_model_size.clone();
    let requested_threads = cfg.local_transcription_threads;
    let local_path = path.to_path_buf();
    let local_result = tokio::task::spawn_blocking(move || {
        whisper::transcribe_local_with_metrics(&local_path, &model_size, requested_threads)
    })
    .await
    .map_err(|e| {
        AppError::new(
            "local_transcription_failed",
            format!("Task error: {e}"),
            true,
            None,
        )
    })?;

    match local_result {
        Ok(local) => {
            let _ = app.emit(
                "dictation-performance",
                DictationPerformancePayload {
                    phase: "transcribe".to_string(),
                    provider: provider.to_string(),
                    model: None,
                    local_model_size: Some(local.metrics.model_size.clone()),
                    audio_duration_ms,
                    audio_bytes,
                    speech_check_ms: Some(speech_check_ms),
                    speech_detected: Some(has_speech),
                    model_cache_hit: Some(local.metrics.model_cache_hit),
                    model_load_ms: Some(local.metrics.model_load_ms),
                    audio_decode_ms: Some(local.metrics.audio_decode_ms),
                    inference_ms: Some(local.metrics.inference_ms),
                    cloud_transcribe_ms: None,
                    cleanup_ms: None,
                    paste_ms: None,
                    total_ms: elapsed_ms(total_start),
                    thread_count: Some(local.metrics.thread_count),
                    error_code: None,
                },
            );
            Ok(local.text)
        }
        Err(error) => {
            let _ = app.emit(
                "dictation-performance",
                DictationPerformancePayload {
                    phase: "transcribe".to_string(),
                    provider: provider.to_string(),
                    model: None,
                    local_model_size: Some(cfg.local_model_size.clone()),
                    audio_duration_ms,
                    audio_bytes,
                    speech_check_ms: Some(speech_check_ms),
                    speech_detected: Some(has_speech),
                    model_cache_hit: None,
                    model_load_ms: None,
                    audio_decode_ms: None,
                    inference_ms: None,
                    cloud_transcribe_ms: None,
                    cleanup_ms: None,
                    paste_ms: None,
                    total_ms: elapsed_ms(total_start),
                    thread_count: Some(whisper::local_thread_count(
                        cfg.local_transcription_threads,
                    )),
                    error_code: Some(error.code.clone()),
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn transcribe_audio(app: tauri::AppHandle, audio_path: String) -> Result<String, AppError> {
    let total_start = Instant::now();
    let cfg = AppConfig::try_load().map_err(|e| {
        AppError::new(
            "config_load_failed",
            format!("Could not load settings: {e}"),
            false,
            Some("Open Settings"),
        )
    })?;
    let path = std::path::PathBuf::from(&audio_path);
    let audio_duration_ms = wav_duration_ms(&path);
    let audio_bytes = audio_bytes(&path);

    let speech_path = path.clone();
    let speech_start = Instant::now();
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
    let speech_check_ms = elapsed_ms(speech_start);

    let mut provider_for_run = cfg.model_provider.clone();
    if cfg.model_provider == "api" && !entitlement::active_status().features.cloud_provider {
        if model_download::is_model_available(&cfg.local_model_size) {
            provider_for_run = "local_fallback".to_string();
            let _ = app.emit(
                "entitlement-offline-fallback",
                "No internet connection. Echo is using local transcription until Pro can be verified.",
            );
        } else {
            cleanup_recording_file(&path);
            return Err(AppError::new(
                "pro_verification_offline",
                "No internet connection. Reconnect to verify Echo Pro, or download a local Whisper model before dictating offline.",
                false,
                Some("Open Settings"),
            ));
        }
    }

    let result = match provider_for_run.as_str() {
        "local" | "local_fallback" => {
            transcribe_local_for_run(
                &app,
                &cfg,
                &path,
                &provider_for_run,
                total_start,
                audio_duration_ms,
                audio_bytes,
                speech_check_ms,
                has_speech,
            )
            .await
        }
        _ => {
            if cfg.groq_api_key.is_empty() {
                Err(AppError::new(
                    "missing_api_key",
                    "Enter a Groq API key or switch to a downloaded local Whisper model.",
                    false,
                    Some("Open Settings"),
                ))
            } else {
                let cloud_start = Instant::now();
                let cloud_result =
                    transcribe_cloud_chunked(&cfg.groq_api_key, &path, &cfg.transcription_model)
                        .await
                        .map_err(|e| AppError::new(e.code, e.message, e.retryable, None));
                let cloud_transcribe_ms = elapsed_ms(cloud_start);
                let _ = app.emit(
                    "dictation-performance",
                    DictationPerformancePayload {
                        phase: "transcribe".to_string(),
                        provider: "api".to_string(),
                        model: Some(cfg.transcription_model.clone()),
                        local_model_size: None,
                        audio_duration_ms,
                        audio_bytes,
                        speech_check_ms: Some(speech_check_ms),
                        speech_detected: Some(has_speech),
                        model_cache_hit: None,
                        model_load_ms: None,
                        audio_decode_ms: None,
                        inference_ms: None,
                        cloud_transcribe_ms: Some(cloud_transcribe_ms),
                        cleanup_ms: None,
                        paste_ms: None,
                        total_ms: elapsed_ms(total_start),
                        thread_count: None,
                        error_code: cloud_result.as_ref().err().map(|error| error.code.clone()),
                    },
                );
                match cloud_result {
                    Err(error)
                        if error.code == "network_error"
                            && model_download::is_model_available(&cfg.local_model_size) =>
                    {
                        let _ = app.emit(
                            "entitlement-offline-fallback",
                            "No internet connection. Echo is using local transcription until Pro can be verified.",
                        );
                        transcribe_local_for_run(
                            &app,
                            &cfg,
                            &path,
                            "local_fallback",
                            total_start,
                            audio_duration_ms,
                            audio_bytes,
                            speech_check_ms,
                            has_speech,
                        )
                        .await
                    }
                    other => other,
                }
            }
        }
    };

    cleanup_recording_file(&path);
    result
}

#[tauri::command]
async fn cleanup_text(app: tauri::AppHandle, text: String) -> Result<String, String> {
    let start = Instant::now();
    let cfg = AppConfig::try_load()?;
    entitlement::require_cloud_provider()?;
    if cfg.groq_api_key.is_empty() {
        return Err("Groq API key not configured".to_string());
    }
    if !cfg.cleanup_enabled {
        return Ok(text);
    }
    let result = groq::cleanup(&cfg.groq_api_key, &text, &cfg.cleanup_model)
        .await
        .map_err(|e| e.message);
    let _ = app.emit(
        "dictation-performance",
        DictationPerformancePayload {
            phase: "cleanup".to_string(),
            provider: cfg.model_provider.clone(),
            model: Some(cfg.cleanup_model.clone()),
            local_model_size: (cfg.model_provider == "local").then(|| cfg.local_model_size),
            audio_duration_ms: None,
            audio_bytes: None,
            speech_check_ms: None,
            speech_detected: None,
            model_cache_hit: None,
            model_load_ms: None,
            audio_decode_ms: None,
            inference_ms: None,
            cloud_transcribe_ms: None,
            cleanup_ms: Some(elapsed_ms(start)),
            paste_ms: None,
            total_ms: elapsed_ms(start),
            thread_count: None,
            error_code: result.as_ref().err().map(|_| "cleanup_failed".to_string()),
        },
    );
    result
}

#[tauri::command]
fn paste_transcript(
    text: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<PasteTranscriptResult, AppError> {
    let start = Instant::now();
    input::write_clipboard(&text)
        .map_err(|e| AppError::paste_denied(format!("Clipboard write failed: {e}")))?;

    let finish = |result: PasteTranscriptResult| {
        let _ = app.emit(
            "dictation-performance",
            DictationPerformancePayload {
                phase: "paste".to_string(),
                provider: "paste".to_string(),
                model: None,
                local_model_size: None,
                audio_duration_ms: None,
                audio_bytes: None,
                speech_check_ms: None,
                speech_detected: None,
                model_cache_hit: None,
                model_load_ms: None,
                audio_decode_ms: None,
                inference_ms: None,
                cloud_transcribe_ms: None,
                cleanup_ms: None,
                paste_ms: Some(elapsed_ms(start)),
                total_ms: elapsed_ms(start),
                thread_count: None,
                error_code: result.warning.as_ref().map(|warning| warning.code.clone()),
            },
        );
        Ok(result)
    };

    if !setup::is_accessibility_trusted() {
        eprintln!("Paste simulation skipped: Echo is not trusted for Accessibility.");
        return finish(PasteTranscriptResult {
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
        return finish(PasteTranscriptResult {
            status: "copied_no_target".to_string(),
            warning: None,
        });
    }

    if let Err(e) = target.restore() {
        eprintln!("Focus restore failed, falling back to clipboard: {e}");
        return finish(PasteTranscriptResult {
            status: "copied".to_string(),
            warning: Some(AppError::paste_denied(format!(
                "Could not restore the target app: {e}"
            ))),
        });
    }

    std::thread::sleep(std::time::Duration::from_millis(250));

    match input::simulate_paste() {
        Ok(()) => finish(PasteTranscriptResult {
            status: "pasted".to_string(),
            warning: None,
        }),
        Err(e) => {
            eprintln!("Paste simulation failed, text is on clipboard: {e}");
            finish(PasteTranscriptResult {
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
    access_token: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AppError> {
    let dl_state = Arc::clone(&state.download_state);
    model_download::download_model(&model_size, &access_token, dl_state).await
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
    let limit = entitlement::history_limit().map(|free_limit| cfg.history_limit.min(free_limit));
    history::add(&text, &paste_result, limit)
}

#[tauri::command]
fn get_effective_entitlement(user_id: Option<String>) -> entitlement::EntitlementStatus {
    entitlement::status_for_user(user_id.as_deref())
}

#[tauri::command]
fn cache_entitlement(
    cache: entitlement::EntitlementCache,
) -> Result<entitlement::EntitlementStatus, String> {
    entitlement::cache_status(cache.clone())?;
    Ok(entitlement::status_for_user(Some(&cache.user_id)))
}

#[tauri::command]
fn clear_active_entitlement_user() {
    entitlement::clear_active_user();
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
fn clear_dictation_stats() -> Result<(), String> {
    stats::clear()
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
fn show_notepad_window(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Regular)
        .map_err(|e| format!("Could not activate app for Notepad: {e}"))?;

    let window = app
        .get_webview_window("notepad")
        .ok_or_else(|| "Notepad window is not available".to_string())?;

    window
        .unminimize()
        .map_err(|e| format!("Could not unminimize Notepad window: {e}"))?;
    window
        .show()
        .map_err(|e| format!("Could not show Notepad window: {e}"))?;
    window
        .set_size(tauri::LogicalSize::new(
            NOTEPAD_WINDOW_WIDTH,
            NOTEPAD_WINDOW_HEIGHT,
        ))
        .map_err(|e| format!("Could not resize Notepad window: {e}"))?;
    window
        .center()
        .map_err(|e| format!("Could not center Notepad window: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("Could not focus Notepad window: {e}"))?;

    Ok(())
}

#[tauri::command]
fn get_auth_storage(key: String) -> Result<Option<String>, String> {
    secure::get_auth_storage(&key)
}

#[tauri::command]
fn set_auth_storage(key: String, value: String) -> Result<(), String> {
    secure::set_auth_storage(&key, &value)
}

#[tauri::command]
fn delete_auth_storage(key: String) -> Result<(), String> {
    secure::delete_auth_storage(&key)
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

fn emit_auth_deep_links<I, U>(app: &tauri::AppHandle, urls: I)
where
    I: IntoIterator<Item = U>,
    U: ToString,
{
    let urls: Vec<String> = urls.into_iter().map(|url| url.to_string()).collect();
    if !urls.is_empty() {
        show_main_window_internal(app);
        let _ = app.emit("auth-deep-link", urls);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window_internal(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
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
            indicator_hovered: Arc::new(Mutex::new(HashMap::new())),
            indicator_hover_enabled: Arc::new(AtomicBool::new(false)),
            indicator_hover_generation: Arc::new(AtomicU64::new(0)),
            indicator_collapse_generation: Arc::new(AtomicU64::new(0)),
            indicator_geometry: Mutex::new(HashMap::new()),
            indicator_window_count: Mutex::new(1),
            app_shortcut: Mutex::new(None),
            config: Mutex::new(AppConfig::load()),
            shortcut_recording_started_at: Mutex::new(None),
            shortcut_session_counter: AtomicU64::new(0),
            active_shortcut_session_id: Mutex::new(None),
        })
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_always_on_top(false).ok();

            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                emit_auth_deep_links(&app_handle, event.urls());
            });

            if let Ok(Some(urls)) = app.deep_link().get_current() {
                emit_auth_deep_links(app.handle(), urls);
            }

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

            let view_dictate_i =
                MenuItem::with_id(app, "menu_open_dictate", "Home", true, Some("CmdOrCtrl+1"))?;
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
                    emit_main_event(app, "tray-start-recording");
                }
                "menu_stop_recording" => {
                    emit_main_event(app, "tray-stop-recording");
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

            // Use a Retina-resolution template source because tray-icon displays
            // the NSImage at 18 points on macOS.
            let icon = Image::from_bytes(include_bytes!("../icons/tray-icon@2x.png"))?;

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
                        emit_main_event(app, "tray-start-recording");
                    }
                    "stop_recording" => {
                        emit_main_event(app, "tray-stop-recording");
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
            get_effective_entitlement,
            cache_entitlement,
            clear_active_entitlement_user,
            get_dictation_stats,
            clear_dictation_stats,
            get_support_diagnostics,
            get_support_diagnostics_json,
            record_dictation_stats,
            list_notepad_notes,
            create_notepad_note,
            update_notepad_note,
            delete_notepad_note,
            show_main_window,
            show_notepad_window,
            get_auth_storage,
            set_auth_storage,
            delete_auth_storage,
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
