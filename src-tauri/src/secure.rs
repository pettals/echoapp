use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "com.andrewjohn.echo";
const GROQ_ACCOUNT: &str = "groq-api-key";
const ENTITLEMENT_ACCOUNT: &str = "entitlement-cache";
const AUTH_ACCOUNT_PREFIX: &str = "supabase-auth:";
#[cfg(target_os = "windows")]
const AUTH_CHUNK_MARKER_PREFIX: &str = "echo-auth-chunk-v1:";
#[cfg(target_os = "windows")]
const AUTH_CHUNK_UTF16_LIMIT: usize = 2000;

static GROQ_API_KEY_CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static ACTIVE_ENTITLEMENT_USER: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<String>> {
    GROQ_API_KEY_CACHE.get_or_init(|| Mutex::new(None))
}

fn cache_key(value: Option<String>) {
    if let Ok(mut cached) = cache().lock() {
        *cached = value;
    }
}

fn cached_key() -> Option<String> {
    cache().lock().ok().and_then(|cached| cached.clone())
}

fn active_entitlement_user_cache() -> &'static Mutex<Option<String>> {
    ACTIVE_ENTITLEMENT_USER.get_or_init(|| Mutex::new(None))
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, GROQ_ACCOUNT).map_err(|e| format!("Credential store error: {e}"))
}

fn entitlement_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ENTITLEMENT_ACCOUNT)
        .map_err(|e| format!("Credential store error: {e}"))
}

fn auth_entry(key: &str) -> Result<keyring::Entry, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() || trimmed.len() > 180 {
        return Err("Invalid auth storage key".to_string());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/'))
    {
        return Err("Invalid auth storage key".to_string());
    }
    keyring::Entry::new(SERVICE, &format!("{AUTH_ACCOUNT_PREFIX}{trimmed}"))
        .map_err(|e| format!("Credential store error: {e}"))
}

#[cfg(target_os = "windows")]
fn auth_part_entry(key: &str, part: usize) -> Result<keyring::Entry, String> {
    auth_entry(&format!("{key}:part:{part}"))
}

#[cfg(target_os = "windows")]
fn split_auth_value(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut current_units = 0;

    for ch in value.chars() {
        let units = ch.len_utf16();
        if current_units > 0 && current_units + units > AUTH_CHUNK_UTF16_LIMIT {
            parts.push(std::mem::take(&mut current));
            current_units = 0;
        }
        current.push(ch);
        current_units += units;
    }

    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

#[cfg(target_os = "windows")]
fn parse_auth_chunk_count(value: &str) -> Option<usize> {
    value
        .strip_prefix(AUTH_CHUNK_MARKER_PREFIX)
        .and_then(|count| count.parse::<usize>().ok())
        .filter(|count| *count > 0 && *count <= 100_000)
}

#[cfg(target_os = "windows")]
fn delete_auth_part(key: &str, part: usize) -> Result<(), String> {
    match auth_part_entry(key, part)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Auth storage delete error: {e}")),
    }
}

pub fn get_groq_api_key_from_store() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            let message = format!("Credential read error: {e}");
            eprintln!("Groq API key secure read failed: {message}");
            Err(message)
        }
    }
}

pub fn get_groq_api_key() -> Result<Option<String>, String> {
    match get_groq_api_key_from_store() {
        Ok(Some(value)) => {
            cache_key(Some(value.clone()));
            Ok(Some(value))
        }
        Ok(None) => Ok(cached_key()),
        Err(e) => {
            if let Some(value) = cached_key() {
                eprintln!("Using in-memory Groq API key after secure read failed: {e}");
                Ok(Some(value))
            } else {
                Err(e)
            }
        }
    }
}

pub fn set_groq_api_key(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return delete_groq_api_key();
    }
    let trimmed = value.trim().to_string();
    entry()?.set_password(&trimmed).map_err(|e| {
        let message = format!("Credential write error: {e}");
        eprintln!("Groq API key secure write failed: {message}");
        message
    })?;
    cache_key(Some(trimmed));
    Ok(())
}

