use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const RECENT_WPM_SAMPLE_LIMIT: usize = 20;
pub const WORD_MILESTONES: [u64; 9] = [100, 1_000, 2_000, 5_000, 7_500, 10_000, 20_000, 50_000, 100_000];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WpmSample {
    pub word_count: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredStats {
    #[serde(default)]
    pub total_words: u64,
    #[serde(default)]
    pub dictation_count: u64,
    #[serde(default)]
    pub daily_word_counts: BTreeMap<String, u64>,
    #[serde(default)]
    pub recent_wpm_samples: Vec<WpmSample>,
    #[serde(default)]
    pub achieved_milestones: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DictationStats {
    pub total_words: u64,
    pub dictation_count: u64,
    pub rolling_wpm: u64,
    pub day_streak: u64,
    pub next_milestone: Option<u64>,
    pub next_milestone_progress: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DictationStatsUpdate {
    pub stats: DictationStats,
    pub crossed_milestones: Vec<u64>,
}

impl Default for StoredStats {
    fn default() -> Self {
        Self {
            total_words: 0,
            dictation_count: 0,
            daily_word_counts: BTreeMap::new(),
            recent_wpm_samples: Vec::new(),
            achieved_milestones: Vec::new(),
        }
    }
}

fn stats_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or("Cannot find config directory")?
        .join("echo");
    fs::create_dir_all(&dir).map_err(|e| format!("Dir create error: {e}"))?;
    Ok(dir.join("stats.json"))
}

pub fn load() -> StoredStats {
    stats_path()
        .ok()
        .and_then(|p| load_from_path(&p).ok())
        .unwrap_or_default()
}

fn load_from_path(path: &Path) -> Result<StoredStats, String> {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("Parse error: {e}")),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(StoredStats::default()),
        Err(e) => Err(format!("Read error: {e}")),
    }
}

fn save(stats: &StoredStats) -> Result<(), String> {
    let path = stats_path()?;
    save_to_path(&path, stats)
}

fn save_to_path(path: &Path, stats: &StoredStats) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Dir create error: {e}"))?;
    }
    let json = serde_json::to_string_pretty(stats).map_err(|e| format!("Serialize error: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Write error: {e}"))
}

pub fn view(local_date: &str) -> Result<DictationStats, String> {
    let stats = load();
    view_from_stored(&stats, local_date)
}

pub fn record(
    word_count: u64,
    duration_ms: u64,
    local_date: &str,
) -> Result<DictationStatsUpdate, String> {
    validate_local_date(local_date)?;

    let mut stats = load();
    let before_words = stats.total_words;
    let before_achieved: HashSet<u64> = stats.achieved_milestones.iter().copied().collect();

    if word_count > 0 {
        stats.total_words = stats.total_words.saturating_add(word_count);
        stats.dictation_count = stats.dictation_count.saturating_add(1);
        *stats
            .daily_word_counts
            .entry(local_date.to_string())
            .or_insert(0) += word_count;

        if duration_ms >= 1_000 {
            stats.recent_wpm_samples.insert(
                0,
                WpmSample {
                    word_count,
                    duration_ms,
                },
            );
            stats.recent_wpm_samples.truncate(RECENT_WPM_SAMPLE_LIMIT);
        }
    }

    let crossed_milestones = crossed_milestones(before_words, stats.total_words, &before_achieved);
    for milestone in &crossed_milestones {
        stats.achieved_milestones.push(*milestone);
    }
    stats.achieved_milestones.sort_unstable();
    stats.achieved_milestones.dedup();

    save(&stats)?;

    Ok(DictationStatsUpdate {
        stats: view_from_stored(&stats, local_date)?,
        crossed_milestones,
    })
}

fn view_from_stored(stats: &StoredStats, local_date: &str) -> Result<DictationStats, String> {
    validate_local_date(local_date)?;
    let next_milestone = WORD_MILESTONES
        .iter()
        .copied()
        .find(|milestone| stats.total_words < *milestone);
    let next_milestone_progress = next_milestone
        .map(|milestone| (stats.total_words as f64 / milestone as f64).clamp(0.0, 1.0))
        .unwrap_or(1.0);

    Ok(DictationStats {
        total_words: stats.total_words,
        dictation_count: stats.dictation_count,
        rolling_wpm: rolling_wpm(&stats.recent_wpm_samples),
        day_streak: day_streak(&stats.daily_word_counts, local_date),
        next_milestone,
        next_milestone_progress,
    })
}

