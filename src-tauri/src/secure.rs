const SERVICE: &str = "com.andrewjohn.echo";
const GROQ_ACCOUNT: &str = "groq-api-key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, GROQ_ACCOUNT).map_err(|e| format!("Credential store error: {e}"))
}

pub fn get_groq_api_key() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) => Ok(None),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Credential read error: {e}")),
    }
}

pub fn set_groq_api_key(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return delete_groq_api_key();
    }
    entry()?
        .set_password(value.trim())
        .map_err(|e| format!("Credential write error: {e}"))
}

pub fn delete_groq_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Credential delete error: {e}")),
    }
}

