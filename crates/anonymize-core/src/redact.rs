use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use unicode_segmentation::UnicodeSegmentation;

use crate::byte_offsets::ByteOffsets;
use crate::normalize::placeholder_fallback;
use crate::placeholders::build_placeholder_map;
use crate::session::{
  RedactionSession, SessionPlaceholderInput, SessionPlaceholderPlan,
  SessionTimestamp, SessionUpdate,
};
use crate::types::{
  Entity, EntityKind, MaskConfig, MaskDirection, Operator, OperatorConfig,
  OperatorEntry, OperatorType, PlaceholderMap, RedactionEntry,
  RedactionReplacement, RedactionResult, Result, validate_redaction_text,
};

pub fn redact_text(
  full_text: &str,
  entities: &[Entity],
  config: &OperatorConfig,
) -> Result<RedactionResult> {
  validate_redaction_text(full_text)?;
  redact_text_inner(RedactTextOptions {
    full_text,
    entities,
    config,
    session: None,
  })
}

/// Inputs for transactional cross-document redaction.
pub struct RedactTextWithSessionParams<'a> {
  pub full_text: &'a str,
  pub entities: &'a [Entity],
  pub config: &'a OperatorConfig,
  pub session: &'a mut RedactionSession,
  pub observed_at: Option<SessionTimestamp>,
}

/// Redacts text while reusing stable placeholders from a session.
///
/// The session is updated only when the complete redaction succeeds.
pub fn redact_text_with_session(
  params: RedactTextWithSessionParams<'_>,
) -> Result<RedactionResult> {
  let RedactTextWithSessionParams {
    full_text,
    entities,
    config,
    session,
    observed_at,
  } = params;
  validate_redaction_text(full_text)?;
  session.ensure_active(observed_at)?;
  redact_text_inner(RedactTextOptions {
    full_text,
    entities,
    config,
    session: Some(session),
  })
}

struct RedactTextOptions<'a> {
  full_text: &'a str,
  entities: &'a [Entity],
  config: &'a OperatorConfig,
  session: Option<&'a mut RedactionSession>,
}

fn redact_text_inner(
  options: RedactTextOptions<'_>,
) -> Result<RedactionResult> {
  let RedactTextOptions {
    full_text,
    entities,
    config,
    session,
  } = options;
  if entities.is_empty() {
    if let Some(active_session) = session {
      active_session.validate_reserved_text(full_text)?;
    }
    return Ok(RedactionResult {
      redacted_text: full_text.to_owned(),
      redaction_map: Vec::new(),
      operator_map: Vec::new(),
      replacements: Vec::new(),
      entity_count: 0,
    });
  }

  let offsets = ByteOffsets::new(full_text);
  let mut sorted = redaction_spans(full_text, entities, &offsets)?;
  sorted.sort_by_key(|span| span.entity.start);

  let mut kept = Vec::<RedactionSpan<'_>>::new();
  let mut masked = Vec::<RedactionSpan<'_>>::new();
  let mut redacted = Vec::<RedactionSpan<'_>>::new();
  for span in sorted {
    match operator_for(config, &span.entity.label) {
      Operator::Keep => kept.push(span),
      Operator::Mask(_) => masked.push(span),
      Operator::Replace | Operator::Redact => redacted.push(span),
    }
  }
  // Existing contract remains within each operator class: the first accepted
  // span wins overlaps. Kept spans are resolved separately so they cannot
  // suppress a nested span that must still be redacted.
  let kept = non_overlapping_spans(kept);
  let masked = non_overlapping_spans(masked);
  let redacted = non_overlapping_spans(redacted);
  let mask_replacements = remove_redacted_mask_overlaps(
    mask_replacement_spans(&masked, config)?,
    &redacted,
  );

  let mut operator_spans = kept
    .iter()
    .chain(&masked)
    .chain(&redacted)
    .collect::<Vec<_>>();
  operator_spans.sort_by_key(|span| span.entity.start);
  let mut session_update = None;
  let placeholder_map = match session.as_deref() {
    Some(active_session) => {
      let inputs = operator_spans
        .iter()
        .map(|span| SessionPlaceholderInput {
          entity: span.entity,
          original: redaction_original_text_ref(span),
          persist: operator_for(config, &span.entity.label)
            == &Operator::Replace,
        })
        .collect::<Vec<_>>();
      let reserved_sources =
        session_reserved_sources(SessionReservedSourcesParams {
          full_text,
          redacted: &redacted,
          config,
        });
      let SessionPlaceholderPlan {
        placeholder_map,
        update,
      } = active_session.plan_placeholder_map(&inputs, &reserved_sources)?;
      session_update = Some(update);
      placeholder_map
    }
    None => build_placeholder_map(entities, full_text),
  };

  let mut operator_map = Vec::<OperatorEntry>::new();
  for span in operator_spans {
    let placeholder = placeholder_map.get_entity(span.entity).map_or_else(
      || Cow::Owned(placeholder_fallback(&span.entity.label)),
      Cow::Borrowed,
    );
    let operator = operator_for(config, &span.entity.label).operator_type();
    set_operator_entry(&mut operator_map, &placeholder, operator);
  }

  let mut rendered = render_selected_spans(&RenderOptions {
    full_text,
    offsets: &offsets,
    placeholder_map: &placeholder_map,
    config,
    redacted: &redacted,
    mask_replacements: &mask_replacements,
    track_placeholder_counts: session_update.is_some(),
  })?;
  rendered.commit_session_update(session, session_update)?;

  Ok(RedactionResult {
    redacted_text: rendered.text,
    redaction_map: rendered.map,
    operator_map,
    replacements: rendered.replacements,
    entity_count: kept
      .len()
      .saturating_add(masked.len())
      .saturating_add(redacted.len()),
  })
}

