use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "com.andrewjohn.echo";
const GROQ_ACCOUNT: &str = "groq-api-key";
const ENTITLEMENT_ACCOUNT: &str = "entitlement-cache";
const AUTH_ACCOUNT_PREFIX: &str = "supabase-auth:";

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
        Ok(value) if !value.is_empty() => Ok(Some(value)),
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
    match auth_entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => {
            let message = format!("Auth storage delete error: {e}");
            eprintln!("{message}");
            Err(message)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::write_and_verify_auth_storage;

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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn compiled_credential_store_persists_until_deleted() {
        use keyring::credential::CredentialPersistence;

        let persistence = keyring::default::default_credential_builder().persistence();
        assert!(matches!(persistence, CredentialPersistence::UntilDelete));
    }
}
