#[cfg(target_os = "macos")]
mod macos {
    use std::path::{Path, PathBuf};
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

    pub fn app_name(bundle_id: &str) -> Option<String> {
        let script = format!(
            "tell application \"System Events\" to get name of first application process whose bundle identifier is \"{}\"",
            bundle_id
        );
        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .ok()?;

        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        } else {
            None
        }
    }

    fn app_path(bundle_id: &str) -> Option<PathBuf> {
        let script = format!("POSIX path of (path to application id \"{}\")", bundle_id);
        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .ok()?;

        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(PathBuf::from(path))
            }
        } else {
            None
        }
    }

    fn icon_file_from_info_plist(app_path: &Path) -> Option<PathBuf> {
        let info_plist = app_path.join("Contents/Info.plist");
        let output = Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print :CFBundleIconFile"])
            .arg(&info_plist)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let mut icon_file = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if icon_file.is_empty() {
            return None;
        }
        if !icon_file.ends_with(".icns") {
            icon_file.push_str(".icns");
        }

        let icon_path = app_path.join("Contents/Resources").join(icon_file);
        if icon_path.exists() {
            Some(icon_path)
        } else {
            None
        }
    }

    pub fn icon_data_url(bundle_id: &str) -> Option<String> {
        let app_path = app_path(bundle_id)?;
        let icon_path = icon_file_from_info_plist(&app_path)?;
        let mut png_path = std::env::temp_dir();
        png_path.push(format!(
            "echo-target-icon-{}-{}.png",
            std::process::id(),
            bundle_id.replace('.', "-")
        ));

        let status = Command::new("sips")
            .args(["-s", "format", "png", "--resampleHeightWidthMax", "64"])
            .arg(&icon_path)
            .arg("--out")
            .arg(&png_path)
            .status()
            .ok()?;

        if !status.success() {
            let _ = std::fs::remove_file(&png_path);
            return None;
        }

        let output = Command::new("base64")
            .arg("-i")
            .arg(&png_path)
            .output()
            .ok()?;
        let _ = std::fs::remove_file(&png_path);
        if !output.status.success() {
            return None;
        }

        let encoded = String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .collect::<String>();
        if encoded.is_empty() {
            None
        } else {
            Some(format!("data:image/png;base64,{encoded}"))
        }
    }
}

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTargetInfo {
    pub bundle_id: Option<String>,
    pub name: Option<String>,
    pub icon_data_url: Option<String>,
}

#[cfg(target_os = "windows")]
mod windows {
    use std::ptr;

    #[derive(Clone, Debug)]
    pub struct WindowTarget {
        pub hwnd: usize,
        pub process_id: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut std::ffi::c_void;
        fn GetWindowThreadProcessId(hwnd: *mut std::ffi::c_void, process_id: *mut u32) -> u32;
        fn GetCurrentThreadId() -> u32;
        fn AttachThreadInput(id_attach: u32, id_attach_to: u32, attach: i32) -> i32;
        fn SetForegroundWindow(hwnd: *mut std::ffi::c_void) -> i32;
        fn BringWindowToTop(hwnd: *mut std::ffi::c_void) -> i32;
        fn IsIconic(hwnd: *mut std::ffi::c_void) -> i32;
        fn ShowWindow(hwnd: *mut std::ffi::c_void, cmd: i32) -> i32;
    }

    const SW_RESTORE: i32 = 9;
    const SW_SHOW: i32 = 5;

    pub fn capture_foreground_window() -> Option<WindowTarget> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return None;
        }

        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut process_id);
        }

        Some(WindowTarget {
            hwnd: hwnd as usize,
            process_id,
        })
    }

    pub fn restore_foreground_window(target: &WindowTarget) -> Result<(), String> {
        let hwnd = target.hwnd;
        let handle = hwnd as *mut std::ffi::c_void;
        if handle.is_null() {
            return Err("Null window handle".to_string());
        }

        unsafe {
            if IsIconic(handle) != 0 {
                ShowWindow(handle, SW_RESTORE);
            } else {
                ShowWindow(handle, SW_SHOW);
            }

            let current_thread = GetCurrentThreadId();
            let target_thread = GetWindowThreadProcessId(handle, ptr::null_mut());
            let attached = target_thread != 0
                && current_thread != target_thread
                && AttachThreadInput(current_thread, target_thread, 1) != 0;

            BringWindowToTop(handle);
            let result = SetForegroundWindow(handle);

            if attached {
                AttachThreadInput(current_thread, target_thread, 0);
            }

            if result == 0 {
                Err("SetForegroundWindow failed".to_string())
            } else {
                Ok(())
            }
        }
    }

    pub fn is_current_process(target: &WindowTarget) -> bool {
        target.process_id == std::process::id()
    }
}

/// Opaque handle representing the previously focused app/window.
#[derive(Clone, Debug)]
pub enum FocusTarget {
    #[cfg(target_os = "macos")]
    MacApp(String),
    #[cfg(target_os = "windows")]
    WinWindow(windows::WindowTarget),
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
            if let Some(target) = windows::capture_foreground_window() {
                return FocusTarget::WinWindow(target);
            }
        }
        FocusTarget::None
    }

    pub fn capture_with_info() -> (Self, Option<FocusTargetInfo>) {
        let target = Self::capture();
        let info = target.info();
        (target, info)
    }

    pub fn info(&self) -> Option<FocusTargetInfo> {
        match self {
            #[cfg(target_os = "macos")]
            FocusTarget::MacApp(bundle_id) => Some(FocusTargetInfo {
                bundle_id: Some(bundle_id.clone()),
                name: macos::app_name(bundle_id),
                icon_data_url: macos::icon_data_url(bundle_id),
            }),
            #[cfg(target_os = "windows")]
            FocusTarget::WinWindow(_) => Some(FocusTargetInfo {
                bundle_id: None,
                name: None,
                icon_data_url: None,
            }),
            FocusTarget::None => None,
        }
    }

    /// Restores focus to the captured target.
    pub fn restore(&self) -> Result<(), String> {
        match self {
            #[cfg(target_os = "macos")]
            FocusTarget::MacApp(bundle_id) => macos::activate_app(bundle_id),
            #[cfg(target_os = "windows")]
            FocusTarget::WinWindow(target) => windows::restore_foreground_window(target),
            FocusTarget::None => Err("No focus target captured".to_string()),
        }
    }

    /// Returns true if this target points to our own app.
    pub fn is_self_app(&self) -> bool {
        match self {
            #[cfg(target_os = "macos")]
            FocusTarget::MacApp(id) => id == "com.andrewjohn.echo",
            #[cfg(target_os = "windows")]
            FocusTarget::WinWindow(target) => windows::is_current_process(target),
            FocusTarget::None => false,
        }
    }

    /// Returns true if we have a valid external paste target.
    pub fn has_target(&self) -> bool {
        !matches!(self, FocusTarget::None)
    }
}