pub fn delete_groq_api_key() -> Result<(), String> {
    let result = match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            let message = format!("Credential delete error: {e}");
            eprintln!("Groq API key secure delete failed: {message}");
            Err(message)
        }
    };
    if result.is_ok() {
        cache_key(None);
    }
    result
}

pub fn active_entitlement_user() -> Option<String> {
    active_entitlement_user_cache()
        .lock()
        .ok()
        .and_then(|cached| cached.clone())
}

pub fn set_active_entitlement_user(user_id: Option<String>) {
    if let Ok(mut cached) = active_entitlement_user_cache().lock() {
        *cached = user_id;
    }
}

pub fn get_entitlement_cache() -> Result<Option<String>, String> {
    match entitlement_entry()?.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            let message = format!("Entitlement cache read error: {e}");
            eprintln!("{message}");
            Err(message)
        }
    }
}

pub fn set_entitlement_cache(value: &str) -> Result<(), String> {
    entitlement_entry()?
        .set_password(value.trim())
        .map_err(|e| {
            let message = format!("Entitlement cache write error: {e}");
            eprintln!("{message}");
            message
        })
}

pub fn delete_entitlement_cache_for_user(user_id: &str) -> Result<(), String> {
    let should_delete = get_entitlement_cache()?
        .as_deref()
        .map(|json| json.contains(&format!(r#""userId":"{}""#, user_id.trim())))
        .unwrap_or(false);
    if !should_delete {
        return Ok(());
    }
    match entitlement_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            let message = format!("Entitlement cache delete error: {e}");
            eprintln!("{message}");
            Err(message)
        }
    }
}

pub fn get_auth_storage(key: &str) -> Result<Option<String>, String> {
    match auth_entry(key)?.get_password() {
        Ok(value) if !value.is_empty() => {
            #[cfg(target_os = "windows")]
            if let Some(part_count) = parse_auth_chunk_count(&value) {
                let mut combined = String::new();
                for part in 0..part_count {
                    let chunk = auth_part_entry(key, part)?.get_password().map_err(|e| {
                        format!("Auth storage read error: missing secure storage part {part}: {e}")
                    })?;
                    combined.push_str(&chunk);
                }
                return Ok(Some(combined));
            }
            Ok(Some(value))
        }
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            let message = format!("Auth storage read error: {e}");
            eprintln!("{message}");
            Err(message)
        }
    }
}

fn write_and_verify_auth_storage(
    value: &str,
    write: impl FnOnce(&str) -> Result<(), String>,
    read: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<(), String> {
    write(value)?;

    match read() {
        Ok(Some(saved)) if saved == value => Ok(()),
        Ok(Some(_)) => Err(
            "Auth storage verification failed: secure storage returned a different value"
                .to_string(),
        ),
        Ok(None) => {
            Err("Auth storage verification failed: secure storage returned no value".to_string())
        }
        Err(error) => Err(format!("Auth storage verification failed: {error}")),
    }
}

pub fn set_auth_storage(key: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return delete_auth_storage(key);
    }

    #[cfg(target_os = "windows")]
    {
        let parts = split_auth_value(trimmed);
        if parts.len() > 1 {
            let previous_part_count = auth_entry(key)?
                .get_password()
                .ok()
                .and_then(|value| parse_auth_chunk_count(&value));

            for (part, chunk) in parts.iter().enumerate() {
                auth_part_entry(key, part)?
                    .set_password(chunk)
                    .map_err(|e| {
                        let message = format!("Auth storage write error: {e}");
                        eprintln!("{message}");
                        message
                    })?;
            }

            auth_entry(key)?
                .set_password(&format!("{AUTH_CHUNK_MARKER_PREFIX}{}", parts.len()))
                .map_err(|e| format!("Auth storage write error: {e}"))?;

            if let Some(previous_part_count) = previous_part_count {
                for part in parts.len()..previous_part_count {
                    delete_auth_part(key, part)?;
                }
            }

            return match get_auth_storage(key)? {
                Some(saved) if saved == trimmed => Ok(()),
                Some(_) => Err(
                    "Auth storage verification failed: secure storage returned a different value"
                        .to_string(),
                ),
                None => Err(
                    "Auth storage verification failed: secure storage returned no value"
                        .to_string(),
                ),
            };
        }

        let previous_part_count = auth_entry(key)?
            .get_password()
            .ok()
            .and_then(|value| parse_auth_chunk_count(&value));
        let result = write_and_verify_auth_storage(
            trimmed,
            |stored_value| {
                auth_entry(key)?.set_password(stored_value).map_err(|e| {
                    let message = format!("Auth storage write error: {e}");
                    eprintln!("{message}");
                    message
                })
            },
            || get_auth_storage(key),
        );
        if result.is_ok() {
            if let Some(previous_part_count) = previous_part_count {
                for part in 0..previous_part_count {
                    delete_auth_part(key, part)?;
                }
            }
        }
        return result;
    }

    #[cfg(not(target_os = "windows"))]
    write_and_verify_auth_storage(
        trimmed,
        |stored_value| {
            auth_entry(key)?.set_password(stored_value).map_err(|e| {
                let message = format!("Auth storage write error: {e}");
                eprintln!("{message}");
                message
            })
        },
        || get_auth_storage(key),
    )
}

