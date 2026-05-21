use crate::{audio, config::AppConfig, secure, whisper};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ShortcutValidation {
    pub valid: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub message: String,
    pub action_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupStatus {
    pub ready: bool,
    pub checks: Vec<SetupCheck>,
}

fn check(
    id: &str,
    label: &str,
    status: &str,
    message: &str,
    action_label: Option<&str>,
) -> SetupCheck {
    SetupCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        message: message.to_string(),
        action_label: action_label.map(str::to_string),
    }
}

pub fn validate_shortcut(shortcut: &str) -> ShortcutValidation {
    let trimmed = shortcut.trim();
    if trimmed.is_empty() {
        return ShortcutValidation {
            valid: false,
            message: "Enter a shortcut such as CommandOrControl+Shift+Space.".to_string(),
        };
    }

    let parts: Vec<String> = trimmed
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();

    if parts.len() < 2 {
        return ShortcutValidation {
            valid: false,
            message: "Use at least one modifier plus one key.".to_string(),
        };
    }

    let modifiers = [
        "command",
        "cmd",
        "control",
        "ctrl",
        "commandorcontrol",
        "cmdorctrl",
        "shift",
        "alt",
        "option",
        "super",
        "meta",
    ];
    let has_modifier = parts[..parts.len() - 1]
        .iter()
        .any(|part| modifiers.contains(&part.as_str()));
    if !has_modifier {
        return ShortcutValidation {
            valid: false,
            message:
                "Shortcut must include a modifier such as CommandOrControl, Shift, Alt, or Control."
                    .to_string(),
        };
    }

    let key = parts.last().map(String::as_str).unwrap_or_default();
    let valid_key = key.len() == 1
        || matches!(
            key,
            "space"
                | "enter"
                | "return"
                | "tab"
                | "escape"
                | "esc"
                | "backspace"
                | "delete"
                | "insert"
                | "home"
                | "end"
                | "pageup"
                | "pagedown"
                | "up"
                | "down"
                | "left"
                | "right"
                | "f1"
                | "f2"
                | "f3"
                | "f4"
                | "f5"
                | "f6"
                | "f7"
                | "f8"
                | "f9"
                | "f10"
                | "f11"
                | "f12"
        );

    if !valid_key {
        return ShortcutValidation {
            valid: false,
            message: "Shortcut key is not recognized. Try CommandOrControl+Shift+Space."
                .to_string(),
        };
    }

    ShortcutValidation {
        valid: true,
        message: "Shortcut format looks valid.".to_string(),
    }
}

#[cfg(target_os = "macos")]
mod macos_accessibility {
    use core_foundation::base::{TCFType, CFTypeRef};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    }

    pub fn is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn request_prompt() -> bool {
        let prompt_key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let prompt_value = CFBoolean::true_value();
        let options =
            CFDictionary::from_CFType_pairs(&[(prompt_key.as_CFType(), prompt_value.as_CFType())]);
        unsafe { AXIsProcessTrustedWithOptions(options.as_CFTypeRef()) }
    }
}

#[cfg(target_os = "macos")]
pub fn is_accessibility_trusted() -> bool {
    macos_accessibility::is_trusted()
}

#[cfg(not(target_os = "macos"))]
pub fn is_accessibility_trusted() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn request_accessibility_permission() -> Result<bool, String> {
    let trusted = macos_accessibility::request_prompt();
    if !trusted {
        open_help("accessibility")?;
    }
    Ok(trusted)
}

#[cfg(not(target_os = "macos"))]
pub fn request_accessibility_permission() -> Result<bool, String> {
    Ok(true)
}

#[cfg(target_os = "macos")]
fn accessibility_check() -> SetupCheck {
    if is_accessibility_trusted() {
        check(
            "paste",
            "Paste permission",
            "ok",
            "Echo is trusted for Accessibility paste automation.",
            None,
        )
    } else {
        check(
            "paste",
            "Paste permission",
            "error",
            "Enable Echo in System Settings > Privacy & Security > Accessibility so auto-paste can work. Echo will copy to clipboard until this is allowed.",
            Some("Enable Accessibility"),
        )
    }
}

#[cfg(not(target_os = "macos"))]
fn accessibility_check() -> SetupCheck {
    check(
        "paste",
        "Paste readiness",
        "ok",
        "Echo will use the clipboard and Ctrl+V paste simulation on Windows, with copy fallback.",
        None,
    )
}

pub fn get_status(config: &AppConfig) -> SetupStatus {
    let mut checks = Vec::new();

    if config.model_provider == "api" {
        let key_available = !config.groq_api_key.trim().is_empty()
            || matches!(secure::get_groq_api_key(), Ok(Some(_)));
        checks.push(if key_available {
            check(
                "provider",
                "Provider",
                "ok",
                "Groq API key is configured in secure storage.",
                None,
            )
        } else {
            check(
                "provider",
                "Provider",
                "error",
                "Add a Groq API key or switch to a downloaded local Whisper model.",
                Some("Open Settings"),
            )
        });
    } else {
        let downloaded = whisper::is_model_downloaded(&config.local_model_size).unwrap_or(false);
        checks.push(if downloaded {
            check(
                "provider",
                "Provider",
                "ok",
                "Selected local Whisper model is downloaded.",
                None,
            )
        } else {
            check(
                "provider",
                "Provider",
                "error",
                "Download the selected local Whisper model before dictating offline.",
                Some("Open Settings"),
            )
        });
    }

    checks.push(match audio::list_devices() {
        Ok(devices) if !devices.is_empty() => check(
            "microphone",
            "Microphone",
            "ok",
            "At least one input device is available. Use Test Microphone before release QA.",
            None,
        ),
        Ok(_) => check(
            "microphone",
            "Microphone",
            "error",
            "No input device was found. Check system microphone permissions and device settings.",
            Some("Open Microphone"),
        ),
        Err(e) => check(
            "microphone",
            "Microphone",
            "warning",
            &format!("Could not inspect input devices: {e}"),
            Some("Open Microphone"),
        ),
    });

    let shortcut = validate_shortcut(&config.shortcut);
    checks.push(if shortcut.valid {
        check("shortcut", "Shortcut", "ok", &shortcut.message, None)
    } else {
        check(
            "shortcut",
            "Shortcut",
            "error",
            &shortcut.message,
            Some("Open Settings"),
        )
    });

    checks.push(accessibility_check());

    let ready = checks.iter().all(|item| item.status == "ok");
    SetupStatus { ready, checks }
}

pub fn open_help(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match target {
            "accessibility" | "paste" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security",
        };
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Open settings error: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let uri = match target {
            "microphone" => "ms-settings:privacy-microphone",
            _ => "ms-settings:privacy",
        };
        std::process::Command::new("cmd")
            .args(["/C", "start", "", uri])
            .spawn()
            .map_err(|e| format!("Open settings error: {e}"))?;
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = target;
        Ok(())
    }
}
