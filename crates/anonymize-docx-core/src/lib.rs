#![forbid(unsafe_code)]

use std::{
  collections::{HashMap, HashSet},
  io::{Cursor, Read, Write},
  path::Path,
};

use percent_encoding::percent_decode_str;
use roxmltree::{Document, Node, NodeId};
use serde::{Deserialize, Serialize};
use stella_docx_kernel as docx_kernel;
use thiserror::Error;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const DOCX_EXTRACTION_CONTRACT_VERSION: u8 = 1;
pub const DOCX_ARCHIVE_MAX_BYTES: usize = 64 * 1024 * 1024;
pub const DOCX_ENTRY_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const DOCX_UNCOMPRESSED_MAX_BYTES: usize = 128 * 1024 * 1024;
pub const DOCX_XML_MAX_DEPTH: usize = 256;
const DOCX_MAX_ENTRIES: usize = 4_096;
const DOCX_MAX_TEXT_BLOCKS: usize = 100_000;
const DOCX_MAX_TEXT_SEGMENTS: usize = 1_000_000;
const DOCX_MAX_XML_EVENTS: usize = 10_000_000;
const DOCX_MAX_INLINE_CONTEXT_SCAN_OPS: usize = 20_000_000;
const DOCX_MAX_REPLACEMENTS: usize = 1_000_000;
const DOCX_RESTORE_MAX_CANDIDATES: usize = 1_000_000;
const DOCX_RESTORE_MAX_PLACEHOLDER_UTF16: usize = 512;
const XML_SPACE_INSERTION_BYTES: usize = 21;
const SIGNATURE_PART_PREFIX: &str = "_xmlsignatures/";

const CONTENT_TYPES_PATH: &str = "[Content_Types].xml";
const ROOT_RELATIONSHIPS_PATH: &str = "_rels/.rels";
const CONTENT_TYPES_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-package.relationships+xml";
const WORDPROCESSING_CONTENT_TYPE_PREFIX: &str =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.";
const GENERIC_XML_CONTENT_TYPE: &str = "application/xml";
const GENERIC_BINARY_CONTENT_TYPE: &str = "application/octet-stream";
const CORE_PROPERTIES_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-package.core-properties+xml";
const EXTENDED_PROPERTIES_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.extended-properties+xml";
const CUSTOM_PROPERTIES_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.custom-properties+xml";
const WORDPROCESSING_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
];
const RELATIONSHIP_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
];
const PACKAGE_RELATIONSHIP_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/package/relationships",
  "http://schemas.openxmlformats.org/package/2006/relationships",
];
#[cfg(test)]
const MARKUP_COMPATIBILITY_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/markup-compatibility/main",
  "http://schemas.openxmlformats.org/markup-compatibility/2006",
];

#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("{message}")]
pub struct DocxError {
  code: DocxErrorCode,
  message: String,
}

impl DocxError {
  #[must_use]
  pub const fn code(&self) -> DocxErrorCode {
    self.code
  }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum DocxErrorCode {
  ArchiveLimitExceeded,
  InvalidArchive,
  InvalidPackage,
  InvalidXml,
  UnsafeEntryPath,
  UncompressedLimitExceeded,
}

#[derive(Debug, Clone, Eq, Hash, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxPartType {
  Comments,
  Endnotes,
  Footer,
  Footnotes,
  Header,
  MainDocument,
}

#[derive(Debug, Clone, Eq, Hash, PartialEq, Deserialize, Serialize)]
pub struct DocxPart {
  #[serde(rename = "type")]
  pub part_type: DocxPartType,
  pub path: String,
}

