#![allow(clippy::unwrap_used)]

use std::sync::Arc;

use stella_document_rules_core::{
  BlockId, BlockSpan, Document, DocumentBlock, DocumentChange, DocumentPatch,
  DocumentRule, FindingAction, FindingDraft, FindingKind, FindingSink,
  IncrementalDocumentSession, Metadata, MetadataKey, MetadataValue,
  NeighborhoodRadius, Revision, RuleContext, RuleEngine, RuleId, RuleScope,
  RuleSet, RuleSpec, TextSpan,
};

struct WordRule {
  spec: RuleSpec,
}

impl DocumentRule for WordRule {
  fn spec(&self) -> &RuleSpec {
    &self.spec
  }

  fn evaluate(
    &self,
    context: RuleContext<'_>,
    findings: &mut FindingSink,
  ) -> Result<(), String> {
    let RuleContext::Block(context) = context else {
      return Err(String::from("wrong context"));
    };
    for span in context.block().word_spans() {
      if context
        .block()
        .text_for_span(*span)
        .map_err(|error| error.to_string())?
        == "marker"
      {
        findings.push(
          FindingDraft::new(
            FindingKind::new("word-marker")
              .map_err(|error| error.to_string())?,
            BlockSpan::new(context.block().id().clone(), *span),
            "marker",
          )
          .with_action(FindingAction::Replace {
            replacement: Arc::from("[marker]"),
          }),
        );
      }
    }
    Ok(())
  }
}

struct NeighborRule {
  spec: RuleSpec,
}

impl DocumentRule for NeighborRule {
  fn spec(&self) -> &RuleSpec {
    &self.spec
  }

  fn evaluate(
    &self,
    context: RuleContext<'_>,
    findings: &mut FindingSink,
  ) -> Result<(), String> {
    let RuleContext::Neighborhood(context) = context else {
      return Err(String::from("wrong context"));
    };
    if context.block().text().contains("use")
      && context
        .previous()
        .is_some_and(|previous| previous.text().contains("define"))
    {
      findings.push(FindingDraft::new(
        FindingKind::new("neighbor-marker")
          .map_err(|error| error.to_string())?,
        BlockSpan::new(
          context.block().id().clone(),
          TextSpan::new(0, 0).map_err(|error| error.to_string())?,
        ),
        "neighbor",
      ));
    }
    Ok(())
  }
}

struct DocumentRuleFixture {
  spec: RuleSpec,
}

struct WideNeighborRule {
  spec: RuleSpec,
}

impl DocumentRule for WideNeighborRule {
  fn spec(&self) -> &RuleSpec {
    &self.spec
  }

  fn evaluate(
    &self,
    context: RuleContext<'_>,
    findings: &mut FindingSink,
  ) -> Result<(), String> {
    let RuleContext::Neighborhood(context) = context else {
      return Err(String::from("wrong context"));
    };
    if context.before().len() == 2
      && context
        .before()
        .first()
        .is_some_and(|block| block.text() == "anchor")
    {
      findings.push(FindingDraft::new(
        FindingKind::new("wide-neighborhood")
          .map_err(|error| error.to_string())?,
        BlockSpan::new(
          context.block().id().clone(),
          TextSpan::new(0, 0).map_err(|error| error.to_string())?,
        ),
        "wide neighborhood",
      ));
    }
    Ok(())
  }
}

struct MetadataRule {
  spec: RuleSpec,
  key: MetadataKey,
}

impl DocumentRule for MetadataRule {
  fn spec(&self) -> &RuleSpec {
    &self.spec
  }

  fn evaluate(
    &self,
    context: RuleContext<'_>,
    findings: &mut FindingSink,
  ) -> Result<(), String> {
    let RuleContext::DocumentFacts(context) = context else {
      return Err(String::from("wrong context"));
    };
    let document_matches = context
      .facts()
      .metadata()
      .get(&self.key)
      .is_some_and(|value| value.as_str() == "enabled");
    let Some(block) = context.facts().blocks().iter().find(|block| {
      block
        .metadata()
        .get(&self.key)
        .is_some_and(|value| value.as_str() == "enabled")
    }) else {
      return Ok(());
    };
    if document_matches {
      findings.push(
        FindingDraft::new(
          FindingKind::new("metadata-match")
            .map_err(|error| error.to_string())?,
          BlockSpan::new(
            block.block_id().clone(),
            TextSpan::new(0, 0).map_err(|error| error.to_string())?,
          ),
          "metadata match",
        )
        .with_action(FindingAction::Remove),
      );
    }
    Ok(())
  }
}

impl DocumentRule for DocumentRuleFixture {
  fn spec(&self) -> &RuleSpec {
    &self.spec
  }

