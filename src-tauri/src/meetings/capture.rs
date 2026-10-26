use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub file: String,
    pub sequence: i64,
    pub source: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
impl Chunk {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.source.as_str(), "microphone" | "computer")
            || self.sequence < 0
            || self.sequence > 100000
            || self.start_ms >= self.end_ms
            || self.end_ms > 14_430_000
            || self.end_ms - self.start_ms > 20000
        {
            return Err("Invalid recording segment".into());
        }
        let path = Path::new(&self.file);
        if path.components().count() != 1
            || !matches!(path.components().next(), Some(Component::Normal(_)))
            || self.file != format!("{}-{}.wav", self.source, self.sequence)
        {
            return Err("Invalid recording segment".into());
        }
        Ok(())
    }
    pub fn path(&self, directory: &Path) -> Result<PathBuf, String> {
        self.validate()?;
        let path = directory.join(&self.file);
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
            "A recording segment is missing. Recover the remaining transcript or discard it."
        })?;
        if !metadata.is_file() || metadata.len() > 700000 {
            return Err("Invalid recording segment".into());
        }
        Ok(path)
    }
    pub fn journal(&self, directory: &Path) -> PathBuf {
        directory.join(format!("{}.json", self.file))
    }
}
pub enum Event {
    Chunk(Chunk),
    Stopped(u64),
    Failed(String),
}
pub struct Capture {
    child: Child,
    pub input: Arc<Mutex<Option<ChildStdin>>>,
    events: mpsc::Receiver<Event>,
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.input.lock().unwrap_or_else(|e| e.into_inner()).take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub fn command(input: &Arc<Mutex<Option<ChildStdin>>>, command: &str) -> Result<(), String> {
    let mut input = input.lock().map_err(|_| "Meeting controls are busy")?;
    let input = input.as_mut().ok_or("Meeting recording has stopped")?;
    writeln!(input, "{}", serde_json::json!({"command":command}))
        .and_then(|_| input.flush())
        .map_err(|_| {
            "The recording stopped responding. Open Meetings to recover the saved transcript."
                .into()
        })
}
impl Capture {
    pub fn start(
        directory: &Path,
        mode: &str,
        status: impl Fn(Value) + Send + 'static,
    ) -> Result<Self, String> {
        let mut child =
            super::runtime::private_command(&super::runtime::helper_path("echo-capture")?)
                .spawn()
                .map_err(|_| "Could not start the meeting recorder")?;
        let mut input = child.stdin.take().ok_or("Meeting controls unavailable")?;
        let output = child
            .stdout
            .take()
            .ok_or("Meeting recorder output unavailable")?;
        writeln!(
            input,
            "{}",
            serde_json::json!({"directory":directory,"mode":mode})
        )
        .and_then(|_| input.flush())
        .map_err(|_| "Could not initialize the meeting recorder")?;
        let (events_send, events) = mpsc::channel();
        let (ready_send, ready) = mpsc::sync_channel(1);
        let directory = directory.to_path_buf();
        std::thread::spawn(move || {
            let mut ready_send = Some(ready_send);
            let mut reader = BufReader::new(output);
            let mut stopped = false;
            loop {
                let mut line = String::new();
                let Ok(n) = reader.by_ref().take(65536).read_line(&mut line) else {
                    break;
                };
                if n == 0 || !line.ends_with('\n') {
                    break;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                match value["kind"].as_str() {
                    Some("started") => {
                        if let Some(send) = ready_send.take() {
                            let _ = send.send(Ok(()));
                        }
                    }
                    Some("chunk") => {
                        match serde_json::from_value::<Chunk>(value) {
                            Ok(chunk) => {
                                if chunk.path(&directory).is_err() {
                                    let _=events_send.send(Event::Failed("A recording segment was invalid. Stop and recover this meeting.".into()));
                                    continue;
                                }
                                // Persist a recovery journal before scheduling any inference.
                                if write_journal(&chunk, &directory).is_err() {
                                    let _ = events_send.send(Event::Failed(
                                        "Could not save recording recovery data. Check disk space."
                                            .into(),
                                    ));
                                    continue;
                                }
                                if events_send.send(Event::Chunk(chunk)).is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    Some("stopped") => {
                        stopped = true;
                        let _ = events_send
                            .send(Event::Stopped(value["durationMs"].as_u64().unwrap_or(0)));
                        break;
                    }
                    Some("error") => {
                        status(value.clone());
                        let message=match value["code"].as_str(){Some("microphone_permission")=>"Allow Microphone access for Echo in system settings, then retry.",Some("computer_audio_permission")=>"Allow Screen & System Audio Recording for Echo in System Settings, then restart Echo. In-person mode needs only microphone access.",Some("recording_write_failed")=>"Recording could not be saved. Check disk space and recover the remaining transcript.",_=>"An audio device stopped or permission was denied. Stop and recover this meeting, then check your microphone and computer audio."}.to_string();
                        if let Some(send) = ready_send.take() {
                            let _ = send.send(Err(message.clone()));
                        }
                        let _ = events_send.send(Event::Failed(message));
                    }
                    _ => status(value),
                }
            }
            if !stopped {
                let _=events_send.send(Event::Failed("The recorder closed unexpectedly. Recover the remaining recording in Meetings.".into()));
            }
        });
        let result = ready
            .recv_timeout(Duration::from_secs(120))
            .map_err(|_| "Recording did not start. Check system permissions and retry.".to_string())
            .and_then(|r| r);
        if let Err(error) = result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(Self {
            child,
            input: Arc::new(Mutex::new(Some(input))),
            events,
        })
    }
    pub fn next(&self) -> Result<Event, String> {
        self.events.recv().map_err(|_| {
            "The meeting recorder closed. Recover the saved recording in Meetings.".into()
        })
    }
}

pub fn write_journal(chunk: &Chunk, directory: &Path) -> Result<(), String> {
    let path = chunk.journal(directory);
    if path.exists() {
        return Ok(());
    }
    let data = serde_json::to_vec(chunk).map_err(|_| "Could not encode recording journal")?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| "Could not save recording journal")?;
    temporary
        .write_all(&data)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "Could not save recording journal")?;
    temporary
        .persist(path)
        .map_err(|_| "Could not save recording journal")?;
    Ok(())
}
pub fn pending(directory: &Path) -> Result<Vec<Chunk>, String> {
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut chunks = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|_| "Could not read interrupted recording")? {
        let path = entry
            .map_err(|_| "Could not read interrupted recording")?
            .path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| "Could not read recording recovery data")?;
        if !metadata.is_file() || metadata.len() > 4096 {
            return Err("Recording recovery data was invalid".into());
        }
        let chunk: Chunk = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| "Could not read recording recovery data")?,
        )
        .map_err(|_| "Recording recovery data was invalid")?;
        chunk.validate()?;
        chunks.push(chunk);
    }
    for entry in
        std::fs::read_dir(directory).map_err(|_| "Could not inspect recording recovery data")?
    {
        let path = entry
            .map_err(|_| "Could not inspect recording recovery data")?
            .path();
        let extension = path.extension().and_then(|s| s.to_str());
        if !matches!(extension, Some("wav" | "json"))
            && path.file_name().and_then(|s| s.to_str()) != Some(".DS_Store")
        {
            return Err("An interrupted audio file is incomplete. Discard unprocessed audio to continue with the saved transcript.".into());
        }
        if path.extension().and_then(|s| s.to_str()) == Some("wav")
            && !path.with_extension("wav.json").exists()
        {
            return Err("An interrupted audio segment has no recovery timing. Discard the unprocessed audio to continue with the saved transcript.".into());
        }
    }
    chunks.sort_by_key(|c| (c.start_ms, c.sequence));
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journals_only_private_bounded_recordings() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("microphone-0.wav"), b"wav").unwrap();
        let mut chunk = Chunk {
            file: "microphone-0.wav".into(),
            sequence: 0,
            source: "microphone".into(),
            start_ms: 0,
            end_ms: 15000,
        };
        write_journal(&chunk, root.path()).unwrap();
        assert_eq!(pending(root.path()).unwrap().len(), 1);
        chunk.file = "../other.wav".into();
        assert!(chunk.path(root.path()).is_err());
        chunk.file = "microphone-0.wav".into();
        chunk.end_ms = 99999999;
        assert!(chunk.path(root.path()).is_err());
    }
}
