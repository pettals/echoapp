use super::{
    capture::{self, Capture, Event},
    license, runtime,
    storage::{Meeting, Segment, Store},
    summary, CAPTURE_ACTIVE, CAPTURE_GATE,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::PathBuf,
    process::ChildStdin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::Emitter;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub transcription_model: String,
    pub summary_provider: String,
    pub mode: String,
    pub cloud_consent: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            transcription_model: "auto".into(),
            summary_provider: "local".into(),
            mode: "online".into(),
            cloud_consent: false,
        }
    }
}
impl Settings {
    pub fn load() -> Result<Self, String> {
        let path = super::directory()?.join("settings.json");
        match std::fs::read(path) {
            Ok(data) => serde_json::from_slice(&data)
                .map_err(|_| "Meetings settings could not be read. Save them again.".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("Could not read Meetings settings".into()),
        }
    }
    fn validate(&self) -> Result<(), String> {
        if self.transcription_model != "auto"
            && !crate::local_models::known(&self.transcription_model)
        {
            return Err("Choose a supported transcription model".into());
        }
        if !summary::valid_provider(&self.summary_provider)
            || !matches!(self.mode.as_str(), "online" | "in-person")
        {
            return Err("Choose supported Meetings settings".into());
        }
        if self.summary_provider != "local"
            && (!self.cloud_consent || summary::key(&self.summary_provider)?.is_none())
        {
            return Err(
                "Add your own API key and explicitly allow transcript processing by this provider"
                    .into(),
            );
        }
        Ok(())
    }
    fn save(&self) -> Result<(), String> {
        self.validate()?;
        let dir = super::directory()?;
        let mut file = tempfile::NamedTempFile::new_in(&dir)
            .map_err(|_| "Could not save Meetings settings")?;
        file.write_all(
            &serde_json::to_vec_pretty(self).map_err(|_| "Could not encode Meetings settings")?,
        )
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Could not save Meetings settings")?;
        file.persist(dir.join("settings.json"))
            .map_err(|_| "Could not save Meetings settings")?;
        Ok(())
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub provider: String,
    pub meeting_id: Option<String>,
    pub state: String,
    pub duration_ms: u64,
    pub microphone_level: f64,
    pub computer_level: f64,
    pub section: usize,
    pub sections: usize,
    pub message: Option<String>,
}
struct Session {
    id: String,
    input: Arc<Mutex<Option<ChildStdin>>>,
    cancel: Arc<AtomicBool>,
}
struct Inner {
    store: OnceLock<Result<Arc<Store>, String>>,
    session: Mutex<Option<Session>>,
    status: Mutex<Status>,
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
impl Default for Service {
    fn default() -> Self {
        Self(Arc::new(Inner {
            store: OnceLock::new(),
            session: Mutex::new(None),
            status: Mutex::new(Status {
                state: "idle".into(),
                ..Default::default()
            }),
        }))
    }
}
impl Service {
    pub fn store(&self) -> Result<Arc<Store>, String> {
        self.0
            .store
            .get_or_init(|| {
                let store = Store::open(&super::directory()?.join("meetings.sqlite"))?;
                store.recover()?;
                Ok(Arc::new(store))
            })
            .clone()
    }
    fn publish(&self, app: &tauri::AppHandle, change: impl FnOnce(&mut Status)) {
        let value = {
            let mut status = self.0.status.lock().unwrap_or_else(|e| e.into_inner());
            change(&mut status);
            status.clone()
        };
        let _ = app.emit("meeting-status", value);
    }
    pub fn busy(&self) -> bool {
        self.0
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
    pub fn shutdown(&self) {
        if let Some(session) = self
            .0
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            session.cancel.store(true, Ordering::SeqCst);
            let _ = capture::command(&session.input, "stop");
        }
    }
    fn finish(&self, app: &tauri::AppHandle, id: &str, state: &str, error: Option<String>) {
        let cancelled = self
            .0
            .session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_none_or(|s| s.id != id || s.cancel.load(Ordering::SeqCst));
        if let Ok(store) = self.store() {
            let _=store.state(id,if cancelled{"interrupted"}else{state},if cancelled{Some("Processing stopped. The saved transcript is available; recover or regenerate notes when ready.")}else{error.as_deref()});
        }
        self.publish(app, |status| {
            status.state = state.into();
            status.message = error;
            status.microphone_level = 0.;
            status.computer_level = 0.;
        });
        let mut session = self.0.session.lock().unwrap_or_else(|e| e.into_inner());
        if session.as_ref().is_some_and(|s| s.id == id) {
            session.take();
        }
    }
}

pub fn supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.split('.').next()?.parse::<u32>().ok())
            .is_some_and(|v| v >= 13)
    }
    #[cfg(not(target_os = "macos"))]
    {
        cfg!(all(target_os = "windows", target_arch = "x86_64"))
    }
}
fn transcription_model(settings: &Settings) -> Result<String, String> {
    if settings.transcription_model != "auto" {
        if crate::model_download::is_model_available(&settings.transcription_model) {
            return Ok(settings.transcription_model.clone());
        }
        return Err("Download the selected meeting transcription model first".into());
    }
    for id in [crate::local_models::BARK_ID, "small", "medium"] {
        if crate::model_download::is_model_available(id) {
            return Ok(id.into());
        }
    }
    Err("Download Bark Clean or Whisper before recording a meeting".into())
}
fn spool(id: &str) -> Result<PathBuf, String> {
    if !super::id_valid(id) {
        return Err("Invalid meeting ID".into());
    }
    Ok(super::directory()?.join("recordings").join(id))
}
fn authorize_provider(settings: &Settings) -> Result<(), String> {
    settings.validate()?;
    if settings.summary_provider == "local"
        && !crate::model_download::is_model_available(runtime::MODEL_ID)
    {
        return Err("Download the local notes model before generating notes. The transcript remains available.".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    supported: bool,
    pro: bool,
    offline_license: bool,
    settings: Settings,
    transcription_model: Option<String>,
    notes_model: crate::model_download::ModelStatus,
    keys: std::collections::HashMap<String, bool>,
    busy: bool,
    requirements: Vec<String>,
}
#[tauri::command]
pub fn meeting_readiness(
    service: tauri::State<'_, Service>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Readiness, String> {
    let loaded = Settings::load();
    let mut requirements = vec![];
    if loaded.is_err() {
        requirements.push(
            "Meetings settings could not be read. Save your processing settings again.".into(),
        );
    }
    let settings = loaded.unwrap_or_default();
    let model = transcription_model(&settings);
    if !supported() {
        requirements.push(
            "Meetings requires macOS 13 or later, or Windows 10/11 on an x64 computer.".into(),
        );
    }
    if !license::allowed() {
        requirements.push("Unlock Echo Pro and verify your purchase online once.".into());
    }
    if let Err(error) = &model {
        requirements.push(error.clone());
    }
    let notes = crate::model_download::check_model_status(runtime::MODEL_ID, &state.download_state);
    if settings.summary_provider == "local" && !notes.downloaded {
        requirements.push("Download the local notes model (2.74 GB). 8 GB memory is recommended; 16 GB gives more headroom.".into());
    }
    let mut keys = std::collections::HashMap::new();
    for provider in ["openai", "gemini", "anthropic"] {
        keys.insert(
            provider.into(),
            summary::key(provider).ok().flatten().is_some(),
        );
    }
    if let Err(error) = settings.validate() {
        requirements.push(error);
    }
    Ok(Readiness {
        supported: supported(),
        pro: license::allowed(),
        offline_license: license::offline_allowed(),
        settings,
        transcription_model: model.ok(),
        notes_model: notes,
        keys,
        busy: service.busy(),
        requirements,
    })
}
#[tauri::command]
pub fn meeting_status(service: tauri::State<'_, Service>) -> Status {
    service
        .0
        .status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}
#[tauri::command]
pub async fn list_meetings(
    service: tauri::State<'_, Service>,
    query: String,
) -> Result<Vec<Meeting>, String> {
    let store = service.store()?;
    tauri::async_runtime::spawn_blocking(move || store.list(&query))
        .await
        .map_err(|_| "Meeting search stopped. Try again.".to_string())?
}
#[tauri::command]
pub fn get_meeting(service: tauri::State<'_, Service>, id: String) -> Result<Meeting, String> {
    service.store()?.get(&id)
}
#[tauri::command]
pub fn update_meeting(
    service: tauri::State<'_, Service>,
    id: String,
    title: String,
    notes: Option<String>,
) -> Result<Meeting, String> {
    let store = service.store()?;
    store.edit(&id, &title, notes.as_deref())?;
    store.get(&id)
}
#[tauri::command]
pub fn save_meeting_settings(
    service: tauri::State<'_, Service>,
    settings: Settings,
) -> Result<(), String> {
    license::require()?;
    if service.busy() {
        return Err(
            "Finish the current meeting or stop processing before changing its AI provider.".into(),
        );
    }
    settings.save()
}
#[tauri::command]
pub fn save_meeting_provider_key(provider: String, key: String) -> Result<(), String> {
    license::require()?;
    summary::save_key(&provider, &key)
}
#[tauri::command]
pub async fn test_meeting_provider(provider: String) -> Result<(), String> {
    license::require()?;
    let schema = serde_json::json!({"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false});
    let value = summary::cloud_generate(
        &provider,
        "Return the requested JSON with ok true. This is a connection test.",
        "Test connection",
        &schema,
        &AtomicBool::new(false),
    )
    .await?;
    if value["ok"] == true {
        Ok(())
    } else {
        Err("The provider returned an unexpected connection-test response".into())
    }
}
#[tauri::command]
pub fn cache_meeting_license(
    user_id: String,
    license: license::SignedLicense,
) -> Result<(), String> {
    if crate::secure::active_entitlement_user().as_deref() != Some(&user_id) {
        return Err("Sign in to this account before saving its licence".into());
    }
    license::save(&user_id, license)
}
#[tauri::command]
pub fn activate_offline_meetings_license(user_id: String) -> bool {
    license::activate(&user_id)
}
#[tauri::command]
pub fn revoke_meeting_license(user_id: String) -> Result<(), String> {
    if crate::secure::active_entitlement_user().as_deref() != Some(&user_id) {
        return Err("The account changed during licence verification".into());
    }
    license::revoke(&user_id)
}

#[tauri::command]
pub async fn start_meeting(
    app: tauri::AppHandle,
    service: tauri::State<'_, Service>,
    state: tauri::State<'_, crate::AppState>,
    mode: String,
) -> Result<String, String> {
    license::require()?;
    if !supported() {
        return Err("Meetings requires macOS 13+ or Windows 10/11 x64".into());
    }
    if !matches!(mode.as_str(), "online" | "in-person") {
        return Err("Select Online meeting or In-person meeting".into());
    }
    let settings = Settings::load()?;
    authorize_provider(&settings)?;
    let model = transcription_model(&settings)?;
    runtime::helper_path("echo-capture")?;
    if settings.summary_provider == "local" {
        runtime::helper_path("echo-notes")?;
    }
    let id = format!(
        "meeting-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        std::process::id()
    );
    let directory = spool(&id)?;
    let input = Arc::new(Mutex::new(None));
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let _gate = CAPTURE_GATE.lock().map_err(|_| "Audio capture is busy")?;
        if state.recording_active.load(Ordering::SeqCst) || service.busy() {
            return Err("Finish the current recording or meeting before starting another.".into());
        }
        std::fs::create_dir_all(&directory)
            .map_err(|_| "Could not create temporary recording storage. Check disk space.")?;
        service
            .store()?
            .create(&id, &mode, &model, &settings.summary_provider)?;
        *service.0.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(Session {
            id: id.clone(),
            input: input.clone(),
            cancel: cancel.clone(),
        });
        CAPTURE_ACTIVE.store(true, Ordering::SeqCst);
    }
    service.publish(&app, |status| {
        *status = Status {
            meeting_id: Some(id.clone()),
            provider: settings.summary_provider.clone(),
            state: "starting".into(),
            ..Default::default()
        }
    });
    let service = service.inner().clone();
    let worker_id = id.clone();
    std::thread::spawn(move || {
        let status_service = service.clone();
        let status_app = app.clone();
        let status_id = worker_id.clone();
        let control = input.clone();
        let recording = Capture::start(&directory, &mode, move |value| {
            if value["kind"] == "limit" || value["kind"] == "error" {
                let _ = capture::command(&control, "stop");
            }
            if matches!(value["kind"].as_str(), Some("paused" | "resumed")) {
                if let Ok(store) = status_service.store() {
                    let _ = store.state(
                        &status_id,
                        if value["kind"] == "paused" {
                            "paused"
                        } else {
                            "recording"
                        },
                        None,
                    );
                    if let Some(duration) = value["durationMs"].as_u64() {
                        let _ = store.duration(&status_id, duration);
                    }
                }
            }
            status_service.publish(&status_app, |s| {
                if let Some(duration) = value["durationMs"].as_u64() {
                    s.duration_ms = duration.min(14_400_000);
                }
                match value["kind"].as_str() {
                    Some("level") => {
                        if value["source"] == "microphone" {
                            s.microphone_level = value["level"].as_f64().unwrap_or(0.)
                        } else {
                            s.computer_level = value["level"].as_f64().unwrap_or(0.)
                        }
                    }
                    Some("paused") => s.state = "paused".into(),
                    Some("resumed") => s.state = "recording".into(),
                    _ => {}
                }
            });
        });
        let mut failure = None;
        if let Ok(recording) = recording {
            // Transfer the writer while the capture object retains ownership of the child.
            *input.lock().unwrap_or_else(|e| e.into_inner()) = recording
                .input
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            service.publish(&app, |s| s.state = "recording".into());
            loop {
                if cancel.load(Ordering::SeqCst) {
                    let _ = capture::command(&input, "stop");
                    break;
                }
                match recording.next() {
                    Ok(Event::Chunk(chunk)) => {
                        if let Err(error) =
                            process_chunk(&service, &worker_id, &directory, &chunk, &model, &cancel)
                        {
                            failure = Some(error);
                            let _ = capture::command(&input, "stop");
                        }
                    }
                    Ok(Event::Stopped(duration)) => {
                        if let Ok(store) = service.store() {
                            let _ = store.duration(&worker_id, duration);
                        }
                        break;
                    }
                    Ok(Event::Failed(error)) | Err(error) => {
                        failure = Some(error);
                        let _ = capture::command(&input, "stop");
                        break;
                    }
                }
            }
            input.lock().unwrap_or_else(|e| e.into_inner()).take();
            drop(recording);
        } else {
            failure = recording.err();
        }
        CAPTURE_ACTIVE.store(false, Ordering::SeqCst);
        if cancel.load(Ordering::SeqCst) {
            service.finish(&app, &worker_id, "interrupted", None);
            return;
        }
        if let Some(error) = failure {
            service.finish(&app, &worker_id, "interrupted", Some(error));
            return;
        }
        let result = generate_notes(&service, &app, &worker_id, &settings, &cancel);
        match result {
            Ok(()) => service.finish(&app, &worker_id, "ready", None),
            Err(error) => service.finish(&app, &worker_id, "failed", Some(error)),
        }
    });
    Ok(id)
}

fn process_chunk(
    service: &Service,
    id: &str,
    directory: &std::path::Path,
    chunk: &capture::Chunk,
    model: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    chunk.validate()?;
    if service.store()?.has_segment(id, chunk.sequence)? {
        let _ = std::fs::remove_file(directory.join(&chunk.file));
        let _ = std::fs::remove_file(chunk.journal(directory));
        return Ok(());
    }
    let path = chunk.path(directory)?;
    if cancel.load(Ordering::SeqCst) {
        return Err("Meeting cancelled".into());
    }
    let text =
        if crate::audio::has_speech(&path).map_err(|_| "Could not inspect a recording segment")? {
            match crate::local_models::transcribe(&path, model, None, || {}) {
                Ok(result) => result.text,
                Err(error) if error.code == "empty_speech" => String::new(),
                Err(error) => return Err(error.message),
            }
        } else {
            String::new()
        };
    if cancel.load(Ordering::SeqCst) {
        return Err("Meeting cancelled".into());
    }
    // Saving even silent segments makes crash recovery idempotent.
    service.store()?.append(
        id,
        &Segment {
            id: chunk.sequence,
            start_ms: chunk.start_ms,
            end_ms: chunk.end_ms,
            source: chunk.source.clone(),
            text,
        },
    )?;
    std::fs::remove_file(&path).map_err(|_|"Transcript saved, but temporary audio could not be removed. Retry recovery or delete this meeting.")?;
    let _ = std::fs::remove_file(chunk.journal(directory));
    Ok(())
}
fn generate_notes(
    service: &Service,
    app: &tauri::AppHandle,
    id: &str,
    settings: &Settings,
    cancel: &AtomicBool,
) -> Result<(), String> {
    authorize_provider(settings)?;
    let store = service.store()?;
    store.state(id, "summarizing", None)?;
    service.publish(app, |s| s.state = "summarizing".into());
    let meeting = store.get(id)?;
    let segments = meeting.transcript;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Could not start meeting note generation")?;
    let notes = runtime.block_on(summary::generate(
        &settings.summary_provider,
        &segments,
        cancel,
        |section, sections| {
            service.publish(app, |s| {
                s.section = section;
                s.sections = sections;
            })
        },
    ))?;
    if cancel.load(Ordering::SeqCst) {
        return Err("Meeting cancelled".into());
    }
    store.save_notes(id, &notes, &settings.summary_provider)?;
    if let Ok(directory) = spool(id) {
        if capture::pending(&directory)?.is_empty() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn control_meeting(
    app: tauri::AppHandle,
    service: tauri::State<'_, Service>,
    command: String,
) -> Result<(), String> {
    if !matches!(command.as_str(), "pause" | "resume" | "stop") {
        return Err("Unknown recording action".into());
    }
    let sessions = service
        .0
        .session
        .lock()
        .map_err(|_| "Meeting controls are busy")?;
    let session = sessions.as_ref().ok_or("No meeting is recording")?;
    capture::command(&session.input, &command)?;
    if command == "stop" {
        service.publish(&app, |s| s.state = "transcribing".into());
        if let Ok(store) = service.store() {
            let _ = store.state(&session.id, "transcribing", None);
        }
    }
    Ok(())
}
#[tauri::command]
pub fn delete_meeting(service: tauri::State<'_, Service>, id: String) -> Result<(), String> {
    let directory = spool(&id)?;
    {
        let session = service
            .0
            .session
            .lock()
            .map_err(|_| "Meeting controls are busy")?;
        if let Some(session) = session.as_ref().filter(|s| s.id == id) {
            session.cancel.store(true, Ordering::SeqCst);
            let _ = capture::command(&session.input, "stop");
        }
    }
    service.store()?.delete(&id)?;
    if directory.exists() {
        std::fs::remove_dir_all(directory).map_err(|_| {
            "Meeting text was deleted, but temporary audio could not be removed. Retry deletion."
        })?;
    }
    Ok(())
}
#[tauri::command]
pub fn discard_meeting_recording(
    service: tauri::State<'_, Service>,
    id: String,
) -> Result<(), String> {
    if service.busy() {
        return Err("Stop the active meeting first".into());
    }
    let directory = spool(&id)?;
    if directory.exists() {
        std::fs::remove_dir_all(directory)
            .map_err(|_| "Could not discard the temporary recording")?;
    }
    service.store()?.state(&id,"failed",Some("Unprocessed audio was discarded. You can still generate notes from the saved transcript."))
}
#[tauri::command]
pub fn cancel_meeting_processing(service: tauri::State<'_, Service>) -> Result<(), String> {
    if super::capture_active() {
        return Err("Stop the meeting recording first".into());
    }
    if let Some(session) = service
        .0
        .session
        .lock()
        .map_err(|_| "Meeting controls are busy")?
        .as_ref()
    {
        session.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}
#[tauri::command]
pub fn regenerate_meeting_notes(
    app: tauri::AppHandle,
    service: tauri::State<'_, Service>,
    state: tauri::State<'_, crate::AppState>,
    id: String,
    recover: bool,
) -> Result<(), String> {
    license::require()?;
    let settings = Settings::load()?;
    authorize_provider(&settings)?;
    let meeting = service.store()?.get(&id)?;
    let directory = spool(&id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let input = Arc::new(Mutex::new(None));
    {
        let _gate = CAPTURE_GATE.lock().map_err(|_| "Meetings is busy")?;
        if service.busy() || state.recording_active.load(Ordering::SeqCst) {
            return Err("Wait for the current meeting to finish processing".into());
        }
        *service.0.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(Session {
            id: id.clone(),
            input,
            cancel: cancel.clone(),
        });
    }
    service.publish(&app, |s| {
        *s = Status {
            meeting_id: Some(id.clone()),
            provider: settings.summary_provider.clone(),
            state: if recover {
                "transcribing"
            } else {
                "summarizing"
            }
            .into(),
            duration_ms: meeting.duration_ms,
            ..Default::default()
        }
    });
    let service = service.inner().clone();
    std::thread::spawn(move || {
        let result = (|| {
            if recover {
                service.store()?.state(&id, "transcribing", None)?;
                for chunk in capture::pending(&directory)? {
                    process_chunk(&service, &id, &directory, &chunk, &meeting.model, &cancel)?;
                }
            }
            if !capture::pending(&directory)?.is_empty() {
                return Err(
                    "Recover or discard the remaining recording before regenerating notes.".into(),
                );
            }
            generate_notes(&service, &app, &id, &settings, &cancel)
        })();
        match result {
            Ok(()) => service.finish(&app, &id, "ready", None),
            Err(error) => service.finish(&app, &id, "failed", Some(error)),
        }
    });
    Ok(())
}
#[tauri::command]
pub fn export_meeting(
    service: tauri::State<'_, Service>,
    id: String,
    format: String,
) -> Result<String, String> {
    let meeting = service.store()?.get(&id)?;
    match format.as_str() {
        "notes" => Ok(summary::markdown(&meeting)),
        "transcript" | "transcript-original" => Ok(summary::transcript_text(
            &meeting,
            format == "transcript-original",
        )),
        _ => Err("Select Notes or Transcript".into()),
    }
}
#[tauri::command]
pub fn show_meetings(app: tauri::AppHandle) {
    crate::show_main_window_internal(&app);
    let _ = app.emit("show-meetings", ());
}

#[tauri::command]
pub fn save_meeting_export(
    service: tauri::State<'_, Service>,
    id: String,
    format: String,
) -> Result<(), String> {
    let meeting = service.store()?.get(&id)?;
    let (text, extension) = match format.as_str() {
        "notes" => (summary::markdown(&meeting), "md"),
        "transcript" | "transcript-original" => (
            summary::transcript_text(&meeting, format == "transcript-original"),
            "txt",
        ),
        _ => return Err("Select Notes or Transcript".into()),
    };
    let directory = dirs::download_dir()
        .ok_or("Cannot find Downloads")?
        .join("Echo Meetings");
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Could not create the export folder in Downloads")?;
    let filename = format!(
        "{}-{}-{}.{}",
        meeting.id,
        format,
        chrono::Utc::now().timestamp_millis(),
        extension
    );
    let mut file =
        tempfile::NamedTempFile::new_in(&directory).map_err(|_| "Could not export this meeting")?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.as_file().sync_all())
        .map_err(|_| "Could not export this meeting. Check disk space.")?;
    file.persist_noclobber(directory.join(filename))
        .map_err(|_| "Could not finish exporting this meeting")?;
    Ok(())
}