#[cfg(test)]
fn count_words(text: &str) -> u64 {
    text.split_whitespace()
        .filter(|word| word.chars().any(|ch| ch.is_alphanumeric()))
        .count() as u64
}

fn crossed_milestones(before_words: u64, total_words: u64, achieved: &HashSet<u64>) -> Vec<u64> {
    WORD_MILESTONES
        .iter()
        .copied()
        .filter(|milestone| before_words < *milestone && total_words >= *milestone)
        .filter(|milestone| !achieved.contains(milestone))
        .collect()
}

fn rolling_wpm(samples: &[WpmSample]) -> u64 {
    let (words, duration_ms) = samples.iter().fold((0u64, 0u64), |(words, duration), sample| {
        if sample.word_count == 0 || sample.duration_ms < 1_000 {
            return (words, duration);
        }
        (
            words.saturating_add(sample.word_count),
            duration.saturating_add(sample.duration_ms),
        )
    });

    if words == 0 || duration_ms == 0 {
        return 0;
    }

    ((words as f64) / (duration_ms as f64 / 60_000.0)).round() as u64
}

fn day_streak(daily_word_counts: &BTreeMap<String, u64>, local_date: &str) -> u64 {
    let Some(today) = date_to_days(local_date) else {
        return 0;
    };
    let active_days: HashSet<i64> = daily_word_counts
        .iter()
        .filter_map(|(date, words)| {
            if *words == 0 {
                None
            } else {
                date_to_days(date)
            }
        })
        .collect();

    let mut cursor = if active_days.contains(&today) {
        today
    } else {
        today - 1
    };
    let mut count = 0;

    while active_days.contains(&cursor) {
        count += 1;
        cursor -= 1;
    }

    count
}

fn validate_local_date(date: &str) -> Result<(), String> {
    date_to_days(date)
        .map(|_| ())
        .ok_or_else(|| "Stats date must use YYYY-MM-DD.".to_string())
}

fn date_to_days(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<i64>().ok()?;
    let day = parts.next()?.parse::<i64>().ok()?;
    if parts.next().is_some() || !valid_date(year, month, day) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

fn valid_date(year: i64, month: i64, day: i64) -> bool {
    if !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    day <= max_day
}

fn days_from_civil(mut year: i64, month: i64, day: i64) -> i64 {
    year -= if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_words_with_punctuation_and_ignores_symbol_only_tokens() {
        assert_eq!(count_words("Hello, world! 100% ready -- yes."), 5);
        assert_eq!(count_words(" ... \n\t"), 0);
    }

    #[test]
    fn milestone_crossing_is_returned_once() {
        let achieved = HashSet::new();
        assert_eq!(crossed_milestones(90, 1_050, &achieved), vec![100, 1_000]);

        let achieved = HashSet::from([100, 1_000]);
        assert!(crossed_milestones(1_050, 2_200, &achieved).contains(&2_000));
        assert!(!crossed_milestones(1_050, 2_200, &achieved).contains(&1_000));
    }

    #[test]
    fn rolling_wpm_uses_valid_recent_samples() {
        let samples = vec![
            WpmSample {
                word_count: 30,
                duration_ms: 30_000,
            },
            WpmSample {
                word_count: 10,
                duration_ms: 10_000,
            },
            WpmSample {
                word_count: 99,
                duration_ms: 999,
            },
        ];

        assert_eq!(rolling_wpm(&samples), 60);
    }

    #[test]
    fn day_streak_counts_today_or_yesterday_backwards() {
        let mut counts = BTreeMap::new();
        counts.insert("2026-05-27".to_string(), 10);
        counts.insert("2026-05-28".to_string(), 12);
        counts.insert("2026-05-29".to_string(), 8);
        assert_eq!(day_streak(&counts, "2026-05-29"), 3);

        counts.remove("2026-05-29");
        assert_eq!(day_streak(&counts, "2026-05-29"), 2);
    }

    #[test]
    fn stored_stats_deserializes_missing_fields_with_defaults() {
        let stats: StoredStats = serde_json::from_str(r#"{"total_words":42}"#).unwrap();
        assert_eq!(stats.total_words, 42);
        assert_eq!(stats.dictation_count, 0);
        assert!(stats.daily_word_counts.is_empty());
        assert!(stats.recent_wpm_samples.is_empty());
        assert!(stats.achieved_milestones.is_empty());
    }
}