#[derive(Debug, Clone, Eq, Hash, PartialEq, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum DocxBlockLocation {
  Paragraph {
    part: DocxPart,
    #[serde(rename = "blockIndex")]
    block_index: usize,
    #[serde(rename = "xmlPath")]
    xml_path: Vec<usize>,
  },
  TableCellParagraph {
    part: DocxPart,
    #[serde(rename = "blockIndex")]
    block_index: usize,
    #[serde(rename = "xmlPath")]
    xml_path: Vec<usize>,
    #[serde(rename = "tablePath")]
    table_path: Vec<usize>,
    #[serde(rename = "rowPath")]
    row_path: Vec<usize>,
    #[serde(rename = "cellPath")]
    cell_path: Vec<usize>,
  },
  TextBoxParagraph {
    part: DocxPart,
    #[serde(rename = "blockIndex")]
    block_index: usize,
    #[serde(rename = "xmlPath")]
    xml_path: Vec<usize>,
    #[serde(rename = "textBoxPath")]
    text_box_path: Vec<usize>,
  },
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum DocxInlineContext {
  Hyperlink {
    #[serde(rename = "relationshipId")]
    relationship_id: Option<String>,
    anchor: Option<String>,
  },
  Revision {
    revision: DocxRevision,
  },
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxRevision {
  Deletion,
  Insertion,
  MoveFrom,
  MoveTo,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocxSegmentSource {
  Break,
  Tab,
  Text,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxTextSegment {
  pub start: usize,
  pub end: usize,
  pub source: DocxSegmentSource,
  pub contexts: Vec<DocxInlineContext>,
  #[serde(rename = "xmlPath")]
  pub xml_path: Vec<usize>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxTextBlock {
  pub text: String,
  pub location: DocxBlockLocation,
  pub segments: Vec<DocxTextSegment>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum DocxCoverageItem {
  Extracted {
    part: DocxPart,
    #[serde(rename = "blockCount")]
    block_count: usize,
  },
  Unsupported {
    path: String,
    #[serde(rename = "contentType")]
    content_type: String,
    reason: String,
  },
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Default)]
pub struct DocxCoverage {
  pub parts: Vec<DocxCoverageItem>,
  #[serde(rename = "hyperlinkTextSegmentCount")]
  pub hyperlink_text_segment_count: usize,
  #[serde(rename = "revisionTextSegmentCount")]
  pub revision_text_segment_count: usize,
  #[serde(rename = "unsupportedAlternateContentCount")]
  pub unsupported_alternate_content_count: usize,
  #[serde(rename = "unsupportedSymbolCount")]
  pub unsupported_symbol_count: usize,
  #[serde(rename = "unsupportedFieldInstructionCount")]
  pub unsupported_field_instruction_count: usize,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxExtraction {
  #[serde(rename = "contractVersion")]
  pub contract_version: u8,
  pub blocks: Vec<DocxTextBlock>,
  pub coverage: DocxCoverage,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
pub struct DocxTextReplacement {
  pub start: usize,
  pub end: usize,
  pub replacement: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize, Serialize)]
pub struct DocxBlockRewrite {
  pub location: DocxBlockLocation,
  #[serde(rename = "expectedText")]
  pub expected_text: String,
  pub replacements: Vec<DocxTextReplacement>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DocxRewriteResult {
  pub document: Vec<u8>,
  pub rewritten_block_count: usize,
  pub applied_replacement_count: usize,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxRestorationCandidate {
  pub start: usize,
  pub end: usize,
  pub candidate: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxBlockRestorationPlan {
  pub location: DocxBlockLocation,
  #[serde(rename = "expectedText")]
  pub expected_text: String,
  pub candidates: Vec<DocxRestorationCandidate>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxRestorationPlan {
  pub extraction: DocxExtraction,
  pub blocks: Vec<DocxBlockRestorationPlan>,
  #[serde(rename = "candidateCount")]
  pub candidate_count: usize,
}

#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("{message}")]
pub struct DocxRestorationError {
  code: DocxRestorationErrorCode,
  message: String,
}

impl DocxRestorationError {
  #[must_use]
  pub const fn code(&self) -> DocxRestorationErrorCode {
    self.code
  }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum DocxRestorationErrorCode {
  InvalidPlaceholder,
  RestorationLimitExceeded,
  UnsupportedDocument,
}

#[derive(Debug, Error, Clone, Eq, PartialEq)]
#[error("{message}")]
pub struct DocxRewriteError {
  code: DocxRewriteErrorCode,
  message: String,
}

impl DocxRewriteError {
  #[must_use]
  pub const fn code(&self) -> DocxRewriteErrorCode {
    self.code
  }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum DocxRewriteErrorCode {
  ArchiveLimitExceeded,
  InvalidArchive,
  InvalidPackage,
  InvalidReplacement,
  InvalidXml,
  RewriteLimitExceeded,
  StaleExtraction,
  UncompressedLimitExceeded,
  UnsafeEntryPath,
  UnsupportedReplacement,
}

#[derive(Debug, Clone)]
struct TextNodeUpdate {
  path: Vec<usize>,
  value: String,
  original_byte_length: usize,
}

#[derive(Debug)]
struct XmlPatch {
  start: usize,
  end: usize,
  value: String,
}

#[derive(Debug)]
struct ArchiveEntry {
  path: String,
  bytes: Vec<u8>,
}

#[derive(Debug)]
struct ContentTypePart {
  path: String,
  content_type: String,
}

fn error(code: DocxErrorCode, message: impl Into<String>) -> DocxError {
  DocxError {
    code,
    message: message.into(),
  }
}

fn rewrite_error(
  code: DocxRewriteErrorCode,
  message: impl Into<String>,
) -> DocxRewriteError {
  DocxRewriteError {
    code,
    message: message.into(),
  }
}

fn restoration_error(
  code: DocxRestorationErrorCode,
  message: impl Into<String>,
) -> DocxRestorationError {
  DocxRestorationError {
    code,
    message: message.into(),
  }
}

fn is_owned_placeholder_candidate(
  value: &str,
  encoded_session_id: &str,
) -> bool {
  let inner = value.strip_prefix('[').unwrap_or(value);
  let inner = inner.strip_suffix(']').unwrap_or(inner);
  let Some((prefix, _count)) = inner.rsplit_once('_') else {
    return false;
  };
  let Some((label, namespace)) = prefix.rsplit_once('_') else {
    return false;
  };
  !label.is_empty() && namespace == encoded_session_id
}

#[allow(clippy::too_many_lines)]
fn scan_restoration_candidates(
  text: &str,
  encoded_session_id: &str,
  candidate_count: &mut usize,
) -> Result<Vec<DocxRestorationCandidate>, DocxRestorationError> {
  let mut candidates = Vec::new();
  let mut start = None::<(usize, usize)>;
  let mut utf16_cursor = 0_usize;
  for (byte_cursor, character) in text.char_indices() {
    if character == '[' {
      if let Some((start_byte, _)) = start {
        let inner_start = start_byte.checked_add(1).ok_or_else(|| {
          restoration_error(
            DocxRestorationErrorCode::RestorationLimitExceeded,
            "DOCX placeholder position overflowed",
          )
        })?;
        if text.get(inner_start..byte_cursor).is_some_and(|value| {
          is_owned_placeholder_candidate(value, encoded_session_id)
        }) {
          return Err(restoration_error(
            DocxRestorationErrorCode::InvalidPlaceholder,
            "DOCX text contains an incomplete placeholder for the expected session",
          ));
        }
      }
      start = Some((byte_cursor, utf16_cursor));
    } else if character == ']'
      && let Some((start_byte, start_utf16)) = start
    {
      let candidate_end_byte = byte_cursor
        .checked_add(character.len_utf8())
        .ok_or_else(|| {
          restoration_error(
            DocxRestorationErrorCode::RestorationLimitExceeded,
            "DOCX placeholder position overflowed",
          )
        })?;
      let candidate_end_utf16 = utf16_cursor
        .checked_add(character.len_utf16())
        .ok_or_else(|| {
          restoration_error(
            DocxRestorationErrorCode::RestorationLimitExceeded,
            "DOCX placeholder position overflowed",
          )
        })?;
      *candidate_count = candidate_count.checked_add(1).ok_or_else(|| {
        restoration_error(
          DocxRestorationErrorCode::RestorationLimitExceeded,
          "DOCX restoration candidate count overflowed",
        )
      })?;
      if *candidate_count > DOCX_RESTORE_MAX_CANDIDATES {
        return Err(restoration_error(
          DocxRestorationErrorCode::RestorationLimitExceeded,
          format!(
            "DOCX restoration must not inspect more than {DOCX_RESTORE_MAX_CANDIDATES} placeholder candidates"
          ),
        ));
      }
      let candidate =
        text.get(start_byte..candidate_end_byte).ok_or_else(|| {
          restoration_error(
            DocxRestorationErrorCode::InvalidPlaceholder,
            "DOCX placeholder text is unavailable",
          )
        })?;
      let is_owned =
        is_owned_placeholder_candidate(candidate, encoded_session_id);
      if candidate_end_utf16.saturating_sub(start_utf16)
        > DOCX_RESTORE_MAX_PLACEHOLDER_UTF16
      {
        if is_owned {
          return Err(restoration_error(
            DocxRestorationErrorCode::InvalidPlaceholder,
            "DOCX session placeholder exceeds the maximum length",
          ));
        }
        start = None;
        utf16_cursor = candidate_end_utf16;
        continue;
      }
      if is_owned {
        candidates.push(DocxRestorationCandidate {
          start: start_utf16,
          end: candidate_end_utf16,
          candidate: candidate.to_owned(),
        });
      }
      start = None;
    }
    utf16_cursor =
      utf16_cursor
        .checked_add(character.len_utf16())
        .ok_or_else(|| {
          restoration_error(
            DocxRestorationErrorCode::RestorationLimitExceeded,
            "DOCX text position overflowed",
          )
        })?;
  }
  if let Some((start_byte, _)) = start {
    let inner_start = start_byte.checked_add(1).ok_or_else(|| {
      restoration_error(
        DocxRestorationErrorCode::RestorationLimitExceeded,
        "DOCX placeholder position overflowed",
      )
    })?;
    if text.get(inner_start..).is_some_and(|value| {
      is_owned_placeholder_candidate(value, encoded_session_id)
    }) {
      return Err(restoration_error(
        DocxRestorationErrorCode::InvalidPlaceholder,
        "DOCX text contains an incomplete placeholder for the expected session",
      ));
    }
  }
  Ok(candidates)
}

impl DocxBlockLocation {
  fn part_path(&self) -> &str {
    match self {
      Self::Paragraph { part, .. }
      | Self::TableCellParagraph { part, .. }
      | Self::TextBoxParagraph { part, .. } => &part.path,
    }
  }
}

fn map_extraction_error(source: &DocxError) -> DocxRewriteError {
  let code = match source.code() {
    DocxErrorCode::ArchiveLimitExceeded => {
      DocxRewriteErrorCode::ArchiveLimitExceeded
    }
    DocxErrorCode::InvalidArchive => DocxRewriteErrorCode::InvalidArchive,
    DocxErrorCode::InvalidPackage => DocxRewriteErrorCode::InvalidPackage,
    DocxErrorCode::InvalidXml => DocxRewriteErrorCode::InvalidXml,
    DocxErrorCode::UnsafeEntryPath => DocxRewriteErrorCode::UnsafeEntryPath,
    DocxErrorCode::UncompressedLimitExceeded => {
      DocxRewriteErrorCode::UncompressedLimitExceeded
    }
  };
  rewrite_error(code, source.to_string())
}

fn utf16_byte_index(value: &str, offset: usize) -> Option<usize> {
  if offset == 0 {
    return Some(0);
  }
  let mut utf16_offset = 0_usize;
  for (byte_index, character) in value.char_indices() {
    if utf16_offset == offset {
      return Some(byte_index);
    }
    utf16_offset = utf16_offset.checked_add(character.len_utf16())?;
    if utf16_offset > offset {
      return None;
    }
  }
  (utf16_offset == offset).then_some(value.len())
}

fn is_valid_xml_text(value: &str) -> bool {
  value.chars().all(|character| {
    matches!(character, '\u{9}' | '\u{a}' | '\u{d}')
      || ('\u{20}'..='\u{d7ff}').contains(&character)
      || ('\u{e000}'..='\u{fffd}').contains(&character)
      || ('\u{10000}'..='\u{10ffff}').contains(&character)
  })
}

fn escaped_xml_text_byte_length(value: &str) -> Option<usize> {
  value.chars().try_fold(0_usize, |total, character| {
    let length = match character {
      '&' => 5,
      '<' | '>' => 4,
      _ => character.len_utf8(),
    };
    total.checked_add(length)
  })
}

fn escape_xml_text(value: &str) -> String {
  let mut escaped = String::with_capacity(value.len());
  for character in value.chars() {
    match character {
      '&' => escaped.push_str("&amp;"),
      '<' => escaped.push_str("&lt;"),
      '>' => escaped.push_str("&gt;"),
      _ => escaped.push(character),
    }
  }
  escaped
}

fn validate_replacement(
  replacement: &DocxTextReplacement,
  block_text: &str,
) -> Result<(), DocxRewriteError> {
  if replacement.start >= replacement.end
    || utf16_byte_index(block_text, replacement.start).is_none()
    || utf16_byte_index(block_text, replacement.end).is_none()
  {
    return Err(rewrite_error(
      DocxRewriteErrorCode::InvalidReplacement,
      "DOCX replacement spans must be nonempty bounded integer ranges at UTF-16 boundaries",
    ));
  }
  if !is_valid_xml_text(&replacement.replacement) {
    return Err(rewrite_error(
      DocxRewriteErrorCode::InvalidReplacement,
      "DOCX replacement text must contain only valid XML characters",
    ));
  }
  if escaped_xml_text_byte_length(&replacement.replacement)
    .is_none_or(|length| length > DOCX_ENTRY_MAX_BYTES)
  {
    return Err(rewrite_error(
      DocxRewriteErrorCode::RewriteLimitExceeded,
      format!(
        "DOCX replacement text must not exceed {DOCX_ENTRY_MAX_BYTES} escaped UTF-8 bytes"
      ),
    ));
  }
  Ok(())
}

fn covered_text_segments<'a>(
  block: &'a DocxTextBlock,
  replacement: &DocxTextReplacement,
) -> Result<Vec<&'a DocxTextSegment>, DocxRewriteError> {
  let segments = block
    .segments
    .iter()
    .filter(|segment| {
      segment.start < replacement.end && segment.end > replacement.start
    })
    .collect::<Vec<_>>();
  let mut cursor = replacement.start;
  for segment in &segments {
    if segment.source != DocxSegmentSource::Text
      || segment.start > cursor
      || segment
        .contexts
        .iter()
        .any(|context| matches!(context, DocxInlineContext::Revision { .. }))
    {
      return Err(rewrite_error(
        DocxRewriteErrorCode::UnsupportedReplacement,
        "DOCX replacements must stay within contiguous non-revision text segments",
      ));
    }
    cursor = replacement.end.min(segment.end);
  }
  if segments.is_empty() || cursor != replacement.end {
    return Err(rewrite_error(
      DocxRewriteErrorCode::UnsupportedReplacement,
      "DOCX replacements must stay within contiguous non-revision text segments",
    ));
  }
  Ok(segments)
}

fn replace_utf16_range(
  value: &str,
  start: usize,
  end: usize,
  replacement: &str,
) -> Result<String, DocxRewriteError> {
  let start_byte = utf16_byte_index(value, start).ok_or_else(|| {
    rewrite_error(
      DocxRewriteErrorCode::InvalidReplacement,
      "DOCX replacement start is not a UTF-16 boundary",
    )
  })?;
  let end_byte = utf16_byte_index(value, end).ok_or_else(|| {
    rewrite_error(
      DocxRewriteErrorCode::InvalidReplacement,
      "DOCX replacement end is not a UTF-16 boundary",
    )
  })?;
  let mut updated = String::with_capacity(
    value
      .len()
      .saturating_sub(end_byte.saturating_sub(start_byte))
      .saturating_add(replacement.len()),
  );
  updated.push_str(value.get(..start_byte).ok_or_else(|| {
    rewrite_error(
      DocxRewriteErrorCode::InvalidReplacement,
      "DOCX replacement start is unavailable",
    )
  })?);
  updated.push_str(replacement);
  updated.push_str(value.get(end_byte..).ok_or_else(|| {
    rewrite_error(
      DocxRewriteErrorCode::InvalidReplacement,
      "DOCX replacement end is unavailable",
    )
  })?);
  Ok(updated)
}

#[allow(clippy::too_many_lines)]
fn plan_block_updates(
  block: &DocxTextBlock,
  rewrite: &DocxBlockRewrite,
) -> Result<Vec<TextNodeUpdate>, DocxRewriteError> {
  let mut replacements = rewrite.replacements.iter().collect::<Vec<_>>();
  replacements.sort_by_key(|replacement| replacement.start);
  for (index, replacement) in replacements.iter().enumerate() {
    validate_replacement(replacement, &block.text)?;
    if index > 0
      && replacements
        .get(index.saturating_sub(1))
        .is_some_and(|previous| previous.end > replacement.start)
    {
      return Err(rewrite_error(
        DocxRewriteErrorCode::InvalidReplacement,
        "DOCX replacement spans must not overlap",
      ));
    }
  }

  let mut values = HashMap::<Vec<usize>, TextNodeUpdate>::new();
  let mut originals = HashMap::<Vec<usize>, String>::new();
  for segment in &block.segments {
    if segment.source != DocxSegmentSource::Text {
      continue;
    }
    let start =
      utf16_byte_index(&block.text, segment.start).ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::StaleExtraction,
          "DOCX text segment start is unavailable",
        )
      })?;
    let end = utf16_byte_index(&block.text, segment.end).ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX text segment end is unavailable",
      )
    })?;
    let original = block
      .text
      .get(start..end)
      .ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::StaleExtraction,
          "DOCX text segment is unavailable",
        )
      })?
      .to_owned();
    values.insert(
      segment.xml_path.clone(),
      TextNodeUpdate {
        path: segment.xml_path.clone(),
        original_byte_length: original.len(),
        value: original.clone(),
      },
    );
    originals.insert(segment.xml_path.clone(), original);
  }

  for replacement in replacements.into_iter().rev() {
    let segments = covered_text_segments(block, replacement)?;
    let first = segments.first().ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::UnsupportedReplacement,
        "DOCX replacement text segments are unavailable",
      )
    })?;
    let last = segments.last().ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::UnsupportedReplacement,
        "DOCX replacement text segments are unavailable",
      )
    })?;
    let first_start = replacement.start.saturating_sub(first.start);
    let last_end = replacement.end.saturating_sub(last.start);
    if first.xml_path == last.xml_path {
      let update = values.get_mut(&first.xml_path).ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::UnsupportedReplacement,
          "DOCX replacement text nodes are unavailable",
        )
      })?;
      update.value = replace_utf16_range(
        &update.value,
        first_start,
        last_end,
        &replacement.replacement,
      )?;
      continue;
    }
    let first_update = values.get_mut(&first.xml_path).ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::UnsupportedReplacement,
        "DOCX replacement text nodes are unavailable",
      )
    })?;
    let first_length = utf16_len(&first_update.value);
    first_update.value = replace_utf16_range(
      &first_update.value,
      first_start,
      first_length,
      &replacement.replacement,
    )?;
    for segment in segments
      .iter()
      .skip(1)
      .take(segments.len().saturating_sub(2))
    {
      if let Some(update) = values.get_mut(&segment.xml_path) {
        update.value.clear();
      }
    }
    let last_update = values.get_mut(&last.xml_path).ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::UnsupportedReplacement,
        "DOCX replacement text nodes are unavailable",
      )
    })?;
    last_update.value =
      replace_utf16_range(&last_update.value, 0, last_end, "")?;
  }
  Ok(
    values
      .into_iter()
      .filter_map(|(path, update)| {
        (originals.get(&path) != Some(&update.value)).then_some(update)
      })
      .collect(),
  )
}

