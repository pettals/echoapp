use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavReader, WavSpec, WavWriter};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tempfile::NamedTempFile;

const MIN_SPEECH_RECORDING_SECS: f32 = 0.25;
const SPEECH_FRAME_MS: u32 = 20;
const MIN_ACTIVE_SPEECH_SECS: f32 = 0.18;
const MIN_CONSECUTIVE_SPEECH_SECS: f32 = 0.08;
const MIN_ACTIVE_RMS: f32 = 0.012;
const MAX_ADAPTIVE_RMS: f32 = 0.02;
const MIN_ACTIVE_PEAK: f32 = 0.035;
const NOISE_MULTIPLIER: f32 = 3.0;
const LEVEL_RMS_GAIN: f32 = 9.0;
const LEVEL_PEAK_GAIN: f32 = 1.4;
const LIVE_CHUNK_SECS: f32 = 1.5;
const LIVE_CHUNK_OVERLAP_SECS: f32 = 0.3;
const CLOUD_CHUNK_TARGET_BYTES: u64 = 22 * 1024 * 1024;
const CLOUD_CHUNK_OVERLAP_SECS: f32 = 1.0;

type SharedWavWriter = Arc<Mutex<Option<WavWriter<BufWriter<std::fs::File>>>>>;
type SharedLiveChunker = Arc<Mutex<Option<LiveChunker>>>;

#[derive(Clone, Debug)]
pub struct LiveAudioChunk {
    pub sequence: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<i16>,
}

pub type LiveChunkSender = tokio::sync::mpsc::UnboundedSender<LiveAudioChunk>;

pub struct SharedLevel(AtomicU32);

impl SharedLevel {
    pub fn new() -> Self {
        Self(AtomicU32::new(0))
    }

    pub fn store(&self, val: f32) {
        self.0.store(val.to_bits(), Ordering::Relaxed);
    }

    pub fn take(&self) -> f32 {
        f32::from_bits(self.0.swap(0, Ordering::Relaxed))
    }
}

enum Command {
    Stop,
}

fn visual_level(rms: f32, peak: f32) -> f32 {
    let lifted = (rms * LEVEL_RMS_GAIN).max(peak * LEVEL_PEAK_GAIN);
    lifted.clamp(0.0, 1.0).sqrt()
}

pub struct RecorderHandle {
    cmd_tx: Option<mpsc::Sender<Command>>,
    result_rx: Option<RecordingResultReceiver>,
    recording: bool,
}

pub type RecordingResult = Result<std::path::PathBuf, String>;
pub type RecordingResultReceiver = mpsc::Receiver<RecordingResult>;

impl RecorderHandle {
    pub fn new() -> Self {
        Self {
            cmd_tx: None,
            result_rx: None,
            recording: false,
        }
    }

    pub fn start(
        &mut self,
        device_name: Option<&str>,
        level: Arc<SharedLevel>,
        live_chunk_sender: Option<LiveChunkSender>,
    ) -> Result<(), String> {
        if self.recording {
            return Err("Already recording".to_string());
        }

        let device_name_owned = device_name.map(|s| s.to_string());
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (result_tx, result_rx) = mpsc::channel::<RecordingResult>();

        thread::spawn(move || {
            let result = run_recording(
                cmd_rx,
                device_name_owned.as_deref(),
                level,
                live_chunk_sender,
            );
            let _ = result_tx.send(result);
        });

        self.cmd_tx = Some(cmd_tx);
        self.result_rx = Some(result_rx);
        self.recording = true;
        Ok(())
    }

    pub fn begin_stop(&mut self) -> Result<RecordingResultReceiver, String> {
        if !self.recording {
            return Err("Not recording".to_string());
        }

        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Command::Stop);
        }

        self.recording = false;
        self.result_rx.take().ok_or("No result channel".to_string())
    }

    pub fn is_recording(&self) -> bool {
        self.recording
    }
}

struct LiveChunker {
    sender: LiveChunkSender,
    sample_rate: u32,
    channels: u16,
    chunk_samples: usize,
    overlap_samples: usize,
    samples: Vec<i16>,
    sequence: u64,
}

