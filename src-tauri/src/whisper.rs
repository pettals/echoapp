use crate::{app_error::AppError, config::AppConfig};
use hound::WavReader;
use std::path::{Path, PathBuf};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub fn model_path(model_size: &str) -> Result<PathBuf, String> {
    let dir = AppConfig::models_dir()?;
    Ok(dir.join(format!("ggml-{model_size}.bin")))
}

/// Load WAV file and convert to 16kHz mono f32 samples as required by Whisper.
fn load_wav_as_whisper_input(audio_path: &Path) -> Result<Vec<f32>, String> {
    let reader = WavReader::open(audio_path).map_err(|e| format!("WAV open error: {e}"))?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels as usize;

    let samples_i16: Vec<i16> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .into_samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("WAV read error: {e}"))?,
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("WAV read error: {e}"))?
            .into_iter()
            .map(|s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .collect(),
    };

    // Mix down to mono by averaging channels
    let mono: Vec<f32> = samples_i16
        .chunks(channels)
        .map(|frame| {
            let sum: f32 = frame.iter().map(|&s| s as f32 / i16::MAX as f32).sum();
            sum / channels as f32
        })
        .collect();

    // Resample to 16kHz if necessary
    if sample_rate == 16000 {
        return Ok(mono);
    }

    let ratio = 16000.0 / sample_rate as f64;
    let new_len = (mono.len() as f64 * ratio) as usize;
    let mut resampled = Vec::with_capacity(new_len);
    for i in 0..new_len {
        let src_idx = i as f64 / ratio;
        let idx = src_idx as usize;
        let frac = src_idx - idx as f64;
        let s0 = mono.get(idx).copied().unwrap_or(0.0);
        let s1 = mono.get(idx + 1).copied().unwrap_or(s0);
        resampled.push(s0 + (s1 - s0) * frac as f32);
    }

    Ok(resampled)
}

pub fn transcribe_local(audio_path: &Path, model_size: &str) -> Result<String, AppError> {
    let model = model_path(model_size).map_err(|e| {
        AppError::new(
            "local_model_path_failed",
            format!("Could not locate the local model folder: {e}"),
            false,
            Some("Open Settings"),
        )
    })?;
    if !model.exists() {
        return Err(AppError::missing_local_model(model_size));
    }

    let ctx = WhisperContext::new_with_params(
        model.to_str().ok_or_else(|| {
            AppError::new(
                "invalid_local_model_path",
                "The local Whisper model path is invalid.",
                false,
                Some("Open Settings"),
            )
        })?,
        WhisperContextParameters::default(),
    )
    .map_err(|e| {
        AppError::new(
            "local_model_load_failed",
            format!("Failed to load the local Whisper model: {e}"),
            false,
            Some("Open Settings"),
        )
    })?;

    let audio_data = load_wav_as_whisper_input(audio_path).map_err(|e| {
        AppError::new(
            "audio_read_failed",
            format!("Could not read the recording: {e}"),
            true,
            None,
        )
    })?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(num_cpus());
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_language(Some("en"));
    params.set_suppress_blank(true);

    let mut state = ctx.create_state().map_err(|e| {
        AppError::new(
            "local_model_state_failed",
            format!("State create error: {e}"),
            true,
            None,
        )
    })?;
    state.full(params, &audio_data).map_err(|e| {
        AppError::new(
            "local_transcription_failed",
            format!("Whisper inference error: {e}"),
            true,
            None,
        )
    })?;

    let num_segments = state.full_n_segments();
    let mut text = String::new();
    for i in 0..num_segments {
        if let Some(segment) = state.get_segment(i) {
            if let Ok(s) = segment.to_str_lossy() {
                text.push_str(&s);
            }
        }
    }

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::empty_speech());
    }

    Ok(trimmed)
}

fn num_cpus() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .min(8)
}
