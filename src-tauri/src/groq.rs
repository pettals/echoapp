use reqwest::{multipart, StatusCode};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
const REQUEST_TIMEOUT_SECS: u64 = 30;
pub const GROQ_DIRECT_UPLOAD_LIMIT_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GroqApiError {
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl GroqApiError {
    fn missing_key() -> Self {
        Self {
            status: None,
            code: "missing_api_key".to_string(),
            message: "Enter a Groq API key before testing the connection.".to_string(),
            retryable: false,
        }
    }

    fn network(error: reqwest::Error) -> Self {
        Self {
            status: error.status().map(|s| s.as_u16()),
            code: "network_error".to_string(),
            message: format!(
                "Could not reach Groq. Check your connection and try again. ({error})"
            ),
            retryable: true,
        }
    }

    fn parse(context: &str, error: impl std::fmt::Display) -> Self {
        Self {
            status: None,
            code: "parse_error".to_string(),
            message: format!("Groq returned an unexpected {context} response: {error}"),
            retryable: false,
        }
    }

    fn audio_preflight(message: String) -> Self {
        Self {
            status: None,
            code: "audio_preflight_failed".to_string(),
            message,
            retryable: false,
        }
    }

    fn empty_response(context: &str) -> Self {
        Self {
            status: None,
            code: "empty_response".to_string(),
            message: format!("Groq returned no {context}. Try again."),
            retryable: true,
        }
    }
}

impl std::fmt::Display for GroqApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GroqApiError {}

#[derive(Debug, Clone, Serialize)]
pub struct GroqReadiness {
    pub ok: bool,
    pub message: String,
    pub transcription_model_ok: bool,
    pub cleanup_model_ok: bool,
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

#[derive(Deserialize)]
struct GroqErrorEnvelope {
    error: Option<GroqErrorBody>,
}

#[derive(Deserialize)]
struct GroqErrorBody {
    message: Option<String>,
    #[serde(rename = "type")]
    error_type: Option<String>,
    code: Option<serde_json::Value>,
}

fn client() -> Result<reqwest::Client, GroqApiError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| GroqApiError::parse("client", e))
}

fn auth_header(api_key: &str) -> String {
    format!("Bearer {}", api_key.trim())
}

fn parse_error_code(value: Option<serde_json::Value>, fallback: &str) -> String {
    match value {
        Some(serde_json::Value::String(code)) if !code.trim().is_empty() => code,
        Some(serde_json::Value::Number(code)) => code.to_string(),
        _ => fallback.to_string(),
    }
}

fn status_error(status: StatusCode, body: &str) -> GroqApiError {
    let parsed = serde_json::from_str::<GroqErrorEnvelope>(body).ok();
    let api_error = parsed.and_then(|envelope| envelope.error);
    let api_message = api_error
        .as_ref()
        .and_then(|error| error.message.clone())
        .filter(|message| !message.trim().is_empty());
    let fallback_code = api_error
        .as_ref()
        .and_then(|error| error.error_type.clone())
        .filter(|code| !code.trim().is_empty())
        .unwrap_or_else(|| format!("http_{}", status.as_u16()));
    let code = parse_error_code(api_error.and_then(|error| error.code), &fallback_code);
    let detail = api_message.unwrap_or_else(|| body.trim().to_string());

    let (message, retryable) = match status {
        StatusCode::UNAUTHORIZED => (
            "Groq rejected the API key. Check that the key is valid and starts with gsk_.".to_string(),
            false,
        ),
        StatusCode::FORBIDDEN => (
            "Groq refused access to the selected model. Check your Groq project or model permissions."
                .to_string(),
            false,
        ),
        StatusCode::PAYLOAD_TOO_LARGE => (
            "The recording is too large for Groq direct upload. Try a shorter recording.".to_string(),
            false,
        ),
        StatusCode::TOO_MANY_REQUESTS => (
            "Groq rate limit reached. Wait a moment and try again.".to_string(),
            true,
        ),
        _ if status.is_server_error() => (
            "Groq is temporarily unavailable. Try again in a moment.".to_string(),
            true,
        ),
        _ => (
            format!("Groq request failed ({status}): {detail}"),
            status.as_u16() == 408 || status.as_u16() == 498,
        ),
    };

    let message = if detail.is_empty()
        || message.contains(&detail)
        || matches!(
            status,
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::PAYLOAD_TOO_LARGE
                | StatusCode::TOO_MANY_REQUESTS
        ) {
        message
    } else {
        format!("{message} Groq said: {detail}")
    };

    GroqApiError {
        status: Some(status.as_u16()),
        code,
        message,
        retryable,
    }
}