pub fn delete_auth_storage(key: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let part_count = auth_entry(key)?
        .get_password()
        .ok()
        .and_then(|value| parse_auth_chunk_count(&value));

    let result = match auth_entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            let message = format!("Auth storage delete error: {e}");
            eprintln!("{message}");
            Err(message)
        }
    };

    #[cfg(target_os = "windows")]
    if result.is_ok() {
        if let Some(part_count) = part_count {
            for part in 0..part_count {
                delete_auth_part(key, part)?;
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::write_and_verify_auth_storage;

    #[cfg(target_os = "windows")]
    use super::{parse_auth_chunk_count, split_auth_value, AUTH_CHUNK_MARKER_PREFIX};

    #[test]
    fn auth_storage_write_succeeds_after_matching_verification() {
        let result = write_and_verify_auth_storage(
            "stored-session",
            |_| Ok(()),
            || Ok(Some("stored-session".to_string())),
        );

        assert_eq!(result, Ok(()));
    }

    #[test]
    fn auth_storage_write_rejects_missing_verification_value() {
        let error =
            write_and_verify_auth_storage("stored-session", |_| Ok(()), || Ok(None)).unwrap_err();

        assert!(error.contains("returned no value"));
    }

    #[test]
    fn auth_storage_write_rejects_mismatched_verification_value() {
        let error = write_and_verify_auth_storage(
            "stored-session",
            |_| Ok(()),
            || Ok(Some("different-session".to_string())),
        )
        .unwrap_err();

        assert!(error.contains("different value"));
    }

    #[test]
    fn auth_storage_write_surfaces_verification_failure() {
        let error = write_and_verify_auth_storage(
            "stored-session",
            |_| Ok(()),
            || Err("Keychain denied read".to_string()),
        )
        .unwrap_err();

        assert!(error.contains("Keychain denied read"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn auth_chunks_preserve_utf16_and_do_not_split_surrogate_pairs() {
        let value = format!("{}{}", "a".repeat(1_999), "😀".repeat(2));
        let parts = split_auth_value(&value);

        assert_eq!(parts.concat(), value);
        assert!(parts
            .iter()
            .all(|part| part.encode_utf16().count() <= 2_000));
        assert_eq!(parts[0].encode_utf16().count(), 1_999);
        assert_eq!(parts[1], "😀😀");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn auth_chunk_marker_parses_only_valid_counts() {
        assert_eq!(
            parse_auth_chunk_count(&format!("{AUTH_CHUNK_MARKER_PREFIX}3")),
            Some(3)
        );
        assert_eq!(parse_auth_chunk_count("echo-auth-chunk-v1:0"), None);
        assert_eq!(parse_auth_chunk_count("not-a-marker"), None);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn compiled_credential_store_persists_until_deleted() {
        use keyring::credential::CredentialPersistence;

        let persistence = keyring::default::default_credential_builder().persistence();
        assert!(matches!(persistence, CredentialPersistence::UntilDelete));
    }
}
