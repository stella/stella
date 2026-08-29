use std::collections::BTreeMap;
use std::{error, fmt};
use unicode_segmentation::UnicodeSegmentation;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
  InvalidCallerDetection {
    field: &'static str,
    reason: String,
  },
  InvalidSpan {
    start: u32,
    end: u32,
  },
  InvalidMaskConfig {
    reason: String,
  },
  InvalidSessionId {
    reason: String,
  },
  InvalidSessionState {
    reason: String,
  },
  UnsupportedSessionVersion {
    version: u32,
  },
  SessionPlaceholderCollision {
    placeholder: String,
  },
  SessionCounterExhausted {
    label: String,
  },
  SessionSerialization {
    reason: String,
  },
  SessionRestoration {
    reason: String,
  },
  InvalidSessionArchive {
    reason: String,
  },
  UnsupportedSessionArchiveVersion {
    version: u32,
  },
  UnsupportedSessionArchiveAlgorithm {
    algorithm: u8,
  },
  SessionArchiveRandomnessUnavailable,
  SessionArchiveEncryptionFailed,
  SessionArchiveAuthenticationFailed,
  SessionObservationRequired,
  SessionNotYetActive,
  SessionExpired,
  SessionDeleted,
  ByteOffsetOutOfBounds {
    offset: u32,
  },
  ByteOffsetInsideCodepoint {
    offset: u32,
  },
  Search {
    engine: SearchEngine,
    reason: String,
  },
  InvalidPackedSearchResult {
    engine: SearchEngine,
    len: usize,
  },
  PatternIndexOutOfRange {
    index: usize,
  },
  PatternIndexNotAddressable {
    pattern: u32,
  },
  UnsupportedRegexValidation {
    pattern: u32,
  },
  UnsupportedStaticSlice {
    slice: &'static str,
  },
  UnsupportedDenyListSource {
    source: String,
  },
  MissingStaticData {
    field: &'static str,
  },
  InvalidStaticData {
    field: &'static str,
    reason: String,
  },
  StaticDataLengthMismatch {
    field: &'static str,
    expected: usize,
    actual: usize,
  },
  TextLimitExceeded {
    actual_bytes: usize,
    max_bytes: usize,
  },
}

/// Maximum UTF-8 text bytes accepted by one redaction pass.
///
/// The engine owns this bound so no binding, adapter, or facade can reach a
/// redaction pass without it.
pub const REDACTION_TEXT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Bounds untrusted text before a redaction pass.
pub const fn validate_redaction_text(full_text: &str) -> Result<()> {
  if full_text.len() > REDACTION_TEXT_MAX_BYTES {
    return Err(Error::TextLimitExceeded {
      actual_bytes: full_text.len(),
      max_bytes: REDACTION_TEXT_MAX_BYTES,
    });
  }
  Ok(())
}

