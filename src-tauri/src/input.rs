#[cfg(not(target_os = "macos"))]
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::process::Command;
use std::time::Duration;

/// Writes text to the system clipboard using platform-native methods.
pub fn write_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("pbcopy spawn error: {e}"))?;

        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("pbcopy write error: {e}"))?;
            drop(stdin);
        }
        child.wait().map_err(|e| format!("pbcopy wait error: {e}"))?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let mut child = Command::new("clip")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("clip spawn error: {e}"))?;

        use std::io::Write;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("clip write error: {e}"))?;
            drop(stdin);
        }
        child.wait().map_err(|e| format!("clip wait error: {e}"))?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Clipboard not supported on this platform".to_string())
    }
}

/// Simulates Cmd+V (macOS) or Ctrl+V (Windows) to paste clipboard contents.
pub fn simulate_paste() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .arg("-e")
            .arg("tell application \"System Events\" to keystroke \"v\" using command down")
            .output()
            .map_err(|e| format!("osascript launch error: {e}"))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("osascript paste failed: {err}"));
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut enigo =
            Enigo::new(&Settings::default()).map_err(|e| format!("Enigo init error: {e}"))?;

        enigo
            .key(Key::Control, Direction::Press)
            .map_err(|e| format!("Key error: {e}"))?;
        enigo
            .key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| format!("Key error: {e}"))?;
        enigo
            .key(Key::Control, Direction::Release)
            .map_err(|e| format!("Key error: {e}"))?;
        Ok(())
    }
}
