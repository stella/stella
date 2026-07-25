use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::model::{
  BlockSpan, Document, DocumentBlock, Error, Metadata, Result, Revision,
  TextSpan,
};
use crate::rule::{
  BlockFact, BlockRuleContext, DocumentFacts, DocumentRuleContext, Finding,
  FindingSink, NeighborhoodRuleContext, RuleContext, RuleScope, RuleSet,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockAnalysis {
  id: crate::model::BlockId,
  text: Arc<str>,
  word_spans: Arc<[TextSpan]>,
  byte_len: u32,
  metadata: Metadata,
}

impl BlockAnalysis {
  #[must_use]
  pub const fn id(&self) -> &crate::model::BlockId {
    &self.id
  }

  #[must_use]
  pub fn text(&self) -> &str {
    &self.text
  }

  #[must_use]
  pub fn word_spans(&self) -> &[TextSpan] {
    &self.word_spans
  }

  #[must_use]
  pub const fn byte_len(&self) -> u32 {
    self.byte_len
  }

  #[must_use]
  pub const fn metadata(&self) -> &Metadata {
    &self.metadata
  }

  pub fn text_for_span(&self, span: TextSpan) -> Result<&str> {
    let start = usize::try_from(span.start()).map_err(|_| {
      Error::FindingSpanOutOfBounds {
        block_id: self.id.clone(),
      }
    })?;
    let end = usize::try_from(span.end()).map_err(|_| {
      Error::FindingSpanOutOfBounds {
        block_id: self.id.clone(),
      }
    })?;
    self
      .text
      .get(start..end)
      .ok_or_else(|| Error::FindingSpanOutOfBounds {
        block_id: self.id.clone(),
      })
  }
}

#[derive(Default)]
pub struct ExecutionCounters {
  block_analysis: AtomicUsize,
  block_rules: AtomicUsize,
  neighborhood_rules: AtomicUsize,
  document_rules: AtomicUsize,
}

impl ExecutionCounters {
  #[must_use]
  pub fn snapshot(&self) -> ExecutionCounterSnapshot {
    ExecutionCounterSnapshot {
      block_analysis: self.block_analysis.load(Ordering::Relaxed),
      block_rules: self.block_rules.load(Ordering::Relaxed),
      neighborhood_rules: self.neighborhood_rules.load(Ordering::Relaxed),
      document_rules: self.document_rules.load(Ordering::Relaxed),
    }
  }

  pub fn reset(&self) {
    self.block_analysis.store(0, Ordering::Relaxed);
    self.block_rules.store(0, Ordering::Relaxed);
    self.neighborhood_rules.store(0, Ordering::Relaxed);
    self.document_rules.store(0, Ordering::Relaxed);
  }

  fn record_analysis(&self) {
    self.block_analysis.fetch_add(1, Ordering::Relaxed);
  }

  fn record_rule(&self, scope: RuleScope) {
    let counter = match scope {
      RuleScope::Block => &self.block_rules,
      RuleScope::Neighborhood(_) => &self.neighborhood_rules,
      RuleScope::DocumentFacts => &self.document_rules,
    };
    counter.fetch_add(1, Ordering::Relaxed);
  }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ExecutionCounterSnapshot {
  block_analysis: usize,
  block_rules: usize,
  neighborhood_rules: usize,
  document_rules: usize,
}

impl ExecutionCounterSnapshot {
  #[must_use]
  pub const fn block_analysis(self) -> usize {
    self.block_analysis
  }

  #[must_use]
  pub const fn block_rules(self) -> usize {
    self.block_rules
  }

  #[must_use]
  pub const fn neighborhood_rules(self) -> usize {
    self.neighborhood_rules
  }

  #[must_use]
  pub const fn document_rules(self) -> usize {
    self.document_rules
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnalysisSnapshot {
  revision: Revision,
  findings: Arc<[Finding]>,
}

impl AnalysisSnapshot {
  pub(crate) fn new(revision: Revision, findings: Vec<Finding>) -> Self {
    Self {
      revision,
      findings: findings.into(),
    }
  }

  #[must_use]
  pub const fn revision(&self) -> Revision {
    self.revision
  }

  #[must_use]
  pub fn findings(&self) -> &[Finding] {
    &self.findings
  }
}

#[derive(Clone)]
pub struct RuleEngine {
  pub(crate) rules: Arc<RuleSet>,
  pub(crate) counters: Arc<ExecutionCounters>,
}

impl RuleEngine {
  #[must_use]
  pub fn new(rules: RuleSet) -> Self {
    Self {
      rules: Arc::new(rules),
      counters: Arc::new(ExecutionCounters::default()),
    }
  }

  #[must_use]
  pub fn counters(&self) -> Arc<ExecutionCounters> {
    Arc::clone(&self.counters)
  }

  pub fn analyze(&self, document: &Document) -> Result<AnalysisSnapshot> {
    let analyses = document
      .blocks()
      .iter()
      .map(|block| analyze_block(block, &self.counters))
      .collect::<Result<Vec<_>>>()?;
    let findings = run_all_rules(
      &self.rules,
      &self.counters,
      &analyses,
      document.metadata(),
    )?;
    validate_findings(document, &findings)?;
    Ok(AnalysisSnapshot::new(Revision::initial(), findings))
  }
}

pub(crate) fn analyze_block(
  block: &DocumentBlock,
  counters: &ExecutionCounters,
) -> Result<Arc<BlockAnalysis>> {
  counters.record_analysis();
  let text = block.text();
  let mut word_spans = Vec::new();
  let mut word_start = None::<usize>;
  for (offset, character) in text.char_indices() {
    if character.is_alphanumeric() || character == '_' {
      if word_start.is_none() {
        word_start = Some(offset);
      }
      continue;
    }
    if let Some(start) = word_start.take() {
      word_spans.push(checked_span(start, offset)?);
    }
  }
  if let Some(start) = word_start {
    word_spans.push(checked_span(start, text.len())?);
  }
  let byte_len =
    u32::try_from(text.len()).map_err(|_| Error::BlockTooLarge {
      block_id: block.id().clone(),
    })?;
  Ok(Arc::new(BlockAnalysis {
    id: block.id().clone(),
    text: block.text_arc(),
    word_spans: word_spans.into(),
    byte_len,
    metadata: block.metadata().clone(),
  }))
}

fn checked_span(start: usize, end: usize) -> Result<TextSpan> {
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

pub(crate) fn run_block_rules(
  rules: &RuleSet,
  counters: &ExecutionCounters,
  analysis: &BlockAnalysis,
) -> Result<Vec<Finding>> {
  run_rules(rules, counters, RuleScope::Block, || {
    RuleContext::Block(BlockRuleContext::new(analysis))
  })
}

pub(crate) fn run_neighborhood_rules(
  rules: &RuleSet,
  counters: &ExecutionCounters,
  before: &[Arc<BlockAnalysis>],
  analysis: &BlockAnalysis,
  after: &[Arc<BlockAnalysis>],
) -> Result<Vec<Finding>> {
  let mut findings = Vec::new();
  for rule in rules.neighborhood_rules() {
    let RuleScope::Neighborhood(radius) = rule.spec().scope() else {
      continue;
    };
    counters.record_rule(rule.spec().scope());
    let radius = usize::from(radius.get());
    let visible_before = before
      .get(before.len().saturating_sub(radius)..)
      .unwrap_or(before);
    let visible_after = after.get(..after.len().min(radius)).unwrap_or(after);
    let mut sink = FindingSink::new(rule.spec().id().clone());
    rule
      .evaluate(
        RuleContext::Neighborhood(NeighborhoodRuleContext::new(
          visible_before,
          analysis,
          visible_after,
        )),
        &mut sink,
      )
      .map_err(|reason| Error::RuleExecution {
        rule_id: rule.spec().id().as_str().to_owned(),
        reason,
      })?;
    findings.extend(sink.into_findings());
  }
  Ok(findings)
}

pub(crate) fn run_document_rules(
  rules: &RuleSet,
  counters: &ExecutionCounters,
  facts: &DocumentFacts,
) -> Result<Vec<Finding>> {
  run_rules(rules, counters, RuleScope::DocumentFacts, || {
    RuleContext::DocumentFacts(DocumentRuleContext::new(facts))
  })
}

fn run_rules<'a>(
  rules: &'a RuleSet,
  counters: &ExecutionCounters,
  scope: RuleScope,
  context: impl Fn() -> RuleContext<'a>,
) -> Result<Vec<Finding>> {
  let mut findings = Vec::new();
  for rule in rules.rules_for_scope(scope) {
    counters.record_rule(scope);
    let mut sink = FindingSink::new(rule.spec().id().clone());
    rule.evaluate(context(), &mut sink).map_err(|reason| {
      Error::RuleExecution {
        rule_id: rule.spec().id().as_str().to_owned(),
        reason,
      }
    })?;
    findings.extend(sink.into_findings());
  }
  Ok(findings)
}

pub(crate) fn run_all_rules(
  rules: &RuleSet,
  counters: &ExecutionCounters,
  analyses: &[Arc<BlockAnalysis>],
  metadata: &Metadata,
) -> Result<Vec<Finding>> {
  let mut findings = Vec::new();
  let mut block_facts = Vec::with_capacity(analyses.len());
  let radius = rules.max_neighborhood_radius();
  for (position, analysis) in analyses.iter().enumerate() {
    let local = run_block_rules(rules, counters, analysis)?;
    let bounds = neighborhood_bounds(analyses.len(), position, radius);
    let before = analyses.get(bounds.before).unwrap_or_default();
    let after = analyses.get(bounds.after).unwrap_or_default();
    let neighborhood =
      run_neighborhood_rules(rules, counters, before, analysis, after)?;
    block_facts.push(BlockFact::new(
      analysis,
      local.len().saturating_add(neighborhood.len()),
    ));
    findings.extend(local);
    findings.extend(neighborhood);
  }
  let facts = DocumentFacts::new(block_facts, metadata.clone());
  findings.extend(run_document_rules(rules, counters, &facts)?);
  Ok(findings)
}

pub(crate) struct NeighborhoodBounds {
  pub(crate) before: Range<usize>,
  pub(crate) after: Range<usize>,
}

pub(crate) fn neighborhood_bounds(
  len: usize,
  position: usize,
  radius: usize,
) -> NeighborhoodBounds {
  let before_start = position.saturating_sub(radius);
  let after_start = position.saturating_add(1).min(len);
  let after_end = after_start.saturating_add(radius).min(len);
  NeighborhoodBounds {
    before: before_start..position,
    after: after_start..after_end,
  }
}

pub(crate) fn validate_findings(
  document: &Document,
  findings: &[Finding],
) -> Result<()> {
  for finding in findings {
    validate_span(document, finding.primary())?;
    for span in finding.related() {
      validate_span(document, span)?;
    }
  }
  Ok(())
}

fn validate_span(document: &Document, location: &BlockSpan) -> Result<()> {
  let Some(block) = document
    .blocks()
    .iter()
    .find(|block| block.id() == location.block_id())
  else {
    return Err(Error::UnknownBlock {
      block_id: location.block_id().clone(),
    });
  };
  validate_span_for_block(block, location)
}

pub(crate) fn validate_span_for_block(
  block: &DocumentBlock,
  location: &BlockSpan,
) -> Result<()> {
  let end = usize::try_from(location.span().end()).map_err(|_| {
    Error::FindingSpanOutOfBounds {
      block_id: location.block_id().clone(),
    }
  })?;
  if end > block.text().len()
    || !block.text().is_char_boundary(end)
    || !block.text().is_char_boundary(
      usize::try_from(location.span().start()).map_err(|_| {
        Error::FindingSpanOutOfBounds {
          block_id: location.block_id().clone(),
        }
      })?,
    )
  {
    return Err(Error::FindingSpanOutOfBounds {
      block_id: location.block_id().clone(),
    });
  }
  Ok(())
}
