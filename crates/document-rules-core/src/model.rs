use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use thiserror::Error;

pub(crate) const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_BLOCKS: usize = 100_000;
const MAX_BLOCK_BYTES: usize = 0x0100_0000;
const MAX_DOCUMENT_BYTES: usize = 0x0400_0000;
const MAX_METADATA_ENTRIES: usize = 128;
const MAX_METADATA_KEY_BYTES: usize = 128;
const MAX_METADATA_VALUE_BYTES: usize = 0x0001_0000;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum Error {
  #[error(
    "block id must be non-blank and at most {MAX_IDENTIFIER_BYTES} bytes"
  )]
  InvalidBlockId,
  #[error("document contains duplicate block id '{block_id}'")]
  DuplicateBlockId { block_id: BlockId },
  #[error("document contains too many blocks: {count}")]
  TooManyBlocks { count: usize },
  #[error("block '{block_id}' exceeds the maximum text size")]
  BlockTooLarge { block_id: BlockId },
  #[error("document exceeds the maximum text size")]
  DocumentTooLarge,
  #[error("block '{block_id}' does not exist")]
  UnknownBlock { block_id: BlockId },
  #[error("block '{block_id}' already exists")]
  ExistingBlock { block_id: BlockId },
  #[error("text span {start}..{end} is invalid")]
  InvalidTextSpan { start: u32, end: u32 },
  #[error("finding span for block '{block_id}' exceeds its text")]
  FindingSpanOutOfBounds { block_id: BlockId },
  #[error("rule id must be non-blank and at most {MAX_IDENTIFIER_BYTES} bytes")]
  InvalidRuleId,
  #[error(
    "finding kind must be non-blank and at most {MAX_IDENTIFIER_BYTES} bytes"
  )]
  InvalidFindingKind,
  #[error(
    "metadata key must be non-blank and at most {MAX_METADATA_KEY_BYTES} bytes"
  )]
  InvalidMetadataKey,
  #[error("metadata value exceeds the maximum size")]
  MetadataValueTooLarge,
  #[error("metadata contains too many entries: {count}")]
  TooManyMetadataEntries { count: usize },
  #[error("neighborhood radius must be between 1 and {max}")]
  InvalidNeighborhoodRadius { max: u8 },
  #[error("rule id '{rule_id}' is registered more than once")]
  DuplicateRuleId { rule_id: String },
  #[error("rule '{rule_id}' failed: {reason}")]
  RuleExecution { rule_id: String, reason: String },
  #[error(
    "expected revision {expected}, but the document is at revision {actual}"
  )]
  StaleRevision {
    expected: Revision,
    actual: Revision,
  },
  #[error("document revision is exhausted")]
  RevisionExhausted,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct BlockId(Arc<str>);

impl BlockId {
  pub fn new(value: impl Into<Arc<str>>) -> Result<Self> {
    let value = value.into();
    if value.trim().is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
      return Err(Error::InvalidBlockId);
    }
    Ok(Self(value))
  }

  #[must_use]
  pub fn as_str(&self) -> &str {
    &self.0
  }
}

impl std::fmt::Display for BlockId {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    formatter.write_str(self.as_str())
  }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct MetadataKey(Arc<str>);

impl MetadataKey {
  pub fn new(value: impl Into<Arc<str>>) -> Result<Self> {
    let value = value.into();
    if value.trim().is_empty() || value.len() > MAX_METADATA_KEY_BYTES {
      return Err(Error::InvalidMetadataKey);
    }
    Ok(Self(value))
  }

  #[must_use]
  pub fn as_str(&self) -> &str {
    &self.0
  }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct MetadataValue(Arc<str>);

impl MetadataValue {
  pub fn new(value: impl Into<Arc<str>>) -> Result<Self> {
    let value = value.into();
    if value.len() > MAX_METADATA_VALUE_BYTES {
      return Err(Error::MetadataValueTooLarge);
    }
    Ok(Self(value))
  }

