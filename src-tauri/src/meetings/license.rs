use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedLicense {
    pub key_id: String,
    pub payload: String,
    pub signature: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claims {
    version: u32,
    issuer: String,
    audience: String,
    user_id: String,
    tier: String,
    issued_at: String,
    features: Vec<String>,
}

fn verify_with_keys(
    license: &SignedLicense,
    user_id: &str,
    keys: &HashMap<String, String>,
) -> Result<(), String> {
    let encoded = keys
        .get(&license.key_id)
        .ok_or("This Echo version does not recognize the licence signing key. Update Echo.")?;
    let bytes = B64
        .decode(encoded)
        .map_err(|_| "Invalid licence verification key")?;
    let key = VerifyingKey::from_bytes(
        &bytes
            .try_into()
            .map_err(|_| "Invalid licence verification key")?,
    )
    .map_err(|_| "Invalid licence verification key")?;
    let payload = B64
        .decode(&license.payload)
        .map_err(|_| "Invalid offline licence")?;
    if payload.len() > 8192 {
        return Err("Invalid offline licence".into());
    }
    let signature = Signature::from_slice(
        &B64.decode(&license.signature)
            .map_err(|_| "Invalid offline licence")?,
    )
    .map_err(|_| "Invalid offline licence")?;
    key.verify_strict(&payload, &signature)
        .map_err(|_| "Offline licence signature did not match")?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| "Invalid offline licence")?;
    if claims.version != 1
        || claims.issuer != "echo"
        || claims.audience != "echo-meetings"
        || claims.user_id != user_id
        || claims.tier != "pro_lifetime"
        || !claims.features.iter().any(|f| f == "meetings")
        || chrono::DateTime::parse_from_rfc3339(&claims.issued_at).is_err()
    {
        return Err("This offline licence does not authorize Meetings for this account".into());
    }
    Ok(())
}
pub fn save(user_id: &str, license: SignedLicense) -> Result<(), String> {
    let keys = serde_json::from_str(include_str!("../../meeting-license-keys.json"))
        .map_err(|_| "Licence verification is unavailable")?;
    verify_with_keys(&license, user_id, &keys)?;
    crate::secure::set_private_credential(
        &format!("meeting-license:{user_id}"),
        &serde_json::to_string(&license).map_err(|_| "Could not save the offline licence")?,
    )
}
pub fn revoke(user_id: &str) -> Result<(), String> {
    crate::secure::set_private_credential(&format!("meeting-license:{user_id}"), "")
}
pub fn offline_allowed() -> bool {
    let Some(user) = crate::secure::active_entitlement_user() else {
        return false;
    };
    let Ok(Some(value)) = crate::secure::get_private_credential(&format!("meeting-license:{user}"))
    else {
        return false;
    };
    let Ok(license) = serde_json::from_str(&value) else {
        return false;
    };
    let Ok(keys) = serde_json::from_str(include_str!("../../meeting-license-keys.json")) else {
        return false;
    };
    verify_with_keys(&license, &user, &keys).is_ok()
}
pub fn activate(user_id: &str) -> bool {
    let previous = crate::secure::active_entitlement_user();
    crate::secure::set_active_entitlement_user(Some(user_id.into()));
    if offline_allowed() {
        true
    } else {
        crate::secure::set_active_entitlement_user(previous);
        false
    }
}
pub fn allowed() -> bool {
    // A frontend-supplied entitlement cache cannot authorize a permanent feature.
    // The first online check must deliver a server-signed licence as well.
    offline_allowed()
}
pub fn require() -> Result<(), String> {
    if allowed() {
        Ok(())
    } else {
        Err("Unlock Echo Pro, then verify your purchase online once to enable Meetings on this computer.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    #[test]
    fn verifies_offline_without_expiry_and_rejects_tampering_and_other_accounts() {
        let signer = SigningKey::from_bytes(&[7; 32]);
        let keys = HashMap::from([(
            "fixture".into(),
            B64.encode(signer.verifying_key().as_bytes()),
        )]);
        let payload=serde_json::json!({"version":1,"issuer":"echo","audience":"echo-meetings","userId":"alice","tier":"pro_lifetime","issuedAt":"2020-01-01T00:00:00Z","features":["meetings"]}).to_string();
        let mut license = SignedLicense {
            key_id: "fixture".into(),
            payload: B64.encode(payload.as_bytes()),
            signature: B64.encode(signer.sign(payload.as_bytes()).to_bytes()),
        };
        assert!(verify_with_keys(&license, "alice", &keys).is_ok());
        assert!(verify_with_keys(&license, "bob", &keys).is_err());
        license.payload = B64.encode(b"tampered");
        assert!(verify_with_keys(&license, "alice", &keys).is_err());
    }
}
