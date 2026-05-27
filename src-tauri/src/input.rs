use std::process::Command;
use std::time::Duration;

#[cfg(not(target_os = "macos"))]
use enigo::{Direction, Enigo, Key, Keyboard, Settings};

#[cfg(target_os = "macos")]
mod macos_paste {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use std::time::Duration;

    pub fn simulate_cmd_v() -> Result<(), String> {
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| "Could not create CoreGraphics event source".to_string())?;

        let command_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::COMMAND, true)
            .map_err(|_| "Could not create Command keydown event".to_string())?;
        command_down.set_flags(CGEventFlags::CGEventFlagCommand);

        let v_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
            .map_err(|_| "Could not create V keydown event".to_string())?;
        v_down.set_flags(CGEventFlags::CGEventFlagCommand);

        let v_up = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, false)
            .map_err(|_| "Could not create V keyup event".to_string())?;
        v_up.set_flags(CGEventFlags::CGEventFlagCommand);

        let command_up = CGEvent::new_keyboard_event(source, KeyCode::COMMAND, false)
            .map_err(|_| "Could not create Command keyup event".to_string())?;

        command_down.post(CGEventTapLocation::HID);
        std::thread::sleep(Duration::from_millis(20));
        v_down.post(CGEventTapLocation::HID);
        std::thread::sleep(Duration::from_millis(20));
        v_up.post(CGEventTapLocation::HID);
        std::thread::sleep(Duration::from_millis(20));
        command_up.post(CGEventTapLocation::HID);

        Ok(())
    }
}

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
        child
            .wait()
            .map_err(|e| format!("pbcopy wait error: {e}"))?;
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
        macos_paste::simulate_cmd_v()?;
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
    }

    Ok(())
}
