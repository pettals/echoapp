use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotepadNote {
    pub id: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

fn notepad_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("Cannot find config directory")?
        .join("echo");
    fs::create_dir_all(&dir).map_err(|e| format!("Dir create error: {e}"))?;
    Ok(dir.join("notepad.json"))
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
    format!("note-{}-{}", dur.as_millis(), dur.subsec_nanos() % 10000)
}

fn sort_notes(items: &mut [NotepadNote]) {
    items.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });
}

fn load_all_from_path(path: &Path) -> Vec<NotepadNote> {
    let mut items: Vec<NotepadNote> = match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
        Err(_) => Vec::new(),
    };
    sort_notes(&mut items);
    items
}

fn save_all_to_path(path: &Path, items: &[NotepadNote]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Dir create error: {e}"))?;
    }
    let json = serde_json::to_string_pretty(items).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Write error: {e}"))
}

pub fn load_all() -> Vec<NotepadNote> {
    notepad_path()
        .ok()
        .map(|path| load_all_from_path(&path))
        .unwrap_or_default()
}

fn create_at_path(path: &Path) -> Result<NotepadNote, String> {
    let now = now_iso();
    let item = NotepadNote {
        id: generate_id(),
        body: String::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    let mut items = load_all_from_path(path);
    items.insert(0, item.clone());
    save_all_to_path(path, &items)?;
    Ok(item)
}

pub fn create() -> Result<NotepadNote, String> {
    let path = notepad_path()?;
    create_at_path(&path)
}

fn update_at_path(path: &Path, id: &str, body: &str) -> Result<NotepadNote, String> {
    let mut items = load_all_from_path(path);
    let item = items
        .iter_mut()
        .find(|note| note.id == id)
        .ok_or_else(|| "Note not found".to_string())?;
    item.body = body.to_string();
    item.updated_at = now_iso();
    let updated = item.clone();
    sort_notes(&mut items);
    save_all_to_path(path, &items)?;
    Ok(updated)
}

pub fn update(id: &str, body: &str) -> Result<NotepadNote, String> {
    let path = notepad_path()?;
    update_at_path(&path, id, body)
}

fn delete_at_path(path: &Path, id: &str) -> Result<(), String> {
    let mut items = load_all_from_path(path);
    let before = items.len();
    items.retain(|note| note.id != id);
    if items.len() == before {
        return Err("Note not found".to_string());
    }
    save_all_to_path(path, &items)
}

pub fn delete(id: &str) -> Result<(), String> {
    let path = notepad_path()?;
    delete_at_path(&path, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn temp_notes_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notepad.json");
        (dir, path)
    }

    fn note(id: &str, body: &str, created_at: &str, updated_at: &str) -> NotepadNote {
        NotepadNote {
            id: id.to_string(),
            body: body.to_string(),
            created_at: created_at.to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn missing_file_loads_empty_notes() {
        let (_dir, path) = temp_notes_path();

        assert!(load_all_from_path(&path).is_empty());
    }

    #[test]
    fn corrupt_file_falls_back_to_empty_notes() {
        let (_dir, path) = temp_notes_path();
        fs::write(&path, "{not valid json").unwrap();

        assert!(load_all_from_path(&path).is_empty());
    }

    #[test]
    fn load_sorts_notes_by_updated_at_newest_first() {
        let (_dir, path) = temp_notes_path();
        save_all_to_path(
            &path,
            &[
                note(
                    "older",
                    "Older",
                    "2026-05-26T10:00:00Z",
                    "2026-05-26T11:00:00Z",
                ),
                note(
                    "newer",
                    "Newer",
                    "2026-05-26T09:00:00Z",
                    "2026-05-27T11:00:00Z",
                ),
            ],
        )
        .unwrap();

        let items = load_all_from_path(&path);

        assert_eq!(items[0].id, "newer");
        assert_eq!(items[1].id, "older");
    }

    #[test]
    fn create_update_and_delete_note() {
        let (_dir, path) = temp_notes_path();
        let created = create_at_path(&path).unwrap();
        assert_eq!(created.body, "");

        let updated = update_at_path(&path, &created.id, "Hello **Echo**").unwrap();
        assert_eq!(updated.body, "Hello **Echo**");

        let items = load_all_from_path(&path);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].body, "Hello **Echo**");

        delete_at_path(&path, &created.id).unwrap();
        assert!(load_all_from_path(&path).is_empty());
    }

    #[test]
    fn update_and_delete_missing_note_return_errors() {
        let (_dir, path) = temp_notes_path();

        assert_eq!(
            update_at_path(&path, "missing", "Body").unwrap_err(),
            "Note not found"
        );
        assert_eq!(
            delete_at_path(&path, "missing").unwrap_err(),
            "Note not found"
        );
    }
}
