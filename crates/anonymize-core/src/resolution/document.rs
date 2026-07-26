use std::collections::BTreeSet;
use std::ops::Range;
use std::sync::OnceLock;

use crate::byte_offsets::ByteOffsets;
use crate::types::Result;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct CharSpan {
  pub(super) start: u32,
  pub(super) end: u32,
  pub(super) ch: char,
}

#[derive(Debug)]
pub(super) struct WordAnalysis {
  pub(super) spans: Vec<CharSpan>,
  pub(super) boundaries: BTreeSet<u32>,
}

pub(crate) struct ResolutionDocument<'a> {
  text: &'a str,
  line_starts: OnceLock<Vec<usize>>,
  #[cfg(test)]
  line_operations: std::cell::Cell<usize>,
  word_analysis: OnceLock<WordAnalysis>,
}

impl<'a> ResolutionDocument<'a> {
  pub(crate) const fn new(text: &'a str) -> Self {
    Self {
      text,
      line_starts: OnceLock::new(),
      #[cfg(test)]
      line_operations: std::cell::Cell::new(0),
      word_analysis: OnceLock::new(),
    }
  }

  pub(crate) const fn text(&self) -> &'a str {
    self.text
  }

  pub(crate) const fn offsets(&self) -> ByteOffsets<'a> {
    ByteOffsets::new(self.text)
  }

  pub(crate) fn slice_ref(&self, start: u32, end: u32) -> Result<&'a str> {
    self.offsets().slice_ref(start, end)
  }

  pub(crate) fn line_range(
    &self,
    start: usize,
    end: usize,
  ) -> Option<Range<usize>> {
    if start > end || end > self.text.len() {
      return None;
    }
    let starts = self.line_starts.get_or_init(|| {
      let mut starts = vec![0];
      let bytes = self.text.as_bytes();
      let mut index = 0_usize;
      while let Some(byte) = bytes.get(index) {
        #[cfg(test)]
        self
          .line_operations
          .set(self.line_operations.get().saturating_add(1));
        let delimiter_len = match byte {
          b'\r'
            if bytes.get(index.saturating_add(1)).copied() == Some(b'\n') =>
          {
            2
          }
          b'\r' | b'\n' => 1,
          _ => {
            index = index.saturating_add(1);
            continue;
          }
        };
        index = index.saturating_add(delimiter_len);
        starts.push(index);
      }
      starts
    });
    let mut left = 0_usize;
    let mut right = starts.len();
    while left < right {
      #[cfg(test)]
      self
        .line_operations
        .set(self.line_operations.get().saturating_add(1));
      let middle = left.midpoint(right);
      if *starts.get(middle)? <= start {
        left = middle.saturating_add(1);
      } else {
        right = middle;
      }
    }
    let line_index = left.checked_sub(1)?;
    let line_start = *starts.get(line_index)?;
    let line_end = starts.get(line_index.saturating_add(1)).map_or(
      self.text.len(),
      |next_start| {
        let delimiter_len =
          if next_start.checked_sub(2).and_then(|delimiter_start| {
            self.text.as_bytes().get(delimiter_start..*next_start)
          }) == Some(b"\r\n".as_slice())
          {
            2
          } else {
            1
          };
        next_start.saturating_sub(delimiter_len)
      },
    );
    (end <= line_end).then_some(line_start..line_end)
  }

  pub(super) fn word_analysis(&self) -> &WordAnalysis {
    self.word_analysis.get_or_init(|| {
      let spans = char_spans(self.text);
      let boundaries = word_boundaries(&spans);
      WordAnalysis { spans, boundaries }
    })
  }
}

fn char_spans(text: &str) -> Vec<CharSpan> {
  let mut spans = Vec::new();
  let mut offset = 0_u32;

  for ch in text.chars() {
    let width = u32::try_from(ch.len_utf8()).unwrap_or(u32::MAX);
    let end = offset.saturating_add(width);
    spans.push(CharSpan {
      start: offset,
      end,
      ch,
    });
    offset = end;
  }

  spans
}

fn word_boundaries(spans: &[CharSpan]) -> BTreeSet<u32> {
  let mut boundaries = BTreeSet::new();
  let mut run_start = None::<u32>;
  let mut run_end = None::<u32>;

  for (index, span) in spans.iter().enumerate() {
    if is_word_body(span.ch) || is_word_connector_between(spans, index) {
      if run_start.is_none() {
        run_start = Some(span.start);
      }
      run_end = Some(span.end);
      continue;
    }

    if let (Some(start), Some(end)) = (run_start.take(), run_end.take()) {
      boundaries.insert(start);
      boundaries.insert(end);
    }
  }

  if let (Some(start), Some(end)) = (run_start, run_end) {
    boundaries.insert(start);
    boundaries.insert(end);
  }

  boundaries
}