fn node_at_path<'tree, 'input>(
  document: &'tree Document<'input>,
  path: &[usize],
) -> Option<Node<'tree, 'input>> {
  let mut node = document.root_element();
  if path.first() != Some(&0) {
    return None;
  }
  for child_index in path.iter().skip(1) {
    node = node.children().filter(Node::is_element).nth(*child_index)?;
  }
  Some(node)
}

fn xml_start_tag_end(source: &str) -> Option<usize> {
  let mut quote = None;
  for (index, character) in source.char_indices() {
    match (quote, character) {
      (Some(expected), current) if current == expected => quote = None,
      (None, '\'' | '"') => quote = Some(character),
      (None, '>') => return Some(index),
      _ => {}
    }
  }
  None
}

fn add_xml_space_preserve_patch(
  node: Node<'_, '_>,
  insertion: usize,
  patches: &mut Vec<XmlPatch>,
) {
  let space_attribute = node.attributes().find(|attribute| {
    attribute.namespace() == Some("http://www.w3.org/XML/1998/namespace")
      && attribute.name() == "space"
  });
  if let Some(attribute) = space_attribute {
    if attribute.value() != "preserve" {
      let value_range = attribute.range_value();
      patches.push(XmlPatch {
        start: value_range.start,
        end: value_range.end,
        value: "preserve".to_owned(),
      });
    }
  } else {
    patches.push(XmlPatch {
      start: insertion,
      end: insertion,
      value: " xml:space=\"preserve\"".to_owned(),
    });
  }
}

fn rewrite_part_xml(
  xml: &str,
  updates: &[TextNodeUpdate],
) -> Result<String, DocxRewriteError> {
  let document = Document::parse(xml).map_err(|_| {
    rewrite_error(
      DocxRewriteErrorCode::UnsupportedReplacement,
      "DOCX source XML changed after extraction",
    )
  })?;
  let mut patches = Vec::new();
  for update in updates {
    let node = node_at_path(&document, &update.path).ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX text-node locations changed after extraction",
      )
    })?;
    if !(is_word(node, "t") || is_word(node, "delText")) {
      return Err(rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX text-node locations changed after extraction",
      ));
    }
    let range = node.range();
    let source = xml.get(range.clone()).ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX text-node source changed after extraction",
      )
    })?;
    let opening_end_relative = xml_start_tag_end(source).ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX text-node opening tag changed after extraction",
      )
    })?;
    if source
      .get(..opening_end_relative)
      .is_some_and(|opening| opening.trim_end().ends_with('/'))
    {
      return Err(rewrite_error(
        DocxRewriteErrorCode::UnsupportedReplacement,
        "DOCX self-closing text nodes cannot receive replacements",
      ));
    }
    let closing_relative = source.rfind("</").ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX text-node closing tag changed after extraction",
      )
    })?;
    let content_start = range
      .start
      .checked_add(opening_end_relative)
      .and_then(|value| value.checked_add(1))
      .ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::StaleExtraction,
          "DOCX text-node source changed after extraction",
        )
      })?;
    let content_end = range.start.saturating_add(closing_relative);
    patches.push(XmlPatch {
      start: content_start,
      end: content_end,
      value: escape_xml_text(&update.value),
    });
    if update.value.chars().next().is_some_and(char::is_whitespace)
      || update
        .value
        .chars()
        .next_back()
        .is_some_and(char::is_whitespace)
    {
      add_xml_space_preserve_patch(
        node,
        range.start.saturating_add(opening_end_relative),
        &mut patches,
      );
    }
  }
  patches.sort_by_key(|patch| std::cmp::Reverse(patch.start));
  let mut rewritten = xml.to_owned();
  for patch in patches {
    if patch.start > patch.end || patch.end > rewritten.len() {
      return Err(rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX text-node source changed after extraction",
      ));
    }
    rewritten.replace_range(patch.start..patch.end, &patch.value);
  }
  Ok(rewritten)
}

fn safe_entry_path(path: &str) -> bool {
  !path.is_empty()
    && !path.starts_with('/')
    && !path.contains('\\')
    && !path.contains('\0')
    && !path.split('/').any(|part| part == "..")
}

fn checked_uncompressed_total(
  total: u64,
  additional: u64,
) -> Result<u64, DocxError> {
  let next = total.checked_add(additional).ok_or_else(|| {
    error(
      DocxErrorCode::UncompressedLimitExceeded,
      "DOCX uncompressed byte count overflowed",
    )
  })?;
  if next > u64::try_from(DOCX_UNCOMPRESSED_MAX_BYTES).unwrap_or(u64::MAX) {
    return Err(error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX archives must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} uncompressed bytes"
      ),
    ));
  }
  Ok(next)
}

fn read_archive(document: &[u8]) -> Result<Vec<ArchiveEntry>, DocxError> {
  if document.len() > DOCX_ARCHIVE_MAX_BYTES {
    return Err(error(
      DocxErrorCode::ArchiveLimitExceeded,
      format!("DOCX archives must not exceed {DOCX_ARCHIVE_MAX_BYTES} bytes"),
    ));
  }
  let mut archive = ZipArchive::new(Cursor::new(document)).map_err(|_| {
    error(
      DocxErrorCode::InvalidArchive,
      "Input is not a valid bounded DOCX ZIP archive",
    )
  })?;
  if archive.len() > DOCX_MAX_ENTRIES {
    return Err(error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!("DOCX archives must contain at most {DOCX_MAX_ENTRIES} entries"),
    ));
  }
  let mut entries = Vec::with_capacity(archive.len());
  let mut seen_paths = HashSet::with_capacity(archive.len());
  let mut total = 0_u64;
  for index in 0..archive.len() {
    let file = archive.by_index(index).map_err(|_| {
      error(
        DocxErrorCode::InvalidArchive,
        "Input is not a valid bounded DOCX ZIP archive",
      )
    })?;
    let path = file.name().to_owned();
    if !safe_entry_path(&path) {
      return Err(error(
        DocxErrorCode::UnsafeEntryPath,
        "DOCX archive contains an unsafe entry path",
      ));
    }
    if !seen_paths.insert(path.clone()) {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        format!("DOCX archive contains a duplicate entry path: {path}"),
      ));
    }
    let entry_limit = u64::try_from(DOCX_ENTRY_MAX_BYTES).unwrap_or(u64::MAX);
    if file.size() > entry_limit {
      return Err(error(
        DocxErrorCode::UncompressedLimitExceeded,
        format!("DOCX entries must not exceed {DOCX_ENTRY_MAX_BYTES} bytes"),
      ));
    }
    checked_uncompressed_total(total, file.size())?;
    let capacity = usize::try_from(file.size()).map_err(|_| {
      error(
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX entry size is unavailable",
      )
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    file
      .take(entry_limit.saturating_add(1))
      .read_to_end(&mut bytes)
      .map_err(|_| {
        error(
          DocxErrorCode::InvalidArchive,
          "Input is not a valid bounded DOCX ZIP archive",
        )
      })?;
    if bytes.len() > DOCX_ENTRY_MAX_BYTES {
      return Err(error(
        DocxErrorCode::UncompressedLimitExceeded,
        format!("DOCX entries must not exceed {DOCX_ENTRY_MAX_BYTES} bytes"),
      ));
    }
    total = checked_uncompressed_total(
      total,
      u64::try_from(bytes.len()).unwrap_or(u64::MAX),
    )?;
    entries.push(ArchiveEntry { path, bytes });
  }
  Ok(entries)
}

fn parse_xml<'a>(
  bytes: &'a [u8],
  path: &str,
) -> Result<Document<'a>, DocxError> {
  let text = std::str::from_utf8(bytes).map_err(|_| {
    error(
      DocxErrorCode::InvalidXml,
      format!("DOCX XML part is not valid UTF-8: {path}"),
    )
  })?;
  if bytes
    .windows(b"<!DOCTYPE".len())
    .any(|window| window.eq_ignore_ascii_case(b"<!DOCTYPE"))
  {
    return Err(error(
      DocxErrorCode::InvalidPackage,
      "DOCX XML must not contain a document type declaration",
    ));
  }
  let document = Document::parse(text).map_err(|_| {
    error(
      DocxErrorCode::InvalidXml,
      format!("DOCX part is not valid XML: {path}"),
    )
  })?;
  let mut depths = HashMap::<NodeId, usize>::new();
  for node in document.descendants().filter(Node::is_element) {
    let parent_depth = node
      .parent_element()
      .and_then(|parent| depths.get(&parent.id()))
      .copied()
      .unwrap_or_default();
    let depth = parent_depth.saturating_add(1);
    if depth >= DOCX_XML_MAX_DEPTH {
      return Err(error(
        DocxErrorCode::UncompressedLimitExceeded,
        format!(
          "DOCX XML must not exceed {DOCX_XML_MAX_DEPTH} nested elements"
        ),
      ));
    }
    depths.insert(node.id(), depth);
  }
  Ok(document)
}

fn attribute(node: Node<'_, '_>, local: &str) -> Option<String> {
  node
    .attributes()
    .find(|attribute| attribute.name() == local)
    .map(|attribute| attribute.value().to_owned())
}

fn parse_content_types(
  bytes: &[u8],
) -> Result<Vec<ContentTypePart>, DocxError> {
  let document = parse_xml(bytes, CONTENT_TYPES_PATH)?;
  let mut parts = Vec::new();
  let mut paths = HashSet::new();
  for node in document.descendants().filter(Node::is_element) {
    if node.tag_name().name() != "Override"
      || node.tag_name().namespace() != Some(CONTENT_TYPES_NAMESPACE)
    {
      continue;
    }
    let raw_path = attribute(node, "PartName").ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX content-type override is incomplete",
      )
    })?;
    let content_type = attribute(node, "ContentType").ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX content-type override is incomplete",
      )
    })?;
    let path = raw_path.strip_prefix('/').unwrap_or(&raw_path).to_owned();
    if !safe_entry_path(&path) || !paths.insert(path.clone()) {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        "DOCX content-type overrides must have unique safe paths",
      ));
    }
    parts.push(ContentTypePart { path, content_type });
  }
  Ok(parts)
}

fn parse_main_target(bytes: &[u8]) -> Result<String, DocxError> {
  let document = parse_xml(bytes, ROOT_RELATIONSHIPS_PATH)?;
  let allowed = RELATIONSHIP_NAMESPACES
    .map(|namespace| format!("{namespace}/officeDocument"));
  let mut targets = Vec::new();
  for node in document.descendants().filter(Node::is_element) {
    if node.tag_name().name() != "Relationship"
      || !PACKAGE_RELATIONSHIP_NAMESPACES
        .contains(&node.tag_name().namespace().unwrap_or_default())
      || !attribute(node, "Type").is_some_and(|value| allowed.contains(&value))
    {
      continue;
    }
    let target = attribute(node, "Target").ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX main-document relationship must be internal",
      )
    })?;
    if attribute(node, "TargetMode").is_some_and(|value| value == "External") {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        "DOCX main-document relationship must be internal",
      ));
    }
    let normalized = target.strip_prefix('/').unwrap_or(&target).to_owned();
    if !safe_entry_path(&normalized) || normalized.contains(':') {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        "DOCX main-document relationship has an unsafe target",
      ));
    }
    targets.push(normalized);
  }
  if targets.len() != 1 {
    return Err(error(
      DocxErrorCode::InvalidPackage,
      "DOCX archive must contain exactly one main-document relationship",
    ));
  }
  targets.into_iter().next().ok_or_else(|| {
    error(
      DocxErrorCode::InvalidPackage,
      "DOCX main-document relationship is unavailable",
    )
  })
}

