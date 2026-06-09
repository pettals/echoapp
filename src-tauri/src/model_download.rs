use crate::{app_error::AppError, whisper};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

const SIGNED_MODEL_URL_ENDPOINT: &str =
    "https://glkriavrwsissibmwxhd.supabase.co/functions/v1/create-model-download-url";
const SUPABASE_PUBLISHABLE_KEY: &str = "sb_publishable_JMOFx_LYWWkusmTdABVxRQ_1BkFvxw-";
const HUGGING_FACE_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

fn hugging_face_model_url(model_size: &str) -> String {
    format!("{HUGGING_FACE_BASE_URL}/ggml-{model_size}.bin")
}

#[derive(Serialize)]
struct SignedModelUrlRequest<'a> {
    #[serde(rename = "modelSize")]
    model_size: &'a str,
}

#[derive(Deserialize)]
struct SignedModelUrlResponse {
    url: String,
}

#[derive(Debug, Clone)]
pub struct ModelMetadata {
    pub expected_size_bytes: u64,
    pub sha256: &'static str,
}

#[derive(Debug, Clone)]
pub struct ModelValidation {
    pub valid: bool,
    pub actual_size_bytes: u64,
    pub message: Option<String>,
}

fn model_metadata(model_size: &str) -> Option<ModelMetadata> {
    match model_size {
        "small" => Some(ModelMetadata {
            expected_size_bytes: 487_601_967,
            sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        }),
        "medium" => Some(ModelMetadata {
            expected_size_bytes: 1_533_763_059,
            sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        }),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStatus {
    pub downloaded: bool,
    pub downloading: bool,
    pub file_size_bytes: u64,
    pub expected_size_bytes: u64,
    pub integrity_checked: bool,
    pub integrity_error: Option<String>,
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

fn download_active_for(model_size: &str, dl_state: &DownloadState) -> bool {
    let is_active = dl_state.active.load(Ordering::Relaxed);
    let active_model = dl_state
        .model_size
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    is_active && active_model == model_size
}

fn status_from_file_size(model_size: &str, dl_state: &DownloadState) -> ModelStatus {
    let metadata = model_metadata(model_size);
    let expected_size = metadata
        .as_ref()
        .map(|meta| meta.expected_size_bytes)
        .unwrap_or(0);
    let file_result = whisper::model_path(model_size).ok().and_then(|path| {
        path.exists()
            .then(|| std::fs::metadata(&path).map(|meta| meta.len()))
    });

    let file_size = file_result
        .as_ref()
        .map(|result| result.as_ref().copied().unwrap_or(0))
        .unwrap_or(0);
    let integrity_error = match file_result.as_ref() {
        Some(Ok(size)) if expected_size > 0 && *size != expected_size => Some(format!(
            "Expected {} bytes but found {} bytes.",
            expected_size, size
        )),
        Some(Err(error)) => Some(format!("Could not read file: {error}")),
        _ => None,
    };
    let downloaded = file_result
        .as_ref()
        .map(|result| {
            result
                .as_ref()
                .is_ok_and(|size| expected_size > 0 && *size == expected_size)
        })
        .unwrap_or(false);

    ModelStatus {
        downloaded,
        downloading: download_active_for(model_size, dl_state),
        file_size_bytes: file_size,
        expected_size_bytes: expected_size,
        integrity_checked: false,
        integrity_error,
        model_size: model_size.to_string(),
    }
}

pub fn check_model_status(model_size: &str, dl_state: &DownloadState) -> ModelStatus {
    status_from_file_size(model_size, dl_state)
}

pub fn verify_model_status(model_size: &str, dl_state: &DownloadState) -> ModelStatus {
    let metadata = model_metadata(model_size);
    let validation = whisper::model_path(model_size).ok().and_then(|path| {
        if path.exists() {
            Some(validate_model_file(model_size, &path))
        } else {
            None
        }
    });
    let downloaded = validation
        .as_ref()
        .map(|result| result.as_ref().map(|v| v.valid).unwrap_or(false))
        .unwrap_or(false);
    let file_size = validation
        .as_ref()
        .map(|result| result.as_ref().map(|v| v.actual_size_bytes).unwrap_or(0))
        .unwrap_or(0);
    let integrity_error = validation.as_ref().and_then(|result| match result {
        Ok(validation) => validation.message.clone(),
        Err(error) => Some(error.to_string()),
    });

    ModelStatus {
        downloaded,
        downloading: download_active_for(model_size, dl_state),
        file_size_bytes: file_size,
        expected_size_bytes: metadata
            .as_ref()
            .map(|meta| meta.expected_size_bytes)
            .unwrap_or(0),
        integrity_checked: validation.is_some(),
        integrity_error,
        model_size: model_size.to_string(),
    }
}

pub fn is_model_available(model_size: &str) -> bool {
    let state = DownloadState::new();
    check_model_status(model_size, &state).downloaded
}

pub fn validate_model_file(model_size: &str, path: &Path) -> Result<ModelValidation, AppError> {
    let metadata = model_metadata(model_size).ok_or_else(|| {
        AppError::model_integrity_failed(format!("Unknown local model size '{model_size}'."))
    })?;
    let actual_size = std::fs::metadata(path)
        .map_err(|e| AppError::model_integrity_failed(format!("Could not read file: {e}")))?
        .len();

    if actual_size != metadata.expected_size_bytes {
        return Ok(ModelValidation {
            valid: false,
            actual_size_bytes: actual_size,
            message: Some(format!(
                "Expected {} bytes but found {} bytes.",
                metadata.expected_size_bytes, actual_size
            )),
        });
    }

    let mut file = std::fs::File::open(path)
        .map_err(|e| AppError::model_integrity_failed(format!("Could not open file: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];

    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| AppError::model_integrity_failed(format!("Could not hash file: {e}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let actual_hash = format!("{:x}", hasher.finalize());
    if actual_hash != metadata.sha256 {
        return Ok(ModelValidation {
            valid: false,
            actual_size_bytes: actual_size,
            message: Some("SHA-256 checksum did not match the expected model file.".to_string()),
        });
    }

    Ok(ModelValidation {
        valid: true,
        actual_size_bytes: actual_size,
        message: None,
    })
}

pub async fn download_model(
    model_size: &str,
    access_token: &str,
    state: Arc<DownloadState>,
) -> Result<(), AppError> {
    if state.active.load(Ordering::Relaxed) {
        return Err(AppError::model_download_failed(
            "A download is already in progress.",
        ));
    }

    state.active.store(true, Ordering::SeqCst);
    state.bytes_downloaded.store(0, Ordering::SeqCst);
    state.total_bytes.store(0, Ordering::SeqCst);
    *state.model_size.lock().unwrap_or_else(|e| e.into_inner()) = model_size.to_string();

    let result = do_download(model_size, access_token, &state).await;

    state.active.store(false, Ordering::SeqCst);

    if result.is_err() {
        // Clean up partial downloads
        if let Ok(path) = whisper::model_path(model_size) {
            let tmp_path = path.with_extension("bin.part");
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(tmp_path);
        }
    }

    result
}

async fn signed_model_url(
    client: &reqwest::Client,
    model_size: &str,
    access_token: &str,
) -> Result<String, AppError> {
    if access_token.trim().is_empty() {
        return Err(AppError::model_download_failed(
            "Sign in before downloading local Whisper models.",
        ));
    }

    let response = client
        .post(SIGNED_MODEL_URL_ENDPOINT)
        .header("apikey", SUPABASE_PUBLISHABLE_KEY)
        .bearer_auth(access_token)
        .json(&SignedModelUrlRequest { model_size })
        .send()
        .await
        .map_err(|e| AppError::model_download_failed(format!("Signed URL request error: {e}")))?;

    if !response.status().is_success() {
        return Err(AppError::model_download_failed(format!(
            "Signed URL HTTP status {}",
            response.status()
        )));
    }

    let signed = response
        .json::<SignedModelUrlResponse>()
        .await
        .map_err(|e| AppError::model_download_failed(format!("Signed URL response error: {e}")))?;

    if signed.url.trim().is_empty() {
        return Err(AppError::model_download_failed(
            "Signed URL response did not include a download URL.",
        ));
    }

    Ok(signed.url)
}

async fn download_from_url(
    client: &reqwest::Client,
    model_size: &str,
    url: &str,
    state: &DownloadState,
) -> Result<(), AppError> {
    let dest = whisper::model_path(model_size).map_err(AppError::model_download_failed)?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::model_download_failed(format!("Request error: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::model_download_failed(format!(
            "HTTP status {}",
            resp.status()
        )));
    }

    let total = resp.content_length().unwrap_or(0);
    state.total_bytes.store(total, Ordering::SeqCst);

    let tmp_path = dest.with_extension("bin.part");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| AppError::model_download_failed(format!("File create error: {e}")))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;

    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| AppError::model_download_failed(format!("Stream error: {e}")))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| AppError::model_download_failed(format!("File write error: {e}")))?;
        downloaded += chunk.len() as u64;
        state.bytes_downloaded.store(downloaded, Ordering::Relaxed);
    }

    file.flush()
        .await
        .map_err(|e| AppError::model_download_failed(format!("Flush error: {e}")))?;
    drop(file);

    let validation = validate_model_file(model_size, &tmp_path)?;
    if !validation.valid {
        return Err(AppError::model_integrity_failed(
            validation
                .message
                .unwrap_or_else(|| "Integrity check failed.".to_string()),
        ));
    }

    tokio::fs::rename(&tmp_path, &dest)
        .await
        .map_err(|e| AppError::model_download_failed(format!("Rename error: {e}")))?;

    Ok(())
}

async fn do_download(
    model_size: &str,
    access_token: &str,
    state: &DownloadState,
) -> Result<(), AppError> {
    let client = reqwest::Client::new();
    let hugging_face_url = hugging_face_model_url(model_size);

    match download_from_url(&client, model_size, &hugging_face_url, state).await {
        Ok(()) => Ok(()),
        Err(primary_error) => {
            if let Ok(path) = whisper::model_path(model_size) {
                let _ = std::fs::remove_file(path.with_extension("bin.part"));
            }
            state.bytes_downloaded.store(0, Ordering::SeqCst);
            state.total_bytes.store(0, Ordering::SeqCst);

            let fallback_url =
                signed_model_url(&client, model_size, access_token)
                    .await
                    .map_err(|fallback_error| {
                        AppError::model_download_failed(format!(
                            "Hugging Face failed ({primary_error}); Pettals fallback failed ({fallback_error})"
                        ))
                    })?;

            download_from_url(&client, model_size, &fallback_url, state)
                .await
                .map_err(|fallback_error| {
                    AppError::model_download_failed(format!(
                        "Hugging Face failed ({primary_error}); Pettals fallback failed ({fallback_error})"
                    ))
                })
        }
    }
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