  #[must_use]
  pub fn as_str(&self) -> &str {
    &self.0
  }
}

#[derive(Clone, Debug, Default, Eq, Hash, PartialEq)]
pub struct Metadata(Arc<BTreeMap<MetadataKey, MetadataValue>>);

impl Metadata {
  pub fn new(
    entries: impl IntoIterator<Item = (MetadataKey, MetadataValue)>,
  ) -> Result<Self> {
    let entries = entries.into_iter().collect::<BTreeMap<_, _>>();
    if entries.len() > MAX_METADATA_ENTRIES {
      return Err(Error::TooManyMetadataEntries {
        count: entries.len(),
      });
    }
    Ok(Self(Arc::new(entries)))
  }

  #[must_use]
  pub fn get(&self, key: &MetadataKey) -> Option<&MetadataValue> {
    self.0.get(key)
  }

  #[must_use]
  pub fn iter(
    &self,
  ) -> impl ExactSizeIterator<Item = (&MetadataKey, &MetadataValue)> {
    self.0.iter()
  }

  #[must_use]
  pub fn is_empty(&self) -> bool {
    self.0.is_empty()
  }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TextSpan {
  start: u32,
  end: u32,
}

impl TextSpan {
  pub const fn new(start: u32, end: u32) -> Result<Self> {
    if start > end {
      return Err(Error::InvalidTextSpan { start, end });
    }
    Ok(Self { start, end })
  }

  #[must_use]
  pub const fn start(self) -> u32 {
    self.start
  }

  #[must_use]
  pub const fn end(self) -> u32 {
    self.end
  }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct BlockSpan {
  block_id: BlockId,
  span: TextSpan,
}

impl BlockSpan {
  #[must_use]
  pub const fn new(block_id: BlockId, span: TextSpan) -> Self {
    Self { block_id, span }
  }

  #[must_use]
  pub const fn block_id(&self) -> &BlockId {
    &self.block_id
  }