fn classify_part(part: &ContentTypePart) -> Option<DocxPart> {
  let suffix = part
    .content_type
    .strip_prefix(WORDPROCESSING_CONTENT_TYPE_PREFIX)?;
  let part_type = match suffix {
    "comments+xml" => DocxPartType::Comments,
    "document.main+xml" => DocxPartType::MainDocument,
    "endnotes+xml" => DocxPartType::Endnotes,
    "footer+xml" => DocxPartType::Footer,
    "footnotes+xml" => DocxPartType::Footnotes,
    "header+xml" => DocxPartType::Header,
    _ => return None,
  };
  Some(DocxPart {
    part_type,
    path: part.path.clone(),
  })
}

fn validate_main_part(
  supported: &[DocxPart],
  main_target: &str,
) -> Result<(), DocxError> {
  let main_parts = supported
    .iter()
    .filter(|part| part.part_type == DocxPartType::MainDocument)
    .collect::<Vec<_>>();
  if main_parts.len() != 1 {
    return Err(error(
      DocxErrorCode::InvalidPackage,
      "DOCX archive must contain exactly one main document",
    ));
  }
  if main_parts
    .first()
    .is_none_or(|part| part.path != main_target)
  {
    return Err(error(
      DocxErrorCode::InvalidPackage,
      "DOCX main-document relationship and content type do not agree",
    ));
  }
  Ok(())
}

fn is_word(node: Node<'_, '_>, local: &str) -> bool {
  node.tag_name().name() == local
    && WORDPROCESSING_NAMESPACES
      .contains(&node.tag_name().namespace().unwrap_or_default())
}

#[cfg(test)]
fn is_markup_compatibility(node: Node<'_, '_>, local: &str) -> bool {
  node.tag_name().name() == local
    && MARKUP_COMPATIBILITY_NAMESPACES
      .contains(&node.tag_name().namespace().unwrap_or_default())
}

#[cfg(test)]
fn markup_choice_supported(choice: Node<'_, '_>) -> bool {
  choice
    .attributes()
    .find(|attribute| {
      attribute.name() == "Requires" && attribute.namespace().is_none()
    })
    .is_some_and(|attribute| {
      let mut prefixes = attribute.value().split_ascii_whitespace().peekable();
      prefixes.peek().is_some()
        && prefixes.all(|prefix| {
          choice
            .lookup_namespace_uri(Some(prefix))
            .is_some_and(|namespace| {
              WORDPROCESSING_NAMESPACES.contains(&namespace)
                || RELATIONSHIP_NAMESPACES.contains(&namespace)
            })
        })
    })
}

#[cfg(test)]
fn selected_markup_branch(alternate_content: Node<'_, '_>) -> Option<NodeId> {
  let mut fallback = None;
  for child in alternate_content.children().filter(Node::is_element) {
    if is_markup_compatibility(child, "Choice")
      && markup_choice_supported(child)
    {
      return Some(child.id());
    }
    if fallback.is_none() && is_markup_compatibility(child, "Fallback") {
      fallback = Some(child.id());
    }
  }
  fallback
}

#[cfg(test)]
fn suppressed_by_markup_compatibility(node: Node<'_, '_>) -> bool {
  node.ancestors().any(|ancestor| {
    let Some(parent) = ancestor.parent_element() else {
      return false;
    };
    if !is_markup_compatibility(parent, "AlternateContent")
      || !(is_markup_compatibility(ancestor, "Choice")
        || is_markup_compatibility(ancestor, "Fallback"))
    {
      return false;
    }
    selected_markup_branch(parent) != Some(ancestor.id())
  })
}

fn utf16_len(value: &str) -> usize {
  value.encode_utf16().count()
}

fn add_count(target: &mut usize, amount: usize) -> Result<(), DocxError> {
  *target = target.checked_add(amount).ok_or_else(|| {
    error(
      DocxErrorCode::UncompressedLimitExceeded,
      "DOCX coverage count overflowed",
    )
  })?;
  Ok(())
}

fn has_extension(path: &str, extension: &str) -> bool {
  Path::new(path)
    .extension()
    .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

fn is_metadata_content_type(content_type: &str) -> bool {
  matches!(
    content_type,
    CORE_PROPERTIES_CONTENT_TYPE
      | EXTENDED_PROPERTIES_CONTENT_TYPE
      | CUSTOM_PROPERTIES_CONTENT_TYPE
  )
}

fn known_metadata_content_type(path: &str) -> Option<&'static str> {
  match path {
    "docProps/core.xml" => Some(CORE_PROPERTIES_CONTENT_TYPE),
    "docProps/app.xml" => Some(EXTENDED_PROPERTIES_CONTENT_TYPE),
    "docProps/custom.xml" => Some(CUSTOM_PROPERTIES_CONTENT_TYPE),
    _ => None,
  }
}

fn is_relationships_entry(path: &str) -> bool {
  if path == ROOT_RELATIONSHIPS_PATH {
    return true;
  }
  path
    .strip_prefix("_rels/")
    .or_else(|| path.rsplit_once("/_rels/").map(|(_, filename)| filename))
    .is_some_and(|filename| {
      !filename.contains('/') && has_extension(filename, "rels")
    })
}

fn has_uri_scheme(target: &str) -> bool {
  let mut characters = target.chars();
  if !characters
    .next()
    .is_some_and(|value| value.is_ascii_alphabetic())
  {
    return false;
  }
  characters.take_while(|value| *value != ':').all(|value| {
    value.is_ascii_alphanumeric() || matches!(value, '+' | '.' | '-')
  }) && target.contains(':')
}

fn normalize_package_path(path: &str) -> Option<String> {
  let mut normalized = Vec::new();
  for segment in path.split('/') {
    match segment {
      "" | "." => {}
      ".." => {
        normalized.pop()?;
      }
      value => normalized.push(value),
    }
  }
  (!normalized.is_empty()).then(|| normalized.join("/"))
}

fn resolve_relationship_target(
  target: &str,
  relationships_path: &str,
) -> Option<String> {
  let decoded = percent_decode_str(target.trim()).decode_utf8().ok()?;
  if decoded.starts_with('/') {
    return normalize_package_path(decoded.trim_start_matches('/'));
  }
  let base = relationships_path
    .rfind("_rels/")
    .and_then(|index| relationships_path.get(..index))
    .unwrap_or_default();
  normalize_package_path(&format!("{base}{decoded}"))
}

fn relationship_coverage(
  entries: &[ArchiveEntry],
) -> Result<Vec<DocxCoverageItem>, DocxError> {
  let known_paths = entries
    .iter()
    .map(|entry| entry.path.to_ascii_lowercase())
    .collect::<HashSet<_>>();
  let mut coverage = Vec::new();
  for entry in entries
    .iter()
    .filter(|entry| is_relationships_entry(&entry.path))
  {
    let document = parse_xml(&entry.bytes, &entry.path)?;
    for node in document.descendants().filter(Node::is_element) {
      if node.tag_name().name() != "Relationship"
        || !PACKAGE_RELATIONSHIP_NAMESPACES
          .contains(&node.tag_name().namespace().unwrap_or_default())
      {
        continue;
      }
      let Some(target) = attribute(node, "Target") else {
        continue;
      };
      let trimmed = target.trim();
      let external = attribute(node, "TargetMode")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("external"))
        || has_uri_scheme(trimmed)
        || trimmed.starts_with("//");
      let resolved = (!external)
        .then(|| resolve_relationship_target(trimmed, &entry.path))
        .flatten();
      if !external
        && resolved
          .as_ref()
          .is_some_and(|path| known_paths.contains(&path.to_ascii_lowercase()))
      {
        continue;
      }
      let reason = if trimmed.to_ascii_lowercase().starts_with("mailto:")
        || trimmed.to_ascii_lowercase().starts_with("tel:")
      {
        "target uses a PII-bearing external scheme (mailto/tel) that anonymization does not redact"
      } else if external {
        "target is external and is not examined or redacted by anonymization"
      } else {
        "target does not resolve to a package part and is not examined or redacted by anonymization"
      };
      let prefix = attribute(node, "Id").map_or_else(
        || "Relationship".to_owned(),
        |identifier| format!("Relationship \"{identifier}\""),
      );
      coverage.push(DocxCoverageItem::Unsupported {
        path: entry.path.clone(),
        content_type: RELATIONSHIPS_CONTENT_TYPE.to_owned(),
        reason: format!("{prefix} {reason}"),
      });
    }
  }
  Ok(coverage)
}

#[cfg(test)]
fn element_child_indices(document: &Document<'_>) -> HashMap<NodeId, usize> {
  let mut indices = HashMap::new();
  indices.insert(document.root_element().id(), 0);
  for parent in document.descendants().filter(Node::is_element) {
    for (index, child) in parent.children().filter(Node::is_element).enumerate()
    {
      indices.insert(child.id(), index);
    }
  }
  indices
}

#[cfg(test)]
fn node_path(
  node: Node<'_, '_>,
  child_indices: &HashMap<NodeId, usize>,
) -> Vec<usize> {
  let mut path = Vec::new();
  let mut current = Some(node);
  while let Some(item) = current {
    path.push(child_indices.get(&item.id()).copied().unwrap_or_default());
    current = item.parent_element();
  }
  path.reverse();
  path
}

#[cfg(test)]
fn contexts(
  node: Node<'_, '_>,
  inline_context_scan_ops: &mut usize,
) -> Result<Vec<DocxInlineContext>, DocxError> {
  let mut found = Vec::new();
  let mut ancestors = node
    .ancestors()
    .filter(Node::is_element)
    .collect::<Vec<_>>();
  *inline_context_scan_ops = inline_context_scan_ops
    .checked_add(ancestors.len())
    .ok_or_else(|| {
      error(
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX inline-context scan operation count overflowed",
      )
    })?;
  if *inline_context_scan_ops > DOCX_MAX_INLINE_CONTEXT_SCAN_OPS {
    return Err(error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX archives must not require more than {DOCX_MAX_INLINE_CONTEXT_SCAN_OPS} aggregate inline-context scan operations"
      ),
    ));
  }
  ancestors.reverse();
  for ancestor in ancestors {
    if is_word(ancestor, "hyperlink") {
      let relationship_id = ancestor
        .attributes()
        .find(|attribute| {
          attribute.name() == "id"
            && RELATIONSHIP_NAMESPACES
              .contains(&attribute.namespace().unwrap_or_default())
        })
        .map(|attribute| attribute.value().to_owned());
      found.push(DocxInlineContext::Hyperlink {
        relationship_id,
        anchor: ancestor
          .attributes()
          .find(|attribute| {
            attribute.name() == "anchor"
              && WORDPROCESSING_NAMESPACES
                .contains(&attribute.namespace().unwrap_or_default())
          })
          .map(|attribute| attribute.value().to_owned()),
      });
    }
    let revision = match ancestor.tag_name().name() {
      "del" if is_word(ancestor, "del") => Some(DocxRevision::Deletion),
      "ins" if is_word(ancestor, "ins") => Some(DocxRevision::Insertion),
      "moveFrom" if is_word(ancestor, "moveFrom") => {
        Some(DocxRevision::MoveFrom)
      }
      "moveTo" if is_word(ancestor, "moveTo") => Some(DocxRevision::MoveTo),
      _ => None,
    };
    if let Some(revision) = revision {
      found.push(DocxInlineContext::Revision { revision });
    }
  }
  Ok(found)
}

