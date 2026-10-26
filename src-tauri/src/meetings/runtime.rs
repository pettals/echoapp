use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

pub const MODEL_ID: &str = "qwen-3.5-4b-notes";
pub static MODEL_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static PROCESS_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
pub fn shutdown() {
    let pid = PROCESS_ID.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        let mut command = Command::new(root.join("System32/taskkill.exe"));
        use std::os::windows::process::CommandExt;
        let _ = command
            .creation_flags(0x08000000)
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
}
pub fn manifest() -> &'static crate::local_models::BarkManifest {
    static MANIFEST: std::sync::OnceLock<crate::local_models::BarkManifest> =
        std::sync::OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../notes-manifest.json"))
            .expect("verified notes manifest")
    })
}
pub fn model_directory() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(path) = std::env::var_os("ECHO_TEST_NOTES_DIRECTORY") {
        return Ok(PathBuf::from(path));
    }
    Ok(crate::config::AppConfig::models_dir()?.join(MODEL_ID))
}
pub fn model_path() -> Result<PathBuf, String> {
    Ok(model_directory()?.join(&manifest().files[0].path))
}

pub fn helper_path(name: &str) -> Result<PathBuf, String> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let sibling = std::env::current_exe()
        .map_err(|_| "Cannot find Echo's native tools")?
        .parent()
        .ok_or("Cannot find Echo's native tools")?
        .join(format!("{name}{extension}"));
    if sibling.is_file() {
        return Ok(sibling);
    }
    #[cfg(debug_assertions)]
    {
        let target = if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "aarch64-apple-darwin"
            } else {
                "x86_64-apple-darwin"
            }
        } else {
            "x86_64-pc-windows-msvc"
        };
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("binaries/{name}-{target}{extension}"));
        if dev.is_file() {
            return Ok(dev);
        }
    }
    Err("A native Meetings component is missing. Reinstall Echo.".into())
}

pub fn private_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

pub struct Runtime {
    child: Child,
    input: ChildStdin,
    responses: mpsc::Receiver<Value>,
    sequence: u64,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = PROCESS_ID.compare_exchange(self.child.id(), 0, Ordering::SeqCst, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Runtime {
    pub fn start() -> Result<Self, String> {
        crate::model_download::inspect_model_files(&model_directory()?, &manifest().files, true)
            .map_err(|_| "Download or verify the local notes model before generating notes")?;
        let child = private_command(&helper_path("echo-notes")?)
            .spawn()
            .map_err(|_| "Could not start the local notes runtime")?;
        let runtime = Self::from_child(child)?;
        PROCESS_ID.store(runtime.child.id(), Ordering::SeqCst);
        Ok(runtime)
    }
    fn from_child(mut child: Child) -> Result<Self, String> {
        let input = child
            .stdin
            .take()
            .ok_or("Notes runtime input unavailable")?;
        let output = child
            .stdout
            .take()
            .ok_or("Notes runtime output unavailable")?;
        let (send, responses) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = String::new();
                let Ok(n) = reader.by_ref().take(2 * 1024 * 1024).read_line(&mut line) else {
                    break;
                };
                if n == 0 || !line.ends_with('\n') {
                    break;
                }
                let Ok(value) = serde_json::from_str(&line) else {
                    break;
                };
                if send.send(value).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input,
            responses,
            sequence: 0,
        })
    }
    pub fn generate(
        &mut self,
        system: &str,
        input: &str,
        schema: &Value,
        cancel: &AtomicBool,
    ) -> Result<Value, String> {
        self.sequence += 1;
        let request = serde_json::json!({"id":self.sequence,"modelPath":model_path()?,"system":system,"input":input,"schema":schema,"maxTokens":3072});
        writeln!(self.input, "{request}")
            .and_then(|_| self.input.flush())
            .map_err(|_| "Local notes runtime stopped. Retry notes from the saved transcript.")?;
        let start = Instant::now();
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("Note generation cancelled".into());
            }
            if start.elapsed() > Duration::from_secs(1800) {
                return Err("Local notes took too long. Retry, or explicitly choose a provider in Meetings settings.".into());
            }
            match self.responses.recv_timeout(Duration::from_millis(100)) {
                Ok(response) => {
                    if response["id"].as_u64() != Some(self.sequence) {
                        return Err("Invalid local notes response. Retry notes.".into());
                    }
                    match response["kind"].as_str(){Some("preparing")=>{},Some("result")=>return response.get("notes").cloned().ok_or("Local notes response was empty".into()),_=>return Err(match response["phase"].as_str(){Some("context_limit")=>"Section notes exceeded the local context limit. The complete transcript is saved.",Some("output_limit")=>"The local model needed more space for its notes. The complete transcript is saved; retry notes.",Some("prompt_inference")=>"The local model could not read this section. Close other memory-heavy apps and retry notes.",_=>"Local notes could not finish. Your transcript is saved. Retry or check available memory."}.into())}
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => {
                    return Err(
                        "The local notes runtime closed. Your transcript is saved; retry notes."
                            .into(),
                    )
                }
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn fake(script: &str) -> Runtime {
        let child = Command::new("/bin/sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        Runtime::from_child(child).unwrap()
    }
    #[test]
    fn helper_failures_and_wrong_request_ids_are_recoverable() {
        for script in [
            "read line; printf '%s\\n' '{\"id\":1,\"kind\":\"error\"}'",
            "read line; printf '%s\\n' '{\"id\":99,\"kind\":\"result\",\"notes\":{}}'",
            "read line; echo malformed",
        ] {
            assert!(fake(script)
                .generate("s", "i", &serde_json::json!({}), &AtomicBool::new(false))
                .is_err());
        }
    }
    #[test]
    fn cancelled_helper_is_killed_without_waiting_for_inference() {
        let start = Instant::now();
        assert!(fake("read line; sleep 30")
            .generate("s", "i", &serde_json::json!({}), &AtomicBool::new(true))
            .is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn notes_artifact_is_pinned_and_never_a_transcription_selection() {
        let manifest = manifest();
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].size, 2740937888);
        assert_eq!(manifest.revision.len(), 40);
        assert_eq!(manifest.files[0].sha256.len(), 64);
        assert!(!crate::local_models::known(MODEL_ID));
        assert_eq!(manifest.files[0].path, "Qwen3.5-4B-Q4_K_M.gguf");
    }
}
