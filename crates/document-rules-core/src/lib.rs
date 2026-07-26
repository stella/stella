#![allow(clippy::redundant_pub_crate)]

//! Neutral structured-document rule execution.
//!
//! Batch evaluation and incremental sessions share the same pure analysis and
//! rule kernels. Salsa is confined to the incremental cache; one-shot callers
//! do not construct a database.

mod engine;
#[cfg(feature = "incremental")]
mod incremental;
mod model;
mod normalized;
mod rule;

pub use engine::{
  AnalysisSnapshot, BlockAnalysis, ExecutionCounterSnapshot, ExecutionCounters,
  RuleEngine,
};
#[cfg(feature = "incremental")]
pub use incremental::IncrementalDocumentSession;
pub use model::{
  BlockId, BlockSpan, Document, DocumentBlock, DocumentChange, DocumentPatch,
  Metadata, MetadataKey, MetadataValue, Revision, TextSpan,
};
pub use rule::{
  AnalysisWindow, BlockFact, BlockRuleContext, DocumentFacts, DocumentRule,
  DocumentRuleContext, Finding, FindingAction, FindingDraft, FindingKind,
  FindingSink, NeighborhoodRadius, NeighborhoodRuleContext, RuleContext,
  RuleId, RuleScope, RuleSet, RuleSpec,
};

pub use model::{Error, Result};
pub use normalized::NormalizedText;