impl LiveChunker {
    fn new(sender: LiveChunkSender, sample_rate: u32, channels: u16) -> Self {
        let channel_count = channels.max(1) as usize;
        let chunk_samples =
            ((sample_rate as f32 * LIVE_CHUNK_SECS) as usize).max(1) * channel_count;
        let overlap_samples =
            ((sample_rate as f32 * LIVE_CHUNK_OVERLAP_SECS) as usize).max(1) * channel_count;

        Self {
            sender,
            sample_rate,
            channels,
            chunk_samples,
            overlap_samples: overlap_samples.min(chunk_samples.saturating_sub(channel_count)),
            samples: Vec::with_capacity(chunk_samples),
            sequence: 0,
        }
    }

    fn push_samples(&mut self, next_samples: &[i16]) {
        self.samples.extend_from_slice(next_samples);

        while self.samples.len() >= self.chunk_samples {
            let chunk = self.samples[..self.chunk_samples].to_vec();
            self.sequence = self.sequence.saturating_add(1);
            let _ = self.sender.send(LiveAudioChunk {
                sequence: self.sequence,
                sample_rate: self.sample_rate,
                channels: self.channels,
                samples: chunk,
            });

            let drain_to = self.chunk_samples.saturating_sub(self.overlap_samples);
            self.samples.drain(..drain_to);
        }
    }
}

fn get_device(device_name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();

    if let Some(name) = device_name {
        let devices = host
            .input_devices()
            .map_err(|e| format!("Input devices error: {e}"))?;
        for device in devices {
            if let Ok(n) = device.name() {
                if n == name {
                    return Ok(device);
                }
            }
        }
    }

    host.default_input_device().ok_or(
        "No input device available. Check System Settings > Privacy & Security > Microphone."
            .to_string(),
    )
}

pub fn list_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| format!("Input devices error: {e}"))?;

    let mut names = Vec::new();
    for device in devices {
        if let Ok(name) = device.name() {
            names.push(name);
        }
    }
    Ok(names)
}

