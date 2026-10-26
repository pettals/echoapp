//! The persisted `local_model_size` is a model ID; keep its legacy wire name.
use crate::{app_error::AppError, bark, config::AppConfig, model_download, whisper};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const BARK_ID: &str = "bark-3-clean";
static INFERENCE: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
pub struct ModelFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Deserialize)]
pub struct BarkManifest {
    pub repository: String,
    pub revision: String,
    pub prefix: String,
    pub files: Vec<ModelFile>,
}

pub fn manifest() -> &'static BarkManifest {
    static MANIFEST: OnceLock<BarkManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../bark-manifest.json"))
            .expect("checked-in Bark manifest")
    })
}

pub fn bark_size() -> u64 {
    manifest().files.iter().map(|file| file.size).sum()
}

#[derive(Serialize)]
pub struct LocalModelDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub engine: &'static str,
    pub description: &'static str,
    pub download_size_bytes: u64,
    pub supported: bool,
    pub unsupported_reason: Option<&'static str>,
    pub built_in_cleanup: bool,
    pub english_only: bool,
}

pub fn known(id: &str) -> bool {
    matches!(id, "small" | "medium" | BARK_ID)
}

pub fn name(id: &str) -> &str {
    match id {
        "small" => "Whisper Small",
        "medium" => "Whisper Medium",
        BARK_ID => "Bark 3 Clean",
        _ => "Unknown local model",
    }
}

fn platform_support(macos: bool, arm64: bool, major: u32) -> bool {
    macos && arm64 && major >= 15
}

pub fn bark_supported() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            let major = std::process::Command::new("/usr/bin/sw_vers")
                .arg("-productVersion")
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .and_then(|version| version.split('.').next()?.parse().ok())
                .unwrap_or(0);
            platform_support(true, true, major)
        }
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            platform_support(false, false, 0)
        }
    })
}

pub fn supported(id: &str) -> bool {
    known(id) && (id != BARK_ID || bark_supported())
}

pub fn require_supported(id: &str) -> Result<(), AppError> {
    if !supported(id) {
        return Err(AppError::new(
            "local_model_unsupported",
            if id == BARK_ID {
                "Bark 3 Clean requires an Apple Silicon Mac running macOS 15 or later. Choose Whisper in Settings."
            } else {
                "This local model is not recognized. Choose a model in Settings."
            },
            false,
            Some("Open Settings"),
        ));
    }
    Ok(())
}

pub fn catalog() -> Vec<LocalModelDescriptor> {
    [
        (
            "small",
            "Fastest. Good for everyday dictation.",
            487_601_967,
        ),
        ("medium", "More accurate. Larger download.", 1_533_763_059),
        (
            BARK_ID,
            "English only. Removes fillers, false starts and repeated words on device.",
            bark_size(),
        ),
    ]
    .into_iter()
    .map(|(id, description, size)| LocalModelDescriptor {
        id,
        name: name(id),
        engine: if id == BARK_ID { "coreml" } else { "whisper" },
        description,
        download_size_bytes: size,
        supported: supported(id),
        unsupported_reason: (!supported(id))
            .then_some("Requires Apple Silicon and macOS 15 or later."),
        built_in_cleanup: id == BARK_ID,
        english_only: id == BARK_ID,
    })
    .collect()
}

pub fn bark_directory() -> Result<PathBuf, String> {
    Ok(AppConfig::models_dir()?.join(BARK_ID))
}

pub fn release() {
    let _guard = lifecycle_lock();
    bark::release();
    whisper::release_cache();
}

pub fn lifecycle_lock() -> std::sync::MutexGuard<'static, ()> {
    INFERENCE.lock().unwrap_or_else(|error| error.into_inner())
}

pub fn transcribe(
    path: &Path,
    id: &str,
    threads: Option<usize>,
    preparing: impl Fn(),
) -> Result<whisper::LocalTranscriptionResult, AppError> {
    let _guard = INFERENCE.lock().unwrap_or_else(|error| error.into_inner());
    require_supported(id)?;
    if !model_download::is_model_available(id) {
        return Err(AppError::missing_local_model(id));
    }
    if id == BARK_ID {
        whisper::release_cache();
        bark::transcribe(path, preparing)
    } else {
        bark::release();
        whisper::transcribe_local_with_metrics(path, id, threads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rejects_unknown_and_path_traversal_ids() {
        for id in ["", "../config", "large", "bark-3"] {
            assert!(!known(id));
        }
        for id in ["small", "medium", BARK_ID] {
            assert!(known(id));
        }
    }

    #[test]
    fn bark_requires_both_hardware_and_os() {
        assert!(platform_support(true, true, 15));
        assert!(platform_support(true, true, 26));
        assert!(!platform_support(true, true, 14));
        assert!(!platform_support(true, false, 26));
        assert!(!platform_support(false, true, 26));
    }

    #[test]
    fn manifest_is_pinned_complete_and_safe() {
        let manifest = manifest();
        assert_eq!(
            manifest.revision,
            "ca21bed2ccd9c3fbcd104a6014b9a5638a764bc8"
        );
        assert_eq!(bark_size(), 447_420_698);
        assert_eq!(manifest.files.len(), 21);
        for file in &manifest.files {
            assert!(Path::new(&file.path)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))));
            assert_eq!(file.sha256.len(), 64);
            assert!(!file.path.contains("Encoder_lut3"));
        }
    }
}
