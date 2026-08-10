use crate::{audio, config::AppConfig, model_download, secure};
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
            message: "Press any key or key combo for the shortcut.".to_string(),
        };
    }

    let parts: Vec<String> = trimmed
        .split('+')
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .collect();

    if parts.is_empty() {
        return ShortcutValidation {
            valid: false,
            message: "Press any key or key combo for the shortcut.".to_string(),
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

    let mut seen = std::collections::HashSet::new();
    if parts.iter().any(|part| !seen.insert(part.as_str())) {
        return ShortcutValidation {
            valid: false,
            message: "Shortcut contains duplicate keys. Press the shortcut again.".to_string(),
        };
    }

    let prefix_has_only_modifiers = parts[..parts.len().saturating_sub(1)]
        .iter()
        .all(|part| modifiers.contains(&part.as_str()));
    if !prefix_has_only_modifiers {
        return ShortcutValidation {
            valid: false,
            message: "Shortcut format is not recognized. Press one key or a modifier combo."
                .to_string(),
        };
    }

    let key = parts.last().map(String::as_str).unwrap_or_default();
    if modifiers.contains(&key) {
        return ShortcutValidation {
            valid: false,
            message: "Choose a final key, not only modifier keys.".to_string(),
        };
    }

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
                | "f13"
                | "f14"
                | "f15"
                | "f16"
                | "f17"
                | "f18"
                | "f19"
                | "f20"
                | "f21"
                | "f22"
                | "f23"
                | "f24"
        );

    if !valid_key {
        return ShortcutValidation {
            valid: false,
            message: "Shortcut key is not recognized. Try another key or key combo.".to_string(),
        };
    }

    ShortcutValidation {
        valid: true,
        message: "Shortcut format looks valid. If the system rejects it, choose another key."
            .to_string(),
    }
}

#[cfg(target_os = "macos")]
mod macos_accessibility {
    use core_foundation::base::{CFTypeRef, TCFType};
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

pub fn get_status_with_credential_error(config: &AppConfig, credential_error: &str) -> SetupStatus {
    get_status_inner(config, Some(credential_error))
}

pub fn get_status_with_provider_error(config: &AppConfig, provider_error: &str) -> SetupStatus {
    let mut status = get_status_inner(config, None);
    if let Some(provider) = status
        .checks
        .iter_mut()
        .find(|check| check.id == "provider")
    {
        provider.status = "error".to_string();
        provider.message = provider_error.to_string();
        provider.action_label = Some("Open Settings".to_string());
    }
    status.ready = false;
    status
}

pub fn get_status(config: &AppConfig) -> SetupStatus {
    get_status_inner(config, None)
}

fn get_status_inner(config: &AppConfig, credential_error: Option<&str>) -> SetupStatus {
    let mut checks = Vec::new();

    if config.model_provider == "api" {
        let provider_check = if !config.groq_api_key.trim().is_empty() {
            check(
                "provider",
                "Provider",
                "ok",
                "Groq API key is configured in secure storage.",
                None,
            )
        } else {
            match credential_error
                .map(|e| Err(e.to_string()))
                .unwrap_or_else(|| secure::get_groq_api_key().map(|key| key.map(|_| ())))
            {
                Ok(Some(())) => check(
                    "provider",
                    "Provider",
                    "ok",
                    "Groq API key is configured in secure storage.",
                    None,
                ),
                Ok(None) => check(
                    "provider",
                    "Provider",
                    "error",
                    "Add a Groq API key or switch to a downloaded local Whisper model.",
                    Some("Open Settings"),
                ),
                Err(e) => check(
                    "provider",
                    "Provider",
                    "error",
                    &format!("Echo could not read the Groq API key from secure storage: {e}"),
                    Some("Open Settings"),
                ),
            }
        };
        checks.push(provider_check);
    } else {
        let downloaded = model_download::is_model_available(&config.local_model_size);
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

#[cfg(test)]
mod tests {
    use super::validate_shortcut;

    #[test]
    fn accepts_function_key_shortcuts_through_f24() {
        for number in 1..=24 {
            let shortcut = format!("F{number}");
            assert!(
                validate_shortcut(&shortcut).valid,
                "{shortcut} should be accepted"
            );
        }

        assert!(validate_shortcut("CommandOrControl+Shift+F24").valid);
    }

    #[test]
    fn rejects_function_keys_outside_the_supported_range() {
        assert!(!validate_shortcut("F25").valid);
    }
}
