use crate::{config::AppConfig, history, model_download, setup, stats};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeErrorEvent {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub context: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportDiagnostics {
    pub generated_at: String,
    pub app_version: String,
    pub product_name: String,
    pub platform: String,
    pub arch: String,
    pub model_provider: String,
    pub transcription_model: String,
    pub cleanup_enabled: bool,
    pub cleanup_model: String,
    pub local_model_size: String,
    pub local_model_downloaded: bool,
    pub local_model_integrity_checked: bool,
    pub local_model_integrity_error: Option<String>,
    pub setup_ready: bool,
    pub setup_checks: Vec<setup::SetupCheck>,
    pub history_enabled: bool,
    pub history_limit: usize,
    pub history_item_count: usize,
    pub notepad_note_count: usize,
    pub stats_total_words: u64,
    pub stats_dictation_count: u64,
    pub recent_errors: Vec<SafeErrorEvent>,
    pub privacy: Vec<String>,
}

pub fn now_iso() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    days += 719468;
    let era = days / 146097;
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn redact_secret_markers(value: &str) -> String {
    let mut redacted = Vec::new();
    for word in value.split_whitespace() {
        if word.starts_with("gsk_")
            || word.starts_with("sk-")
            || word.to_ascii_lowercase().contains("bearer")
        {
            redacted.push("[redacted]");
        } else {
            redacted.push(word);
        }
    }
    redacted.join(" ")
}

fn safe_error_event(
    code: impl Into<String>,
    message: impl Into<String>,
    retryable: bool,
    context: impl Into<String>,
) -> SafeErrorEvent {
    SafeErrorEvent {
        code: code.into(),
        message: redact_secret_markers(&message.into()),
        retryable,
        context: context.into(),
    }
}

fn sanitize_setup_checks(checks: &[setup::SetupCheck]) -> Vec<setup::SetupCheck> {
    checks
        .iter()
        .map(|check| setup::SetupCheck {
            id: check.id.clone(),
            label: check.label.clone(),
            status: check.status.clone(),
            message: redact_secret_markers(&check.message),
            action_label: check.action_label.clone(),
        })
        .collect()
}

fn collect_recent_errors(
    config_error: Option<&str>,
    setup_status: &setup::SetupStatus,
) -> Vec<SafeErrorEvent> {
    let mut errors = Vec::new();
    if let Some(error) = config_error {
        errors.push(safe_error_event(
            "config_load_failed",
            error,
            false,
            "configuration",
        ));
    }

    errors.extend(
        setup_status
            .checks
            .iter()
            .filter(|check| check.status == "error")
            .map(|check| {
                safe_error_event(
                    format!("setup_{}", check.id),
                    check.message.clone(),
                    true,
                    "setup",
                )
            }),
    );

    errors
}

fn privacy_notes() -> Vec<String> {
    vec![
        "Transcript text is excluded.".to_string(),
        "Notepad note contents are excluded.".to_string(),
        "Audio files and audio samples are excluded.".to_string(),
        "Groq API keys and future company cloud credentials are excluded.".to_string(),
        "Clipboard contents are excluded.".to_string(),
    ]
}

pub fn build_support_diagnostics(
    cfg: &AppConfig,
    setup_status: setup::SetupStatus,
    local_model_status: model_download::ModelStatus,
    history_item_count: usize,
    notepad_note_count: usize,
    stored_stats: stats::StoredStats,
    config_error: Option<String>,
) -> SupportDiagnostics {
    SupportDiagnostics {
        generated_at: now_iso(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        product_name: "Echo".to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        model_provider: cfg.model_provider.clone(),
        transcription_model: cfg.transcription_model.clone(),
        cleanup_enabled: cfg.cleanup_enabled,
        cleanup_model: cfg.cleanup_model.clone(),
        local_model_size: cfg.local_model_size.clone(),
        local_model_downloaded: local_model_status.downloaded,
        local_model_integrity_checked: local_model_status.integrity_checked,
        local_model_integrity_error: local_model_status.integrity_error.clone(),
        setup_ready: setup_status.ready,
        setup_checks: sanitize_setup_checks(&setup_status.checks),
        history_enabled: cfg.history_enabled,
        history_limit: cfg.history_limit,
        history_item_count,
        notepad_note_count,
        stats_total_words: stored_stats.total_words,
        stats_dictation_count: stored_stats.dictation_count,
        recent_errors: collect_recent_errors(config_error.as_deref(), &setup_status),
        privacy: privacy_notes(),
    }
}

pub fn diagnostics_to_pretty_json(report: &SupportDiagnostics) -> Result<String, String> {
    serde_json::to_string_pretty(report).map_err(|e| format!("Serialize diagnostics error: {e}"))
}

#[cfg(test)]
fn diagnostics_summary_counts() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        ("transcripts", "count only"),
        ("notes", "count only"),
        ("audio", "excluded"),
        ("credentials", "excluded"),
        ("clipboard", "excluded"),
    ])
}

pub fn current_support_diagnostics(
    download_state: &model_download::DownloadState,
) -> SupportDiagnostics {
    let (cfg, config_error) = match AppConfig::try_load() {
        Ok(cfg) => (cfg, None),
        Err(error) => {
            eprintln!("Diagnostics config load failed; building redacted fallback report: {error}");
            (AppConfig::load(), Some(error))
        }
    };
    let setup_status = if let Some(error) = config_error.as_deref() {
        setup::get_status_with_credential_error(&cfg, error)
    } else {
        setup::get_status(&cfg)
    };
    let local_model_status =
        model_download::check_model_status(&cfg.local_model_size, download_state);
    let stored_stats = stats::load();

    build_support_diagnostics(
        &cfg,
        setup_status,
        local_model_status,
        history::load_all().len(),
        crate::notepad::load_all().len(),
        stored_stats,
        config_error,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_status(message: &str) -> setup::SetupStatus {
        setup::SetupStatus {
            ready: false,
            checks: vec![setup::SetupCheck {
                id: "provider".to_string(),
                label: "Provider".to_string(),
                status: "error".to_string(),
                message: message.to_string(),
                action_label: Some("Open Settings".to_string()),
            }],
        }
    }

    #[test]
    fn diagnostics_exclude_transcript_note_audio_and_key_content() {
        let cfg = AppConfig {
            groq_api_key: "gsk_super_secret".to_string(),
            ..AppConfig::default()
        };
        let report = build_support_diagnostics(
            &cfg,
            setup_status("Provider failed for gsk_super_secret"),
            model_download::ModelStatus {
                downloaded: false,
                downloading: false,
                file_size_bytes: 0,
                expected_size_bytes: 0,
                integrity_checked: false,
                integrity_error: None,
                model_size: "small".to_string(),
            },
            2,
            3,
            stats::StoredStats {
                total_words: 42,
                dictation_count: 4,
                ..stats::StoredStats::default()
            },
            Some("Could not read gsk_super_secret".to_string()),
        );
        let json = diagnostics_to_pretty_json(&report).unwrap();

        assert!(!json.contains("gsk_super_secret"));
        assert!(!json.contains("secret transcript sample"));
        assert!(!json.contains("secret note sample"));
        assert!(json.contains("\"historyItemCount\": 2"));
        assert!(json.contains("\"notepadNoteCount\": 3"));
        assert!(json.contains("Transcript text is excluded."));
    }

    #[test]
    fn summary_counts_document_sensitive_data_policy() {
        let counts = diagnostics_summary_counts();

        assert_eq!(counts.get("transcripts"), Some(&"count only"));
        assert_eq!(counts.get("notes"), Some(&"count only"));
        assert_eq!(counts.get("credentials"), Some(&"excluded"));
    }
}
