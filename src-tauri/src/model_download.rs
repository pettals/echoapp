use crate::whisper;
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

fn model_url(model_size: &str) -> String {
    format!("{BASE_URL}/ggml-{model_size}.bin")
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
    pub downloaded: bool,
    pub downloading: bool,
    pub file_size_bytes: u64,
    pub model_size: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub percentage: f64,
    pub model_size: String,
}

pub struct DownloadState {
    pub bytes_downloaded: AtomicU64,
    pub total_bytes: AtomicU64,
    pub active: AtomicBool,
    pub model_size: std::sync::Mutex<String>,
}

impl DownloadState {
    pub fn new() -> Self {
        Self {
            bytes_downloaded: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            active: AtomicBool::new(false),
            model_size: std::sync::Mutex::new(String::new()),
        }
    }

    pub fn progress(&self) -> DownloadProgress {
        let downloaded = self.bytes_downloaded.load(Ordering::Relaxed);
        let total = self.total_bytes.load(Ordering::Relaxed);
        let pct = if total > 0 {
            (downloaded as f64 / total as f64 * 100.0).min(100.0)
        } else {
            0.0
        };
        DownloadProgress {
            bytes_downloaded: downloaded,
            total_bytes: total,
            percentage: pct,
            model_size: self
                .model_size
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        }
    }
}

pub fn check_model_status(model_size: &str, dl_state: &DownloadState) -> ModelStatus {
    let downloaded = whisper::is_model_downloaded(model_size).unwrap_or(false);
    let is_active = dl_state.active.load(Ordering::Relaxed);
    let active_model = dl_state
        .model_size
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let downloading = is_active && active_model == model_size;
    let file_size = if downloaded {
        whisper::model_path(model_size)
            .ok()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    ModelStatus {
        downloaded,
        downloading,
        file_size_bytes: file_size,
        model_size: model_size.to_string(),
    }
}

pub async fn download_model(model_size: &str, state: Arc<DownloadState>) -> Result<(), String> {
    if state.active.load(Ordering::Relaxed) {
        return Err("A download is already in progress".to_string());
    }

    state.active.store(true, Ordering::SeqCst);
    state.bytes_downloaded.store(0, Ordering::SeqCst);
    state.total_bytes.store(0, Ordering::SeqCst);
    *state.model_size.lock().unwrap_or_else(|e| e.into_inner()) = model_size.to_string();

    let result = do_download(model_size, &state).await;

    state.active.store(false, Ordering::SeqCst);

    if result.is_err() {
        // Clean up partial downloads
        if let Ok(path) = whisper::model_path(model_size) {
            let _ = std::fs::remove_file(path);
        }
    }

    result
}

async fn do_download(model_size: &str, state: &DownloadState) -> Result<(), String> {
    let url = model_url(model_size);
    let dest = whisper::model_path(model_size)?;

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download request error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed with status: {}", resp.status()));
    }

    let total = resp.content_length().unwrap_or(0);
    state.total_bytes.store(total, Ordering::SeqCst);

    let tmp_path = dest.with_extension("bin.part");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| format!("File create error: {e}"))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;

    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("File write error: {e}"))?;
        downloaded += chunk.len() as u64;
        state.bytes_downloaded.store(downloaded, Ordering::Relaxed);
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {e}"))?;
    drop(file);

    tokio::fs::rename(&tmp_path, &dest)
        .await
        .map_err(|e| format!("Rename error: {e}"))?;

    Ok(())
}

pub async fn delete_model(model_size: &str) -> Result<(), String> {
    let path = whisper::model_path(model_size)?;
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("Delete error: {e}"))?;
    }
    Ok(())
}
