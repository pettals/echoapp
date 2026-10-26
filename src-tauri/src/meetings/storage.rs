use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: i64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub source: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub duration_ms: u64,
    pub mode: String,
    pub model: String,
    pub state: String,
    pub error: Option<String>,
    pub notes: Option<super::summary::Notes>,
    pub edited_notes: Option<String>,
    pub provider: String,
    pub segments: Vec<Segment>,
    pub transcript: Vec<Segment>,
}

pub struct Store(Mutex<Connection>);

fn safe_error(_: rusqlite::Error) -> String {
    "Could not update the local meeting library. Check available disk space and retry.".into()
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(safe_error)?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(safe_error)?;
        if version > 2 {
            return Err(
                "This meeting library was created by a newer Echo version. Update Echo to open it."
                    .into(),
            );
        }
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(safe_error)?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
                duration_ms INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL, model TEXT NOT NULL,
                state TEXT NOT NULL, error TEXT, notes TEXT, edited_notes TEXT, provider TEXT NOT NULL DEFAULT 'local', title_edited INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS segments (
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                id INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
                source TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(meeting_id,id)
            );") .map_err(safe_error)?;
        let has_title_edited = {
            let mut statement = connection
                .prepare("PRAGMA table_info(meetings)")
                .map_err(safe_error)?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(safe_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(safe_error)?;
            columns.iter().any(|name| name == "title_edited")
        };
        if !has_title_edited {
            connection
                .execute(
                    "ALTER TABLE meetings ADD COLUMN title_edited INTEGER NOT NULL DEFAULT 0",
                    [],
                )
                .map_err(safe_error)?;
        }
        connection
            .pragma_update(None, "user_version", 2)
            .map_err(safe_error)?;
        connection.execute_batch("COMMIT").map_err(safe_error)?;
        Ok(Self(Mutex::new(connection)))
    }

    pub fn recover(&self) -> Result<(), String> {
        self.0.lock().map_err(|_| "Meeting library is busy")?.execute(
            "UPDATE meetings SET state='interrupted', error='Echo closed before processing finished. Recover or discard the remaining recording.' WHERE state IN ('recording','paused','transcribing','summarizing')", []
        ).map_err(safe_error)?;
        Ok(())
    }

    pub fn create(&self, id: &str, mode: &str, model: &str, provider: &str) -> Result<(), String> {
        let now = chrono::Utc::now();
        let title = format!("Meeting · {}", now.format("%d %b %Y %H:%M"));
        self.0.lock().map_err(|_| "Meeting library is busy")?.execute(
            "INSERT INTO meetings(id,title,created_at,mode,model,state,provider) VALUES (?1,?2,?3,?4,?5,'recording',?6)",
            params![id,title,now.to_rfc3339(),mode,model,provider]
        ).map_err(safe_error)?;
        Ok(())
    }

    pub fn list(&self, query: &str) -> Result<Vec<Meeting>, String> {
        let connection = self.0.lock().map_err(|_| "Meeting library is busy")?;
        let mut statement = connection.prepare("SELECT id,title,created_at,duration_ms,mode,model,state,error,NULL,NULL,provider FROM meetings WHERE instr(lower(title),lower(?1))>0 OR EXISTS(SELECT 1 FROM segments WHERE meeting_id=meetings.id AND instr(lower(text),lower(?1))>0) ORDER BY created_at DESC").map_err(safe_error)?;
        let rows = statement
            .query_map([query], row_meeting)
            .map_err(safe_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(safe_error)
    }

    pub fn get(&self, id: &str) -> Result<Meeting, String> {
        let connection = self.0.lock().map_err(|_| "Meeting library is busy")?;
        let mut meeting = connection.query_row("SELECT id,title,created_at,duration_ms,mode,model,state,error,notes,edited_notes,provider FROM meetings WHERE id=?1", [id], row_meeting).optional().map_err(safe_error)?.ok_or("Meeting no longer exists")?;
        let mut statement = connection.prepare("SELECT id,start_ms,end_ms,source,text FROM segments WHERE meeting_id=?1 ORDER BY start_ms,id").map_err(safe_error)?;
        meeting.segments = statement
            .query_map([id], |row| {
                Ok(Segment {
                    id: row.get(0)?,
                    start_ms: row.get(1)?,
                    end_ms: row.get(2)?,
                    source: row.get(3)?,
                    text: row.get(4)?,
                })
            })
            .map_err(safe_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(safe_error)?;
        meeting.transcript = super::transcript::assembled(&meeting.segments);
        Ok(meeting)
    }

    pub fn append(&self, id: &str, segment: &Segment) -> Result<(), String> {
        let mut connection = self.0.lock().map_err(|_| "Meeting library is busy")?;
        let transaction = connection.transaction().map_err(safe_error)?;
        transaction.execute("INSERT OR REPLACE INTO segments(meeting_id,id,start_ms,end_ms,source,text) VALUES (?1,?2,?3,?4,?5,?6)", params![id,segment.id,segment.start_ms,segment.end_ms,segment.source,segment.text]).map_err(safe_error)?;
        transaction
            .execute(
                "UPDATE meetings SET duration_ms=MAX(duration_ms,?2) WHERE id=?1",
                params![id, segment.end_ms],
            )
            .map_err(safe_error)?;
        transaction.commit().map_err(safe_error)
    }
    pub fn has_segment(&self, id: &str, sequence: i64) -> Result<bool, String> {
        self.0
            .lock()
            .map_err(|_| "Meeting library is busy")?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM segments WHERE meeting_id=?1 AND id=?2)",
                params![id, sequence],
                |row| row.get(0),
            )
            .map_err(safe_error)
    }

    pub fn state(&self, id: &str, state: &str, error: Option<&str>) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Meeting library is busy")?
            .execute(
                "UPDATE meetings SET state=?2,error=?3 WHERE id=?1",
                params![id, state, error],
            )
            .map_err(safe_error)?;
        Ok(())
    }
    pub fn duration(&self, id: &str, duration: u64) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Meeting library is busy")?
            .execute(
                "UPDATE meetings SET duration_ms=MAX(duration_ms,?2) WHERE id=?1",
                params![id, duration],
            )
            .map_err(safe_error)?;
        Ok(())
    }
    pub fn save_notes(
        &self,
        id: &str,
        notes: &super::summary::Notes,
        provider: &str,
    ) -> Result<(), String> {
        let value = serde_json::to_string(notes).map_err(|_| "Could not encode meeting notes")?;
        self.0.lock().map_err(|_| "Meeting library is busy")?.execute("UPDATE meetings SET notes=?2,edited_notes=NULL,provider=?3,state='ready',error=NULL,title=CASE WHEN notes IS NULL AND title_edited=0 THEN ?4 ELSE title END WHERE id=?1", params![id,value,provider,notes.title]).map_err(safe_error)?;
        Ok(())
    }
    pub fn edit(&self, id: &str, title: &str, notes: Option<&str>) -> Result<(), String> {
        if title.trim().is_empty()
            || title.len() > 500
            || notes.is_some_and(|n| n.len() > 1_000_000)
        {
            return Err("Enter a title and keep notes under 1 MB".into());
        }
        self.0
            .lock()
            .map_err(|_| "Meeting library is busy")?
            .execute(
                "UPDATE meetings SET title_edited=CASE WHEN title<>?2 THEN 1 ELSE title_edited END,title=?2,edited_notes=?3 WHERE id=?1",
                params![id, title.trim(), notes],
            )
            .map_err(safe_error)?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Meeting library is busy")?
            .execute("DELETE FROM meetings WHERE id=?1", [id])
            .map_err(safe_error)?;
        Ok(())
    }
}