async fn error_for_response(resp: reqwest::Response) -> GroqApiError {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    status_error(status, &body)
}

fn model_is_available(models: &[String], model: &str) -> bool {
    models.iter().any(|candidate| candidate == model)
}

fn readiness_from_models(
    models: &[String],
    transcription_model: &str,
    cleanup_model: &str,
    cleanup_enabled: bool,
) -> GroqReadiness {
    let transcription_model_ok = model_is_available(models, transcription_model);
    let cleanup_model_ok = !cleanup_enabled || model_is_available(models, cleanup_model);
    let ok = transcription_model_ok && cleanup_model_ok;

    let message = if ok {
        "Groq connection looks good. Selected models are available.".to_string()
    } else if !transcription_model_ok {
        format!("Groq key works, but transcription model '{transcription_model}' is not available.")
    } else {
        format!("Groq key works, but cleanup model '{cleanup_model}' is not available.")
    };

    GroqReadiness {
        ok,
        message,
        transcription_model_ok,
        cleanup_model_ok,
    }
}

pub async fn list_models(api_key: &str) -> Result<Vec<String>, GroqApiError> {
    if api_key.trim().is_empty() {
        return Err(GroqApiError::missing_key());
    }

    let resp = client()?
        .get(format!("{GROQ_BASE_URL}/models"))
        .header("Authorization", auth_header(api_key))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(GroqApiError::network)?;

    if !resp.status().is_success() {
        return Err(error_for_response(resp).await);
    }

    let result: ModelsResponse = resp
        .json()
        .await
        .map_err(|e| GroqApiError::parse("models", e))?;

    Ok(result.data.into_iter().map(|model| model.id).collect())
}

pub async fn validate_api_key(
    api_key: &str,
    transcription_model: &str,
    cleanup_model: &str,
    cleanup_enabled: bool,
) -> Result<GroqReadiness, GroqApiError> {
    let models = list_models(api_key).await?;
    Ok(readiness_from_models(
        &models,
        transcription_model,
        cleanup_model,
        cleanup_enabled,
    ))
}

async fn preflight_audio_file(audio_path: &Path) -> Result<(), GroqApiError> {
    let metadata = tokio::fs::metadata(audio_path).await.map_err(|e| {
        GroqApiError::audio_preflight(format!(
            "Could not read recording before sending to Groq: {e}"
        ))
    })?;

    if !metadata.is_file() {
        return Err(GroqApiError::audio_preflight(
            "Recording path is not a file.".to_string(),
        ));
    }

    if metadata.len() == 0 {
        return Err(GroqApiError::audio_preflight(
            "Recording is empty. Try recording again.".to_string(),
        ));
    }

    if metadata.len() > GROQ_DIRECT_UPLOAD_LIMIT_BYTES {
        return Err(GroqApiError::audio_preflight(format!(
            "Recording is too large for Groq direct upload ({} MB max). Try a shorter recording.",
            GROQ_DIRECT_UPLOAD_LIMIT_BYTES / 1024 / 1024
        )));
    }

    Ok(())
}

pub async fn transcribe(
    api_key: &str,
    audio_path: &Path,
    model: &str,
) -> Result<String, GroqApiError> {
    if api_key.trim().is_empty() {
        return Err(GroqApiError::missing_key());
    }

    preflight_audio_file(audio_path).await?;

    let file_bytes = tokio::fs::read(audio_path).await.map_err(|e| {
        GroqApiError::audio_preflight(format!(
            "Could not read recording before sending to Groq: {e}"
        ))
    })?;

    let file_name = audio_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let part = multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("audio/wav")
        .map_err(|e| GroqApiError::parse("audio MIME", e))?;

    let form = multipart::Form::new()
        .text("model", model.to_string())
        .text("response_format", "json")
        .text("temperature", "0")
        .part("file", part);

    let resp = client()?
        .post(format!("{GROQ_BASE_URL}/audio/transcriptions"))
        .header("Authorization", auth_header(api_key))
        .multipart(form)
        .send()
        .await
        .map_err(GroqApiError::network)?;

    if !resp.status().is_success() {
        return Err(error_for_response(resp).await);
    }

    let result: TranscriptionResponse = resp
        .json()
        .await
        .map_err(|e| GroqApiError::parse("transcription", e))?;

    if result.text.trim().is_empty() {
        return Err(GroqApiError::empty_response("transcript"));
    }

    Ok(result.text)
}

