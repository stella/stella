use std::sync::Arc;

use unicode_normalization::IsNormalized;
use unicode_normalization::char::{
  canonical_combining_class, compose, decompose_canonical,
};
use unicode_normalization::is_nfc_quick;

use crate::{Error, Result, TextSpan};

// Canonical ordering and recomposition follow Unicode Standard Annex #15;
// unicode-normalization supplies the versioned character data and primitives.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MappedScalar {
  character: char,
  source_start: usize,
  source_end: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScalarOffset {
  normalized_start: usize,
  normalized_end: usize,
  source_start: usize,
  source_end: usize,
  source_boundary_after: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum OffsetMap {
  Identity,
  Scalars(Arc<[ScalarOffset]>),
}

/// An NFC-normalized text view with offsets back to the source text.
///
/// Build this through [`crate::BlockAnalysis::normalized_text`]. The block
/// owns and lazily caches one view, so independent rules never repeat Unicode
/// normalization for the same analysis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NormalizedText {
  text: Arc<str>,
  source_len: usize,
  offsets: OffsetMap,
}

impl NormalizedText {
  pub(crate) fn from_source(source: Arc<str>) -> Self {
    if source.is_ascii() || is_nfc_quick(source.chars()) == IsNormalized::Yes {
      let source_len = source.len();
      return Self {
        text: source,
        source_len,
        offsets: OffsetMap::Identity,
      };
    }

    let mut decomposed = Vec::new();
    let mut pending = Vec::new();
    for (source_start, character) in source.char_indices() {
      let source_end = source_start.saturating_add(character.len_utf8());
      decompose_canonical(character, |decomposed_character| {
        if canonical_combining_class(decomposed_character) == 0 {
          flush_canonical_sequence(&mut pending, &mut decomposed);
        }
        pending.push(MappedScalar {
          character: decomposed_character,
          source_start,
          source_end,
        });
      });
    }
    flush_canonical_sequence(&mut pending, &mut decomposed);

    let composed = canonical_compose(decomposed);
    let mut normalized = String::with_capacity(source.len());
    let mut offsets = Vec::with_capacity(composed.len());
    let mut source_boundary_after = 0;
    for scalar in composed {
      let normalized_start = normalized.len();
      normalized.push(scalar.character);
      source_boundary_after = source_boundary_after.max(scalar.source_end);
      offsets.push(ScalarOffset {
        normalized_start,
        normalized_end: normalized.len(),
        source_start: scalar.source_start,
        source_end: scalar.source_end,
        source_boundary_after,
      });
    }

    let source_len = source.len();
    if normalized == source.as_ref() {
      Self {
        text: source,
        source_len,
        offsets: OffsetMap::Identity,
      }
    } else {
      Self {
        text: Arc::from(normalized),
        source_len,
        offsets: OffsetMap::Scalars(offsets.into()),
      }
    }
  }

  #[must_use]
  pub fn as_str(&self) -> &str {
    &self.text
  }

  /// Maps a normalized UTF-8 byte span to the source text.
  ///
  /// A composed scalar can represent several source scalars. Canonically
  /// reordered combining marks can also change order. In both cases the
  /// returned span is the smallest contiguous source range covering every
  /// scalar represented by the normalized span.
  pub fn original_span(&self, normalized_span: TextSpan) -> Result<TextSpan> {
    let start = usize::try_from(normalized_span.start())
      .map_err(|_| invalid_span(normalized_span))?;
    let end = usize::try_from(normalized_span.end())
      .map_err(|_| invalid_span(normalized_span))?;
    if self.text.get(start..end).is_none() {
      return Err(invalid_span(normalized_span));
    }

    match &self.offsets {
      OffsetMap::Identity => Ok(normalized_span),
      OffsetMap::Scalars(offsets) => {
        if start == end {
          return self.empty_original_span(start, normalized_span, offsets);
        }

        let first =
          offsets.partition_point(|offset| offset.normalized_end <= start);
        let last =
          offsets.partition_point(|offset| offset.normalized_start < end);
        let selected = offsets
          .get(first..last)
          .ok_or_else(|| invalid_span(normalized_span))?;
        let source_start = selected
          .iter()
          .map(|offset| offset.source_start)
          .min()
          .ok_or_else(|| invalid_span(normalized_span))?;
        let source_end = selected
          .iter()
          .map(|offset| offset.source_end)
          .max()
          .ok_or_else(|| invalid_span(normalized_span))?;
        checked_source_span(source_start, source_end, normalized_span)
      }
    }
  }