#[derive(Clone, Copy)]
struct SessionReservedSourcesParams<'borrow, 'text> {
  full_text: &'text str,
  redacted: &'borrow [RedactionSpan<'text>],
  config: &'text OperatorConfig,
}

fn session_reserved_sources<'text>(
  params: SessionReservedSourcesParams<'_, 'text>,
) -> Vec<&'text str> {
  let SessionReservedSourcesParams {
    full_text,
    redacted,
    config,
  } = params;
  let mut sources = vec![full_text];
  if redacted
    .iter()
    .any(|span| operator_for(config, &span.entity.label) == &Operator::Redact)
  {
    sources.push(&config.redact_string);
  }
  sources
}

#[must_use]
pub fn deanonymise(
  redacted_text: &str,
  redaction_map: &[RedactionEntry],
) -> String {
  let mut result = redacted_text.to_owned();

  for entry in redaction_map {
    result = result.replace(&entry.placeholder, &entry.original);
  }

  result
}

struct RedactionSpan<'a> {
  entity: &'a Entity,
  source_text: &'a str,
}

struct MaskReplacementSpan<'a> {
  start: u32,
  end: u32,
  masking_character: &'a str,
}

struct RenderOptions<'text, 'config, 'borrow> {
  full_text: &'text str,
  offsets: &'borrow ByteOffsets<'text>,
  placeholder_map: &'borrow PlaceholderMap,
  config: &'config OperatorConfig,
  redacted: &'borrow [RedactionSpan<'text>],
  mask_replacements: &'borrow [MaskReplacementSpan<'config>],
  track_placeholder_counts: bool,
}

struct RenderedRedactions {
  text: String,
  map: Vec<RedactionEntry>,
  replacements: Vec<RedactionReplacement>,
  placeholder_counts: BTreeMap<String, usize>,
}

struct RenderedReplacementOutput {
  text: String,
  replacements: Vec<RedactionReplacement>,
}

impl RenderedReplacementOutput {
  fn push(&mut self, replacement: RedactionReplacement) {
    self.text.push_str(&replacement.replacement);
    self.replacements.push(replacement);
  }

  fn push_source(
    &mut self,
    options: &RenderOptions<'_, '_, '_>,
    (start, end): (u32, u32),
  ) -> Result<()> {
    self.text.push_str(source_slice(
      options.full_text,
      options.offsets,
      start,
      end,
    )?);
    Ok(())
  }
}

impl RenderedRedactions {
  fn commit_session_update(
    &mut self,
    session: Option<&mut RedactionSession>,
    update: Option<SessionUpdate>,
  ) -> Result<()> {
    let (Some(active_session), Some(update)) = (session, update) else {
      return Ok(());
    };
    active_session
      .validate_rendered_placeholders(&self.text, &self.placeholder_counts)?;
    active_session.apply_update(update);
    active_session.canonicalize_redaction_map(&mut self.map);
    Ok(())
  }
}

#[derive(Clone, Copy)]
enum NextSpan<'borrow, 'text, 'config> {
  Redacted(&'borrow RedactionSpan<'text>),
  Mask(&'borrow MaskReplacementSpan<'config>),
}

