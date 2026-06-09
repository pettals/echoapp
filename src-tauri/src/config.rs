use crate::secure;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

trait GroqCredentialStore {
    fn get_groq_api_key(&self) -> Result<Option<String>, String>;
    fn get_groq_api_key_from_store(&self) -> Result<Option<String>, String>;
    fn set_groq_api_key(&self, value: &str) -> Result<(), String>;
    fn delete_groq_api_key(&self) -> Result<(), String>;
}

struct SystemCredentialStore;

impl GroqCredentialStore for SystemCredentialStore {
    fn get_groq_api_key(&self) -> Result<Option<String>, String> {
        secure::get_groq_api_key()
    }

    fn get_groq_api_key_from_store(&self) -> Result<Option<String>, String> {
        secure::get_groq_api_key_from_store()
    }

    fn set_groq_api_key(&self, value: &str) -> Result<(), String> {
        secure::set_groq_api_key(value)
    }

    fn delete_groq_api_key(&self) -> Result<(), String> {
        secure::delete_groq_api_key()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ConfigSaveError {
    pub code: String,
    pub message: String,
}

impl ConfigSaveError {
    fn secure_write(message: String) -> Self {
        Self {
            code: "secure_write_failed".to_string(),
            message: format!("Groq API key could not be saved to secure storage: {message}"),
        }
    }

    fn secure_delete(message: String) -> Self {
        Self {
            code: "secure_delete_failed".to_string(),
            message: format!("Groq API key could not be removed from secure storage: {message}"),
        }
    }

    fn config_write(message: String) -> Self {
        Self {
            code: "config_write_failed".to_string(),
            message: format!("Settings were not saved: {message}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SecureSaveStatus {
    pub state: String,
    pub message: String,
}

impl SecureSaveStatus {
    fn verified(message: impl Into<String>) -> Self {
        Self {
            state: "verified".to_string(),
            message: message.into(),
        }
    }

    fn pending_verification(message: impl Into<String>) -> Self {
        Self {
            state: "pending_verification".to_string(),
            message: message.into(),
        }
    }

    fn read_failed(message: impl Into<String>) -> Self {
        Self {
            state: "read_failed".to_string(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigSaveResult {
    pub config: AppConfig,
    pub secure_storage: SecureSaveStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub groq_api_key: String,
    pub shortcut: String,
    pub transcription_model: String,
    pub cleanup_model: String,
    pub cleanup_enabled: bool,
    #[serde(default)]
    pub input_device: Option<String>,
    #[serde(default = "default_model_provider")]
    pub model_provider: String,
    #[serde(default = "default_local_model_size")]
    pub local_model_size: String,
    #[serde(default)]
    pub local_transcription_threads: Option<usize>,
    #[serde(default = "default_true")]
    pub sounds_enabled: bool,
    #[serde(default = "default_indicator_sound")]
    pub indicator_sound: String,
    #[serde(default = "default_success_sound")]
    pub success_sound: String,
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default = "default_true")]
    pub history_enabled: bool,
    #[serde(default = "default_history_limit")]
    pub history_limit: usize,
    #[serde(default = "default_appearance_theme")]
    pub appearance_theme: String,
    #[serde(default)]
    pub launch_at_login: bool,
}

fn default_model_provider() -> String {
    "api".to_string()
}

fn default_local_model_size() -> String {
    "small".to_string()
}

fn default_true() -> bool {
    true
}

fn default_indicator_sound() -> String {
    "tink".to_string()
}

fn default_success_sound() -> String {
    "glass".to_string()
}

fn default_history_limit() -> usize {
    100
}

fn default_appearance_theme() -> String {
    "dark".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            groq_api_key: String::new(),
            shortcut: "CommandOrControl+D".to_string(),
            transcription_model: "whisper-large-v3-turbo".to_string(),
            cleanup_model: "llama-3.1-8b-instant".to_string(),
            cleanup_enabled: true,
            input_device: None,
            model_provider: default_model_provider(),
            local_model_size: default_local_model_size(),
            local_transcription_threads: None,
            sounds_enabled: default_true(),
            indicator_sound: default_indicator_sound(),
            success_sound: default_success_sound(),
            onboarding_completed: false,
            history_enabled: true,
            history_limit: default_history_limit(),
            appearance_theme: default_appearance_theme(),
            launch_at_login: false,
        }
    }
}

impl AppConfig {
    pub fn models_dir() -> Result<PathBuf, String> {
        let dir = dirs::data_dir()
            .ok_or("Cannot find data directory")?
            .join("echo")
            .join("models");
        fs::create_dir_all(&dir).map_err(|e| format!("Dir create error: {e}"))?;
        Ok(dir)
    }
}

impl AppConfig {
    fn config_path() -> Result<PathBuf, String> {
        let dir = dirs::config_dir()
            .ok_or("Cannot find config directory")?
            .join("echo");
        fs::create_dir_all(&dir).map_err(|e| format!("Dir create error: {e}"))?;
        Ok(dir.join("config.json"))
    }

    pub fn load() -> Self {
        match Self::try_load() {
            Ok(cfg) => cfg,
            Err(e) => {
                eprintln!("Config load failed; using non-secret config fallback: {e}");
                Self::config_path()
                    .ok()
                    .and_then(|path| Self::read_from_path(&path).ok())
                    .map(|mut cfg| {
                        cfg.groq_api_key.clear();
                        cfg
                    })
                    .unwrap_or_default()
            }
        }
    }

    pub fn try_load() -> Result<Self, String> {
        let path = Self::config_path()?;
        Self::load_from_path_with_store(&path, &SystemCredentialStore)
    }

    fn load_from_path_with_store(
        path: &Path,
        store: &impl GroqCredentialStore,
    ) -> Result<Self, String> {
        let mut cfg = Self::read_from_path(path)?;

        if cfg.groq_api_key.trim().is_empty() {
            match store.get_groq_api_key() {
                Ok(Some(key)) => cfg.groq_api_key = key,
                Ok(None) => {}
                Err(e) => {
                    eprintln!("Groq API key secure read failed during config load: {e}");
                    return Err(e);
                }
            }
        } else {
            let legacy_key = cfg.groq_api_key.trim().to_string();
            eprintln!("Migrating legacy plaintext Groq API key into secure storage.");
            store
                .set_groq_api_key(&legacy_key)
                .map_err(|e| format!("Credential migration write error: {e}"))?;

            match store.get_groq_api_key_from_store() {
                Ok(Some(saved_key)) if saved_key == legacy_key => {}
                Ok(Some(_)) => eprintln!(
                    "Credential migration verification returned a different Groq API key; sanitizing plaintext config anyway."
                ),
                Ok(None) => eprintln!(
                    "Credential migration verification returned no Groq API key; sanitizing plaintext config anyway."
                ),
                Err(e) => eprintln!(
                    "Credential migration verification read failed; sanitizing plaintext config anyway: {e}"
                ),
            }

            cfg.groq_api_key = legacy_key;
            let mut sanitized = cfg.clone();
            sanitized.groq_api_key.clear();
            sanitized.save_without_secure_migration_to_path(path)?;
        }

        Ok(cfg)
    }

    pub fn save_with_status(&self) -> Result<ConfigSaveResult, ConfigSaveError> {
        let path = Self::config_path().map_err(ConfigSaveError::config_write)?;
        self.save_with_status_to_path_with_store(&path, &SystemCredentialStore)
    }

    fn save_with_status_to_path_with_store(
        &self,
        path: &Path,
        store: &impl GroqCredentialStore,
    ) -> Result<ConfigSaveResult, ConfigSaveError> {
        let mut verified = self.clone();
        verified.groq_api_key = self.groq_api_key.trim().to_string();

        let secure_storage = if !verified.groq_api_key.is_empty() {
            eprintln!("Saving Groq API key to secure storage.");
            store
                .set_groq_api_key(&verified.groq_api_key)
                .map_err(|e| {
                    eprintln!("Groq API key secure write failed: {e}");
                    ConfigSaveError::secure_write(e)
                })?;

            match store.get_groq_api_key_from_store() {
                Ok(Some(saved_key)) if saved_key == verified.groq_api_key => {
                    SecureSaveStatus::verified("Groq API key was saved in secure storage.")
                }
                Ok(Some(_)) => SecureSaveStatus::pending_verification(
                    "Groq API key was saved, but secure storage did not return the new key immediately. Echo will keep using this key for the current session and retry secure storage reads later.",
                ),
                Ok(None) => SecureSaveStatus::pending_verification(
                    "Groq API key was saved, but secure storage returned no key immediately after saving. Echo will keep using this key for the current session and retry secure storage reads later.",
                ),
                Err(e) => {
                    eprintln!("Groq API key secure verification read failed: {e}");
                    SecureSaveStatus::read_failed(format!(
                        "Groq API key was saved, but Echo could not verify secure storage immediately: {e}. Echo will keep using this key for the current session."
                    ))
                }
            }
        } else {
            eprintln!("Removing Groq API key from secure storage.");
            store
                .delete_groq_api_key()
                .map_err(ConfigSaveError::secure_delete)?;
            SecureSaveStatus::verified("Groq API key was removed from secure storage.")
        };

        verified
            .save_without_secure_migration_to_path(path)
            .map_err(ConfigSaveError::config_write)?;

        Ok(ConfigSaveResult {
            config: verified,
            secure_storage,
        })
    }

    fn read_from_path(path: &Path) -> Result<Self, String> {
        match fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("Read error: {e}")),
        }
    }

    fn save_without_secure_migration_to_path(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("Dir create error: {e}"))?;
        }
        let mut sanitized = self.clone();
        sanitized.groq_api_key.clear();
        let json = serde_json::to_string_pretty(&sanitized)
            .map_err(|e| format!("Serialize error: {e}"))?;
        fs::write(path, json).map_err(|e| format!("Write error: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use tempfile::tempdir;

    #[derive(Default)]
    struct MockCredentialStore {
        key: RefCell<Option<String>>,
        get_error: RefCell<Option<String>>,
        get_from_store_error: RefCell<Option<String>>,
        get_from_store_returns_none: bool,
        set_error: RefCell<Option<String>>,
        delete_error: RefCell<Option<String>>,
    }

    impl MockCredentialStore {
        fn with_get_error(message: &str) -> Self {
            Self {
                get_error: RefCell::new(Some(message.to_string())),
                ..Self::default()
            }
        }

        fn with_get_from_store_error(message: &str) -> Self {
            Self {
                get_from_store_error: RefCell::new(Some(message.to_string())),
                ..Self::default()
            }
        }

        fn with_get_from_store_returning_none() -> Self {
            Self {
                get_from_store_returns_none: true,
                ..Self::default()
            }
        }

        fn with_set_error(message: &str) -> Self {
            Self {
                set_error: RefCell::new(Some(message.to_string())),
                ..Self::default()
            }
        }
    }

    impl GroqCredentialStore for MockCredentialStore {
        fn get_groq_api_key(&self) -> Result<Option<String>, String> {
            if let Some(message) = self.get_error.borrow().clone() {
                return Err(message);
            }
            Ok(self.key.borrow().clone())
        }

        fn get_groq_api_key_from_store(&self) -> Result<Option<String>, String> {
            if let Some(message) = self.get_from_store_error.borrow().clone() {
                return Err(message);
            }
            if self.get_from_store_returns_none {
                return Ok(None);
            }
            Ok(self.key.borrow().clone())
        }

        fn set_groq_api_key(&self, value: &str) -> Result<(), String> {
            if let Some(message) = self.set_error.borrow().clone() {
                return Err(message);
            }
            *self.key.borrow_mut() = Some(value.to_string());
            Ok(())
        }

        fn delete_groq_api_key(&self) -> Result<(), String> {
            if let Some(message) = self.delete_error.borrow().clone() {
                return Err(message);
            }
            *self.key.borrow_mut() = None;
            Ok(())
        }
    }

    fn temp_config_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        (dir, path)
    }

    #[test]
    fn load_old_config_defaults_local_transcription_threads() {
        let cfg: AppConfig = serde_json::from_str(
            r#"{
                "groq_api_key": "",
                "shortcut": "CommandOrControl+D",
                "transcription_model": "whisper-large-v3-turbo",
                "cleanup_model": "llama-3.1-8b-instant",
                "cleanup_enabled": true,
                "model_provider": "local",
                "local_model_size": "small"
            }"#,
        )
        .unwrap();

        assert_eq!(cfg.local_transcription_threads, None);
        assert_eq!(cfg.model_provider, "local");
    }

    #[test]
    fn save_verified_writes_secure_key_and_sanitized_config() {
        let (_dir, path) = temp_config_path();
        let store = MockCredentialStore::default();
        let cfg = AppConfig {
            groq_api_key: "  gsk_test_key  ".to_string(),
            ..Default::default()
        };

        let saved = cfg
            .save_with_status_to_path_with_store(&path, &store)
            .unwrap();

        assert_eq!(saved.config.groq_api_key, "gsk_test_key");
        assert_eq!(saved.secure_storage.state, "verified");
        assert_eq!(store.key.borrow().as_deref(), Some("gsk_test_key"));

        let persisted: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(persisted["groq_api_key"], "");
    }

    #[test]
    fn save_verified_surfaces_secure_write_failure() {
        let (_dir, path) = temp_config_path();
        let store = MockCredentialStore::with_set_error("Keychain denied write");
        let cfg = AppConfig {
            groq_api_key: "gsk_test_key".to_string(),
            ..Default::default()
        };

        let err = cfg
            .save_with_status_to_path_with_store(&path, &store)
            .unwrap_err();

        assert_eq!(err.code, "secure_write_failed");
        assert!(err.message.contains("Keychain denied write"));
        assert!(!path.exists());
    }

    #[test]
    fn save_verified_allows_missing_immediate_read_after_write() {
        let (_dir, path) = temp_config_path();
        let store = MockCredentialStore::with_get_from_store_returning_none();
        let cfg = AppConfig {
            groq_api_key: "gsk_test_key".to_string(),
            ..Default::default()
        };

        let saved = cfg
            .save_with_status_to_path_with_store(&path, &store)
            .unwrap();

        assert_eq!(saved.config.groq_api_key, "gsk_test_key");
        assert_eq!(saved.secure_storage.state, "pending_verification");
        assert!(saved.secure_storage.message.contains("returned no key"));
        assert!(path.exists());
    }

    #[test]
    fn save_verified_records_read_after_write_failure_as_warning() {
        let (_dir, path) = temp_config_path();
        let store = MockCredentialStore::with_get_from_store_error("Keychain denied read");
        let cfg = AppConfig {
            groq_api_key: "gsk_test_key".to_string(),
            ..Default::default()
        };

        let saved = cfg
            .save_with_status_to_path_with_store(&path, &store)
            .unwrap();

        assert_eq!(saved.config.groq_api_key, "gsk_test_key");
        assert_eq!(saved.secure_storage.state, "read_failed");
        assert!(saved
            .secure_storage
            .message
            .contains("Keychain denied read"));
        assert!(path.exists());
    }

    #[test]
    fn load_migrates_legacy_plaintext_key_and_sanitizes_config() {
        let (_dir, path) = temp_config_path();
        let store = MockCredentialStore::default();
        let legacy = AppConfig {
            groq_api_key: "gsk_legacy_key".to_string(),
            ..Default::default()
        };
        fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();

        let loaded = AppConfig::load_from_path_with_store(&path, &store).unwrap();

        assert_eq!(loaded.groq_api_key, "gsk_legacy_key");
        assert_eq!(store.key.borrow().as_deref(), Some("gsk_legacy_key"));

        let persisted: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(persisted["groq_api_key"], "");
    }

    #[test]
    fn load_surfaces_secure_read_failure() {
        let (_dir, path) = temp_config_path();
        let store = MockCredentialStore::with_get_error("Keychain denied read");
        let cfg = AppConfig {
            groq_api_key: String::new(),
            ..Default::default()
        };
        fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();

        let err = AppConfig::load_from_path_with_store(&path, &store).unwrap_err();

        assert!(err.contains("Keychain denied read"));
    }
}
