use std::collections::BTreeSet;
use std::sync::Arc;

use crate::engine::BlockAnalysis;
use crate::model::{
  BlockId, BlockSpan, Error, MAX_IDENTIFIER_BYTES, Metadata, Result,
};

const MAX_NEIGHBORHOOD_RADIUS: u8 = 16;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RuleId(Arc<str>);

impl RuleId {
  pub fn new(value: impl Into<Arc<str>>) -> Result<Self> {
    let value = value.into();
    if value.trim().is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
      return Err(Error::InvalidRuleId);
    }
    Ok(Self(value))
  }

  #[must_use]
  pub fn as_str(&self) -> &str {
    &self.0
  }
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct FindingKind(Arc<str>);

impl FindingKind {
  pub fn new(value: impl Into<Arc<str>>) -> Result<Self> {
    let value = value.into();
    if value.trim().is_empty() || value.len() > MAX_IDENTIFIER_BYTES {
      return Err(Error::InvalidFindingKind);
    }
    Ok(Self(value))
  }

  #[must_use]
  pub fn as_str(&self) -> &str {
    &self.0
  }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct NeighborhoodRadius(u8);

impl NeighborhoodRadius {
  pub const fn new(value: u8) -> Result<Self> {
    if value == 0 || value > MAX_NEIGHBORHOOD_RADIUS {
      return Err(Error::InvalidNeighborhoodRadius {
        max: MAX_NEIGHBORHOOD_RADIUS,
      });
    }
    Ok(Self(value))
  }

  #[must_use]
  pub const fn adjacent() -> Self {
    Self(1)
  }

  #[must_use]
  pub const fn get(self) -> u8 {
    self.0
  }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RuleScope {
  Block,
  Neighborhood(NeighborhoodRadius),
  DocumentFacts,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuleSpec {
  id: RuleId,
  scope: RuleScope,
}

impl RuleSpec {
  #[must_use]
  pub const fn new(id: RuleId, scope: RuleScope) -> Self {
    Self { id, scope }
  }

  #[must_use]
  pub const fn id(&self) -> &RuleId {
    &self.id
  }

  #[must_use]
  pub const fn scope(&self) -> RuleScope {
    self.scope
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Finding {
  rule_id: RuleId,
  kind: FindingKind,
  primary: BlockSpan,
  related: Vec<BlockSpan>,
  message: String,
  action: FindingAction,
}

impl Finding {
  #[must_use]
  pub const fn rule_id(&self) -> &RuleId {
    &self.rule_id
  }

  #[must_use]
  pub const fn kind(&self) -> &FindingKind {
    &self.kind
  }

  #[must_use]
  pub const fn primary(&self) -> &BlockSpan {
    &self.primary
  }

  #[must_use]
  pub fn related(&self) -> &[BlockSpan] {
    &self.related
  }

  #[must_use]
  pub fn message(&self) -> &str {
    &self.message
  }

  #[must_use]
  pub const fn action(&self) -> &FindingAction {
    &self.action
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FindingAction {
  Report,
  Replace { replacement: Arc<str> },
  Remove,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FindingDraft {
  kind: FindingKind,
  primary: BlockSpan,
  related: Vec<BlockSpan>,
  message: String,
  action: FindingAction,
}

impl FindingDraft {
  #[must_use]
  pub fn new(
    kind: FindingKind,
    primary: BlockSpan,
    message: impl Into<String>,
  ) -> Self {
    Self {
      kind,
      primary,
      related: Vec::new(),
      message: message.into(),
      action: FindingAction::Report,
    }
  }

  #[must_use]
  pub fn with_related(mut self, related: Vec<BlockSpan>) -> Self {
    self.related = related;
    self
  }

  #[must_use]
  pub fn with_action(mut self, action: FindingAction) -> Self {
    self.action = action;
    self
  }
}

pub struct FindingSink {
  rule_id: RuleId,
  findings: Vec<Finding>,
}

impl FindingSink {
  pub(crate) const fn new(rule_id: RuleId) -> Self {
    Self {
      rule_id,
      findings: Vec::new(),
    }
  }

  pub fn push(&mut self, draft: FindingDraft) {
    self.findings.push(Finding {
      rule_id: self.rule_id.clone(),
      kind: draft.kind,
      primary: draft.primary,
      related: draft.related,
      message: draft.message,
      action: draft.action,
    });
  }

  pub(crate) fn into_findings(self) -> Vec<Finding> {
    self.findings
  }
}

pub struct BlockRuleContext<'a> {
  block: &'a BlockAnalysis,
}

impl<'a> BlockRuleContext<'a> {
  pub(crate) const fn new(block: &'a BlockAnalysis) -> Self {
    Self { block }
  }

  #[must_use]
  pub const fn block(&self) -> &'a BlockAnalysis {
    self.block
  }
}

pub struct NeighborhoodRuleContext<'a> {
  before: &'a [Arc<BlockAnalysis>],
  block: &'a BlockAnalysis,
  after: &'a [Arc<BlockAnalysis>],
}

impl<'a> NeighborhoodRuleContext<'a> {
  pub(crate) const fn new(
    before: &'a [Arc<BlockAnalysis>],
    block: &'a BlockAnalysis,
    after: &'a [Arc<BlockAnalysis>],
  ) -> Self {
    Self {
      before,
      block,
      after,
    }
  }

  /// Blocks before the current block, in document order.
  #[must_use]
  pub const fn before(&self) -> AnalysisWindow<'a> {
    AnalysisWindow(self.before)
  }

  #[must_use]
  pub fn previous(&self) -> Option<&'a BlockAnalysis> {
    self.before.last().map(Arc::as_ref)
  }

  #[must_use]
  pub const fn block(&self) -> &'a BlockAnalysis {
    self.block
  }

  #[must_use]
  pub fn next(&self) -> Option<&'a BlockAnalysis> {
    self.after.first().map(Arc::as_ref)
  }