  fn empty_original_span(
    &self,
    normalized_offset: usize,
    normalized_span: TextSpan,
    offsets: &[ScalarOffset],
  ) -> Result<TextSpan> {
    let source_offset = if normalized_offset == 0 {
      0
    } else if normalized_offset == self.text.len() {
      self.source_len
    } else {
      let previous = offsets
        .partition_point(|offset| offset.normalized_end <= normalized_offset);
      previous
        .checked_sub(1)
        .and_then(|index| offsets.get(index))
        .map(|offset| offset.source_boundary_after)
        .ok_or_else(|| invalid_span(normalized_span))?
    };
    checked_source_span(source_offset, source_offset, normalized_span)
  }
}

fn flush_canonical_sequence(
  pending: &mut Vec<MappedScalar>,
  output: &mut Vec<MappedScalar>,
) {
  pending.sort_by_key(|scalar| canonical_combining_class(scalar.character));
  output.append(pending);
}

fn canonical_compose(decomposed: Vec<MappedScalar>) -> Vec<MappedScalar> {
  let mut output = Vec::<MappedScalar>::with_capacity(decomposed.len());
  let mut starter_index = None::<usize>;
  let mut last_combining_class = 0;

  for scalar in decomposed {
    let combining_class = canonical_combining_class(scalar.character);
    let composition = starter_index.and_then(|index| {
      output.get(index).and_then(|starter| {
        ((last_combining_class < combining_class) || last_combining_class == 0)
          .then(|| compose(starter.character, scalar.character))
          .flatten()
      })
    });
    if let (Some(index), Some(character)) = (starter_index, composition) {
      if let Some(starter) = output.get_mut(index) {
        starter.character = character;
        starter.source_start = starter.source_start.min(scalar.source_start);
        starter.source_end = starter.source_end.max(scalar.source_end);
      }
      continue;
    }

    if combining_class == 0 {
      starter_index = Some(output.len());
    }
    last_combining_class = combining_class;
    output.push(scalar);
  }
  output
}

fn checked_source_span(
  start: usize,
  end: usize,
  normalized_span: TextSpan,
) -> Result<TextSpan> {
  let start =
    u32::try_from(start).map_err(|_| invalid_span(normalized_span))?;
  let end = u32::try_from(end).map_err(|_| invalid_span(normalized_span))?;
  TextSpan::new(start, end)
}

