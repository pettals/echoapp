use crate::{app_error::AppError, config::AppConfig};
use hound::WavReader;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Debug, Clone)]
pub struct LocalTranscriptionMetrics {
    pub model_size: String,
    pub model_cache_hit: bool,
    pub model_load_ms: u64,
    pub audio_decode_ms: u64,
    pub inference_ms: u64,
    pub thread_count: i32,
}

#[derive(Debug, Clone)]
pub struct LocalTranscriptionResult {
    pub text: String,
    pub metrics: LocalTranscriptionMetrics,
}

struct CachedWhisperContext {
    model_size: String,
    model_path: PathBuf,
    context: WhisperContext,
}

static LOCAL_MODEL_CACHE: OnceLock<Mutex<Option<CachedWhisperContext>>> = OnceLock::new();

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

pub fn transcribe_local_with_metrics(
    audio_path: &Path,
    model_size: &str,
    requested_threads: Option<usize>,
) -> Result<LocalTranscriptionResult, AppError> {
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

    let model_cache = LOCAL_MODEL_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = model_cache.lock().map_err(|e| {
        AppError::new(
            "local_model_cache_failed",
            format!("Local model cache lock failed: {e}"),
            true,
            None,
        )
    })?;
    let model_cache_hit = cached
        .as_ref()
        .is_some_and(|entry| entry.model_size == model_size && entry.model_path == model);

    let load_start = Instant::now();
    if !model_cache_hit {
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

        *cached = Some(CachedWhisperContext {
            model_size: model_size.to_string(),
            model_path: model.clone(),
            context: ctx,
        });
    }
    let model_load_ms = elapsed_ms(load_start);

    let audio_start = Instant::now();
    let audio_data = load_wav_as_whisper_input(audio_path).map_err(|e| {
        AppError::new(
            "audio_read_failed",
            format!("Could not read the recording: {e}"),
            true,
            None,
        )
    })?;
    let audio_decode_ms = elapsed_ms(audio_start);

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let thread_count = local_thread_count(requested_threads);
    params.set_n_threads(thread_count);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_language(Some("en"));
    params.set_suppress_blank(true);

    let ctx = &cached
        .as_ref()
        .ok_or_else(|| {
            AppError::new(
                "local_model_cache_empty",
                "Local Whisper model was not available after loading.",
                true,
                None,
            )
        })?
        .context;

    let inference_start = Instant::now();
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
    let inference_ms = elapsed_ms(inference_start);

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

    Ok(LocalTranscriptionResult {
        text: trimmed,
        metrics: LocalTranscriptionMetrics {
            model_size: model_size.to_string(),
            model_cache_hit,
            model_load_ms,
            audio_decode_ms,
            inference_ms,
            thread_count,
        },
    })
}

fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .max(1) as usize
}

pub fn local_thread_count(requested_threads: Option<usize>) -> i32 {
    let available = available_parallelism();
    let balanced = available.min(4).max(1);
    let threads = requested_threads
        .filter(|threads| *threads > 0)
        .unwrap_or(balanced)
        .clamp(1, available);
    threads as i32
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_thread_count_uses_balanced_default() {
        let expected = available_parallelism().min(4).max(1) as i32;
        assert_eq!(local_thread_count(None), expected);
    }

    #[test]
    fn local_thread_count_clamps_zero_and_large_values() {
        let available = available_parallelism() as i32;

        assert_eq!(local_thread_count(Some(0)), available.min(4).max(1));
        assert_eq!(local_thread_count(Some(usize::MAX)), available);
        assert_eq!(local_thread_count(Some(1)), 1);
    }
}