  /// Blocks after the current block, in document order.
  #[must_use]
  pub const fn after(&self) -> AnalysisWindow<'a> {
    AnalysisWindow(self.after)
  }
}

#[derive(Clone, Copy)]
pub struct AnalysisWindow<'a>(&'a [Arc<BlockAnalysis>]);

impl<'a> AnalysisWindow<'a> {
  #[must_use]
  pub const fn len(self) -> usize {
    self.0.len()
  }

  #[must_use]
  pub const fn is_empty(self) -> bool {
    self.0.is_empty()
  }

  #[must_use]
  pub fn first(self) -> Option<&'a BlockAnalysis> {
    self.0.first().map(Arc::as_ref)
  }

  #[must_use]
  pub fn last(self) -> Option<&'a BlockAnalysis> {
    self.0.last().map(Arc::as_ref)
  }

  pub fn iter(self) -> impl DoubleEndedIterator<Item = &'a BlockAnalysis> {
    self.0.iter().map(Arc::as_ref)
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockFact {
  block_id: BlockId,
  byte_len: u32,
  word_count: usize,
  finding_count: usize,
  metadata: Metadata,
}

impl BlockFact {
  pub(crate) fn new(block: &BlockAnalysis, finding_count: usize) -> Self {
    Self {
      block_id: block.id().clone(),
      byte_len: block.byte_len(),
      word_count: block.word_spans().len(),
      finding_count,
      metadata: block.metadata().clone(),
    }
  }

  #[must_use]
  pub const fn block_id(&self) -> &BlockId {
    &self.block_id
  }

  #[must_use]
  pub const fn byte_len(&self) -> u32 {
    self.byte_len
  }

  #[must_use]
  pub const fn word_count(&self) -> usize {
    self.word_count
  }

  #[must_use]
  pub const fn finding_count(&self) -> usize {
    self.finding_count
  }

  #[must_use]
  pub const fn metadata(&self) -> &Metadata {
    &self.metadata
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentFacts {
  blocks: Arc<[BlockFact]>,
  metadata: Metadata,
}

impl DocumentFacts {
  pub(crate) fn new(blocks: Vec<BlockFact>, metadata: Metadata) -> Self {
    Self {
      blocks: blocks.into(),
      metadata,
    }
  }

  #[must_use]
  pub fn blocks(&self) -> &[BlockFact] {
    &self.blocks
  }

  #[must_use]
  pub const fn metadata(&self) -> &Metadata {
    &self.metadata
  }
}

pub struct DocumentRuleContext<'a> {
  facts: &'a DocumentFacts,
}

impl<'a> DocumentRuleContext<'a> {
  pub(crate) const fn new(facts: &'a DocumentFacts) -> Self {
    Self { facts }
  }

  #[must_use]
  pub const fn facts(&self) -> &'a DocumentFacts {
    self.facts
  }
}

pub enum RuleContext<'a> {
  Block(BlockRuleContext<'a>),
  Neighborhood(NeighborhoodRuleContext<'a>),
  DocumentFacts(DocumentRuleContext<'a>),
}

pub trait DocumentRule: Send + Sync {
  fn spec(&self) -> &RuleSpec;
  fn evaluate(
    &self,
    context: RuleContext<'_>,
    findings: &mut FindingSink,
  ) -> std::result::Result<(), String>;
}

pub struct RuleSet {
  rules: Vec<Arc<dyn DocumentRule>>,
}

impl RuleSet {
  pub fn new(rules: Vec<Arc<dyn DocumentRule>>) -> Result<Self> {
    let mut ids = BTreeSet::new();
    for rule in &rules {
      if !ids.insert(rule.spec().id().clone()) {
        return Err(Error::DuplicateRuleId {
          rule_id: rule.spec().id().as_str().to_owned(),
        });
      }
    }
    Ok(Self { rules })
  }

  pub(crate) fn rules_for_scope(
    &self,
    scope: RuleScope,
  ) -> impl Iterator<Item = &Arc<dyn DocumentRule>> {
    self
      .rules
      .iter()
      .filter(move |rule| rule.spec().scope() == scope)
  }

  pub(crate) fn neighborhood_rules(
    &self,
  ) -> impl Iterator<Item = &Arc<dyn DocumentRule>> {
    self
      .rules
      .iter()
      .filter(|rule| matches!(rule.spec().scope(), RuleScope::Neighborhood(_)))
  }

  pub(crate) fn max_neighborhood_radius(&self) -> usize {
    self
      .neighborhood_rules()
      .filter_map(|rule| match rule.spec().scope() {
        RuleScope::Neighborhood(radius) => Some(usize::from(radius.get())),
        RuleScope::Block | RuleScope::DocumentFacts => None,
      })
      .max()
      .unwrap_or(0)
  }
}
