use crate::secure;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
    "system".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            groq_api_key: String::new(),
            shortcut: "CommandOrControl+Shift+Space".to_string(),
            transcription_model: "whisper-large-v3-turbo".to_string(),
            cleanup_model: "llama-3.1-8b-instant".to_string(),
            cleanup_enabled: true,
            input_device: None,
            model_provider: default_model_provider(),
            local_model_size: default_local_model_size(),
            sounds_enabled: default_true(),
            indicator_sound: default_indicator_sound(),
            success_sound: default_success_sound(),
            onboarding_completed: false,
            history_enabled: true,
            history_limit: default_history_limit(),
            appearance_theme: default_appearance_theme(),
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
        let mut cfg: Self = Self::config_path()
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        if cfg.groq_api_key.trim().is_empty() {
            if let Ok(Some(key)) = secure::get_groq_api_key() {
                cfg.groq_api_key = key;
            }
        } else if secure::set_groq_api_key(&cfg.groq_api_key).is_ok() {
            let mut sanitized = cfg.clone();
            sanitized.groq_api_key.clear();
            let _ = sanitized.save_without_secure_migration();
        }

        cfg
    }

    pub fn save(&self) -> Result<(), String> {
        if !self.groq_api_key.trim().is_empty() {
            secure::set_groq_api_key(&self.groq_api_key)?;
        } else {
            secure::delete_groq_api_key()?;
        }

        self.save_without_secure_migration()
    }

    fn save_without_secure_migration(&self) -> Result<(), String> {
        let path = Self::config_path()?;
        let mut sanitized = self.clone();
        sanitized.groq_api_key.clear();
        let json = serde_json::to_string_pretty(&sanitized)
            .map_err(|e| format!("Serialize error: {e}"))?;
        fs::write(path, json).map_err(|e| format!("Write error: {e}"))
    }
}