  #[must_use]
  pub const fn span(&self) -> TextSpan {
    self.span
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentBlock {
  id: BlockId,
  text: Arc<str>,
  metadata: Metadata,
}

impl DocumentBlock {
  pub fn new(id: BlockId, text: impl Into<Arc<str>>) -> Result<Self> {
    Self::with_metadata(id, text, Metadata::default())
  }

  pub fn with_metadata(
    id: BlockId,
    text: impl Into<Arc<str>>,
    metadata: Metadata,
  ) -> Result<Self> {
    let text = text.into();
    if text.len() > MAX_BLOCK_BYTES || u32::try_from(text.len()).is_err() {
      return Err(Error::BlockTooLarge { block_id: id });
    }
    Ok(Self { id, text, metadata })
  }

  #[must_use]
  pub const fn id(&self) -> &BlockId {
    &self.id
  }

  #[must_use]
  pub fn text(&self) -> &str {
    &self.text
  }

  #[must_use]
  pub const fn metadata(&self) -> &Metadata {
    &self.metadata
  }

  pub(crate) fn text_arc(&self) -> Arc<str> {
    Arc::clone(&self.text)
  }

  #[cfg(feature = "incremental")]
  fn replace_text(&mut self, text: Arc<str>) {
    self.text = text;
  }

  #[cfg(feature = "incremental")]
  fn replace_metadata(&mut self, metadata: Metadata) {
    self.metadata = metadata;
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Document {
  blocks: Vec<DocumentBlock>,
  metadata: Metadata,
}

impl Document {
  pub fn new(blocks: Vec<DocumentBlock>) -> Result<Self> {
    Self::with_metadata(blocks, Metadata::default())
  }

  pub fn with_metadata(
    blocks: Vec<DocumentBlock>,
    metadata: Metadata,
  ) -> Result<Self> {
    validate_blocks(&blocks)?;
    Ok(Self { blocks, metadata })
  }

  #[must_use]
  pub fn blocks(&self) -> &[DocumentBlock] {
    &self.blocks
  }

  #[must_use]
  pub const fn metadata(&self) -> &Metadata {
    &self.metadata
  }

  #[cfg(feature = "incremental")]
  pub(crate) fn text_bytes(&self) -> usize {
    self.blocks.iter().map(|block| block.text.len()).sum()
  }

  #[cfg(feature = "incremental")]
  pub(crate) fn prepare_non_structural_patch(
    &self,
    changes: &[DocumentChange],
    current_text_bytes: usize,
    position_of: &dyn Fn(&BlockId) -> Option<usize>,
  ) -> Result<Option<NonStructuralDocumentPatch>> {
    if changes.iter().any(DocumentChange::changes_structure) {
      return Ok(None);
    }

    let mut pending = Vec::<PendingBlockMutation>::new();
    let mut document_metadata = None;
    for (sequence, change) in changes.iter().enumerate() {
      match change {
        DocumentChange::ReplaceText { block_id, text } => {
          let Some(position) = position_of(block_id) else {
            return Err(Error::UnknownBlock {
              block_id: block_id.clone(),
            });
          };
          pending.push(PendingBlockMutation::new(
            block_id.clone(),
            position,
            sequence,
            PendingBlockValue::Text(Arc::clone(text)),
          ));
        }
        DocumentChange::ReplaceBlockMetadata { block_id, metadata } => {
          let Some(position) = position_of(block_id) else {
            return Err(Error::UnknownBlock {
              block_id: block_id.clone(),
            });
          };
          pending.push(PendingBlockMutation::new(
            block_id.clone(),
            position,
            sequence,
            PendingBlockValue::Metadata(metadata.clone()),
          ));
        }
        DocumentChange::ReplaceDocumentMetadata { metadata } => {
          document_metadata = Some(metadata.clone());
        }
        DocumentChange::InsertAfter { .. } | DocumentChange::Remove { .. } => {
          return Ok(None);
        }
      }
    }

    let pending_updates = fold_pending_mutations(pending);

    let mut text_bytes = current_text_bytes;
    let mut block_updates = Vec::with_capacity(pending_updates.len());
    for pending_update in pending_updates {
      let position = pending_update.position;
      let Some(block) = self
        .blocks
        .get(position)
        .filter(|block| block.id() == &pending_update.block_id)
      else {
        return Err(Error::UnknownBlock {
          block_id: pending_update.block_id,
        });
      };
      let text = pending_update
        .text
        .filter(|text| text.as_ref() != block.text());
      if let Some(text) = &text {
        validate_block_text(block.id(), text)?;
        text_bytes = text_bytes
          .checked_sub(block.text().len())
          .and_then(|bytes| bytes.checked_add(text.len()))
          .ok_or(Error::DocumentTooLarge)?;
      }
      let metadata = pending_update
        .metadata
        .filter(|metadata| metadata != block.metadata());
      if text.is_some() || metadata.is_some() {
        block_updates.push(NonStructuralBlockUpdate {
          block_id: block.id().clone(),
          position,
          text,
          metadata,
        });
      }
    }
    if text_bytes > MAX_DOCUMENT_BYTES {
      return Err(Error::DocumentTooLarge);
    }
    let document_metadata =
      document_metadata.filter(|metadata| metadata != &self.metadata);
    Ok(Some(NonStructuralDocumentPatch {
      block_updates,
      document_metadata,
      text_bytes,
    }))
  }

  #[cfg(feature = "incremental")]
  pub(crate) fn apply_non_structural_patch(
    &mut self,
    patch: &NonStructuralDocumentPatch,
  ) -> Result<()> {
    for update in &patch.block_updates {
      let Some(_block) = self
        .blocks
        .get(update.position)
        .filter(|block| block.id() == &update.block_id)
      else {
        return Err(Error::UnknownBlock {
          block_id: update.block_id.clone(),
        });
      };
    }
    for update in &patch.block_updates {
      let Some(block) = self.blocks.get_mut(update.position) else {
        return Err(Error::UnknownBlock {
          block_id: update.block_id.clone(),
        });
      };
      if let Some(text) = &update.text {
        block.replace_text(Arc::clone(text));
      }
      if let Some(metadata) = &update.metadata {
        block.replace_metadata(metadata.clone());
      }
    }
    if let Some(metadata) = &patch.document_metadata {
      self.metadata = metadata.clone();
    }
    Ok(())
  }

  #[cfg(feature = "incremental")]
  pub(crate) fn apply_changes(
    &self,
    changes: &[DocumentChange],
  ) -> Result<Self> {
    let mut blocks = self.blocks.clone();
    let mut metadata = self.metadata.clone();
    for change in changes {
      match change {
        DocumentChange::ReplaceText { block_id, text } => {
          let Some(block) =
            blocks.iter_mut().find(|block| block.id == *block_id)
          else {
            return Err(Error::UnknownBlock {
              block_id: block_id.clone(),
            });
          };
          block.replace_text(Arc::clone(text));
        }
        DocumentChange::InsertAfter { after, block } => {
          if blocks.iter().any(|candidate| candidate.id == block.id) {
            return Err(Error::ExistingBlock {
              block_id: block.id.clone(),
            });
          }
          let insert_at = match after {
            Some(after) => {
              let Some(position) =
                blocks.iter().position(|candidate| candidate.id == *after)
              else {
                return Err(Error::UnknownBlock {
                  block_id: after.clone(),
                });
              };
              position.saturating_add(1)
            }
            None => 0,
          };
          blocks.insert(insert_at, block.clone());
        }
        DocumentChange::Remove { block_id } => {
          let Some(position) = blocks
            .iter()
            .position(|candidate| candidate.id == *block_id)
          else {
            return Err(Error::UnknownBlock {
              block_id: block_id.clone(),
            });
          };
          blocks.remove(position);
        }
        DocumentChange::ReplaceBlockMetadata {
          block_id,
          metadata: next,
        } => {
          let Some(block) =
            blocks.iter_mut().find(|block| block.id == *block_id)
          else {
            return Err(Error::UnknownBlock {
              block_id: block_id.clone(),
            });
          };
          block.replace_metadata(next.clone());
        }
        DocumentChange::ReplaceDocumentMetadata { metadata: next } => {
          metadata = next.clone();
        }
      }
    }
    Self::with_metadata(blocks, metadata)
  }
}

fn validate_blocks(blocks: &[DocumentBlock]) -> Result<()> {
  if blocks.len() > MAX_BLOCKS {
    return Err(Error::TooManyBlocks {
      count: blocks.len(),
    });
  }
  let mut ids = BTreeSet::new();
  let mut total_bytes = 0_usize;
  for block in blocks {
    if !ids.insert(block.id.clone()) {
      return Err(Error::DuplicateBlockId {
        block_id: block.id.clone(),
      });
    }
    validate_block_text(&block.id, &block.text)?;
    total_bytes = total_bytes
      .checked_add(block.text.len())
      .ok_or(Error::DocumentTooLarge)?;
    if total_bytes > MAX_DOCUMENT_BYTES {
      return Err(Error::DocumentTooLarge);
    }
  }
  Ok(())
}

fn validate_block_text(block_id: &BlockId, text: &str) -> Result<()> {
  if text.len() > MAX_BLOCK_BYTES || u32::try_from(text.len()).is_err() {
    return Err(Error::BlockTooLarge {
      block_id: block_id.clone(),
    });
  }
  Ok(())
}

#[cfg(feature = "incremental")]
struct PendingBlockUpdate {
  block_id: BlockId,
  position: usize,
  text: Option<Arc<str>>,
  metadata: Option<Metadata>,
}

#[cfg(feature = "incremental")]
impl PendingBlockUpdate {
  const fn new(block_id: BlockId, position: usize) -> Self {
    Self {
      block_id,
      position,
      text: None,
      metadata: None,
    }
  }

  fn replace(&mut self, value: PendingBlockValue) {
    match value {
      PendingBlockValue::Text(text) => self.text = Some(text),
      PendingBlockValue::Metadata(metadata) => {
        self.metadata = Some(metadata);
      }
    }
  }
}

#[cfg(feature = "incremental")]
enum PendingBlockValue {
  Text(Arc<str>),
  Metadata(Metadata),
}

#[cfg(feature = "incremental")]
struct PendingBlockMutation {
  block_id: BlockId,
  position: usize,
  sequence: usize,
  value: PendingBlockValue,
}

#[cfg(feature = "incremental")]
impl PendingBlockMutation {
  const fn new(
    block_id: BlockId,
    position: usize,
    sequence: usize,
    value: PendingBlockValue,
  ) -> Self {
    Self {
      block_id,
      position,
      sequence,
      value,
    }
  }
}

#[cfg(feature = "incremental")]
fn fold_pending_mutations(
  mut pending: Vec<PendingBlockMutation>,
) -> Vec<PendingBlockUpdate> {
  pending
    .sort_unstable_by_key(|mutation| (mutation.position, mutation.sequence));
  let mut updates = Vec::<PendingBlockUpdate>::new();
  for mutation in pending {
    if let Some(update) = updates.last_mut().filter(|update| {
      update.position == mutation.position
        && update.block_id == mutation.block_id
    }) {
      update.replace(mutation.value);
    } else {
      let mut update =
        PendingBlockUpdate::new(mutation.block_id, mutation.position);
      update.replace(mutation.value);
      updates.push(update);
    }
  }
  updates
}

#[cfg(feature = "incremental")]
pub(crate) struct NonStructuralDocumentPatch {
  block_updates: Vec<NonStructuralBlockUpdate>,
  document_metadata: Option<Metadata>,
  text_bytes: usize,
}

#[cfg(feature = "incremental")]
impl NonStructuralDocumentPatch {
  pub(crate) fn block_updates(&self) -> &[NonStructuralBlockUpdate] {
    &self.block_updates
  }

  pub(crate) const fn document_metadata(&self) -> Option<&Metadata> {
    self.document_metadata.as_ref()
  }

  pub(crate) const fn is_empty(&self) -> bool {
    self.block_updates.is_empty() && self.document_metadata.is_none()
  }

  pub(crate) const fn text_bytes(&self) -> usize {
    self.text_bytes
  }
}

#[cfg(feature = "incremental")]
pub(crate) struct NonStructuralBlockUpdate {
  block_id: BlockId,
  position: usize,
  text: Option<Arc<str>>,
  metadata: Option<Metadata>,
}

#[cfg(feature = "incremental")]
impl NonStructuralBlockUpdate {
  pub(crate) const fn block_id(&self) -> &BlockId {
    &self.block_id
  }

  pub(crate) const fn position(&self) -> usize {
    self.position
  }

  pub(crate) const fn text(&self) -> Option<&Arc<str>> {
    self.text.as_ref()
  }

  pub(crate) const fn metadata(&self) -> Option<&Metadata> {
    self.metadata.as_ref()
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DocumentChange {
  ReplaceText {
    block_id: BlockId,
    text: Arc<str>,
  },
  InsertAfter {
    after: Option<BlockId>,
    block: DocumentBlock,
  },
  Remove {
    block_id: BlockId,
  },
  ReplaceBlockMetadata {
    block_id: BlockId,
    metadata: Metadata,
  },
  ReplaceDocumentMetadata {
    metadata: Metadata,
  },
}

impl DocumentChange {
  #[cfg(feature = "incremental")]
  const fn changes_structure(&self) -> bool {
    matches!(self, Self::InsertAfter { .. } | Self::Remove { .. })
  }

  #[must_use]
  pub fn replace_text(block_id: BlockId, text: impl Into<Arc<str>>) -> Self {
    Self::ReplaceText {
      block_id,
      text: text.into(),
    }
  }

  #[must_use]
  pub const fn insert_after(
    after: Option<BlockId>,
    block: DocumentBlock,
  ) -> Self {
    Self::InsertAfter { after, block }
  }

  #[must_use]
  pub const fn remove(block_id: BlockId) -> Self {
    Self::Remove { block_id }
  }

  #[must_use]
  pub const fn replace_block_metadata(
    block_id: BlockId,
    metadata: Metadata,
  ) -> Self {
    Self::ReplaceBlockMetadata { block_id, metadata }
  }

  #[must_use]
  pub const fn replace_document_metadata(metadata: Metadata) -> Self {
    Self::ReplaceDocumentMetadata { metadata }
  }
}

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct Revision(u64);

impl Revision {
  #[must_use]
  pub const fn initial() -> Self {
    Self(0)
  }

  #[must_use]
  pub const fn value(self) -> u64 {
    self.0
  }

  #[cfg(feature = "incremental")]
  pub(crate) fn next(self) -> Result<Self> {
    self
      .0
      .checked_add(1)
      .map(Self)
      .ok_or(Error::RevisionExhausted)
  }
}

impl std::fmt::Display for Revision {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    self.0.fmt(formatter)
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentPatch {
  expected_revision: Revision,
  changes: Vec<DocumentChange>,
}

impl DocumentPatch {
  #[must_use]
  pub const fn new(
    expected_revision: Revision,
    changes: Vec<DocumentChange>,
  ) -> Self {
    Self {
      expected_revision,
      changes,
    }
  }

  #[must_use]
  pub const fn expected_revision(&self) -> Revision {
    self.expected_revision
  }

  #[must_use]
  pub fn changes(&self) -> &[DocumentChange] {
    &self.changes
  }
}