  fn evaluate(
    &self,
    context: RuleContext<'_>,
    findings: &mut FindingSink,
  ) -> Result<(), String> {
    let RuleContext::DocumentFacts(context) = context else {
      return Err(String::from("wrong context"));
    };
    let total_words = context
      .facts()
      .blocks()
      .iter()
      .map(stella_document_rules_core::BlockFact::word_count)
      .sum::<usize>();
    if total_words >= 5
      && let Some(first) = context.facts().blocks().first()
    {
      findings.push(FindingDraft::new(
        FindingKind::new("document-marker")
          .map_err(|error| error.to_string())?,
        BlockSpan::new(
          first.block_id().clone(),
          TextSpan::new(0, 0).map_err(|error| error.to_string())?,
        ),
        "document",
      ));
    }
    Ok(())
  }
}

fn engine() -> RuleEngine {
  RuleEngine::new(
    RuleSet::new(vec![
      Arc::new(WordRule {
        spec: RuleSpec::new(RuleId::new("word").unwrap(), RuleScope::Block),
      }),
      Arc::new(NeighborRule {
        spec: RuleSpec::new(
          RuleId::new("neighbor").unwrap(),
          RuleScope::Neighborhood(NeighborhoodRadius::adjacent()),
        ),
      }),
      Arc::new(DocumentRuleFixture {
        spec: RuleSpec::new(
          RuleId::new("document").unwrap(),
          RuleScope::DocumentFacts,
        ),
      }),
    ])
    .unwrap(),
  )
}

fn block(id: &str, text: &str) -> DocumentBlock {
  DocumentBlock::new(BlockId::new(id).unwrap(), text).unwrap()
}

fn document() -> Document {
  Document::new(vec![
    block("a", "define marker"),
    block("b", "use this"),
    block("c", "plain words"),
    block("d", "plain words"),
    block("e", "plain words"),
  ])
  .unwrap()
}

fn metadata(key: &str, value: &str) -> Metadata {
  Metadata::new([(
    MetadataKey::new(key).unwrap(),
    MetadataValue::new(value).unwrap(),
  )])
  .unwrap()
}

#[test]
fn batch_and_incremental_paths_share_exact_results() {
  let engine = engine();
  let document = document();
  let batch = engine.analyze(&document).unwrap();
  let session = IncrementalDocumentSession::new(&engine, document);
  let incremental = session.analyze().unwrap();

  assert_eq!(batch, incremental);
  assert_eq!(incremental.revision(), Revision::initial());
  let typed = incremental
    .findings()
    .iter()
    .find(|finding| finding.kind().as_str() == "word-marker")
    .unwrap();
  assert_eq!(
    typed.action(),
    &FindingAction::Replace {
      replacement: Arc::from("[marker]"),
    }
  );
}

#[test]
fn one_block_edit_has_bounded_invalidation() {
  let engine = engine();
  let counters = engine.counters();
  let mut session = IncrementalDocumentSession::new(&engine, document());
  session.analyze().unwrap();
  counters.reset();

  session
    .apply_patch(&DocumentPatch::new(
      Revision::initial(),
      vec![DocumentChange::replace_text(
        BlockId::new("c").unwrap(),
        "changed words",
      )],
    ))
    .unwrap();
  let incremental = session.analyze().unwrap();

  let counts = counters.snapshot();
  assert_eq!(counts.block_analysis(), 1);
  assert_eq!(counts.block_rules(), 1);
  assert_eq!(counts.neighborhood_rules(), 3);
  assert_eq!(counts.document_rules(), 1);

  let batch = engine.analyze(session.document()).unwrap();
  assert_eq!(incremental.findings(), batch.findings());
}

#[test]
fn insertion_invalidates_only_new_and_adjacent_block_queries() {
  let engine = engine();
  let counters = engine.counters();
  let mut session = IncrementalDocumentSession::new(&engine, document());
  session.analyze().unwrap();
  counters.reset();

  session
    .apply_patch(&DocumentPatch::new(
      Revision::initial(),
      vec![DocumentChange::insert_after(
        Some(BlockId::new("b").unwrap()),
        block("inserted", "marker use"),
      )],
    ))
    .unwrap();
  session.analyze().unwrap();

  let counts = counters.snapshot();
  assert_eq!(counts.block_analysis(), 1);
  assert_eq!(counts.block_rules(), 1);
  assert_eq!(counts.neighborhood_rules(), 3);
  assert_eq!(counts.document_rules(), 1);
}