impl fmt::Display for Error {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::InvalidCallerDetection { field, reason } => {
        write!(
          formatter,
          "Caller detection field '{field}' is invalid: {reason}"
        )
      }
      Self::InvalidSpan { start, end } => {
        write!(formatter, "Invalid entity span: {start}..{end}")
      }
      Self::InvalidMaskConfig { reason } => {
        write!(formatter, "Invalid mask operator configuration: {reason}")
      }
      Self::InvalidSessionId { .. }
      | Self::InvalidSessionState { .. }
      | Self::UnsupportedSessionVersion { .. }
      | Self::SessionPlaceholderCollision { .. }
      | Self::SessionCounterExhausted { .. }
      | Self::SessionSerialization { .. }
      | Self::SessionRestoration { .. }
      | Self::InvalidSessionArchive { .. }
      | Self::UnsupportedSessionArchiveVersion { .. }
      | Self::UnsupportedSessionArchiveAlgorithm { .. }
      | Self::SessionArchiveRandomnessUnavailable
      | Self::SessionArchiveEncryptionFailed
      | Self::SessionArchiveAuthenticationFailed
      | Self::SessionObservationRequired
      | Self::SessionNotYetActive
      | Self::SessionExpired
      | Self::SessionDeleted => display_session_error(self, formatter),
      Self::ByteOffsetOutOfBounds { offset } => {
        write!(formatter, "Byte offset is out of bounds: {offset}")
      }
      Self::ByteOffsetInsideCodepoint { offset } => {
        write!(formatter, "Byte offset is not a UTF-8 boundary: {offset}")
      }
      Self::Search { engine, reason } => {
        write!(formatter, "{engine} search failed: {reason}")
      }
      Self::InvalidPackedSearchResult { engine, len } => {
        write!(
          formatter,
          "{engine} search returned malformed packed matches of length {len}"
        )
      }
      Self::PatternIndexOutOfRange { index } => {
        write!(formatter, "Search pattern index exceeds u32 range: {index}")
      }
      Self::PatternIndexNotAddressable { pattern } => {
        write!(
          formatter,
          "Search pattern index is not addressable: {pattern}"
        )
      }
      Self::UnsupportedRegexValidation { pattern } => {
        write!(
          formatter,
          "Regex pattern {pattern} requires validation that is not available in core"
        )
      }
      Self::UnsupportedStaticSlice { slice } => {
        write!(
          formatter,
          "Static slice '{slice}' is configured but not supported by native core"
        )
      }
      Self::UnsupportedDenyListSource { source } => {
        write!(
          formatter,
          "Deny-list source '{source}' is not supported by native core"
        )
      }
      Self::MissingStaticData { field } => {
        write!(formatter, "Static data field '{field}' is required")
      }
      Self::InvalidStaticData { field, reason } => {
        write!(
          formatter,
          "Static data field '{field}' is invalid: {reason}"
        )
      }
      Self::TextLimitExceeded {
        actual_bytes,
        max_bytes,
      } => write!(
        formatter,
        "Text contains {actual_bytes} bytes; the maximum is {max_bytes}"
      ),
      Self::StaticDataLengthMismatch {
        field,
        expected,
        actual,
      } => {
        write!(
          formatter,
          "Static data field '{field}' has {actual} item(s), expected {expected}"
        )
      }
    }
  }
}

impl error::Error for Error {}

fn display_invalid_session_id(
  formatter: &mut fmt::Formatter<'_>,
  reason: &str,
) -> fmt::Result {
  write!(formatter, "Invalid redaction session id: {reason}")
}

fn display_invalid_session_state(
  formatter: &mut fmt::Formatter<'_>,
  reason: &str,
) -> fmt::Result {
  write!(formatter, "Invalid redaction session state: {reason}")
}

fn display_session_placeholder_collision(
  formatter: &mut fmt::Formatter<'_>,
  placeholder: &str,
) -> fmt::Result {
  write!(
    formatter,
    "Input contains a placeholder reserved by this redaction session: {placeholder}"
  )
}

fn display_session_counter_exhausted(
  formatter: &mut fmt::Formatter<'_>,
  label: &str,
) -> fmt::Result {
  write!(
    formatter,
    "Redaction session placeholder counter is exhausted for label: {label}"
  )
}

fn display_session_serialization_error(
  formatter: &mut fmt::Formatter<'_>,
  reason: &str,
) -> fmt::Result {
  write!(formatter, "Could not serialize redaction session: {reason}")
}

fn display_session_error(
  error: &Error,
  formatter: &mut fmt::Formatter<'_>,
) -> fmt::Result {
  match error {
    Error::InvalidSessionId { reason } => {
      display_invalid_session_id(formatter, reason)
    }
    Error::InvalidSessionState { reason } => {
      display_invalid_session_state(formatter, reason)
    }
    Error::UnsupportedSessionVersion { version } => write!(
      formatter,
      "Unsupported redaction session version: {version}",
    ),
    Error::SessionPlaceholderCollision { placeholder } => {
      display_session_placeholder_collision(formatter, placeholder)
    }
    Error::SessionCounterExhausted { label } => {
      display_session_counter_exhausted(formatter, label)
    }
    Error::SessionSerialization { reason } => {
      display_session_serialization_error(formatter, reason)
    }
    Error::SessionRestoration { reason } => {
      write!(
        formatter,
        "Could not restore redaction session text: {reason}"
      )
    }
    Error::InvalidSessionArchive { reason } => {
      write!(formatter, "Invalid encrypted session archive: {reason}")
    }
    Error::UnsupportedSessionArchiveVersion { version } => write!(
      formatter,
      "Unsupported encrypted session archive version: {version}",
    ),
    Error::UnsupportedSessionArchiveAlgorithm { algorithm } => write!(
      formatter,
      "Unsupported encrypted session archive algorithm: {algorithm}",
    ),
    Error::SessionArchiveRandomnessUnavailable => formatter.write_str(
      "Could not obtain secure randomness for the encrypted session archive",
    ),
    Error::SessionArchiveEncryptionFailed => {
      formatter.write_str("Could not encrypt the redaction session archive")
    }
    Error::SessionArchiveAuthenticationFailed => {
      formatter.write_str("Encrypted session archive authentication failed")
    }
    Error::SessionObservationRequired => display_observation(formatter),
    Error::SessionNotYetActive => display_session_not_active(formatter),
    Error::SessionExpired => display_session_expired(formatter),
    Error::SessionDeleted => display_session_deleted(formatter),
    _ => formatter.write_str("Redaction session failed"),
  }
}