pub fn test_mic(device_name: Option<&str>) -> Result<f32, String> {
    let device = get_device(device_name)?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("Config error: {e}"))?;

    let peak = Arc::new(Mutex::new(0.0f32));

    let err_fn = |err: cpal::StreamError| {
        eprintln!("Test stream error: {err}");
    };

    let stream = {
        let peak_writer = Arc::clone(&peak);
        match config.sample_format() {
            cpal::SampleFormat::F32 => device
                .build_input_stream(
                    &config.into(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        for sample in data.iter() {
                            let abs = sample.abs();
                            if let Ok(mut p) = peak_writer.lock() {
                                if abs > *p {
                                    *p = abs;
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Stream error: {e}"))?,
            cpal::SampleFormat::I16 => device
                .build_input_stream(
                    &config.into(),
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        for &sample in data.iter() {
                            let abs = (sample as f32 / i16::MAX as f32).abs();
                            if let Ok(mut p) = peak_writer.lock() {
                                if abs > *p {
                                    *p = abs;
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Stream error: {e}"))?,
            cpal::SampleFormat::U16 => device
                .build_input_stream(
                    &config.into(),
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        for &sample in data.iter() {
                            let normalized = (sample as f32 / u16::MAX as f32) * 2.0 - 1.0;
                            let abs = normalized.abs();
                            if let Ok(mut p) = peak_writer.lock() {
                                if abs > *p {
                                    *p = abs;
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Stream error: {e}"))?,
            fmt => return Err(format!("Unsupported format: {fmt:?}")),
        }
    };

    stream.play().map_err(|e| format!("Play error: {e}"))?;
    // Record for 2 seconds
    thread::sleep(Duration::from_secs(2));
    drop(stream);

    let result = peak.lock().map(|p| *p).unwrap_or(0.0);
    Ok(result.min(1.0))
}

pub fn has_speech(audio_path: &Path) -> Result<bool, String> {
    let reader = WavReader::open(audio_path).map_err(|e| format!("WAV open error: {e}"))?;
    let spec = reader.spec();
    let sample_rate = spec.sample_rate;
    let channels = spec.channels as usize;

    if sample_rate == 0 || channels == 0 {
        return Ok(false);
    }

    let samples = read_wav_samples(reader)?;
    let mono = mix_to_mono(&samples, channels);
    if mono.is_empty() {
        return Ok(false);
    }

    let duration_secs = mono.len() as f32 / sample_rate as f32;
    if duration_secs < MIN_SPEECH_RECORDING_SECS {
        return Ok(false);
    }

    let frame_size = ((sample_rate as u64 * SPEECH_FRAME_MS as u64) / 1000).max(1) as usize;
    let mut frames = Vec::new();

    for frame in mono.chunks(frame_size) {
        let mut sum_squares = 0.0f32;
        let mut peak = 0.0f32;

        for sample in frame {
            let abs = sample.abs();
            sum_squares += sample * sample;
            peak = peak.max(abs);
        }

        let rms = (sum_squares / frame.len() as f32).sqrt();
        frames.push((rms, peak));
    }

    if frames.is_empty() {
        return Ok(false);
    }

    let mut rms_values: Vec<f32> = frames.iter().map(|(rms, _)| *rms).collect();
    rms_values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let noise_index =
        ((rms_values.len() as f32 * 0.2).floor() as usize).min(rms_values.len().saturating_sub(1));
    let noise_floor = rms_values[noise_index];
    let active_rms_threshold =
        MIN_ACTIVE_RMS.max((noise_floor * NOISE_MULTIPLIER).min(MAX_ADAPTIVE_RMS));

    let frame_secs = frame_size as f32 / sample_rate as f32;
    let mut active_secs = 0.0f32;
    let mut consecutive_secs = 0.0f32;
    let mut max_consecutive_secs = 0.0f32;

    for (rms, peak) in frames {
        if rms >= active_rms_threshold && peak >= MIN_ACTIVE_PEAK {
            active_secs += frame_secs;
            consecutive_secs += frame_secs;
            max_consecutive_secs = max_consecutive_secs.max(consecutive_secs);
        } else {
            consecutive_secs = 0.0;
        }
    }

    Ok(
        active_secs >= MIN_ACTIVE_SPEECH_SECS
            && max_consecutive_secs >= MIN_CONSECUTIVE_SPEECH_SECS,
    )
}

fn read_wav_samples<R: std::io::Read + std::io::Seek>(
    reader: WavReader<R>,
) -> Result<Vec<f32>, String> {
    let spec = reader.spec();

    match spec.sample_format {
        hound::SampleFormat::Int => match spec.bits_per_sample {
            8 => reader
                .into_samples::<i8>()
                .map(|s| s.map(|v| v as f32 / i8::MAX as f32))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("WAV read error: {e}")),
            16 => reader
                .into_samples::<i16>()
                .map(|s| s.map(|v| v as f32 / i16::MAX as f32))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("WAV read error: {e}")),
            24 | 32 => reader
                .into_samples::<i32>()
                .map(|s| {
                    s.map(|v| {
                        let max = if spec.bits_per_sample == 24 {
                            8_388_607.0
                        } else {
                            i32::MAX as f32
                        };
                        (v as f32 / max).clamp(-1.0, 1.0)
                    })
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("WAV read error: {e}")),
            bits => Err(format!("Unsupported WAV bit depth: {bits}")),
        },
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .map(|s| s.map(|v| v.clamp(-1.0, 1.0)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("WAV read error: {e}")),
    }
}

fn mix_to_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

pub fn write_i16_wav_chunk(
    samples: &[i16],
    sample_rate: u32,
    channels: u16,
) -> Result<std::path::PathBuf, String> {
    let temp_file =
        NamedTempFile::with_suffix(".wav").map_err(|e| format!("Temp file error: {e}"))?;
    let temp_path = temp_file.path().to_path_buf();
    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let file = temp_file
        .persist(&temp_path)
        .map_err(|e| format!("Persist error: {e}"))?;
    let mut writer =
        WavWriter::new(BufWriter::new(file), spec).map_err(|e| format!("WAV error: {e}"))?;

    for sample in samples {
        writer
            .write_sample(*sample)
            .map_err(|e| format!("WAV write error: {e}"))?;
    }

    writer
        .finalize()
        .map_err(|e| format!("Finalize error: {e}"))?;
    Ok(temp_path)
}

fn bytes_per_frame(spec: WavSpec) -> Result<usize, String> {
    let bytes_per_sample = (spec.bits_per_sample as usize)
        .checked_add(7)
        .ok_or("Unsupported WAV bit depth.".to_string())?
        / 8;
    let channels = spec.channels.max(1) as usize;
    let bytes = bytes_per_sample
        .checked_mul(channels)
        .ok_or("WAV frame size overflow.".to_string())?;
    if bytes == 0 {
        return Err("Unsupported WAV frame size.".to_string());
    }
    Ok(bytes)
}

fn cloud_chunk_frame_plan(
    total_frames: usize,
    sample_rate: u32,
    bytes_per_frame: usize,
    target_bytes: u64,
    overlap_secs: f32,
) -> Result<Vec<(usize, usize)>, String> {
    if total_frames == 0 {
        return Ok(Vec::new());
    }
    if sample_rate == 0 {
        return Err("WAV sample rate is zero.".to_string());
    }

    let max_frames_by_size = (target_bytes as usize)
        .checked_div(bytes_per_frame)
        .unwrap_or(0)
        .max(1);
    let min_chunk_frames = sample_rate as usize;
    let chunk_frames = max_frames_by_size.max(min_chunk_frames);
    let overlap_frames =
        ((sample_rate as f32 * overlap_secs).round() as usize).min(chunk_frames.saturating_sub(1));
    let step_frames = chunk_frames.saturating_sub(overlap_frames).max(1);

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < total_frames {
        let end = start.saturating_add(chunk_frames).min(total_frames);
        chunks.push((start, end));
        if end == total_frames {
            break;
        }
        start = start.saturating_add(step_frames);
    }
    Ok(chunks)
}

pub fn split_wav_for_cloud(audio_path: &Path, max_bytes: u64) -> Result<Vec<PathBuf>, String> {
    let metadata = std::fs::metadata(audio_path)
        .map_err(|e| format!("Could not read recording before chunking: {e}"))?;
    if metadata.len() <= max_bytes {
        return Ok(vec![audio_path.to_path_buf()]);
    }

    let reader = WavReader::open(audio_path).map_err(|e| format!("WAV open error: {e}"))?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return Err("Recording has an invalid WAV format.".to_string());
    }

    let samples = read_wav_samples(reader)?;
    let channels = spec.channels as usize;
    if samples.is_empty() {
        return Err("Recording is empty. Try recording again.".to_string());
    }

    let total_frames = samples.len().div_ceil(channels);
    let plan = cloud_chunk_frame_plan(
        total_frames,
        spec.sample_rate,
        bytes_per_frame(spec)?,
        CLOUD_CHUNK_TARGET_BYTES.min(max_bytes).max(1),
        CLOUD_CHUNK_OVERLAP_SECS,
    )?;

    let mut chunk_paths = Vec::with_capacity(plan.len());
    for (start_frame, end_frame) in plan {
        let start_sample = start_frame.saturating_mul(channels);
        let end_sample = end_frame.saturating_mul(channels).min(samples.len());
        if start_sample >= end_sample {
            continue;
        }

        let chunk = samples[start_sample..end_sample]
            .iter()
            .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .collect::<Vec<_>>();
        let path = write_i16_wav_chunk(&chunk, spec.sample_rate, spec.channels)?;
        chunk_paths.push(path);
    }

    if chunk_paths.is_empty() {
        return Err("Recording could not be split for cloud transcription.".to_string());
    }

    Ok(chunk_paths)
}

fn write_samples_and_level(
    samples: &[i16],
    writer: &SharedWavWriter,
    live_chunker: &SharedLiveChunker,
    level: &SharedLevel,
) {
    let mut peak: f32 = 0.0;
    let mut sum_sq: f32 = 0.0;
    let mut count: usize = 0;

    if let Ok(mut guard) = writer.lock() {
        if let Some(ref mut wav_writer) = *guard {
            for &sample in samples {
                let normalized = sample as f32 / i16::MAX as f32;
                peak = peak.max(normalized.abs());
                sum_sq += normalized * normalized;
                count += 1;
                let _ = wav_writer.write_sample(sample);
            }
        }
    }

    if let Ok(mut guard) = live_chunker.lock() {
        if let Some(ref mut chunker) = *guard {
            chunker.push_samples(samples);
        }
    }

    let rms = if count > 0 {
        (sum_sq / count as f32).sqrt()
    } else {
        0.0
    };
    level.store(visual_level(rms, peak));
}

fn run_recording(
    cmd_rx: mpsc::Receiver<Command>,
    device_name: Option<&str>,
    level: Arc<SharedLevel>,
    live_chunk_sender: Option<LiveChunkSender>,
) -> Result<std::path::PathBuf, String> {
    let device = get_device(device_name)?;

    let supported_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get input config: {e}"))?;

    let sample_rate = supported_config.sample_rate().0;
    let channels = supported_config.channels();
    let sample_format = supported_config.sample_format();

    let temp_file =
        NamedTempFile::with_suffix(".wav").map_err(|e| format!("Temp file error: {e}"))?;
    let temp_path = temp_file.path().to_path_buf();

    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let file = temp_file
        .persist(&temp_path)
        .map_err(|e| format!("Persist error: {e}"))?;
    let wav_writer =
        WavWriter::new(BufWriter::new(file), spec).map_err(|e| format!("WAV error: {e}"))?;

    let writer = Arc::new(Mutex::new(Some(wav_writer)));
    let live_chunker = Arc::new(Mutex::new(
        live_chunk_sender.map(|sender| LiveChunker::new(sender, sample_rate, channels)),
    ));

    let err_fn = |err: cpal::StreamError| {
        eprintln!("Stream error: {err}");
    };

    let stream_config: cpal::StreamConfig = supported_config.into();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let writer_clone = Arc::clone(&writer);
            let live_clone = Arc::clone(&live_chunker);
            let lvl = Arc::clone(&level);
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let samples: Vec<i16> = data
                            .iter()
                            .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                            .collect();
                        write_samples_and_level(&samples, &writer_clone, &live_clone, &lvl);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Stream build error: {e}"))?
        }
        cpal::SampleFormat::I16 => {
            let writer_clone = Arc::clone(&writer);
            let live_clone = Arc::clone(&live_chunker);
            let lvl = Arc::clone(&level);
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        write_samples_and_level(data, &writer_clone, &live_clone, &lvl);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Stream build error: {e}"))?
        }
        cpal::SampleFormat::U16 => {
            let writer_clone = Arc::clone(&writer);
            let live_clone = Arc::clone(&live_chunker);
            let lvl = Arc::clone(&level);
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let samples: Vec<i16> = data
                            .iter()
                            .map(|sample| {
                                let normalized = (*sample as f32 / u16::MAX as f32) * 2.0 - 1.0;
                                (normalized * i16::MAX as f32) as i16
                            })
                            .collect();
                        write_samples_and_level(&samples, &writer_clone, &live_clone, &lvl);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Stream build error: {e}"))?
        }
        fmt => return Err(format!("Unsupported sample format: {fmt:?}")),
    };

    stream.play().map_err(|e| format!("Play error: {e}"))?;

    let _ = cmd_rx.recv();

    drop(stream);

    let mut guard = writer.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(w) = guard.take() {
        w.finalize().map_err(|e| format!("Finalize error: {e}"))?;
    }

    Ok(temp_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(frames: usize, sample_rate: u32, channels: u16) -> NamedTempFile {
        let file = NamedTempFile::with_suffix(".wav").unwrap();
        let spec = WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        {
            let mut writer = WavWriter::create(file.path(), spec).unwrap();
            for frame in 0..frames {
                for channel in 0..channels {
                    let sample = ((frame + channel as usize) % 512) as i16;
                    writer.write_sample(sample).unwrap();
                }
            }
            writer.finalize().unwrap();
        }
        file
    }

    #[test]
    fn cloud_chunk_plan_uses_overlap_between_chunks() {
        let chunks = cloud_chunk_frame_plan(250, 100, 2, 200, 0.25).unwrap();

        assert_eq!(chunks, vec![(0, 100), (75, 175), (150, 250)]);
    }

    #[test]
    fn cloud_chunk_plan_keeps_small_recording_single_chunk() {
        let chunks = cloud_chunk_frame_plan(90, 100, 2, 200, 0.25).unwrap();

        assert_eq!(chunks, vec![(0, 90)]);
    }

    #[test]
    fn split_wav_for_cloud_returns_original_when_under_limit() {
        let wav = write_test_wav(50, 100, 1);
        let paths = split_wav_for_cloud(wav.path(), 4096).unwrap();

        assert_eq!(paths, vec![wav.path().to_path_buf()]);
    }

    #[test]
    fn split_wav_for_cloud_writes_temp_chunks_for_oversized_recording() {
        let wav = write_test_wav(250, 100, 1);
        let paths = split_wav_for_cloud(wav.path(), 220).unwrap();

        assert!(paths.len() > 1);
        assert!(paths.iter().all(|path| path != wav.path()));
        let original_size = std::fs::metadata(wav.path()).unwrap().len();
        for path in paths {
            let metadata = std::fs::metadata(&path).unwrap();
            assert!(metadata.len() < original_size);
            std::fs::remove_file(path).unwrap();
        }
    }
}