fn render_selected_spans(
  options: &RenderOptions<'_, '_, '_>,
) -> Result<RenderedRedactions> {
  let mut output = RenderedReplacementOutput {
    text: String::with_capacity(options.full_text.len()),
    replacements: Vec::new(),
  };
  let mut map = Vec::<RedactionEntry>::new();
  let mut placeholders = HashSet::<String>::new();
  let mut placeholder_counts = BTreeMap::<String, usize>::new();
  let mut cursor = 0;
  let mut redacted_index = 0;
  let mut mask_index = 0;

  loop {
    let next = match (
      options.redacted.get(redacted_index),
      options.mask_replacements.get(mask_index),
    ) {
      (Some(redacted), Some(mask)) if redacted.entity.start <= mask.start => {
        NextSpan::Redacted(redacted)
      }
      (_, Some(mask)) => NextSpan::Mask(mask),
      (Some(redacted), None) => NextSpan::Redacted(redacted),
      (None, None) => break,
    };
    let (start, end) = match next {
      NextSpan::Redacted(span) => (span.entity.start, span.entity.end),
      NextSpan::Mask(span) => (span.start, span.end),
    };
    if start > cursor {
      output.push_source(options, (cursor, start))?;
    }

    match next {
      NextSpan::Mask(span) => {
        output.push(RedactionReplacement {
          start,
          end,
          replacement: span.masking_character.to_owned(),
        });
        mask_index = mask_index.saturating_add(1);
      }
      NextSpan::Redacted(span) => {
        let entity = span.entity;
        let placeholder =
          options.placeholder_map.get_entity(entity).map_or_else(
            || Cow::Owned(placeholder_fallback(&entity.label)),
            Cow::Borrowed,
          );
        let operator = operator_for(options.config, &entity.label);
        let replacement = match operator {
          Operator::Replace => {
            if options.track_placeholder_counts {
              let count = placeholder_counts
                .entry(placeholder.to_string())
                .or_insert(0);
              *count = count.saturating_add(1);
            }
            Some(placeholder.to_string())
          }
          Operator::Redact => Some(options.config.redact_string.clone()),
          Operator::Mask(mask) => Some(mask_text(span.source_text, mask)),
          Operator::Keep => None,
        };
        if let Some(replacement) = replacement {
          output.push(RedactionReplacement {
            start,
            end,
            replacement,
          });
        }
        if operator == &Operator::Replace
          && !placeholders.contains(placeholder.as_ref())
        {
          let placeholder = placeholder.into_owned();
          placeholders.insert(placeholder.clone());
          map.push(RedactionEntry {
            placeholder,
            original: redaction_original_text(span),
          });
        }
        redacted_index = redacted_index.saturating_add(1);
      }
    }
    cursor = end;
  }

  let full_text_len = options.offsets.len()?;
  if cursor < full_text_len {
    output.push_source(options, (cursor, full_text_len))?;
  }
  Ok(RenderedRedactions {
    text: output.text,
    map,
    replacements: output.replacements,
    placeholder_counts,
  })
}

fn non_overlapping_spans(
  spans: Vec<RedactionSpan<'_>>,
) -> Vec<RedactionSpan<'_>> {
  let mut non_overlapping = Vec::with_capacity(spans.len());
  let mut last_end = 0;
  for span in spans {
    if span.entity.start >= last_end {
      last_end = span.entity.end;
      non_overlapping.push(span);
    }
  }
  non_overlapping
}

fn redaction_spans<'a>(
  full_text: &'a str,
  entities: &'a [Entity],
  offsets: &ByteOffsets<'_>,
) -> Result<Vec<RedactionSpan<'a>>> {
  let mut resolved = Vec::with_capacity(entities.len());

  for entity in entities {
    // Empty spans would insert without redacting.
    if entity.start >= entity.end {
      return Err(crate::types::Error::InvalidSpan {
        start: entity.start,
        end: entity.end,
      });
    }

    resolved.push(RedactionSpan {
      entity,
      source_text: source_slice(full_text, offsets, entity.start, entity.end)?,
    });
  }

  Ok(resolved)
}

fn source_slice<'a>(
  full_text: &'a str,
  offsets: &ByteOffsets<'_>,
  start: u32,
  end: u32,
) -> Result<&'a str> {
  if start > end {
    return Err(crate::types::Error::InvalidSpan { start, end });
  }

  let start_byte = offsets.validate_offset(start)?;
  let end_byte = offsets.validate_offset(end)?;
  full_text
    .get(start_byte..end_byte)
    .ok_or(crate::types::Error::InvalidSpan { start, end })
}