fn display_observation(formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
  formatter.write_str(
    "A caller-supplied observation time is required for this redaction session",
  )
}

fn display_session_not_active(
  formatter: &mut fmt::Formatter<'_>,
) -> fmt::Result {
  formatter.write_str("Redaction session is not yet active")
}

fn display_session_expired(formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
  formatter.write_str("Redaction session has expired")
}

fn display_session_deleted(formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
  formatter.write_str("Redaction session has been deleted")
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EntityKind {
  Detected,
  Coreference { source_text: String },
}

/// Source span with UTF-8 byte offsets.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub kind: EntityKind,
}

impl Entity {
  #[must_use]
  pub fn detected(
    start: u32,
    end: u32,
    label: impl Into<String>,
    text: impl Into<String>,
  ) -> Self {
    Self {
      start,
      end,
      label: label.into(),
      text: text.into(),
      kind: EntityKind::Detected,
    }
  }

  #[must_use]
  pub fn coreference(
    start: u32,
    end: u32,
    label: impl Into<String>,
    text: impl Into<String>,
    source_text: impl Into<String>,
  ) -> Self {
    Self {
      start,
      end,
      label: label.into(),
      text: text.into(),
      kind: EntityKind::Coreference {
        source_text: source_text.into(),
      },
    }
  }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OperatorType {
  #[default]
  Replace,
  Redact,
  Keep,
  Mask,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaskDirection {
  Start,
  End,
}

const MAX_MASKING_CHARACTER_BYTES: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaskConfig {
  masking_character: String,
  characters_to_mask: u32,
  direction: MaskDirection,
}

impl MaskConfig {
  pub fn new(
    masking_character: impl Into<String>,
    characters_to_mask: u32,
    direction: MaskDirection,
  ) -> Result<Self> {
    let masking_character = masking_character.into();
    if masking_character.len() > MAX_MASKING_CHARACTER_BYTES {
      return Err(Error::InvalidMaskConfig {
        reason: format!(
          "masking_character must not exceed {MAX_MASKING_CHARACTER_BYTES} UTF-8 bytes"
        ),
      });
    }
    if masking_character.graphemes(true).count() != 1 {
      return Err(Error::InvalidMaskConfig {
        reason: String::from(
          "masking_character must contain exactly one grapheme cluster",
        ),
      });
    }
    if characters_to_mask == 0 {
      return Err(Error::InvalidMaskConfig {
        reason: String::from("characters_to_mask must be greater than zero"),
      });
    }
    Ok(Self {
      masking_character,
      characters_to_mask,
      direction,
    })
  }

  #[must_use]
  pub fn masking_character(&self) -> &str {
    &self.masking_character
  }

  #[must_use]
  pub const fn characters_to_mask(&self) -> u32 {
    self.characters_to_mask
  }

  #[must_use]
  pub const fn direction(&self) -> MaskDirection {
    self.direction
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Operator {
  Replace,
  Redact,
  Keep,
  Mask(MaskConfig),
}

impl Operator {
  #[must_use]
  pub const fn operator_type(&self) -> OperatorType {
    match self {
      Self::Replace => OperatorType::Replace,
      Self::Redact => OperatorType::Redact,
      Self::Keep => OperatorType::Keep,
      Self::Mask(_) => OperatorType::Mask,
    }
  }
}

#[derive(bon::Builder, Clone, Debug, Eq, PartialEq)]
pub struct OperatorConfig {
  #[builder(default)]
  pub operators: BTreeMap<String, Operator>,
  #[builder(default = String::from("[REDACTED]"))]
  pub redact_string: String,
}

impl Default for OperatorConfig {
  fn default() -> Self {
    Self {
      operators: BTreeMap::new(),
      redact_string: String::from("[REDACTED]"),
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaceholderEntry {
  pub label: String,
  pub text: String,
  pub source_text: Option<String>,
  pub placeholder: String,
}

/// Deterministic placeholder lookup for one document.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PlaceholderMap {
  entries: Vec<PlaceholderEntry>,
}

impl PlaceholderMap {
  #[must_use]
  pub fn entries(&self) -> &[PlaceholderEntry] {
    &self.entries
  }

  #[must_use]
  pub fn get(&self, label: &str, text: &str) -> Option<&str> {
    self.get_with_source(label, text, None).or_else(|| {
      self
        .entries
        .iter()
        .find(|entry| entry.label == label && entry.text == text)
        .map(|entry| entry.placeholder.as_str())
    })
  }

  #[must_use]
  pub(crate) fn get_entity(&self, entity: &Entity) -> Option<&str> {
    self.get_with_source(
      &entity.label,
      &entity.text,
      coreference_source_text(entity),
    )
  }

  fn get_with_source(
    &self,
    label: &str,
    text: &str,
    source_text: Option<&str>,
  ) -> Option<&str> {
    self
      .entries
      .iter()
      .find(|entry| {
        entry.label == label
          && entry.text == text
          && entry.source_text.as_deref() == source_text
      })
      .map(|entry| entry.placeholder.as_str())
  }

  pub(super) fn has_entity(&self, entity: &Entity) -> bool {
    self.get_entity(entity).is_some()
  }

  pub(super) fn push_entity(&mut self, entity: &Entity, placeholder: &str) {
    self.entries.push(PlaceholderEntry {
      label: entity.label.clone(),
      text: entity.text.clone(),
      source_text: coreference_source_text(entity).map(ToOwned::to_owned),
      placeholder: placeholder.to_owned(),
    });
  }
}

fn coreference_source_text(entity: &Entity) -> Option<&str> {
  let EntityKind::Coreference { source_text } = &entity.kind else {
    return None;
  };
  Some(source_text)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedactionEntry {
  pub placeholder: String,
  pub original: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorEntry {
  pub placeholder: String,
  pub operator: OperatorType,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedactionReplacement {
  pub start: u32,
  pub end: u32,
  pub replacement: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedactionResult {
  pub redacted_text: String,
  pub redaction_map: Vec<RedactionEntry>,
  pub operator_map: Vec<OperatorEntry>,
  pub replacements: Vec<RedactionReplacement>,
  pub entity_count: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchEngine {
  Literal,
  Regex,
  Fuzzy,
  Text,
}

impl fmt::Display for SearchEngine {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Literal => formatter.write_str("literal"),
      Self::Regex => formatter.write_str("regex"),
      Self::Fuzzy => formatter.write_str("fuzzy"),
      Self::Text => formatter.write_str("text-search"),
    }
  }
}

/// Search match with the caller's pattern index and UTF-8 byte offsets.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchMatch {
  Literal {
    pattern: u32,
    start: u32,
    end: u32,
  },
  Regex {
    pattern: u32,
    start: u32,
    end: u32,
  },
  Fuzzy {
    pattern: u32,
    start: u32,
    end: u32,
    distance: u32,
  },
}

impl SearchMatch {
  #[must_use]
  pub const fn engine(&self) -> SearchEngine {
    match self {
      Self::Literal { .. } => SearchEngine::Literal,
      Self::Regex { .. } => SearchEngine::Regex,
      Self::Fuzzy { .. } => SearchEngine::Fuzzy,
    }
  }

  #[must_use]
  pub const fn pattern(&self) -> u32 {
    match self {
      Self::Literal { pattern, .. }
      | Self::Regex { pattern, .. }
      | Self::Fuzzy { pattern, .. } => *pattern,
    }
  }

  #[must_use]
  pub const fn start(&self) -> u32 {
    match self {
      Self::Literal { start, .. }
      | Self::Regex { start, .. }
      | Self::Fuzzy { start, .. } => *start,
    }
  }

  #[must_use]
  pub const fn end(&self) -> u32 {
    match self {
      Self::Literal { end, .. }
      | Self::Regex { end, .. }
      | Self::Fuzzy { end, .. } => *end,
    }
  }

  #[must_use]
  pub(crate) const fn with_span(self, start: u32, end: u32) -> Self {
    match self {
      Self::Literal { pattern, .. } => Self::Literal {
        pattern,
        start,
        end,
      },
      Self::Regex { pattern, .. } => Self::Regex {
        pattern,
        start,
        end,
      },
      Self::Fuzzy {
        pattern, distance, ..
      } => Self::Fuzzy {
        pattern,
        start,
        end,
        distance,
      },
    }
  }
}