#[cfg(test)]
fn block_location(
  part: &DocxPart,
  paragraph: Node<'_, '_>,
  block_index: usize,
  child_indices: &HashMap<NodeId, usize>,
) -> DocxBlockLocation {
  let xml_path = node_path(paragraph, child_indices);
  if let Some(text_box) = paragraph
    .ancestors()
    .find(|node| is_word(*node, "txbxContent"))
  {
    return DocxBlockLocation::TextBoxParagraph {
      part: part.clone(),
      block_index,
      xml_path,
      text_box_path: node_path(text_box, child_indices),
    };
  }
  let cell = paragraph.ancestors().find(|node| is_word(*node, "tc"));
  let row = paragraph.ancestors().find(|node| is_word(*node, "tr"));
  let table = paragraph.ancestors().find(|node| is_word(*node, "tbl"));
  if let (Some(cell), Some(row), Some(table)) = (cell, row, table) {
    return DocxBlockLocation::TableCellParagraph {
      part: part.clone(),
      block_index,
      xml_path,
      table_path: node_path(table, child_indices),
      row_path: node_path(row, child_indices),
      cell_path: node_path(cell, child_indices),
    };
  }
  DocxBlockLocation::Paragraph {
    part: part.clone(),
    block_index,
    xml_path,
  }
}

#[cfg(test)]
fn nearest_paragraph<'tree, 'input>(
  node: Node<'tree, 'input>,
) -> Option<Node<'tree, 'input>> {
  node.ancestors().find(|ancestor| is_word(*ancestor, "p"))
}

#[cfg(test)]
fn nearest_run<'tree, 'input>(
  node: Node<'tree, 'input>,
) -> Option<Node<'tree, 'input>> {
  node.ancestors().find(|ancestor| is_word(*ancestor, "r"))
}

#[allow(clippy::too_many_lines)]
#[cfg(test)]
fn extract_part_dom(
  part: &DocxPart,
  bytes: &[u8],
  total_segments: &mut usize,
  inline_context_scan_ops: &mut usize,
) -> Result<(Vec<DocxTextBlock>, DocxCoverage), DocxError> {
  let document = parse_xml(bytes, &part.path)?;
  let child_indices = element_child_indices(&document);
  for node in document.descendants().filter(Node::is_element) {
    if (is_word(node, "t") || is_word(node, "delText"))
      && !suppressed_by_markup_compatibility(node)
      && nearest_paragraph(node).is_none()
      && node.text().is_some_and(|text| !text.is_empty())
    {
      return Err(error(
        DocxErrorCode::InvalidPackage,
        "DOCX text is outside a paragraph",
      ));
    }
  }
  let paragraphs = document
    .descendants()
    .filter(Node::is_element)
    .filter(|node| is_word(*node, "p"))
    .filter(|node| !suppressed_by_markup_compatibility(*node))
    .collect::<Vec<_>>();
  if paragraphs.len() > DOCX_MAX_TEXT_BLOCKS {
    return Err(error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX parts must not contain more than {DOCX_MAX_TEXT_BLOCKS} text blocks"
      ),
    ));
  }
  let mut blocks = Vec::with_capacity(paragraphs.len());
  let mut coverage = DocxCoverage::default();
  for (block_index, paragraph) in paragraphs.into_iter().enumerate() {
    let mut text = String::new();
    let mut text_utf16_len = 0_usize;
    let mut segments = Vec::new();
    for node in paragraph.descendants().filter(Node::is_element) {
      if suppressed_by_markup_compatibility(node) {
        continue;
      }
      if nearest_paragraph(node) != Some(paragraph) {
        continue;
      }
      let (source, value) = if is_word(node, "t") || is_word(node, "delText") {
        let value = node
          .children()
          .filter(Node::is_text)
          .filter_map(|child| child.text())
          .collect::<String>();
        (DocxSegmentSource::Text, value)
      } else if is_word(node, "tab") && nearest_run(node).is_some() {
        (DocxSegmentSource::Tab, "\t".to_owned())
      } else if (is_word(node, "br") || is_word(node, "cr"))
        && nearest_run(node).is_some()
      {
        (DocxSegmentSource::Break, "\n".to_owned())
      } else {
        continue;
      };
      if value.is_empty() {
        continue;
      }
      *total_segments = total_segments.checked_add(1).ok_or_else(|| {
        error(
          DocxErrorCode::UncompressedLimitExceeded,
          "DOCX text segment count overflowed",
        )
      })?;
      if *total_segments > DOCX_MAX_TEXT_SEGMENTS {
        return Err(error(
          DocxErrorCode::UncompressedLimitExceeded,
          format!(
            "DOCX archives must not contain more than {DOCX_MAX_TEXT_SEGMENTS} text segments"
          ),
        ));
      }
      let start = text_utf16_len;
      text_utf16_len = text_utf16_len
        .checked_add(utf16_len(&value))
        .ok_or_else(|| {
          error(
            DocxErrorCode::UncompressedLimitExceeded,
            "DOCX text length overflowed",
          )
        })?;
      text.push_str(&value);
      let item_contexts = contexts(node, inline_context_scan_ops)?;
      if item_contexts
        .iter()
        .any(|item| matches!(item, DocxInlineContext::Hyperlink { .. }))
      {
        add_count(&mut coverage.hyperlink_text_segment_count, 1)?;
      }
      if item_contexts
        .iter()
        .any(|item| matches!(item, DocxInlineContext::Revision { .. }))
      {
        add_count(&mut coverage.revision_text_segment_count, 1)?;
      }
      segments.push(DocxTextSegment {
        start,
        end: text_utf16_len,
        source,
        contexts: item_contexts,
        xml_path: node_path(node, &child_indices),
      });
    }
    blocks.push(DocxTextBlock {
      text,
      location: block_location(part, paragraph, block_index, &child_indices),
      segments,
    });
  }
  coverage.unsupported_symbol_count = document
    .descendants()
    .filter(|node| is_word(*node, "sym"))
    .count();
  coverage.unsupported_field_instruction_count = document
    .descendants()
    .filter(|node| is_word(*node, "instrText") || is_word(*node, "fldSimple"))
    .count();
  coverage.unsupported_alternate_content_count = document
    .descendants()
    .filter(|node| {
      node.tag_name().name() == "AlternateContent"
        && MARKUP_COMPATIBILITY_NAMESPACES
          .contains(&node.tag_name().namespace().unwrap_or_default())
    })
    .count();
  Ok((blocks, coverage))
}

fn kernel_error(source: docx_kernel::ScanError, part_path: &str) -> DocxError {
  match source {
    docx_kernel::ScanError::InvalidXml => error(
      DocxErrorCode::InvalidXml,
      format!("DOCX part is not valid XML: {part_path}"),
    ),
    docx_kernel::ScanError::TextOutsideParagraph => error(
      DocxErrorCode::InvalidPackage,
      "DOCX text is outside a paragraph",
    ),
    docx_kernel::ScanError::DocumentTypeDeclaration => error(
      DocxErrorCode::InvalidPackage,
      "DOCX XML must not contain a document type declaration",
    ),
    docx_kernel::ScanError::TooDeep => error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!("DOCX XML must not exceed {DOCX_XML_MAX_DEPTH} nested elements"),
    ),
    docx_kernel::ScanError::TooManyBlocks => error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX archives must not contain more than {DOCX_MAX_TEXT_BLOCKS} text blocks"
      ),
    ),
    docx_kernel::ScanError::TooManySegments => error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX archives must not contain more than {DOCX_MAX_TEXT_SEGMENTS} text segments"
      ),
    ),
    docx_kernel::ScanError::TooManyEvents => error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX archives must not require more than {DOCX_MAX_XML_EVENTS} XML events"
      ),
    ),
    docx_kernel::ScanError::TooManyInlineContextCopies => error(
      DocxErrorCode::UncompressedLimitExceeded,
      format!(
        "DOCX archives must not require more than {DOCX_MAX_INLINE_CONTEXT_SCAN_OPS} aggregate inline-context scan operations"
      ),
    ),
    docx_kernel::ScanError::TextLengthOverflow => error(
      DocxErrorCode::UncompressedLimitExceeded,
      "DOCX text length overflowed",
    ),
    docx_kernel::ScanError::UnsupportedEncoding => error(
      DocxErrorCode::InvalidXml,
      format!("DOCX XML part is not valid UTF-8: {part_path}"),
    ),
  }
}

fn convert_context(context: docx_kernel::InlineContext) -> DocxInlineContext {
  match context {
    docx_kernel::InlineContext::Hyperlink {
      relationship_id,
      anchor,
    } => DocxInlineContext::Hyperlink {
      relationship_id,
      anchor,
    },
    docx_kernel::InlineContext::Revision(revision) => {
      DocxInlineContext::Revision {
        revision: match revision {
          docx_kernel::RevisionKind::Deletion => DocxRevision::Deletion,
          docx_kernel::RevisionKind::Insertion => DocxRevision::Insertion,
          docx_kernel::RevisionKind::MoveFrom => DocxRevision::MoveFrom,
          docx_kernel::RevisionKind::MoveTo => DocxRevision::MoveTo,
        },
      }
    }
  }
}

fn convert_location(
  part: &DocxPart,
  block_index: usize,
  location: docx_kernel::BlockLocation,
) -> DocxBlockLocation {
  match location {
    docx_kernel::BlockLocation::Paragraph { xml_path } => {
      DocxBlockLocation::Paragraph {
        part: part.clone(),
        block_index,
        xml_path,
      }
    }
    docx_kernel::BlockLocation::TableCellParagraph {
      xml_path,
      table_path,
      row_path,
      cell_path,
    } => DocxBlockLocation::TableCellParagraph {
      part: part.clone(),
      block_index,
      xml_path,
      table_path,
      row_path,
      cell_path,
    },
    docx_kernel::BlockLocation::TextBoxParagraph {
      xml_path,
      text_box_path,
    } => DocxBlockLocation::TextBoxParagraph {
      part: part.clone(),
      block_index,
      xml_path,
      text_box_path,
    },
  }
}

