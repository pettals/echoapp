use reqwest::multipart;
use serde::Deserialize;
use std::path::Path;

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

pub async fn transcribe(api_key: &str, audio_path: &Path, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let file_bytes = tokio::fs::read(audio_path)
        .await
        .map_err(|e| format!("Read audio error: {e}"))?;

    let file_name = audio_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let part = multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("audio/wav")
        .map_err(|e| format!("MIME error: {e}"))?;

    let form = multipart::Form::new()
        .text("model", model.to_string())
        .text("response_format", "json")
        .part("file", part);

    let resp = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Request error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Groq transcription failed ({status}): {body}"));
    }

    let result: TranscriptionResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse error: {e}"))?;

    Ok(result.text)
}

pub async fn cleanup(api_key: &str, raw_text: &str, model: &str) -> Result<String, String> {
    let client = reqwest::Client::new();

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

    let resp = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request error: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Groq cleanup failed ({status}): {body}"));
    }

    let result: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("Parse error: {e}"))?;

    result
        .choices
        .first()
        .map(|c| c.message.content.trim().to_string())
        .ok_or_else(|| "No response from cleanup model".to_string())
}
