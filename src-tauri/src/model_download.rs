use crate::{app_error::AppError, local_models, whisper};
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
    pub supported: bool,
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
        supported: local_models::supported(model_size),
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
    if model_size == crate::meetings::runtime::MODEL_ID {
        return notes_status(dl_state, false);
    }
    if model_size == local_models::BARK_ID {
        return bark_status(dl_state, false);
    }
    status_from_file_size(model_size, dl_state)
}

pub fn verify_model_status(model_size: &str, dl_state: &DownloadState) -> ModelStatus {
    if model_size == crate::meetings::runtime::MODEL_ID {
        return notes_status(dl_state, true);
    }
    if model_size == local_models::BARK_ID {
        return bark_status(dl_state, true);
    }
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
        supported: local_models::supported(model_size),
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
    let status = check_model_status(model_size, &state);
    status.supported && status.downloaded && status.integrity_error.is_none()
}

fn inspect_bark_directory(directory: &Path, hash: bool) -> Result<u64, AppError> {
    inspect_model_files(directory, &local_models::manifest().files, hash)
}

pub(crate) fn inspect_model_files(
    directory: &Path,
    files: &[local_models::ModelFile],
    hash: bool,
) -> Result<u64, AppError> {
    let mut total = 0;
    for file in files {
        let path = directory.join(&file.path);
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
            AppError::model_integrity_failed("A local model is incomplete. Download it again.")
        })?;
        if !metadata.is_file() || metadata.len() != file.size {
            return Err(AppError::model_integrity_failed(
                "A local model file is missing or has the wrong size. Download it again.",
            ));
        }
        if hash {
            let mut input = std::fs::File::open(&path)
                .map_err(|_| AppError::model_integrity_failed("Could not read a model file."))?;
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; 1024 * 1024];
            loop {
                let count = input.read(&mut buffer).map_err(|_| {
                    AppError::model_integrity_failed("Could not verify a model file.")
                })?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            if format!("{:x}", hasher.finalize()) != file.sha256 {
                return Err(AppError::model_integrity_failed(
                    "A local model checksum did not match. Download the model again.",
                ));
            }
        }
        total += metadata.len();
    }
    Ok(total)
}

#[cfg(test)]
mod bark_tests {
    use super::*;

    fn fixture_manifest() -> local_models::BarkManifest {
        local_models::BarkManifest {
            repository: "fixture".into(),
            revision: "fixture".into(),
            prefix: "".into(),
            files: vec![local_models::ModelFile {
                path: "component/weights".into(),
                size: 3,
                sha256: format!("{:x}", Sha256::digest(b"abc")),
            }],
        }
    }

    fn serve(response: &'static [u8]) -> String {
        use std::io::Write;
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            stream.write_all(response).unwrap();
        });
        format!("http://{address}/")
    }

    #[tokio::test]
    async fn failed_download_preserves_installation_and_retry_publishes_verified_files() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("bark");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("previous-marker"), b"old").unwrap();
        let manifest = fixture_manifest();
        let state = DownloadState::new();
        let corrupt =
            serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nxyz");
        let error = download_bark_to(&directory, &manifest, &corrupt, &state)
            .await
            .unwrap_err();
        assert_eq!(error.code, "model_integrity_failed");
        assert!(directory.join("previous-marker").exists());
        assert!(!directory.with_extension("part").exists());
        let valid = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc");
        download_bark_to(&directory, &manifest, &valid, &state)
            .await
            .unwrap();
        assert_eq!(
            inspect_model_files(&directory, &manifest.files, true).unwrap(),
            3
        );
        assert!(!directory.join("previous-marker").exists());
        assert!(!directory.with_extension("previous").exists());
    }

    #[tokio::test]
    async fn truncated_download_never_becomes_an_installation() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("bark");
        let url = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\na");
        assert!(
            download_bark_to(&directory, &fixture_manifest(), &url, &DownloadState::new())
                .await
                .is_err()
        );
        assert!(!directory.exists());
        assert!(!directory.with_extension("part").exists());
    }

    #[test]
    fn publication_failure_restores_previous_installation() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("bark");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("marker"), b"old").unwrap();
        assert!(publish_bark_directory(&root.path().join("absent"), &directory).is_err());
        assert!(directory.join("marker").exists());
    }

    #[test]
    fn verifies_whole_directory_and_detects_same_size_corruption() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("component")).unwrap();
        let path = root.path().join("component/weights");
        let files = vec![local_models::ModelFile {
            path: "component/weights".to_string(),
            size: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
        }];
        assert!(inspect_model_files(root.path(), &files, false).is_err());
        std::fs::write(&path, b"ab").unwrap();
        assert!(inspect_model_files(root.path(), &files, false).is_err());
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(inspect_model_files(root.path(), &files, true).unwrap(), 3);
        std::fs::write(&path, b"xyz").unwrap();
        assert!(inspect_model_files(root.path(), &files, false).is_ok());
        assert!(inspect_model_files(root.path(), &files, true).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(inspect_model_files(root.path(), &files, true).is_err());
    }

    #[tokio::test]
    async fn rejects_unknown_ids_without_starting_downloads() {
        let state = Arc::new(DownloadState::new());
        let result = download_model("../config", "", state.clone()).await;
        assert_eq!(result.unwrap_err().code, "local_model_unsupported");
        assert!(!state.active.load(Ordering::SeqCst));
        assert!(delete_model("../config").is_err());
    }
}

