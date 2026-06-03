use std::sync::{Mutex, OnceLock};

const SERVICE: &str = "com.andrewjohn.echo";
const GROQ_ACCOUNT: &str = "groq-api-key";
const AUTH_ACCOUNT_PREFIX: &str = "supabase-auth:";

static GROQ_API_KEY_CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

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

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, GROQ_ACCOUNT).map_err(|e| format!("Credential store error: {e}"))
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

pub fn set_auth_storage(key: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return delete_auth_storage(key);
    }
    auth_entry(key)?.set_password(trimmed).map_err(|e| {
        let message = format!("Auth storage write error: {e}");
        eprintln!("{message}");
        message
    })
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