const fn invalid_span(span: TextSpan) -> Error {
  Error::NormalizedTextSpanOutOfBounds {
    start: span.start(),
    end: span.end(),
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Arc;

  use proptest::prelude::*;
  use unicode_normalization::UnicodeNormalization;

  use super::NormalizedText;
  use crate::engine::{ExecutionCounters, analyze_block};
  use crate::{BlockId, DocumentBlock, Error, Result, TextSpan};

  fn test_span(start: usize, end: usize) -> Result<TextSpan> {
    let start = u32::try_from(start).map_err(|_| Error::InvalidTextSpan {
      start: u32::MAX,
      end: u32::MAX,
    })?;
    let end = u32::try_from(end).map_err(|_| Error::InvalidTextSpan {
      start,
      end: u32::MAX,
    })?;
    TextSpan::new(start, end)
  }

  #[test]
  fn decomposed_phrase_maps_to_the_exact_source_bytes() -> Result<()> {
    let source = "Předmět — da\u{301}le take\u{301} — konec";
    let normalized = NormalizedText::from_source(Arc::from(source));
    assert_eq!(normalized.as_str(), "Předmět — dále také — konec");

    let phrase = "dále také";
    let Some(start) = normalized.as_str().find(phrase) else {
      return Err(Error::NormalizedTextSpanOutOfBounds { start: 0, end: 0 });
    };
    let mapped =
      normalized.original_span(test_span(start, start + phrase.len())?)?;
    let mapped_start =
      usize::try_from(mapped.start()).map_err(|_| Error::InvalidTextSpan {
        start: mapped.start(),
        end: mapped.end(),
      })?;
    let mapped_end =
      usize::try_from(mapped.end()).map_err(|_| Error::InvalidTextSpan {
        start: mapped.start(),
        end: mapped.end(),
      })?;
    assert_eq!(
      source.get(mapped_start..mapped_end),
      Some("da\u{301}le take\u{301}")
    );
    Ok(())
  }

  #[test]
  fn composition_and_reordering_return_covering_source_ranges() -> Result<()> {
    let hangul_source = "x\u{1100}\u{1161}y";
    let hangul = NormalizedText::from_source(Arc::from(hangul_source));
    assert_eq!(hangul.as_str(), "x가y");
    let hangul_start = "x".len();
    assert_eq!(
      hangul
        .original_span(test_span(hangul_start, hangul_start + "가".len())?)?,
      test_span("x".len(), "x\u{1100}\u{1161}".len())?
    );

    let reordered_source = "a\u{315}\u{300}";
    let reordered = NormalizedText::from_source(Arc::from(reordered_source));
    assert_eq!(reordered.as_str(), "à\u{315}");
    assert_eq!(
      reordered.original_span(test_span(0, "à".len())?)?,
      test_span(0, reordered_source.len())?
    );
    Ok(())
  }

  #[test]
  fn empty_and_invalid_boundaries_are_handled_explicitly() -> Result<()> {
    let source = "e\u{301}x";
    let normalized = NormalizedText::from_source(Arc::from(source));
    assert_eq!(normalized.as_str(), "éx");
    assert_eq!(
      normalized.original_span(test_span(0, 0)?)?,
      test_span(0, 0)?
    );
    assert_eq!(
      normalized.original_span(test_span("é".len(), "é".len())?)?,
      test_span("e\u{301}".len(), "e\u{301}".len())?
    );
    assert_eq!(
      normalized.original_span(test_span("éx".len(), "éx".len())?)?,
      test_span(source.len(), source.len())?
    );
    assert!(
      normalized.original_span(test_span(1, 1)?).is_err(),
      "a byte offset inside a UTF-8 scalar must be rejected"
    );
    Ok(())
  }

  #[test]
  fn block_owns_one_lazy_view_and_ascii_keeps_its_allocation() -> Result<()> {
    let block = DocumentBlock::new(BlockId::new("block")?, "plain ASCII")?;
    let analysis = analyze_block(&block, &ExecutionCounters::default())?;
    let first = analysis.normalized_text();
    let second = analysis.normalized_text();
    assert!(
      std::ptr::eq(first, second),
      "a block must share one normalized view across rules"
    );
    assert!(
      std::ptr::eq(analysis.text().as_ptr(), first.as_str().as_ptr()),
      "normalized ASCII must retain the source allocation"
    );
    Ok(())
  }

  proptest! {
    #[test]
    fn normalization_matches_the_unicode_reference(source in any::<String>()) {
      let actual = NormalizedText::from_source(Arc::from(source.as_str()));
      let expected = source.nfc().collect::<String>();
      prop_assert_eq!(actual.as_str(), expected);
    }

    #[test]
    fn every_normalized_scalar_maps_to_valid_source_boundaries(
      source in any::<String>(),
    ) {
      let normalized = NormalizedText::from_source(Arc::from(source.as_str()));
      for (start, character) in normalized.as_str().char_indices() {
        let Some(end) = start.checked_add(character.len_utf8()) else {
          prop_assert!(false, "generated normalized scalar offset overflowed");
          continue;
        };
        let Ok(span) = test_span(start, end) else {
          prop_assert!(false, "generated normalized text exceeded u32 offsets");
          continue;
        };
        let mapped = normalized.original_span(span);
        prop_assert!(mapped.is_ok(), "scalar span failed to map: {mapped:?}");
        if let Ok(mapped) = mapped {
          let mapped_start = usize::try_from(mapped.start());
          let mapped_end = usize::try_from(mapped.end());
          prop_assert!(mapped_start.is_ok() && mapped_end.is_ok());
          if let (Ok(mapped_start), Ok(mapped_end)) = (mapped_start, mapped_end) {
            prop_assert!(
              source.get(mapped_start..mapped_end).is_some(),
              "mapped span is not a source UTF-8 boundary"
            );
          }
        }
      }
    }
  }
}
