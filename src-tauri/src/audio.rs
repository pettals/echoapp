use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::io::BufWriter;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tempfile::NamedTempFile;

enum Command {
    Stop,
}

pub struct RecorderHandle {
    cmd_tx: Option<mpsc::Sender<Command>>,
    result_rx: Option<mpsc::Receiver<Result<std::path::PathBuf, String>>>,
    recording: bool,
}

impl RecorderHandle {
    pub fn new() -> Self {
        Self {
            cmd_tx: None,
            result_rx: None,
            recording: false,
        }
    }

    pub fn start(&mut self, device_name: Option<&str>) -> Result<(), String> {
        if self.recording {
            return Err("Already recording".to_string());
        }

        let device_name_owned = device_name.map(|s| s.to_string());
        let (cmd_tx, cmd_rx) = mpsc::channel::<Command>();
        let (result_tx, result_rx) = mpsc::channel::<Result<std::path::PathBuf, String>>();

        thread::spawn(move || {
            let result = run_recording(cmd_rx, device_name_owned.as_deref());
            let _ = result_tx.send(result);
        });

        self.cmd_tx = Some(cmd_tx);
        self.result_rx = Some(result_rx);
        self.recording = true;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<std::path::PathBuf, String> {
        if !self.recording {
            return Err("Not recording".to_string());
        }

        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Command::Stop);
        }

        let result = self
            .result_rx
            .take()
            .ok_or("No result channel")?
            .recv()
            .map_err(|e| format!("Recv error: {e}"))?;

        self.recording = false;
        result
    }

    pub fn is_recording(&self) -> bool {
        self.recording
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

    host.default_input_device()
        .ok_or("No input device available. Check System Settings > Privacy & Security > Microphone.".to_string())
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

fn run_recording(
    cmd_rx: mpsc::Receiver<Command>,
    device_name: Option<&str>,
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

    // Write all channels so the WAV is valid; Whisper handles multi-channel fine
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
    let writer_clone = Arc::clone(&writer);

    let err_fn = |err: cpal::StreamError| {
        eprintln!("Stream error: {err}");
    };

    let stream_config: cpal::StreamConfig = supported_config.into();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut guard) = writer_clone.lock() {
                        if let Some(ref mut w) = *guard {
                            for &sample in data.iter() {
                                let s = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
                                let _ = w.write_sample(s);
                            }
                        }
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Stream build error: {e}"))?,
        cpal::SampleFormat::I16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut guard) = writer_clone.lock() {
                        if let Some(ref mut w) = *guard {
                            for &sample in data.iter() {
                                let _ = w.write_sample(sample);
                            }
                        }
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Stream build error: {e}"))?,
        cpal::SampleFormat::U16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut guard) = writer_clone.lock() {
                        if let Some(ref mut w) = *guard {
                            for &sample in data.iter() {
                                let normalized = (sample as f32 / u16::MAX as f32) * 2.0 - 1.0;
                                let s = (normalized * i16::MAX as f32) as i16;
                                let _ = w.write_sample(s);
                            }
                        }
                    }
                },
                err_fn,
                None,
            )
            .map_err(|e| format!("Stream build error: {e}"))?,
        fmt => return Err(format!("Unsupported sample format: {fmt:?}")),
    };

    stream.play().map_err(|e| format!("Play error: {e}"))?;

    // Block until stop command
    let _ = cmd_rx.recv();

    drop(stream);

    let mut guard = writer.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(w) = guard.take() {
        w.finalize().map_err(|e| format!("Finalize error: {e}"))?;
    }

    Ok(temp_path)
}