fn convert_block(
  part: &DocxPart,
  block_index: usize,
  block: docx_kernel::TextBlock,
) -> DocxTextBlock {
  DocxTextBlock {
    text: block.text,
    location: convert_location(part, block_index, block.location),
    segments: block
      .segments
      .into_iter()
      .map(|segment| DocxTextSegment {
        start: segment.start_utf16,
        end: segment.end_utf16,
        source: match segment.source {
          docx_kernel::SegmentSource::Break => DocxSegmentSource::Break,
          docx_kernel::SegmentSource::Tab => DocxSegmentSource::Tab,
          docx_kernel::SegmentSource::Text => DocxSegmentSource::Text,
        },
        contexts: segment.contexts.into_iter().map(convert_context).collect(),
        xml_path: segment.xml_path,
      })
      .collect(),
  }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct DocxScanBudget {
  blocks: usize,
  segments: usize,
  events: usize,
  inline_context_copies: usize,
}

impl DocxScanBudget {
  fn remaining_limits(self) -> Result<docx_kernel::ScanLimits, DocxError> {
    let blocks = DOCX_MAX_TEXT_BLOCKS.checked_sub(self.blocks).ok_or_else(
      || {
        error(
          DocxErrorCode::UncompressedLimitExceeded,
          format!(
            "DOCX archives must not contain more than {DOCX_MAX_TEXT_BLOCKS} text blocks"
          ),
        )
      },
    )?;
    let segments = DOCX_MAX_TEXT_SEGMENTS.checked_sub(self.segments).ok_or_else(
      || {
        error(
          DocxErrorCode::UncompressedLimitExceeded,
          format!(
            "DOCX archives must not contain more than {DOCX_MAX_TEXT_SEGMENTS} text segments"
          ),
        )
      },
    )?;
    let events = DOCX_MAX_XML_EVENTS.checked_sub(self.events).ok_or_else(|| {
      error(
        DocxErrorCode::UncompressedLimitExceeded,
        format!(
          "DOCX archives must not require more than {DOCX_MAX_XML_EVENTS} XML events"
        ),
      )
    })?;
    let inline_context_copies = DOCX_MAX_INLINE_CONTEXT_SCAN_OPS
      .checked_sub(self.inline_context_copies)
      .ok_or_else(|| {
        error(
          DocxErrorCode::UncompressedLimitExceeded,
          format!(
            "DOCX archives must not require more than {DOCX_MAX_INLINE_CONTEXT_SCAN_OPS} aggregate inline-context scan operations"
          ),
        )
      })?;
    Ok(docx_kernel::ScanLimits {
      blocks,
      segments,
      depth: DOCX_XML_MAX_DEPTH,
      events,
      inline_context_copies,
    })
  }

  fn add(&mut self, delta: Self) -> Result<(), DocxError> {
    self.blocks = self.blocks.checked_add(delta.blocks).ok_or_else(|| {
      error(
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX text block count overflowed",
      )
    })?;
    self.segments =
      self.segments.checked_add(delta.segments).ok_or_else(|| {
        error(
          DocxErrorCode::UncompressedLimitExceeded,
          "DOCX text segment count overflowed",
        )
      })?;
    self.events = self.events.checked_add(delta.events).ok_or_else(|| {
      error(
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX XML event count overflowed",
      )
    })?;
    self.inline_context_copies = self
      .inline_context_copies
      .checked_add(delta.inline_context_copies)
      .ok_or_else(|| {
        error(
          DocxErrorCode::UncompressedLimitExceeded,
          "DOCX inline-context scan operation count overflowed",
        )
      })?;
    Ok(())
  }
}

fn extract_part(
  part: &DocxPart,
  bytes: &[u8],
  budget: &mut DocxScanBudget,
) -> Result<(Vec<DocxTextBlock>, DocxCoverage), DocxError> {
  let mut blocks = Vec::new();
  let mut part_segment_count = 0_usize;
  let coverage = docx_kernel::scan_wordprocessing_part_with(
    bytes,
    budget.remaining_limits()?,
    |block| {
      part_segment_count = part_segment_count
        .checked_add(block.segments.len())
        .ok_or(docx_kernel::ScanError::TooManySegments)?;
      let block_index = blocks.len();
      blocks.push(convert_block(part, block_index, block));
      Ok(())
    },
  )
  .map_err(|source| kernel_error(source, &part.path))?;
  budget.add(DocxScanBudget {
    blocks: blocks.len(),
    segments: part_segment_count,
    events: coverage.work.events,
    inline_context_copies: coverage.work.inline_context_copies,
  })?;
  let coverage = DocxCoverage {
    hyperlink_text_segment_count: coverage.hyperlink_segments,
    revision_text_segment_count: coverage.revision_segments,
    unsupported_alternate_content_count: coverage.unsupported_alternate_content,
    unsupported_symbol_count: coverage.unsupported_symbols,
    unsupported_field_instruction_count: coverage
      .unsupported_field_instructions,
    ..DocxCoverage::default()
  };
  Ok((blocks, coverage))
}

fn add_inventory_coverage<'a>(
  entries: &[ArchiveEntry],
  content_types: &'a [ContentTypePart],
  covered: &mut HashSet<&'a str>,
  coverage: &mut DocxCoverage,
) {
  let overrides = content_types
    .iter()
    .map(|part| (part.path.as_str(), part.content_type.as_str()))
    .collect::<HashMap<_, _>>();
  for part in content_types {
    if covered.contains(part.path.as_str())
      || part.content_type == RELATIONSHIPS_CONTENT_TYPE
    {
      continue;
    }
    let reason = if is_metadata_content_type(&part.content_type) {
      "Document metadata parts are not extracted or redacted"
    } else if part
      .content_type
      .starts_with(WORDPROCESSING_CONTENT_TYPE_PREFIX)
    {
      "WordprocessingML part type is not extracted"
    } else {
      "Package part type is not extracted or redacted"
    };
    coverage.parts.push(DocxCoverageItem::Unsupported {
      path: part.path.clone(),
      content_type: part.content_type.clone(),
      reason: reason.to_owned(),
    });
    covered.insert(part.path.as_str());
  }
  for entry in entries {
    if covered.contains(entry.path.as_str())
      || entry.path.ends_with('/')
      || is_relationships_entry(&entry.path)
    {
      continue;
    }
    let metadata = entry.path.starts_with("docProps/");
    let custom_xml =
      entry.path.starts_with("customXml/") && has_extension(&entry.path, "xml");
    coverage.parts.push(DocxCoverageItem::Unsupported {
      path: entry.path.clone(),
      content_type: overrides.get(entry.path.as_str()).map_or_else(
        || {
          known_metadata_content_type(&entry.path).map_or_else(
            || {
              if has_extension(&entry.path, "xml") {
                GENERIC_XML_CONTENT_TYPE.to_owned()
              } else {
                GENERIC_BINARY_CONTENT_TYPE.to_owned()
              }
            },
            str::to_owned,
          )
        },
        |value| (*value).to_owned(),
      ),
      reason: if metadata {
        "Document metadata parts are not extracted or redacted"
      } else if custom_xml {
        "Custom XML parts are not extracted or redacted"
      } else {
        "Package part is not examined by anonymization"
      }
      .to_owned(),
    });
  }
}

pub fn extract_docx_text(document: &[u8]) -> Result<DocxExtraction, DocxError> {
  let entries = read_archive(document)?;
  let entries_by_path = entries
    .iter()
    .map(|entry| (entry.path.as_str(), entry.bytes.as_slice()))
    .collect::<HashMap<_, _>>();
  let content_type_bytes =
    entries_by_path.get(CONTENT_TYPES_PATH).ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX archive is missing [Content_Types].xml",
      )
    })?;
  let content_types = parse_content_types(content_type_bytes)?;
  let root_relationships = entries_by_path
    .get(ROOT_RELATIONSHIPS_PATH)
    .ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        "DOCX archive is missing _rels/.rels",
      )
    })?;
  let main_target = parse_main_target(root_relationships)?;
  let supported = content_types
    .iter()
    .filter_map(classify_part)
    .collect::<Vec<_>>();
  validate_main_part(&supported, &main_target)?;
  let mut blocks = Vec::new();
  let mut coverage = DocxCoverage::default();
  let mut scan_budget = DocxScanBudget::default();
  let mut covered =
    HashSet::from([CONTENT_TYPES_PATH, ROOT_RELATIONSHIPS_PATH]);
  for part in &supported {
    let bytes = entries_by_path.get(part.path.as_str()).ok_or_else(|| {
      error(
        DocxErrorCode::InvalidPackage,
        format!("DOCX archive is missing declared part: {}", part.path),
      )
    })?;
    let (part_blocks, part_coverage) =
      extract_part(part, bytes, &mut scan_budget)?;
    coverage.parts.push(DocxCoverageItem::Extracted {
      part: part.clone(),
      block_count: part_blocks.len(),
    });
    add_count(
      &mut coverage.hyperlink_text_segment_count,
      part_coverage.hyperlink_text_segment_count,
    )?;
    add_count(
      &mut coverage.revision_text_segment_count,
      part_coverage.revision_text_segment_count,
    )?;
    add_count(
      &mut coverage.unsupported_alternate_content_count,
      part_coverage.unsupported_alternate_content_count,
    )?;
    add_count(
      &mut coverage.unsupported_symbol_count,
      part_coverage.unsupported_symbol_count,
    )?;
    add_count(
      &mut coverage.unsupported_field_instruction_count,
      part_coverage.unsupported_field_instruction_count,
    )?;
    blocks.extend(part_blocks);
    covered.insert(part.path.as_str());
  }
  coverage.parts.extend(relationship_coverage(&entries)?);
  add_inventory_coverage(&entries, &content_types, &mut covered, &mut coverage);
  Ok(DocxExtraction {
    contract_version: DOCX_EXTRACTION_CONTRACT_VERSION,
    blocks,
    coverage,
  })
}

pub fn plan_docx_restoration(
  document: &[u8],
  session_id: &str,
) -> Result<DocxRestorationPlan, DocxRestorationError> {
  let extraction = extract_docx_text(document).map_err(|source| {
    restoration_error(
      match source.code() {
        DocxErrorCode::ArchiveLimitExceeded
        | DocxErrorCode::UncompressedLimitExceeded => {
          DocxRestorationErrorCode::RestorationLimitExceeded
        }
        DocxErrorCode::InvalidArchive
        | DocxErrorCode::InvalidPackage
        | DocxErrorCode::InvalidXml
        | DocxErrorCode::UnsafeEntryPath => {
          DocxRestorationErrorCode::UnsupportedDocument
        }
      },
      source.to_string(),
    )
  })?;
  let encoded_session_id = session_id.replace('_', "%5F");
  let mut blocks = Vec::new();
  let mut candidate_count = 0_usize;
  for block in &extraction.blocks {
    let candidates = scan_restoration_candidates(
      &block.text,
      &encoded_session_id,
      &mut candidate_count,
    )?;
    if !candidates.is_empty() {
      blocks.push(DocxBlockRestorationPlan {
        location: block.location.clone(),
        expected_text: block.text.clone(),
        candidates,
      });
    }
  }
  Ok(DocxRestorationPlan {
    extraction,
    blocks,
    candidate_count,
  })
}