pub fn verify_bark_directory(directory: &Path) -> Result<(), AppError> {
    inspect_bark_directory(directory, true).map(|_| ())
}

fn bark_status(state: &DownloadState, verify: bool) -> ModelStatus {
    let directory = local_models::bark_directory().ok();
    let exists = directory.as_ref().is_some_and(|path| path.exists());
    let result = directory
        .as_ref()
        .filter(|_| exists)
        .map(|path| inspect_bark_directory(path, verify));
    ModelStatus {
        supported: local_models::bark_supported(),
        downloaded: result.as_ref().is_some_and(|result| result.is_ok()),
        downloading: download_active_for(local_models::BARK_ID, state),
        file_size_bytes: result
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .copied()
            .unwrap_or(0),
        expected_size_bytes: local_models::bark_size(),
        integrity_checked: verify && exists,
        integrity_error: result
            .and_then(|result| result.err())
            .map(|error| error.message),
        model_size: local_models::BARK_ID.to_string(),
    }
}

fn notes_status(state: &DownloadState, verify: bool) -> ModelStatus {
    let directory = crate::meetings::runtime::model_directory().ok();
    let exists = directory.as_ref().is_some_and(|p| p.exists());
    let result = directory
        .as_ref()
        .filter(|_| exists)
        .map(|p| inspect_model_files(p, &crate::meetings::runtime::manifest().files, verify));
    ModelStatus {
        supported: crate::meetings::commands::supported(),
        downloaded: result.as_ref().is_some_and(|r| r.is_ok()),
        downloading: download_active_for(crate::meetings::runtime::MODEL_ID, state),
        file_size_bytes: result
            .as_ref()
            .and_then(|r| r.as_ref().ok())
            .copied()
            .unwrap_or(0),
        expected_size_bytes: crate::meetings::runtime::manifest().files[0].size,
        integrity_checked: verify && exists,
        integrity_error: result.and_then(Result::err).map(|e| e.message),
        model_size: crate::meetings::runtime::MODEL_ID.into(),
    }
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
    if model_size == crate::meetings::runtime::MODEL_ID {
        if !crate::meetings::commands::supported() {
            return Err(AppError::model_download_failed(
                "Meeting notes require macOS 13+ or Windows 10/11 x64.",
            ));
        }
    } else {
        local_models::require_supported(model_size)?;
    }
    if state
        .active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::model_download_failed(
            "A download is already in progress.",
        ));
    }

    state.bytes_downloaded.store(0, Ordering::SeqCst);
    state.total_bytes.store(0, Ordering::SeqCst);
    *state.model_size.lock().unwrap_or_else(|e| e.into_inner()) = model_size.to_string();

    let result = if model_size == crate::meetings::runtime::MODEL_ID {
        let manifest = crate::meetings::runtime::manifest();
        let directory =
            crate::meetings::runtime::model_directory().map_err(AppError::model_download_failed)?;
        let base = format!(
            "https://huggingface.co/{}/resolve/{}/",
            manifest.repository, manifest.revision
        );
        download_bark_to(&directory, manifest, &base, &state).await
    } else if model_size == local_models::BARK_ID {
        download_bark(&state).await
    } else {
        do_download(model_size, access_token, &state).await
    };

    state.active.store(false, Ordering::SeqCst);

    if result.is_err()
        && model_size != local_models::BARK_ID
        && model_size != crate::meetings::runtime::MODEL_ID
    {
        // Clean up partial downloads
        if let Ok(path) = whisper::model_path(model_size) {
            let tmp_path = path.with_extension("bin.part");
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(tmp_path);
        }
    }

    result
}

async fn download_bark(state: &DownloadState) -> Result<(), AppError> {
    let directory = local_models::bark_directory().map_err(AppError::model_download_failed)?;
    let manifest = local_models::manifest();
    let base_url = format!(
        "https://huggingface.co/{}/resolve/{}/{}",
        manifest.repository, manifest.revision, manifest.prefix
    );
    download_bark_to(&directory, manifest, &base_url, state).await
}

