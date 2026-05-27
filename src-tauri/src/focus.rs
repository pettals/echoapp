#[cfg(target_os = "macos")]
mod macos {
    use std::process::Command;

    /// Returns the bundle identifier of the frontmost application (e.g. "com.apple.Notes").
    /// Filters out invalid/placeholder values that osascript can return.
    pub fn capture_frontmost_app() -> Option<String> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg("tell application \"System Events\" to get bundle identifier of first application process whose frontmost is true")
            .output()
            .ok()?;

        if output.status.success() {
            let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if id.is_empty() || id == "missing value" || !id.contains('.') {
                None
            } else {
                Some(id)
            }
        } else {
            None
        }
    }

    /// Activates the application with the given bundle identifier.
    pub fn activate_app(bundle_id: &str) -> Result<(), String> {
        let script = format!("tell application id \"{}\" to activate", bundle_id);
        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("osascript launch error: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(format!("Failed to activate {bundle_id}: {err}"))
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::ptr;

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
        fn SetForegroundWindow(hwnd: *mut std::ffi::c_void) -> i32;
        fn ShowWindow(hwnd: *mut std::ffi::c_void, cmd: i32) -> i32;
    }

    const SW_RESTORE: i32 = 9;

    pub fn capture_foreground_window() -> Option<usize> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            None
        } else {
            Some(hwnd as usize)
        }
    }

    pub fn restore_foreground_window(hwnd: usize) -> Result<(), String> {
        let handle = hwnd as *mut std::ffi::c_void;
        if handle.is_null() {
            return Err("Null window handle".to_string());
        }
        unsafe {
            ShowWindow(handle, SW_RESTORE);
            let result = SetForegroundWindow(handle);
            if result == 0 {
                Err("SetForegroundWindow failed".to_string())
            } else {
                Ok(())
            }
        }
    }
}

/// Opaque handle representing the previously focused app/window.
#[derive(Clone, Debug)]
pub enum FocusTarget {
    #[cfg(target_os = "macos")]
    MacApp(String),
    #[cfg(target_os = "windows")]
    WinHwnd(usize),
    None,
}

impl FocusTarget {
    /// Captures the currently focused application/window.
    pub fn capture() -> Self {
        #[cfg(target_os = "macos")]
        {
            if let Some(bundle_id) = macos::capture_frontmost_app() {
                return FocusTarget::MacApp(bundle_id);
            }
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(hwnd) = windows::capture_foreground_window() {
                return FocusTarget::WinHwnd(hwnd);
            }
        }
        FocusTarget::None
    }

    /// Restores focus to the captured target.
    pub fn restore(&self) -> Result<(), String> {
        match self {
            #[cfg(target_os = "macos")]
            FocusTarget::MacApp(bundle_id) => macos::activate_app(bundle_id),
            #[cfg(target_os = "windows")]
            FocusTarget::WinHwnd(hwnd) => windows::restore_foreground_window(*hwnd),
            FocusTarget::None => Err("No focus target captured".to_string()),
        }
    }

    /// Returns true if this target points to our own app.
    pub fn is_self_app(&self) -> bool {
        match self {
            #[cfg(target_os = "macos")]
            FocusTarget::MacApp(id) => id == "com.andrewjohn.echo",
            #[cfg(target_os = "windows")]
            FocusTarget::WinHwnd(_) => false,
            FocusTarget::None => false,
        }
    }

    /// Returns true if we have a valid external paste target.
    pub fn has_target(&self) -> bool {
        !matches!(self, FocusTarget::None)
    }
}
