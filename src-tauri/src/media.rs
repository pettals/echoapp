use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

static DUCKED: AtomicBool = AtomicBool::new(false);
/// Stored original volume (0-100). Only meaningful when DUCKED is true.
static ORIGINAL_VOLUME: AtomicU8 = AtomicU8::new(0);

const DUCKED_VOLUME: u8 = 15;

/// Lowers the system output volume to DUCKED_VOLUME while recording.
/// Stores the original volume so resume_media can restore it.
pub fn pause_media() -> Result<(), String> {
    let current = get_system_volume()?;
    if current <= DUCKED_VOLUME {
        // Already quiet enough — don't duck or we'd raise volume on restore.
        DUCKED.store(false, Ordering::SeqCst);
        return Ok(());
    }
    ORIGINAL_VOLUME.store(current, Ordering::SeqCst);
    set_system_volume(DUCKED_VOLUME)?;
    DUCKED.store(true, Ordering::SeqCst);
    Ok(())
}

/// Restores the system output volume if we previously ducked it.
pub fn resume_media() -> Result<(), String> {
    if DUCKED.swap(false, Ordering::SeqCst) {
        let orig = ORIGINAL_VOLUME.load(Ordering::SeqCst);
        set_system_volume(orig)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// macOS: use osascript to read/write system volume
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn get_system_volume() -> Result<u8, String> {
    use std::process::Command;

    let output = Command::new("osascript")
        .arg("-e")
        .arg("output volume of (get volume settings)")
        .output()
        .map_err(|e| format!("osascript error: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("get volume failed: {err}"));
    }

    let vol_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    vol_str
        .parse::<u8>()
        .map_err(|e| format!("parse volume '{vol_str}': {e}"))
}

#[cfg(target_os = "macos")]
fn set_system_volume(vol: u8) -> Result<(), String> {
    use std::process::Command;

    let script = format!("set volume output volume {vol}");
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript error: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("set volume failed: {err}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Windows: no-op for now (user target is macOS)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn get_system_volume() -> Result<u8, String> {
    Ok(50)
}

#[cfg(target_os = "windows")]
fn set_system_volume(_vol: u8) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Other platforms: no-op
// ---------------------------------------------------------------------------

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn get_system_volume() -> Result<u8, String> {
    Ok(50)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn set_system_volume(_vol: u8) -> Result<(), String> {
    Ok(())
}