const DEFAULT_OPERATOR: Operator = Operator::Replace;

fn operator_for<'a>(config: &'a OperatorConfig, label: &str) -> &'a Operator {
  config.operators.get(label).unwrap_or(&DEFAULT_OPERATOR)
}

fn mask_replacement_spans<'a>(
  spans: &[RedactionSpan<'_>],
  config: &'a OperatorConfig,
) -> Result<Vec<MaskReplacementSpan<'a>>> {
  let mut replacements = Vec::new();
  for span in spans {
    let Operator::Mask(mask_config) = operator_for(config, &span.entity.label)
    else {
      continue;
    };
    let grapheme_count = span.source_text.graphemes(true).count();
    let characters_to_mask = usize::try_from(mask_config.characters_to_mask())
      .unwrap_or(usize::MAX)
      .min(grapheme_count);
    let mask_from = grapheme_count.saturating_sub(characters_to_mask);

    for (index, (relative_start, grapheme)) in
      span.source_text.grapheme_indices(true).enumerate()
    {
      let should_mask = match mask_config.direction() {
        MaskDirection::Start => index < characters_to_mask,
        MaskDirection::End => index >= mask_from,
      };
      if !should_mask {
        continue;
      }
      replacements.push(MaskReplacementSpan {
        start: checked_byte_offset(span.entity.start, relative_start)?,
        end: checked_byte_offset(
          span.entity.start,
          relative_start.saturating_add(grapheme.len()),
        )?,
        masking_character: mask_config.masking_character(),
      });
    }
  }
  Ok(replacements)
}

fn checked_byte_offset(base: u32, relative: usize) -> Result<u32> {
  let relative = u32::try_from(relative).map_err(|_| {
    crate::types::Error::ByteOffsetOutOfBounds { offset: u32::MAX }
  })?;
  base
    .checked_add(relative)
    .ok_or(crate::types::Error::ByteOffsetOutOfBounds { offset: u32::MAX })
}

fn remove_redacted_mask_overlaps<'a>(
  replacements: Vec<MaskReplacementSpan<'a>>,
  redacted: &[RedactionSpan<'_>],
) -> Vec<MaskReplacementSpan<'a>> {
  let mut result = Vec::with_capacity(replacements.len());
  let mut redacted_index = 0;
  for replacement in replacements {
    while redacted
      .get(redacted_index)
      .is_some_and(|span| span.entity.end <= replacement.start)
    {
      redacted_index = redacted_index.saturating_add(1);
    }
    let overlaps = redacted.get(redacted_index).is_some_and(|span| {
      span.entity.start < replacement.end && replacement.start < span.entity.end
    });
    if !overlaps {
      result.push(replacement);
    }
  }
  result
}

fn mask_text(text: &str, config: &MaskConfig) -> String {
  let grapheme_count = text.graphemes(true).count();
  let characters_to_mask = usize::try_from(config.characters_to_mask())
    .unwrap_or(usize::MAX)
    .min(grapheme_count);
  let mask_from = grapheme_count.saturating_sub(characters_to_mask);
  let mut masked = String::with_capacity(text.len());

  for (index, grapheme) in text.graphemes(true).enumerate() {
    let should_mask = match config.direction() {
      MaskDirection::Start => index < characters_to_mask,
      MaskDirection::End => index >= mask_from,
    };
    if should_mask {
      masked.push_str(config.masking_character());
    } else {
      masked.push_str(grapheme);
    }
  }

  masked
}

fn set_operator_entry(
  operator_map: &mut Vec<OperatorEntry>,
  placeholder: &str,
  operator: OperatorType,
) {
  if let Some(entry) = operator_map
    .iter_mut()
    .find(|entry| entry.placeholder == placeholder)
  {
    entry.operator = operator;
    return;
  }

  operator_map.push(OperatorEntry {
    placeholder: placeholder.to_owned(),
    operator,
  });
}

fn redaction_original_text(span: &RedactionSpan<'_>) -> String {
  redaction_original_text_ref(span).to_owned()
}

fn redaction_original_text_ref<'a>(span: &'a RedactionSpan<'_>) -> &'a str {
  match &span.entity.kind {
    EntityKind::Detected => span.source_text,
    EntityKind::Coreference { source_text } => source_text,
  }
}