#[allow(clippy::too_many_lines)]
pub fn rewrite_docx_text(
  document: &[u8],
  rewrites: &[DocxBlockRewrite],
) -> Result<DocxRewriteResult, DocxRewriteError> {
  let extraction = extract_docx_text(document)
    .map_err(|source| map_extraction_error(&source))?;
  if rewrites.is_empty() {
    return Ok(DocxRewriteResult {
      document: document.to_vec(),
      rewritten_block_count: 0,
      applied_replacement_count: 0,
    });
  }
  let blocks_by_location = extraction
    .blocks
    .iter()
    .map(|block| (&block.location, block))
    .collect::<HashMap<_, _>>();
  let mut rewritten_locations = HashSet::new();
  let mut updates_by_part =
    HashMap::<String, HashMap<Vec<usize>, TextNodeUpdate>>::new();
  let mut replacement_bytes_by_part = HashMap::<String, usize>::new();
  let mut applied_replacement_count = 0_usize;
  let mut total_replacement_bytes = 0_usize;

  for rewrite in rewrites {
    if !rewritten_locations.insert(rewrite.location.clone()) {
      return Err(rewrite_error(
        DocxRewriteErrorCode::InvalidReplacement,
        "Each DOCX block may appear in a rewrite plan only once",
      ));
    }
    let block = blocks_by_location.get(&rewrite.location).ok_or_else(|| {
      rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX block location or expected text no longer matches",
      )
    })?;
    if block.text != rewrite.expected_text {
      return Err(rewrite_error(
        DocxRewriteErrorCode::StaleExtraction,
        "DOCX block location or expected text no longer matches",
      ));
    }
    if rewrite.replacements.is_empty() {
      return Err(rewrite_error(
        DocxRewriteErrorCode::InvalidReplacement,
        "DOCX block rewrite plans must contain at least one replacement",
      ));
    }
    applied_replacement_count = applied_replacement_count
      .checked_add(rewrite.replacements.len())
      .ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::RewriteLimitExceeded,
          "DOCX replacement count overflowed",
        )
      })?;
    if applied_replacement_count > DOCX_MAX_REPLACEMENTS {
      return Err(rewrite_error(
        DocxRewriteErrorCode::RewriteLimitExceeded,
        format!(
          "DOCX rewrites must not contain more than {DOCX_MAX_REPLACEMENTS} replacements"
        ),
      ));
    }
    let rewrite_replacement_bytes = rewrite
      .replacements
      .iter()
      .try_fold(0_usize, |total, replacement| {
        total.checked_add(
          escaped_xml_text_byte_length(&replacement.replacement)
            .unwrap_or(usize::MAX),
        )
      })
      .ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::RewriteLimitExceeded,
          "DOCX rewrite replacement byte count overflowed",
        )
      })?;
    total_replacement_bytes = total_replacement_bytes
      .checked_add(rewrite_replacement_bytes)
      .ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::RewriteLimitExceeded,
          "DOCX rewrite replacement byte count overflowed",
        )
      })?;
    if total_replacement_bytes > DOCX_UNCOMPRESSED_MAX_BYTES {
      return Err(rewrite_error(
        DocxRewriteErrorCode::RewriteLimitExceeded,
        format!(
          "DOCX rewrite replacement text must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} aggregate escaped UTF-8 bytes"
        ),
      ));
    }
    let part_path = rewrite.location.part_path().to_owned();
    let part_replacement_bytes = replacement_bytes_by_part
      .get(&part_path)
      .copied()
      .unwrap_or_default()
      .checked_add(rewrite_replacement_bytes)
      .ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::RewriteLimitExceeded,
          "DOCX part replacement byte count overflowed",
        )
      })?;
    if part_replacement_bytes > DOCX_ENTRY_MAX_BYTES {
      return Err(rewrite_error(
        DocxRewriteErrorCode::RewriteLimitExceeded,
        format!(
          "DOCX rewrite replacement text for a single part must not exceed {DOCX_ENTRY_MAX_BYTES} aggregate escaped UTF-8 bytes"
        ),
      ));
    }
    replacement_bytes_by_part.insert(part_path.clone(), part_replacement_bytes);
    let part_updates = updates_by_part.entry(part_path).or_default();
    for update in plan_block_updates(block, rewrite)? {
      part_updates.insert(update.path.clone(), update);
    }
  }

  let mut total_updated_node_bytes = 0_usize;
  for updates in updates_by_part.values() {
    let part_updated_node_bytes = updates
      .values()
      .try_fold(0_usize, |total, update| {
        total.checked_add(
          escaped_xml_text_byte_length(&update.value).unwrap_or(usize::MAX),
        )
      })
      .ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::RewriteLimitExceeded,
          "DOCX rewritten text-node byte count overflowed",
        )
      })?;
    if part_updated_node_bytes > DOCX_ENTRY_MAX_BYTES {
      return Err(rewrite_error(
        DocxRewriteErrorCode::RewriteLimitExceeded,
        format!(
          "DOCX rewritten text nodes for a single part must not exceed {DOCX_ENTRY_MAX_BYTES} escaped UTF-8 bytes"
        ),
      ));
    }
    total_updated_node_bytes = total_updated_node_bytes
      .checked_add(part_updated_node_bytes)
      .ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::RewriteLimitExceeded,
          "DOCX rewritten text-node byte count overflowed",
        )
      })?;
    if total_updated_node_bytes > DOCX_UNCOMPRESSED_MAX_BYTES {
      return Err(rewrite_error(
        DocxRewriteErrorCode::RewriteLimitExceeded,
        format!(
          "DOCX rewritten text nodes must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} aggregate escaped UTF-8 bytes"
        ),
      ));
    }
  }

  let mut entries =
    read_archive(document).map_err(|source| map_extraction_error(&source))?;
  if entries.iter().any(|entry| {
    entry
      .path
      .to_ascii_lowercase()
      .starts_with(SIGNATURE_PART_PREFIX)
  }) {
    return Err(rewrite_error(
      DocxRewriteErrorCode::UnsupportedReplacement,
      "Digitally signed DOCX packages must be re-signed before rewriting",
    ));
  }
  let mut projected_total = 0_usize;
  for entry in &entries {
    let mut projected = entry.bytes.len();
    if let Some(updates) = updates_by_part.get(&entry.path) {
      for update in updates.values() {
        let escaped =
          escaped_xml_text_byte_length(&update.value).unwrap_or(usize::MAX);
        projected = projected
          .checked_add(escaped)
          .and_then(|value| value.checked_add(XML_SPACE_INSERTION_BYTES))
          .and_then(|value| value.checked_sub(update.original_byte_length))
          .ok_or_else(|| {
            rewrite_error(
              DocxRewriteErrorCode::RewriteLimitExceeded,
              "DOCX projected part byte count overflowed",
            )
          })?;
      }
      if projected > DOCX_ENTRY_MAX_BYTES {
        return Err(rewrite_error(
          DocxRewriteErrorCode::RewriteLimitExceeded,
          format!(
            "Rewritten DOCX parts must not exceed {DOCX_ENTRY_MAX_BYTES} projected bytes"
          ),
        ));
      }
    }
    projected_total =
      projected_total.checked_add(projected).ok_or_else(|| {
        rewrite_error(
          DocxRewriteErrorCode::RewriteLimitExceeded,
          "DOCX projected archive byte count overflowed",
        )
      })?;
    if projected_total > DOCX_UNCOMPRESSED_MAX_BYTES {
      return Err(rewrite_error(
        DocxRewriteErrorCode::RewriteLimitExceeded,
        format!(
          "Rewritten DOCX archives must not exceed {DOCX_UNCOMPRESSED_MAX_BYTES} projected uncompressed bytes"
        ),
      ));
    }
  }
  for entry in &mut entries {
    if let Some(updates) = updates_by_part.remove(&entry.path) {
      let xml = std::str::from_utf8(&entry.bytes).map_err(|_| {
        rewrite_error(
          DocxRewriteErrorCode::UnsupportedReplacement,
          "DOCX source XML changed after extraction",
        )
      })?;
      let updates = updates.into_values().collect::<Vec<_>>();
      entry.bytes = rewrite_part_xml(xml, &updates)?.into_bytes();
    }
  }
  if !updates_by_part.is_empty() {
    return Err(rewrite_error(
      DocxRewriteErrorCode::StaleExtraction,
      "DOCX source part changed after extraction",
    ));
  }
  let output = Cursor::new(Vec::new());
  let mut writer = ZipWriter::new(output);
  let options = SimpleFileOptions::default()
    .compression_method(CompressionMethod::Deflated);
  for entry in entries {
    if entry.path.ends_with('/') {
      writer.add_directory(entry.path, options).map_err(|_| {
        rewrite_error(
          DocxRewriteErrorCode::UnsupportedReplacement,
          "Rewritten DOCX archive could not be created",
        )
      })?;
    } else {
      writer.start_file(entry.path, options).map_err(|_| {
        rewrite_error(
          DocxRewriteErrorCode::UnsupportedReplacement,
          "Rewritten DOCX archive could not be created",
        )
      })?;
      writer.write_all(&entry.bytes).map_err(|_| {
        rewrite_error(
          DocxRewriteErrorCode::UnsupportedReplacement,
          "Rewritten DOCX archive could not be created",
        )
      })?;
    }
  }
  let rewritten = writer.finish().map_err(|_| {
    rewrite_error(
      DocxRewriteErrorCode::UnsupportedReplacement,
      "Rewritten DOCX archive could not be created",
    )
  })?;
  let rewritten_document = rewritten.into_inner();
  if rewritten_document.len() > DOCX_ARCHIVE_MAX_BYTES {
    return Err(rewrite_error(
      DocxRewriteErrorCode::RewriteLimitExceeded,
      format!(
        "Rewritten DOCX archives must not exceed {DOCX_ARCHIVE_MAX_BYTES} bytes"
      ),
    ));
  }
  Ok(DocxRewriteResult {
    document: rewritten_document,
    rewritten_block_count: rewrites.len(),
    applied_replacement_count,
  })
}

#[cfg(test)]
mod extraction_kernel_parity {
  use std::fmt::Write as _;

  use super::{
    DOCX_MAX_INLINE_CONTEXT_SCAN_OPS, DOCX_MAX_TEXT_BLOCKS,
    DOCX_MAX_TEXT_SEGMENTS, DOCX_MAX_XML_EVENTS, DocxError, DocxErrorCode,
    DocxPart, DocxPartType, DocxScanBudget, extract_part, extract_part_dom,
    kernel_error,
  };

  const WORD_TRANSITIONAL: &str =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const WORD_STRICT: &str = "http://purl.oclc.org/ooxml/wordprocessingml/main";
  const REL_TRANSITIONAL: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const REL_STRICT: &str =
    "http://purl.oclc.org/ooxml/officeDocument/relationships";
  const MC_TRANSITIONAL: &str =
    "http://schemas.openxmlformats.org/markup-compatibility/2006";
  const MC_STRICT: &str =
    "http://purl.oclc.org/ooxml/markup-compatibility/main";

  fn part() -> DocxPart {
    DocxPart {
      part_type: DocxPartType::MainDocument,
      path: "word/document.xml".to_owned(),
    }
  }

  fn oracle(
    bytes: &[u8],
  ) -> Result<(Vec<super::DocxTextBlock>, super::DocxCoverage, usize), DocxError>
  {
    let mut segments = 0;
    let mut context_scan_ops = 0;
    let (blocks, coverage) =
      extract_part_dom(&part(), bytes, &mut segments, &mut context_scan_ops)?;
    Ok((blocks, coverage, segments))
  }

  fn kernel(
    bytes: &[u8],
  ) -> Result<(Vec<super::DocxTextBlock>, super::DocxCoverage, usize), DocxError>
  {
    let mut budget = DocxScanBudget::default();
    let (blocks, coverage) = extract_part(&part(), bytes, &mut budget)?;
    Ok((blocks, coverage, budget.segments))
  }

  fn assert_parity(name: &str, xml: &str) -> Result<(), DocxError> {
    assert_eq!(kernel(xml.as_bytes())?, oracle(xml.as_bytes())?, "{name}");
    Ok(())
  }

  fn assert_error_code_parity(
    name: &str,
    bytes: &[u8],
  ) -> Result<(), DocxError> {
    let kernel_error = kernel(bytes).err().ok_or_else(|| {
      super::error(
        DocxErrorCode::InvalidPackage,
        format!("kernel accepted invalid parity fixture: {name}"),
      )
    })?;
    let oracle_error = oracle(bytes).err().ok_or_else(|| {
      super::error(
        DocxErrorCode::InvalidPackage,
        format!("oracle accepted invalid parity fixture: {name}"),
      )
    })?;
    assert_eq!(kernel_error.code(), oracle_error.code(), "{name}");
    Ok(())
  }