async fn download_bark_to(
    directory: &Path,
    manifest: &local_models::BarkManifest,
    base_url: &str,
    state: &DownloadState,
) -> Result<(), AppError> {
    let staging = directory.with_extension("part");
    state.total_bytes.store(
        manifest.files.iter().map(|file| file.size).sum(),
        Ordering::SeqCst,
    );
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(7200))
        .build()
        .map_err(|_| AppError::model_download_failed("Could not start the downloader."))?;
    let result = async {
        if staging.exists() {
            tokio::fs::remove_dir_all(&staging).await.map_err(|_| {
                AppError::model_download_failed("Could not clear the partial model download.")
            })?;
        }
        for file in &manifest.files {
            let path = staging.join(&file.path);
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|_| {
                    AppError::model_download_failed(
                        "Could not create the model folder. Check free disk space.",
                    )
                })?;
            }
            let url = format!("{base_url}{}", file.path);
            let mut stream = client
                .get(url)
                .send()
                .await
                .map_err(|_| {
                    AppError::model_download_failed(
                        "Could not reach Hugging Face. Check your connection and retry.",
                    )
                })?
                .error_for_status()
                .map_err(|_| {
                    AppError::model_download_failed(
                        "Hugging Face could not provide a model file. Retry the download.",
                    )
                })?
                .bytes_stream();
            let mut output = tokio::fs::File::create(&path).await.map_err(|_| {
                AppError::model_download_failed("Could not save the local model. Check free disk space.")
            })?;
            let mut received = 0u64;
            let mut hasher = Sha256::new();
            use tokio::io::AsyncWriteExt;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    AppError::model_download_failed(
                        "The model download was interrupted. Retry when connected.",
                    )
                })?;
                received += chunk.len() as u64;
                if received > file.size {
                    return Err(AppError::model_integrity_failed(
                        "A model file exceeded its expected size.",
                    ));
                }
                hasher.update(&chunk);
                output.write_all(&chunk).await.map_err(|_| {
                    AppError::model_download_failed("Could not save the local model. Check free disk space.")
                })?;
                state
                    .bytes_downloaded
                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
            }
            output
                .flush()
                .await
                .map_err(|_| AppError::model_download_failed("Could not finish writing the local model."))?;
            if received != file.size || format!("{:x}", hasher.finalize()) != file.sha256 {
                return Err(AppError::model_integrity_failed(
                    "A model file failed verification. Retry the download.",
                ));
            }
        }
        // Do not disturb a previous installation until every staged file is verified.
        // Inference uses the same lifecycle lock as deletion/replacement.
        let publish_directory = directory.to_path_buf();
        let publish_staging = staging.clone();
        tokio::task::spawn_blocking(move || {
            let _notes_guard = (publish_directory.file_name().and_then(|s| s.to_str())
                == Some(crate::meetings::runtime::MODEL_ID))
            .then(|| {
                crate::meetings::runtime::MODEL_GATE
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
            });
            let _guard = local_models::lifecycle_lock();
            crate::bark::release();
            publish_bark_directory(&publish_staging, &publish_directory)
        })
        .await
        .map_err(|_| {
            AppError::model_download_failed("The model installation stopped. Retry the download.")
        })??;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

fn publish_bark_directory(staging: &Path, directory: &Path) -> Result<(), AppError> {
    let previous = directory.with_extension("previous");
    if previous.exists() {
        if directory.exists() {
            std::fs::remove_dir_all(&previous).map_err(|_| {
                AppError::model_download_failed(
                    "Could not clear the previous model installation.",
                )
            })?;
        } else {
            std::fs::rename(&previous, directory).map_err(|_| {
                AppError::model_download_failed(
                    "Could not recover the previous model installation.",
                )
            })?;
        }
    }
    let replacing = directory.exists();
    if replacing {
        std::fs::rename(directory, &previous).map_err(|_| {
            AppError::model_download_failed(
                "Could not replace the existing model installation.",
            )
        })?;
    }
    if std::fs::rename(staging, directory).is_err() {
        if replacing {
            let _ = std::fs::rename(&previous, directory);
        }
        return Err(AppError::model_download_failed(
            "Could not finish installing the local model. Retry the download.",
        ));
    }
    if replacing {
        let _ = std::fs::remove_dir_all(previous);
    }
    Ok(())
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

pub fn delete_model(model_size: &str) -> Result<(), String> {
    if model_size == crate::meetings::runtime::MODEL_ID {
        let _guard = crate::meetings::runtime::MODEL_GATE
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let path = crate::meetings::runtime::model_directory()?;
        if path.exists() {
            std::fs::remove_dir_all(path).map_err(|_| "Could not remove the notes model")?;
        }
        return Ok(());
    }
    if !local_models::known(model_size) {
        return Err("Unknown local model.".to_string());
    }
    let _guard = local_models::lifecycle_lock();
    crate::bark::release();
    whisper::release_cache();
    if model_size == local_models::BARK_ID {
        let path = local_models::bark_directory()?;
        if path.exists() {
            std::fs::remove_dir_all(path)
                .map_err(|_| "Could not remove Bark. Try again.".to_string())?;
        }
        return Ok(());
    }
    let path = whisper::model_path(model_size)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Delete error: {e}"))?;
    }
    Ok(())
}
