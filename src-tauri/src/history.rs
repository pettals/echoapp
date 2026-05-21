use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_MAX_HISTORY_ITEMS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub text: String,
    pub created_at: String,
    pub paste_result: String,
}

fn history_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("Cannot find config directory")?
        .join("echo");
    fs::create_dir_all(&dir).map_err(|e| format!("Dir create error: {e}"))?;
    Ok(dir.join("history.json"))
}

fn now_iso() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn days_to_ymd(mut days: u64) -> (u64, u64, u64) {
    days += 719468;
    let era = days / 146097;
    let doe = days - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn generate_id() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{}", dur.as_millis(), dur.subsec_nanos() % 10000)
}

pub fn load_all() -> Vec<HistoryItem> {
    history_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_all(items: &[HistoryItem]) -> Result<(), String> {
    let path = history_path()?;
    let json = serde_json::to_string_pretty(items).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Write error: {e}"))
}

pub fn add(text: &str, paste_result: &str, limit: usize) -> Result<HistoryItem, String> {
    let item = HistoryItem {
        id: generate_id(),
        text: text.to_string(),
        created_at: now_iso(),
        paste_result: paste_result.to_string(),
    };
    let mut items = load_all();
    items.insert(0, item.clone());
    items.truncate(limit.clamp(1, DEFAULT_MAX_HISTORY_ITEMS));
    save_all(&items)?;
    Ok(item)
}

pub fn delete(id: &str) -> Result<(), String> {
    let mut items = load_all();
    let before = items.len();
    items.retain(|i| i.id != id);
    if items.len() == before {
        return Err("Item not found".to_string());
    }
    save_all(&items)
}

pub fn clear() -> Result<(), String> {
    save_all(&[])
}