pub async fn cleanup(api_key: &str, raw_text: &str, model: &str) -> Result<String, GroqApiError> {
    if api_key.trim().is_empty() {
        return Err(GroqApiError::missing_key());
    }

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You are a dictation cleanup assistant. Fix punctuation, remove filler words (um, uh, like, you know), correct obvious grammar mistakes, and improve formatting. Preserve the original meaning and tone exactly. Do not add, remove, or rephrase substantive content. Return only the cleaned text with no commentary."
            },
            {
                "role": "user",
                "content": raw_text
            }
        ],
        "temperature": 0.1,
        "max_tokens": 4096
    });

    let resp = client()?
        .post(format!("{GROQ_BASE_URL}/chat/completions"))
        .header("Authorization", auth_header(api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(GroqApiError::network)?;

    if !resp.status().is_success() {
        return Err(error_for_response(resp).await);
    }

    let result: ChatResponse = resp
        .json()
        .await
        .map_err(|e| GroqApiError::parse("cleanup", e))?;

    result
        .choices
        .first()
        .map(|c| c.message.content.trim().to_string())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| GroqApiError::empty_response("cleanup text"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn maps_invalid_key_status_to_clear_error() {
        let err = status_error(
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}"#,
        );

        assert_eq!(err.status, Some(401));
        assert_eq!(err.code, "invalid_api_key");
        assert!(!err.retryable);
        assert!(err.message.contains("API key"));
    }

    #[test]
    fn maps_permission_status_to_clear_error() {
        let err = status_error(
            StatusCode::FORBIDDEN,
            r#"{"error":{"message":"model not allowed","type":"permissions_error"}}"#,
        );

        assert_eq!(err.status, Some(403));
        assert_eq!(err.code, "permissions_error");
        assert!(!err.retryable);
        assert!(err.message.contains("permissions"));
    }

    #[test]
    fn maps_payload_and_rate_limit_errors() {
        let too_large = status_error(StatusCode::PAYLOAD_TOO_LARGE, "");
        let rate_limit = status_error(StatusCode::TOO_MANY_REQUESTS, "");

        assert_eq!(too_large.code, "http_413");
        assert!(!too_large.retryable);
        assert!(too_large.message.contains("too large"));
        assert_eq!(rate_limit.code, "http_429");
        assert!(rate_limit.retryable);
        assert!(rate_limit.message.contains("rate limit"));
    }

    #[test]
    fn maps_server_error_as_retryable() {
        let err = status_error(StatusCode::BAD_GATEWAY, "upstream failed");

        assert_eq!(err.status, Some(502));
        assert!(err.retryable);
        assert!(err.message.contains("temporarily unavailable"));
    }

    #[test]
    fn validates_model_availability_from_models_response() {
        let models = vec![
            "whisper-large-v3-turbo".to_string(),
            "llama-3.1-8b-instant".to_string(),
        ];

        let ready = readiness_from_models(
            &models,
            "whisper-large-v3-turbo",
            "llama-3.1-8b-instant",
            true,
        );

        assert!(ready.ok);
        assert!(ready.transcription_model_ok);
        assert!(ready.cleanup_model_ok);
    }

    #[test]
    fn readiness_fails_when_cleanup_model_missing() {
        let models = vec!["whisper-large-v3-turbo".to_string()];

        let ready = readiness_from_models(
            &models,
            "whisper-large-v3-turbo",
            "llama-3.1-8b-instant",
            true,
        );

        assert!(!ready.ok);
        assert!(ready.transcription_model_ok);
        assert!(!ready.cleanup_model_ok);
    }

    #[tokio::test]
    async fn audio_preflight_rejects_empty_file() {
        let file = NamedTempFile::new().unwrap();

        let err = preflight_audio_file(file.path()).await.unwrap_err();

        assert_eq!(err.code, "audio_preflight_failed");
        assert!(err.message.contains("empty"));
    }

    #[tokio::test]
    async fn audio_preflight_rejects_oversized_file() {
        let file = NamedTempFile::new().unwrap();
        file.as_file()
            .set_len(GROQ_DIRECT_UPLOAD_LIMIT_BYTES + 1)
            .unwrap();

        let err = preflight_audio_file(file.path()).await.unwrap_err();

        assert_eq!(err.code, "audio_preflight_failed");
        assert!(err.message.contains("too large"));
    }
}