fn row_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<Meeting> {
    let notes: Option<String> = row.get(8)?;
    Ok(Meeting {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        duration_ms: row.get(3)?,
        mode: row.get(4)?,
        model: row.get(5)?,
        state: row.get(6)?,
        error: row.get(7)?,
        notes: notes.and_then(|n| serde_json::from_str(&n).ok()),
        edited_notes: row.get(9)?,
        provider: row.get(10)?,
        segments: vec![],
        transcript: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_segments_recovery_search_and_delete_are_independent_of_history() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("meetings.sqlite");
        let store = Store::open(&path).unwrap();
        store.create("one", "online", "small", "local").unwrap();
        let segment = Segment {
            id: 1,
            start_ms: 10,
            end_ms: 2000,
            source: "microphone".into(),
            text: "Project Marmalade".into(),
        };
        store.append("one", &segment).unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        store.recover().unwrap();
        assert_eq!(store.get("one").unwrap().segments, vec![segment]);
        assert_eq!(store.get("one").unwrap().state, "interrupted");
        assert_eq!(store.list("marmalade").unwrap().len(), 1);
        store.delete("one").unwrap();
        assert!(store.get("one").is_err());
        assert!(store
            .append(
                "one",
                &Segment {
                    id: 2,
                    start_ms: 0,
                    end_ms: 1,
                    source: "microphone".into(),
                    text: "late".into()
                }
            )
            .is_err());
    }
    #[test]
    fn renamed_titles_survive_first_generation_and_failed_regeneration_preserves_notes() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(&root.path().join("meetings.sqlite")).unwrap();
        store.create("one", "in-person", "small", "local").unwrap();
        store.edit("one", "My chosen title", None).unwrap();
        let notes = super::super::summary::Notes {
            title: "Generated title".into(),
            overview: "A grounded overview".into(),
            overview_segment_ids: vec![1],
            discussion_points: vec![],
            decisions: vec![],
            action_items: vec![],
            open_questions: vec![],
        };
        store.save_notes("one", &notes, "local").unwrap();
        assert_eq!(store.get("one").unwrap().title, "My chosen title");
        store
            .edit("one", "My chosen title", Some("My edits"))
            .unwrap();
        store
            .state("one", "failed", Some("Provider unavailable"))
            .unwrap();
        let saved = store.get("one").unwrap();
        assert_eq!(saved.edited_notes.as_deref(), Some("My edits"));
        assert_eq!(saved.notes.unwrap(), notes);
        store.save_notes("one", &notes, "local").unwrap();
        assert!(store.get("one").unwrap().edited_notes.is_none());
    }
    #[test]
    fn upgrades_version_one_library_and_refuses_future_versions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("old.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE meetings(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,duration_ms INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL,model TEXT NOT NULL,state TEXT NOT NULL,error TEXT,notes TEXT,edited_notes TEXT,provider TEXT NOT NULL DEFAULT 'local'); INSERT INTO meetings(id,title,created_at,mode,model,state) VALUES('old','Existing title','2026-01-01','online','small','ready'); PRAGMA user_version=1;").unwrap();
        drop(db);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.get("old").unwrap().title, "Existing title");
        drop(store);
        let db = Connection::open(&path).unwrap();
        db.pragma_update(None, "user_version", 999).unwrap();
        drop(db);
        assert!(Store::open(&path).is_err());
    }
}