#[test]
fn patches_are_revisioned_and_fail_atomically() {
  let engine = engine();
  let mut session = IncrementalDocumentSession::new(&engine, document());
  let before = session.analyze().unwrap();

  let error = session
    .apply_patch(&DocumentPatch::new(
      Revision::initial(),
      vec![
        DocumentChange::replace_text(BlockId::new("a").unwrap(), "changed"),
        DocumentChange::remove(BlockId::new("missing").unwrap()),
      ],
    ))
    .unwrap_err();
  assert!(error.to_string().contains("does not exist"));
  assert_eq!(session.revision(), Revision::initial());
  assert_eq!(session.analyze().unwrap(), before);

  session
    .apply_patch(&DocumentPatch::new(
      Revision::initial(),
      vec![DocumentChange::replace_text(
        BlockId::new("a").unwrap(),
        "changed",
      )],
    ))
    .unwrap();
  let stale = session
    .apply_patch(&DocumentPatch::new(Revision::initial(), Vec::new()))
    .unwrap_err();
  assert!(stale.to_string().contains("expected revision 0"));
  assert_eq!(session.revision().value(), 1);
}

#[test]
fn structural_patches_preserve_batch_incremental_equality() {
  let engine = engine();
  let mut session = IncrementalDocumentSession::new(&engine, document());
  session
    .apply_patch(&DocumentPatch::new(
      Revision::initial(),
      vec![DocumentChange::insert_after(
        Some(BlockId::new("b").unwrap()),
        block("inserted", "marker use"),
      )],
    ))
    .unwrap();

  let batch = engine.analyze(session.document()).unwrap();
  let incremental = session.analyze().unwrap();
  assert_eq!(batch.findings(), incremental.findings());
}

#[test]
fn declared_radius_controls_visibility_and_invalidation() {
  let engine = RuleEngine::new(
    RuleSet::new(vec![Arc::new(WideNeighborRule {
      spec: RuleSpec::new(
        RuleId::new("wide-neighbor").unwrap(),
        RuleScope::Neighborhood(NeighborhoodRadius::new(2).unwrap()),
      ),
    })])
    .unwrap(),
  );
  let document = Document::new(vec![
    block("a", "anchor"),
    block("b", "one"),
    block("c", "target"),
    block("d", "three"),
    block("e", "four"),
    block("f", "five"),
    block("g", "six"),
  ])
  .unwrap();
  let batch = engine.analyze(&document).unwrap();
  assert_eq!(batch.findings().len(), 1);
  assert_eq!(
    batch
      .findings()
      .first()
      .unwrap()
      .primary()
      .block_id()
      .as_str(),
    "c"
  );

  let counters = engine.counters();
  let mut session = IncrementalDocumentSession::new(&engine, document);
  session.analyze().unwrap();
  counters.reset();
  session
    .apply_patch(&DocumentPatch::new(
      Revision::initial(),
      vec![DocumentChange::replace_text(
        BlockId::new("d").unwrap(),
        "changed",
      )],
    ))
    .unwrap();
  session.analyze().unwrap();

  let counts = counters.snapshot();
  assert_eq!(counts.block_analysis(), 1);
  assert_eq!(counts.block_rules(), 0);
  assert_eq!(counts.neighborhood_rules(), 5);
  assert_eq!(counts.document_rules(), 0);
}

#[test]
fn metadata_is_neutral_rule_input_with_precise_invalidation() {
  let key = MetadataKey::new("mode").unwrap();
  let engine = RuleEngine::new(
    RuleSet::new(vec![Arc::new(MetadataRule {
      spec: RuleSpec::new(
        RuleId::new("metadata").unwrap(),
        RuleScope::DocumentFacts,
      ),
      key,
    })])
    .unwrap(),
  );
  let document = Document::with_metadata(
    vec![
      DocumentBlock::with_metadata(
        BlockId::new("a").unwrap(),
        "text",
        metadata("mode", "enabled"),
      )
      .unwrap(),
      block("b", "other"),
    ],
    metadata("mode", "enabled"),
  )
  .unwrap();
  let batch = engine.analyze(&document).unwrap();
  assert_eq!(batch.findings().len(), 1);
  assert_eq!(
    batch.findings().first().unwrap().action(),
    &FindingAction::Remove
  );

  let counters = engine.counters();
  let mut session = IncrementalDocumentSession::new(&engine, document);
  assert_eq!(session.analyze().unwrap().findings(), batch.findings());
  counters.reset();
  session
    .apply_patch(&DocumentPatch::new(
      Revision::initial(),
      vec![DocumentChange::replace_document_metadata(metadata(
        "mode", "disabled",
      ))],
    ))
    .unwrap();
  assert!(session.analyze().unwrap().findings().is_empty());

  let counts = counters.snapshot();
  assert_eq!(counts.block_analysis(), 0);
  assert_eq!(counts.block_rules(), 0);
  assert_eq!(counts.neighborhood_rules(), 0);
  assert_eq!(counts.document_rules(), 1);
}

#[test]
fn invalid_neighborhood_radii_are_rejected() {
  assert!(NeighborhoodRadius::new(0).is_err());
  assert!(NeighborhoodRadius::new(17).is_err());
}
