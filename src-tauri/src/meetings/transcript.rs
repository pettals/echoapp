use super::storage::Segment;

fn normalized(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Remove only long, exact word runs shared by overlapping microphone and
/// loopback segments. Raw ASR segments remain immutable in SQLite and available
/// in the Original view. Distinct and simultaneous microphone speech survives.
pub fn assembled(segments: &[Segment]) -> Vec<Segment> {
    let mut stitched = Vec::<Segment>::new();
    for segment in segments {
        let mut next = segment.clone();
        if let Some(previous) = stitched.iter().rev().find(|s| s.source == segment.source) {
            if previous.end_ms > segment.start_ms {
                let words: Vec<_> = next.text.split_whitespace().collect();
                let before: Vec<_> = previous.text.split_whitespace().map(normalized).collect();
                let overlap = (1..=words.len().min(before.len()).min(12))
                    .rev()
                    .find(|n| {
                        before[before.len() - n..].iter().eq(words[..*n]
                            .iter()
                            .map(|s| normalized(s))
                            .collect::<Vec<_>>()
                            .iter())
                    })
                    .unwrap_or(0);
                next.text = words[overlap..].join(" ");
            }
        }
        stitched.push(next);
    }
    let computers: Vec<_> = stitched
        .iter()
        .filter(|s| s.source == "computer" && !s.text.is_empty())
        .collect();
    stitched
        .iter()
        .filter_map(|segment| {
            let mut result = segment.clone();
            if segment.source == "microphone" {
                let original: Vec<_> = segment.text.split_whitespace().collect();
                let words: Vec<_> = original.iter().map(|w| normalized(w)).collect();
                let mut echo = vec![false; words.len()];
                for other in computers
                    .iter()
                    .filter(|s| s.start_ms < segment.end_ms && s.end_ms > segment.start_ms)
                {
                    let reference: Vec<_> = other.text.split_whitespace().map(normalized).collect();
                    let mut previous = vec![0usize; reference.len() + 1];
                    for (i, word) in words.iter().enumerate() {
                        let mut next = vec![0; reference.len() + 1];
                        for (j, reference) in reference.iter().enumerate() {
                            if !word.is_empty() && word == reference {
                                next[j + 1] = previous[j] + 1;
                                if next[j + 1] >= 4 {
                                    for flag in &mut echo[i + 1 - next[j + 1]..=i] {
                                        *flag = true;
                                    }
                                }
                            }
                        }
                        previous = next;
                    }
                }
                result.text = original
                    .into_iter()
                    .enumerate()
                    .filter_map(|(i, w)| (!echo[i]).then_some(w))
                    .collect::<Vec<_>>()
                    .join(" ");
            }
            (!result.text.trim().is_empty()).then_some(result)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn segment(id: i64, source: &str, text: &str, start: u64) -> Segment {
        Segment {
            id,
            start_ms: start,
            end_ms: start + 15000,
            source: source.into(),
            text: text.into(),
        }
    }
    #[test]
    fn loopback_echo_is_removed_but_distinct_overlapping_speech_and_original_are_preserved() {
        let source = vec![
            segment(
                0,
                "microphone",
                "I agree we should release on Friday and I can prepare the announcement.",
                0,
            ),
            segment(1, "computer", "We should release on Friday.", 0),
            segment(2, "microphone", "We should release on Friday.", 30000),
        ];
        let transcript = assembled(&source);
        assert_eq!(
            transcript[0].text,
            "I agree and I can prepare the announcement."
        );
        assert_eq!(transcript[2].text, "We should release on Friday.");
        assert!(source[0].text.contains("release on Friday"));
    }
    #[test]
    fn short_acknowledgements_are_not_removed() {
        let source = vec![
            segment(0, "microphone", "Yes I agree", 0),
            segment(1, "computer", "Yes I agree", 0),
        ];
        assert_eq!(assembled(&source).len(), 2);
    }
    #[test]
    fn overlapping_chunks_do_not_repeat_boundary_words() {
        let source = vec![
            segment(0, "microphone", "We should ship on Friday", 0),
            segment(2, "microphone", "On Friday we will meet again", 14500),
        ];
        let result = assembled(&source);
        assert_eq!(result[1].text, "we will meet again");
        assert_eq!(source[1].text, "On Friday we will meet again");
    }
}
