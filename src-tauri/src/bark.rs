use crate::{
    app_error::AppError,
    local_models,
    whisper::{LocalTranscriptionMetrics, LocalTranscriptionResult},
};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: u64,
    kind: String,
    text: Option<String>,
    code: Option<String>,
    model_cache_hit: Option<bool>,
    model_load_ms: Option<u64>,
    inference_ms: Option<u64>,
}

struct Runtime {
    child: Child,
    input: ChildStdin,
    responses: mpsc::Receiver<Response>,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        PROCESS_ID.store(0, Ordering::SeqCst);
    }
}

static RUNTIME: Mutex<Option<Runtime>> = Mutex::new(None);
static PROCESS_ID: AtomicU32 = AtomicU32::new(0);

fn error(code: &str) -> AppError {
    AppError::new(code, match code {
        "bark_helper_missing" => "The Bark runtime is missing from Echo. Reinstall Echo, or choose Whisper in Settings.",
        "bark_timeout" => "Bark took too long to prepare or transcribe. Try again, or choose Whisper in Settings.",
        "bark_protocol_failed" => "The Bark runtime stopped responding. Try again, or choose Whisper in Settings.",
        _ => "Bark could not transcribe this recording. Try again; if this continues, verify the model or choose Whisper in Settings.",
    }, true, Some("Open Settings"))
}

pub fn helper_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let bundled = executable.parent()?.join("echo-bark");
    if bundled.is_file() {
        return Some(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let target = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x86_64"
        };
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("binaries/echo-bark-{target}-apple-darwin"));
        if dev.is_file() {
            return Some(dev);
        }
    }
    None
}

impl Runtime {
    fn start() -> Result<Self, AppError> {
        let binary = helper_path().ok_or_else(|| error("bark_helper_missing"))?;
        let child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| error("bark_helper_missing"))?;
        Self::from_child(child)
    }

    fn from_child(mut child: Child) -> Result<Self, AppError> {
        let input = child
            .stdin
            .take()
            .ok_or_else(|| error("bark_protocol_failed"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| error("bark_protocol_failed"))?;
        let (send, responses) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                // Limit protocol frames to 8 MiB, including for long recordings.
                let Ok(count) = reader.by_ref().take(8 * 1024 * 1024).read_line(&mut line) else {
                    break;
                };
                if count == 0 || !line.ends_with('\n') {
                    break;
                }
                let Ok(response) = serde_json::from_str(&line) else {
                    break;
                };
                if send.send(response).is_err() {
                    break;
                }
            }
        });
        PROCESS_ID.store(child.id(), Ordering::SeqCst);
        Ok(Self {
            child,
            input,
            responses,
        })
    }

    fn request(
        &mut self,
        path: &Path,
        directory: &Path,
        preparing: impl Fn(),
        timeout: Duration,
    ) -> Result<LocalTranscriptionResult, AppError> {
        let request = serde_json::json!({"id": 1, "modelDirectory": directory, "audioPath": path});
        writeln!(self.input, "{request}")
            .and_then(|_| self.input.flush())
            .map_err(|_| error("bark_protocol_failed"))?;
        // Core ML's first ANE specialization can take a minute. Bound the entire request.
        let deadline = Instant::now() + timeout;
        loop {
            let response = self
                .responses
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|failure| {
                    error(if matches!(failure, mpsc::RecvTimeoutError::Timeout) {
                        "bark_timeout"
                    } else {
                        "bark_protocol_failed"
                    })
                })?;
            if response.id != 1 {
                return Err(error("bark_protocol_failed"));
            }
            match response.kind.as_str() {
                "preparing" => preparing(),
                "result" => {
                    let text = response.text.ok_or_else(|| error("bark_protocol_failed"))?;
                    if text.trim().is_empty() {
                        return Err(AppError::empty_speech());
                    }
                    return Ok(LocalTranscriptionResult {
                        text,
                        metrics: LocalTranscriptionMetrics {
                            model_size: local_models::BARK_ID.to_string(),
                            model_cache_hit: response.model_cache_hit.unwrap_or(false),
                            model_load_ms: response.model_load_ms.unwrap_or(0),
                            audio_decode_ms: 0,
                            inference_ms: response.inference_ms.unwrap_or(0),
                            thread_count: 0,
                        },
                    });
                }
                "error" => {
                    return Err(error(match response.code.as_deref() {
                        Some("bark_unsupported_platform") => "local_model_unsupported",
                        _ => "bark_transcription_failed",
                    }))
                }
                _ => return Err(error("bark_protocol_failed")),
            }
        }
    }
}

pub fn release() {
    RUNTIME
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
}

pub fn shutdown() {
    // Interrupt an in-flight request before taking the runtime mutex on app exit.
    let pid = PROCESS_ID.swap(0, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    if pid != 0 {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pid;
    release();
}

pub fn transcribe(path: &Path, preparing: impl Fn()) -> Result<LocalTranscriptionResult, AppError> {
    let mut runtime = RUNTIME.lock().unwrap_or_else(|error| error.into_inner());
    let directory =
        local_models::bark_directory().map_err(|_| error("bark_transcription_failed"))?;
    if runtime.is_none() {
        // Recheck all hashes before loading bytes into Core ML, even after an app restart.
        crate::model_download::verify_bark_directory(&directory)?;
        *runtime = Some(Runtime::start()?);
    }
    let result = runtime
        .as_mut()
        .ok_or_else(|| error("bark_protocol_failed"))?
        .request(path, &directory, preparing, Duration::from_secs(300));
    if result
        .as_ref()
        .is_err_and(|error| error.code != "empty_speech")
    {
        runtime.take();
    }
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn fake_runtime(script: &str) -> Runtime {
        let child = Command::new("/bin/sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Runtime::from_child(child).unwrap()
    }

    #[test]
    fn protocol_passes_preparation_and_cache_metrics() {
        let mut runtime = fake_runtime(
            r#"read request
printf '%s\n' '{"id":1,"kind":"preparing"}' '{"id":1,"kind":"result","text":"Synthetic fixture.","modelCacheHit":true,"modelLoadMs":0,"inferenceMs":12}'
"#,
        );
        let preparing = AtomicBool::new(false);
        let result = runtime
            .request(
                Path::new("fixture.wav"),
                Path::new("models"),
                || preparing.store(true, Ordering::SeqCst),
                Duration::from_secs(2),
            )
            .unwrap();
        assert!(preparing.load(Ordering::SeqCst));
        assert_eq!(result.text, "Synthetic fixture.");
        assert!(result.metrics.model_cache_hit);
        assert_eq!(result.metrics.inference_ms, 12);
    }

    #[test]
    fn crashes_and_malformed_replies_are_recoverable() {
        for script in [
            "read request; exit 1",
            "read request; printf 'not json\\n'",
            r#"read request; printf '%s\n' '{"id":2,"kind":"result","text":"Wrong request"}'"#,
        ] {
            let mut runtime = fake_runtime(script);
            let failure = runtime
                .request(
                    Path::new("fixture.wav"),
                    Path::new("models"),
                    || {},
                    Duration::from_secs(2),
                )
                .unwrap_err();
            assert_eq!(failure.code, "bark_protocol_failed");
            assert!(failure.retryable);
        }
    }

    #[test]
    fn unresponsive_helper_has_a_bounded_timeout() {
        let mut runtime = fake_runtime("read request; read another_request");
        let failure = runtime
            .request(
                Path::new("fixture.wav"),
                Path::new("models"),
                || {},
                Duration::from_millis(20),
            )
            .unwrap_err();
        assert_eq!(failure.code, "bark_timeout");
    }
}
