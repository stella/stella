use std::collections::BTreeSet;
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
  word_analysis: OnceLock<WordAnalysis>,
}

impl<'a> ResolutionDocument<'a> {
  pub(crate) const fn new(text: &'a str) -> Self {
    Self {
      text,
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
  use super::ResolutionDocument;

  #[test]
  fn word_analysis_is_built_once_and_reused() {
    let document = ResolutionDocument::new("Jean d’Arc");
    let first = document.word_analysis();
    let second = document.word_analysis();

    assert!(std::ptr::eq(first, second));
    assert!(first.boundaries.contains(&0));
    assert!(first.boundaries.contains(&12));
  }
}