fn is_word_connector_between(spans: &[CharSpan], index: usize) -> bool {
  let Some(span) = spans.get(index) else {
    return false;
  };
  if !is_word_connector(span.ch) {
    return false;
  }

  let Some(previous) = index.checked_sub(1).and_then(|prev| spans.get(prev))
  else {
    return false;
  };
  let Some(next) = spans.get(index.saturating_add(1)) else {
    return false;
  };

  is_word_body(previous.ch) && is_word_body(next.ch)
}

const fn is_word_connector(ch: char) -> bool {
  matches!(ch, '\'' | '\u{2018}' | '\u{2019}' | '\u{02bc}' | '\u{ff07}')
}

fn is_word_body(ch: char) -> bool {
  ch.is_alphanumeric() || is_combining_mark(ch)
}

const fn is_combining_mark(ch: char) -> bool {
  matches!(
    ch,
    '\u{0300}'..='\u{036f}'
      | '\u{1ab0}'..='\u{1aff}'
      | '\u{1dc0}'..='\u{1dff}'
      | '\u{20d0}'..='\u{20ff}'
      | '\u{fe20}'..='\u{fe2f}'
  )
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::ResolutionDocument;

  fn generated_lines(
    segments: &[String],
    ending_codes: &[u8],
  ) -> (String, Vec<std::ops::Range<usize>>) {
    let mut text = String::new();
    let mut ranges = Vec::with_capacity(segments.len());
    for (index, segment) in segments.iter().enumerate() {
      let start = text.len();
      text.push_str(segment);
      ranges.push(start..text.len());
      if index.saturating_add(1) == segments.len() {
        continue;
      }
      let ending = ending_codes
        .get(index.checked_rem(ending_codes.len()).unwrap_or_default())
        .copied()
        .unwrap_or_default();
      text.push_str(match ending % 3 {
        0 => "\n",
        1 => "\r\n",
        _ => "\r",
      });
    }
    (text, ranges)
  }

  proptest! {
    #[test]
    fn generated_line_index_matches_reference_model(
      segments in proptest::collection::vec("[A-Za-z0-9 ]{0,16}", 1..32),
      ending_codes in proptest::collection::vec(any::<u8>(), 0..32),
      queries in proptest::collection::vec((any::<usize>(), any::<usize>()), 0..64),
    ) {
      let (text, ranges) = generated_lines(&segments, &ending_codes);
      let document = ResolutionDocument::new(&text);
      for (first, second) in queries {
        let divisor = text.len().saturating_add(1);
        let left = first.checked_rem(divisor).unwrap_or_default();
        let right = second.checked_rem(divisor).unwrap_or_default();
        let start = left.min(right);
        let end = left.max(right);
        let expected = ranges
          .iter()
          .find(|range| start >= range.start && end <= range.end)
          .cloned();

        prop_assert_eq!(document.line_range(start, end), expected);
      }
    }
  }

  #[test]
  fn word_analysis_is_built_once_and_reused() {
    let document = ResolutionDocument::new("Jean d’Arc");
    let first = document.word_analysis();
    let second = document.word_analysis();

    assert!(std::ptr::eq(first, second));
    assert!(first.boundaries.contains(&0));
    assert!(first.boundaries.contains(&12));
  }

  #[test]
  fn line_ranges_are_built_lazily_and_reused() {
    let document = ResolutionDocument::new("first\nsecond");

    assert!(document.line_starts.get().is_none());
    assert_eq!(document.line_range(6, 12), Some(6..12));
    let first = document.line_starts.get().map(Vec::as_ptr);
    assert!(first.is_some());
    assert_eq!(document.line_range(0, 5), Some(0..5));
    assert_eq!(first, document.line_starts.get().map(Vec::as_ptr));
  }

  #[test]
  fn line_ranges_support_all_line_endings() {
    for (text, range) in [
      ("first\nsecond", 6..12),
      ("first\r\nsecond", 7..13),
      ("first\rsecond", 6..12),
    ] {
      let document = ResolutionDocument::new(text);
      assert_eq!(document.line_range(range.start, range.end), Some(range));
    }
  }

  #[test]
  fn dense_line_queries_have_bounded_structural_work() {
    const LINE_COUNT: usize = 10_000;
    let text = "x\n".repeat(LINE_COUNT);
    let document = ResolutionDocument::new(&text);

    for index in 0..LINE_COUNT {
      let start = index.saturating_mul(2);
      assert_eq!(
        document.line_range(start, start + 1),
        Some(start..start + 1)
      );
    }

    let linear_build_work = text.len();
    let logarithmic_query_work = LINE_COUNT.saturating_mul(20);
    assert!(
      document.line_operations.get()
        <= linear_build_work.saturating_add(logarithmic_query_work)
    );
  }
}