  #[test]
  fn streaming_kernel_matches_the_dom_oracle_corpus() -> Result<(), DocxError> {
    let corpus = [
      (
        "transitional entities, UTF-16 offsets, contexts, and controls",
        format!(
          "<d:document xmlns:d=\"{WORD_TRANSITIONAL}\" xmlns:rel=\"{REL_TRANSITIONAL}\"><d:body><d:p><d:pPr><d:tabs><d:tab d:val=\"left\"/></d:tabs></d:pPr><d:t>invalid direct text</d:t><d:r><d:t>😀 &amp;amp; &lt; &#x41;</d:t></d:r><d:hyperlink rel:id=\"r1\" d:anchor=\"target\"><d:r><d:t> link</d:t></d:r></d:hyperlink><d:del><d:r><d:delText> deleted</d:delText></d:r></d:del><d:ins><d:r><d:t> inserted</d:t></d:r></d:ins><d:moveFrom><d:r><d:t> from</d:t></d:r></d:moveFrom><d:moveTo><d:r><d:t> to</d:t></d:r></d:moveTo><d:r><d:tab/><d:br/><d:cr/></d:r></d:p></d:body></d:document>"
        ),
      ),
      (
        "Strict namespaces and relationship attributes",
        format!(
          "<s:document xmlns:s=\"{WORD_STRICT}\" xmlns:r=\"{REL_STRICT}\"><s:body><s:p><s:hyperlink r:id=\"strict-link\" s:anchor=\"bookmark\"><s:r><s:t>Strict</s:t></s:r></s:hyperlink></s:p></s:body></s:document>"
        ),
      ),
      (
        "prefix rebinding cannot spoof WordprocessingML",
        format!(
          "<x:document xmlns:x=\"{WORD_TRANSITIONAL}\"><x:body><x:p><x:r><x:t>before</x:t></x:r></x:p><scope xmlns:x=\"urn:not-wordprocessing\"><x:p><x:r><x:t>hidden</x:t></x:r></x:p></scope><x:p><x:r><x:t>after</x:t></x:r></x:p></x:body></x:document>"
        ),
      ),
      (
        "table and text-box locations",
        format!(
          "<w:document xmlns:w=\"{WORD_TRANSITIONAL}\"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p></w:body></w:document>"
        ),
      ),
      (
        "Transitional markup-compatibility coverage",
        format!(
          "<w:document xmlns:w=\"{WORD_TRANSITIONAL}\" xmlns:mc=\"{MC_TRANSITIONAL}\" xmlns:x=\"urn:unsupported\"><w:body><w:p><w:r><w:t>Visible</w:t></w:r></w:p><mc:AlternateContent><mc:Choice Requires=\"x\"><w:p><w:r><w:sym/><w:instrText> suppressed instruction </w:instrText><w:t>unsupported choice</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent><w:sym/><w:instrText> REF target </w:instrText><w:fldSimple/></w:body></w:document>"
        ),
      ),
      (
        "Strict markup-compatibility coverage",
        format!(
          "<w:document xmlns:w=\"{WORD_STRICT}\" xmlns:mc=\"{MC_STRICT}\"><w:body><mc:AlternateContent><mc:Choice Requires=\"w\"><w:p><w:r><w:t>choice</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:body></w:document>"
        ),
      ),
    ];
    for (name, xml) in corpus {
      assert_parity(name, &xml)?;
    }
    Ok(())
  }

  #[test]
  fn generated_prefixes_and_run_splits_match_the_dom_oracle()
  -> Result<(), DocxError> {
    for namespace in [WORD_TRANSITIONAL, WORD_STRICT] {
      for prefix in ["w", "doc", "x14", "legal"] {
        for fragments in [
          ["Alice", " ", "😀"],
          ["&amp;", "&#x3C;", "tail"],
          ["", "middle", ""],
        ] {
          let mut runs = String::new();
          for fragment in fragments {
            write!(
              &mut runs,
              "<{prefix}:r><{prefix}:t>{fragment}</{prefix}:t></{prefix}:r>"
            )
            .map_err(|_| {
              super::error(
                DocxErrorCode::InvalidXml,
                "failed to build generated DOCX fixture",
              )
            })?;
          }
          let xml = format!(
            "<{prefix}:document xmlns:{prefix}=\"{namespace}\"><{prefix}:body><{prefix}:p>{runs}</{prefix}:p></{prefix}:body></{prefix}:document>"
          );
          assert_parity("generated prefix and run split", &xml)?;
        }
      }
    }
    Ok(())
  }

  #[test]
  fn malformed_and_bounded_inputs_preserve_error_codes() -> Result<(), DocxError>
  {
    let malformed =
      format!("<w:document xmlns:w=\"{WORD_TRANSITIONAL}\"><w:body><w:p>");
    assert_error_code_parity("malformed XML", malformed.as_bytes())?;
    assert_error_code_parity("unsupported encoding", &[0xff])?;

    let document_type = format!(
      "<!DOCTYPE document><w:document xmlns:w=\"{WORD_TRANSITIONAL}\"><w:body/></w:document>"
    );
    assert_error_code_parity(
      "document type declaration",
      document_type.as_bytes(),
    )?;

    let text_outside_paragraph = format!(
      "<w:document xmlns:w=\"{WORD_TRANSITIONAL}\"><w:body><w:r><w:t>outside</w:t></w:r></w:body></w:document>"
    );
    assert_error_code_parity(
      "text outside paragraph",
      text_outside_paragraph.as_bytes(),
    )?;

    let mut too_many_blocks =
      format!("<w:document xmlns:w=\"{WORD_TRANSITIONAL}\"><w:body>");
    for _ in 0..=DOCX_MAX_TEXT_BLOCKS {
      too_many_blocks.push_str("<w:p/>");
    }
    too_many_blocks.push_str("</w:body></w:document>");
    assert_error_code_parity("block limit", too_many_blocks.as_bytes())?;
    Ok(())
  }

  #[test]
  fn every_kernel_error_has_a_stable_public_mapping() {
    let cases = [
      (
        stella_docx_kernel::ScanError::InvalidXml,
        DocxErrorCode::InvalidXml,
        "DOCX part is not valid XML: word/document.xml",
      ),
      (
        stella_docx_kernel::ScanError::TextOutsideParagraph,
        DocxErrorCode::InvalidPackage,
        "DOCX text is outside a paragraph",
      ),
      (
        stella_docx_kernel::ScanError::DocumentTypeDeclaration,
        DocxErrorCode::InvalidPackage,
        "DOCX XML must not contain a document type declaration",
      ),
      (
        stella_docx_kernel::ScanError::TooDeep,
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX XML must not exceed 256 nested elements",
      ),
      (
        stella_docx_kernel::ScanError::TooManyBlocks,
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX archives must not contain more than 100000 text blocks",
      ),
      (
        stella_docx_kernel::ScanError::TooManySegments,
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX archives must not contain more than 1000000 text segments",
      ),
      (
        stella_docx_kernel::ScanError::TooManyEvents,
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX archives must not require more than 10000000 XML events",
      ),
      (
        stella_docx_kernel::ScanError::TooManyInlineContextCopies,
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX archives must not require more than 20000000 aggregate inline-context scan operations",
      ),
      (
        stella_docx_kernel::ScanError::TextLengthOverflow,
        DocxErrorCode::UncompressedLimitExceeded,
        "DOCX text length overflowed",
      ),
      (
        stella_docx_kernel::ScanError::UnsupportedEncoding,
        DocxErrorCode::InvalidXml,
        "DOCX XML part is not valid UTF-8: word/document.xml",
      ),
    ];
    for (source, expected_code, expected_message) in cases {
      let mapped = kernel_error(source, "word/document.xml");
      assert_eq!(mapped.code(), expected_code);
      assert_eq!(mapped.to_string(), expected_message);
    }
  }

  fn projection_work(xml: &str) -> Result<DocxScanBudget, DocxError> {
    let mut budget = DocxScanBudget::default();
    extract_part(&part(), xml.as_bytes(), &mut budget)?;
    Ok(budget)
  }

  fn sibling_run_fixture(run_count: usize) -> String {
    let mut runs = String::new();
    for _ in 0..run_count {
      runs.push_str("<w:r><w:t>x</w:t></w:r>");
    }
    format!(
      "<w:document xmlns:w=\"{WORD_TRANSITIONAL}\"><w:body><w:p>{runs}</w:p></w:body></w:document>"
    )
  }

  fn sibling_paragraph_fixture(paragraph_count: usize) -> String {
    let mut paragraphs = String::new();
    for _ in 0..paragraph_count {
      paragraphs.push_str("<w:p><w:r><w:t>x</w:t></w:r></w:p>");
    }
    format!(
      "<w:document xmlns:w=\"{WORD_TRANSITIONAL}\"><w:body>{paragraphs}</w:body></w:document>"
    )
  }

  fn sibling_revision_fixture(segment_count: usize) -> String {
    let mut runs = String::new();
    for _ in 0..segment_count {
      runs.push_str("<w:ins><w:r><w:t>x</w:t></w:r></w:ins>");
    }
    format!(
      "<w:document xmlns:w=\"{WORD_TRANSITIONAL}\"><w:body><w:p>{runs}</w:p></w:body></w:document>"
    )
  }

  fn assert_second_part_exhausts_budget(
    mut budget: DocxScanBudget,
    xml: &str,
    expected_message: &str,
  ) -> Result<(), DocxError> {
    extract_part(&part(), xml.as_bytes(), &mut budget)?;
    let committed = budget;
    let rejected = extract_part(&part(), xml.as_bytes(), &mut budget);
    let actual = rejected
      .as_ref()
      .err()
      .map(|rejected| (rejected.code(), rejected.to_string()));
    assert_eq!(
      actual,
      Some((
        DocxErrorCode::UncompressedLimitExceeded,
        expected_message.to_owned(),
      )),
    );
    assert_eq!(budget, committed, "failed scans must not consume budget");
    Ok(())
  }

  #[test]
  fn aggregate_scan_budgets_are_carried_across_parts() -> Result<(), DocxError>
  {
    let plain = sibling_run_fixture(1);
    let plain_work = projection_work(&plain)?;
    assert_second_part_exhausts_budget(
      DocxScanBudget {
        blocks: DOCX_MAX_TEXT_BLOCKS - plain_work.blocks,
        ..DocxScanBudget::default()
      },
      &plain,
      "DOCX archives must not contain more than 100000 text blocks",
    )?;
    assert_second_part_exhausts_budget(
      DocxScanBudget {
        segments: DOCX_MAX_TEXT_SEGMENTS - plain_work.segments,
        ..DocxScanBudget::default()
      },
      &plain,
      "DOCX archives must not contain more than 1000000 text segments",
    )?;
    assert_second_part_exhausts_budget(
      DocxScanBudget {
        events: DOCX_MAX_XML_EVENTS - plain_work.events,
        ..DocxScanBudget::default()
      },
      &plain,
      "DOCX archives must not require more than 10000000 XML events",
    )?;

    let revision = sibling_revision_fixture(1);
    let revision_work = projection_work(&revision)?;
    assert!(revision_work.inline_context_copies > 0);
    assert_second_part_exhausts_budget(
      DocxScanBudget {
        inline_context_copies: DOCX_MAX_INLINE_CONTEXT_SCAN_OPS
          - revision_work.inline_context_copies,
        ..DocxScanBudget::default()
      },
      &revision,
      "DOCX archives must not require more than 20000000 aggregate inline-context scan operations",
    )?;
    Ok(())
  }

  #[test]
  fn projection_work_is_additive_across_independent_growth_axes()
  -> Result<(), DocxError> {
    let empty_segments = projection_work(&sibling_run_fixture(0))?;
    let small_segments = projection_work(&sibling_run_fixture(512))?;
    let large_segments = projection_work(&sibling_run_fixture(1_024))?;
    assert_eq!(small_segments.blocks, 1);
    assert_eq!(small_segments.segments, 512);
    assert_eq!(large_segments.blocks, 1);
    assert_eq!(large_segments.segments, 1_024);
    assert_eq!(
      large_segments.events - empty_segments.events,
      2 * (small_segments.events - empty_segments.events),
    );

    let empty_blocks = projection_work(&sibling_paragraph_fixture(0))?;
    let small_blocks = projection_work(&sibling_paragraph_fixture(256))?;
    let large_blocks = projection_work(&sibling_paragraph_fixture(512))?;
    assert_eq!(small_blocks.blocks, 256);
    assert_eq!(small_blocks.segments, 256);
    assert_eq!(large_blocks.blocks, 512);
    assert_eq!(large_blocks.segments, 512);
    assert_eq!(
      large_blocks.events - empty_blocks.events,
      2 * (small_blocks.events - empty_blocks.events),
    );

    let small_contexts = projection_work(&sibling_revision_fixture(256))?;
    let large_contexts = projection_work(&sibling_revision_fixture(512))?;
    assert_eq!(small_contexts.inline_context_copies, 256);
    assert_eq!(large_contexts.inline_context_copies, 512);
    Ok(())
  }
}
