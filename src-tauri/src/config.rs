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
}

fn default_model_provider() -> String {
    "api".to_string()
}

fn default_local_model_size() -> String {
    "small".to_string()
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
        Self::config_path()
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path()?;
        let json = serde_json::to_string_pretty(self).map_err(|e| format!("Serialize error: {e}"))?;
        fs::write(path, json).map_err(|e| format!("Write error: {e}"))
    }
}
