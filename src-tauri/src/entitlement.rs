use crate::secure;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FREE_HISTORY_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementFeatures {
    pub unlimited_history: bool,
    pub cloud_provider: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementStatus {
    pub tier: String,
    pub features: EntitlementFeatures,
    pub checked_at: String,
    pub grace_until: Option<String>,
    pub lease_until: Option<String>,
    pub requires_online: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementCache {
    pub user_id: String,
    pub tier: String,
    pub checked_at: String,
    #[serde(default)]
    pub grace_until: Option<String>,
    #[serde(default)]
    pub lease_until: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionEntitlement {
    user_id: String,
    tier: String,
    checked_at: String,
    lease_until: String,
}

static SESSION_ENTITLEMENT: OnceLock<Mutex<Option<SessionEntitlement>>> = OnceLock::new();

fn session_entitlement() -> &'static Mutex<Option<SessionEntitlement>> {
    SESSION_ENTITLEMENT.get_or_init(|| Mutex::new(None))
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_seconds_from_iso(value: &str) -> Option<u64> {
    let value = value.trim();
    let date_time = value.strip_suffix('Z').unwrap_or(value);
    let (date, time) = date_time.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<u64>().ok()?;
    let month = date_parts.next()?.parse::<u64>().ok()?;
    let day = date_parts.next()?.parse::<u64>().ok()?;
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u64>().ok()?;
    let minute = time_parts.next()?.parse::<u64>().ok()?;
    let second_part = time_parts.next()?;
    let second = second_part
        .split_once('.')
        .map(|(whole, _)| whole)
        .unwrap_or(second_part)
        .parse::<u64>()
        .ok()?;
    Some(
        days_from_civil(year as i64, month as i64, day as i64) as u64 * 86_400
            + hour * 3_600
            + minute * 60
            + second,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn free_status(source: &str) -> EntitlementStatus {
    EntitlementStatus {
        tier: "free".to_string(),
        features: EntitlementFeatures {
            unlimited_history: false,
            cloud_provider: false,
        },
        checked_at: String::new(),
        grace_until: None,
        lease_until: None,
        requires_online: true,
        source: source.to_string(),
    }
}

fn pro_status(session: SessionEntitlement, source: &str) -> EntitlementStatus {
    EntitlementStatus {
        tier: session.tier,
        features: EntitlementFeatures {
            unlimited_history: true,
            cloud_provider: true,
        },
        checked_at: session.checked_at,
        grace_until: None,
        lease_until: Some(session.lease_until),
        requires_online: true,
        source: source.to_string(),
    }
}

pub fn cache_status(cache: EntitlementCache) -> Result<(), String> {
    if cache.user_id.trim().is_empty() {
        return Err("Entitlement cache is missing a user id".to_string());
    }
    if cache.tier != "pro_lifetime" {
        if let Ok(mut session) = session_entitlement().lock() {
            *session = None;
        }
        return secure::delete_entitlement_cache_for_user(&cache.user_id);
    }
    if let Some(lease_until) = cache.lease_until.clone() {
        if unix_seconds_from_iso(&lease_until)
            .map(|expires_at| expires_at >= now_unix_seconds())
            .unwrap_or(false)
        {
            if let Ok(mut session) = session_entitlement().lock() {
                *session = Some(SessionEntitlement {
                    user_id: cache.user_id.clone(),
                    tier: cache.tier.clone(),
                    checked_at: cache.checked_at.clone(),
                    lease_until,
                });
            }
        }
    }
    let json = serde_json::to_string(&cache)
        .map_err(|e| format!("Entitlement cache serialize error: {e}"))?;
    secure::set_entitlement_cache(&json)
}

pub fn clear_active_user() {
    secure::set_active_entitlement_user(None);
    if let Ok(mut session) = session_entitlement().lock() {
        *session = None;
    }
}

pub fn status_for_user(user_id: Option<&str>) -> EntitlementStatus {
    let Some(user_id) = user_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return free_status("no_user");
    };

    secure::set_active_entitlement_user(Some(user_id.to_string()));

    let session = session_entitlement()
        .lock()
        .ok()
        .and_then(|session| session.clone());
    let Some(session) = session else {
        return free_status("no_fresh_online_entitlement");
    };
    if session.user_id != user_id || session.tier != "pro_lifetime" {
        return free_status("session_mismatch");
    }
    if let Some(expires_at) = unix_seconds_from_iso(&session.lease_until) {
        if expires_at >= now_unix_seconds() {
            return pro_status(session, "online_session");
        }
    }
    if let Ok(mut session) = session_entitlement().lock() {
        *session = None;
    }
    free_status("online_lease_expired")
}

pub fn active_status() -> EntitlementStatus {
    let user_id = secure::active_entitlement_user();
    status_for_user(user_id.as_deref())
}

pub fn require_cloud_provider() -> Result<(), String> {
    if active_status().features.cloud_provider {
        Ok(())
    } else {
        Err("Unlock Echo Pro to use cloud transcription and save a Groq API key.".to_string())
    }
}

pub fn history_limit() -> Option<usize> {
    if active_status().features.unlimited_history {
        None
    } else {
        Some(FREE_HISTORY_LIMIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn test_lock() -> &'static Mutex<()> {
        TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn set_test_session(user_id: &str, lease_until: &str) {
        *session_entitlement().lock().unwrap() = Some(SessionEntitlement {
            user_id: user_id.to_string(),
            tier: "pro_lifetime".to_string(),
            checked_at: "2026-06-17T12:00:00Z".to_string(),
            lease_until: lease_until.to_string(),
        });
    }

    #[test]
    fn parses_utc_iso_seconds() {
        assert_eq!(unix_seconds_from_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(unix_seconds_from_iso("1970-01-02T00:00:01Z"), Some(86_401));
    }

    #[test]
    fn parses_utc_iso_fractional_seconds() {
        assert_eq!(unix_seconds_from_iso("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(unix_seconds_from_iso("1970-01-02T00:00:01.999Z"), Some(86_401));
    }

    #[test]
    fn fresh_session_lease_authorizes_pro_features() {
        let _guard = test_lock().lock().unwrap();
        set_test_session("user-1", "2999-01-01T00:00:00Z");

        let status = status_for_user(Some("user-1"));

        assert_eq!(status.tier, "pro_lifetime");
        assert!(status.features.cloud_provider);
        assert!(status.features.unlimited_history);
        assert_eq!(status.source, "online_session");
        clear_active_user();
    }

    #[test]
    fn fractional_session_lease_authorizes_pro_features() {
        let _guard = test_lock().lock().unwrap();
        set_test_session("user-1", "2999-01-01T00:00:00.123Z");

        let status = status_for_user(Some("user-1"));

        assert_eq!(status.tier, "pro_lifetime");
        assert!(status.features.cloud_provider);
        assert!(status.features.unlimited_history);
        assert_eq!(status.source, "online_session");
        clear_active_user();
    }

    #[test]
    fn expired_session_lease_falls_back_to_free() {
        let _guard = test_lock().lock().unwrap();
        set_test_session("user-1", "1970-01-01T00:00:00Z");

        let status = status_for_user(Some("user-1"));

        assert_eq!(status.tier, "free");
        assert!(!status.features.cloud_provider);
        assert!(!status.features.unlimited_history);
        assert_eq!(status.source, "online_lease_expired");
        clear_active_user();
    }

    #[test]
    fn session_does_not_authorize_other_users() {
        let _guard = test_lock().lock().unwrap();
        set_test_session("user-1", "2999-01-01T00:00:00Z");

        let status = status_for_user(Some("user-2"));

        assert_eq!(status.tier, "free");
        assert_eq!(status.source, "session_mismatch");
        clear_active_user();
    }
}
