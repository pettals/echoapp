use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub action_label: Option<String>,
}

impl AppError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
        action_label: Option<&str>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            action_label: action_label.map(str::to_string),
        }
    }

    pub fn missing_local_model(model_size: &str) -> Self {
        Self::new(
            "missing_local_model",
            format!(
                "Download the Whisper {model_size} model in Settings before using local dictation."
            ),
            false,
            Some("Open Settings"),
        )
    }

    pub fn empty_speech() -> Self {
        Self::new(
            "empty_speech",
            "No speech was detected. Try again when you are ready.",
            true,
            None,
        )
    }

    pub fn mic_unavailable(message: impl Into<String>) -> Self {
        Self::new(
            "mic_unavailable",
            format!("Microphone is unavailable: {}", message.into()),
            true,
            Some("Check Microphone"),
        )
    }

    pub fn not_recording() -> Self {
        Self::new(
            "not_recording",
            "Recording has already stopped. Start a new dictation and try again.",
            true,
            None,
        )
    }

    pub fn paste_denied(message: impl Into<String>) -> Self {
        Self::new(
            "paste_denied",
            format!(
                "Auto-paste was blocked, so Echo copied the transcript instead. {}",
                message.into()
            ),
            false,
            Some("Enable Accessibility"),
        )
    }

    pub fn model_download_failed(message: impl Into<String>) -> Self {
        Self::new(
            "model_download_failed",
            format!("Model download failed: {}", message.into()),
            true,
            Some("Retry Download"),
        )
    }

    pub fn model_integrity_failed(message: impl Into<String>) -> Self {
        Self::new(
            "model_integrity_failed",
            format!("Downloaded model could not be verified: {}", message.into()),
            true,
            Some("Retry Download"),
        )
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}
