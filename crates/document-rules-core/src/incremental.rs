use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::Arc;

use salsa::Setter as _;

use crate::engine::{
  AnalysisSnapshot, BlockAnalysis, ExecutionCounters, RuleEngine,
  analyze_block, neighborhood_bounds, run_block_rules, run_document_rules,
  run_neighborhood_rules, validate_span_for_block,
};
use crate::model::{
  BlockId, BlockSpan, Document, DocumentBlock, DocumentPatch, Error, Metadata,
  NonStructuralDocumentPatch, Result, Revision,
};
use crate::rule::{BlockFact, DocumentFacts, Finding, RuleSet};

// Salsa input slots live for the database lifetime. Rotate the cache generation
// before structural churn can retain more old records than this bounded budget.
const MIN_RETIRED_RECORD_LIMIT: usize = 64;

#[salsa::input]
#[derive(Debug)]
struct BlockInput {
  #[returns(clone)]
  id: BlockId,
  #[returns(clone)]
  text: Arc<str>,
  #[returns(clone)]
  metadata: Metadata,
}

#[salsa::input]
#[derive(Debug)]
struct LinkInput {
  #[returns(clone)]
  before: Arc<[BlockInput]>,
  #[returns(clone)]
  after: Arc<[BlockInput]>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct BlockRecord {
  block: BlockInput,
  links: LinkInput,
  position: usize,
}

#[salsa::input]
struct DocumentInput {
  #[returns(clone)]
  blocks: Arc<[BlockRecord]>,
  #[returns(clone)]
  metadata: Metadata,
}

#[salsa::db]
trait DocumentDatabase: salsa::Database {
  fn rules(&self) -> &RuleSet;
  fn counters(&self) -> &ExecutionCounters;
}

#[salsa::db]
#[derive(Clone)]
struct Database {
  storage: salsa::Storage<Self>,
  rules: Arc<RuleSet>,
  counters: Arc<ExecutionCounters>,
}

impl Database {
  fn new(engine: &RuleEngine) -> Self {
    Self {
      storage: salsa::Storage::new(None),
      rules: Arc::clone(&engine.rules),
      counters: Arc::clone(&engine.counters),
    }
  }

  fn fresh(&self) -> Self {
    Self {
      storage: salsa::Storage::new(None),
      rules: Arc::clone(&self.rules),
      counters: Arc::clone(&self.counters),
    }
  }
}

#[salsa::db]
impl salsa::Database for Database {}

#[salsa::db]
impl DocumentDatabase for Database {
  fn rules(&self) -> &RuleSet {
    &self.rules
  }

  fn counters(&self) -> &ExecutionCounters {
    &self.counters
  }
}

#[salsa::tracked(returns(clone))]
fn tracked_block_analysis(
  db: &dyn DocumentDatabase,
  block: BlockInput,
) -> Result<Arc<BlockAnalysis>> {
  let document_block = DocumentBlock::with_metadata(
    block.id(db),
    block.text(db),
    block.metadata(db),
  )?;
  analyze_block(&document_block, db.counters())
}

#[salsa::tracked(returns(clone))]
fn tracked_block_findings(
  db: &dyn DocumentDatabase,
  block: BlockInput,
) -> Result<Arc<[Finding]>> {
  let analysis = tracked_block_analysis(db, block)?;
  Ok(run_block_rules(db.rules(), db.counters(), &analysis)?.into())
}

#[salsa::tracked(returns(clone))]
fn tracked_neighborhood_findings(
  db: &dyn DocumentDatabase,
  block: BlockInput,
  links: LinkInput,
) -> Result<Arc<[Finding]>> {
  let analysis = tracked_block_analysis(db, block)?;
  let before = links
    .before(db)
    .iter()
    .map(|neighbor| tracked_block_analysis(db, *neighbor))
    .collect::<Result<Vec<_>>>()?;
  let after = links
    .after(db)
    .iter()
    .map(|neighbor| tracked_block_analysis(db, *neighbor))
    .collect::<Result<Vec<_>>>()?;
  Ok(
    run_neighborhood_rules(
      db.rules(),
      db.counters(),
      &before,
      &analysis,
      &after,
    )?
    .into(),
  )
}

#[salsa::tracked(returns(clone))]
fn tracked_document_facts(
  db: &dyn DocumentDatabase,
  document: DocumentInput,
) -> Result<Arc<DocumentFacts>> {
  let records = document.blocks(db);
  let mut facts = Vec::with_capacity(records.len());
  for record in records.iter().copied() {
    let analysis = tracked_block_analysis(db, record.block)?;
    let local = tracked_block_findings(db, record.block)?;
    let neighborhood =
      tracked_neighborhood_findings(db, record.block, record.links)?;
    facts.push(BlockFact::new(
      &analysis,
      local.len().saturating_add(neighborhood.len()),
    ));
  }
  Ok(Arc::new(DocumentFacts::new(facts, document.metadata(db))))
}

#[salsa::tracked(returns(clone))]
fn tracked_document_findings(
  db: &dyn DocumentDatabase,
  document: DocumentInput,
) -> Result<Arc<[Finding]>> {
  let facts = tracked_document_facts(db, document)?;
  Ok(run_document_rules(db.rules(), db.counters(), &facts)?.into())
}

#[derive(Default)]
struct FindingCache {
  initialized: bool,
  by_position: Vec<(usize, Arc<[Finding]>)>,
  dirty_positions: Vec<usize>,
  #[cfg(test)]
  refreshed_record_count: usize,
}

impl FindingCache {
  fn invalidate_structure(&mut self) {
    self.initialized = false;
    self.by_position.clear();
    self.dirty_positions.clear();
  }

  fn invalidate_around(
    &mut self,
    position: usize,
    block_count: usize,
    radius: usize,
  ) {
    if !self.initialized {
      return;
    }
    let start = position.saturating_sub(radius);
    let end = position
      .saturating_add(radius)
      .saturating_add(1)
      .min(block_count);
    self.dirty_positions.extend(start..end);
  }

  fn collect(
    &mut self,
    database: &Database,
    records: &[BlockRecord],
  ) -> Result<Vec<Finding>> {
    if !self.initialized {
      let mut by_position = Vec::new();
      for (position, record) in records.iter().copied().enumerate() {
        #[cfg(test)]
        self.record_refresh();
        let findings = refresh_record(database, record)?;
        if !findings.is_empty() {
          by_position.push((position, findings));
        }
      }
      self.by_position = by_position;
      self.initialized = true;
      self.dirty_positions.clear();
    } else if !self.dirty_positions.is_empty() {
      self.dirty_positions.sort_unstable();
      self.dirty_positions.dedup();
      let mut refreshed = Vec::with_capacity(self.dirty_positions.len());
      for position in self.dirty_positions.iter().copied() {
        let Some(record) = records.get(position).copied() else {
          self.invalidate_structure();
          return self.collect(database, records);
        };
        refreshed.push((position, refresh_record(database, record)?));
      }
      #[cfg(test)]
      {
        self.refreshed_record_count =
          self.refreshed_record_count.saturating_add(refreshed.len());
      }
      self.by_position = merge_refreshed_findings(
        std::mem::take(&mut self.by_position),
        refreshed,
      );
      self.dirty_positions.clear();
    }

    let finding_count = self
      .by_position
      .iter()
      .map(|(_, findings)| findings.len())
      .sum();
    let mut findings = Vec::with_capacity(finding_count);
    for (_, block_findings) in &self.by_position {
      findings.extend(block_findings.iter().cloned());
    }
    Ok(findings)
  }

  #[cfg(test)]
  const fn record_refresh(&mut self) {
    self.refreshed_record_count = self.refreshed_record_count.saturating_add(1);
  }
}

fn merge_refreshed_findings(
  cached: Vec<(usize, Arc<[Finding]>)>,
  refreshed: Vec<(usize, Arc<[Finding]>)>,
) -> Vec<(usize, Arc<[Finding]>)> {
  let mut merged =
    Vec::with_capacity(cached.len().saturating_add(refreshed.len()));
  let mut cached = cached.into_iter().peekable();
  let mut refreshed = refreshed.into_iter().peekable();

  while let (Some((cached_position, _)), Some((refreshed_position, _))) =
    (cached.peek(), refreshed.peek())
  {
    match cached_position.cmp(refreshed_position) {
      std::cmp::Ordering::Less => {
        if let Some(entry) = cached.next() {
          merged.push(entry);
        }
      }
      std::cmp::Ordering::Equal => {
        cached.next();
        if let Some(entry) = refreshed.next()
          && !entry.1.is_empty()
        {
          merged.push(entry);
        }
      }
      std::cmp::Ordering::Greater => {
        if let Some(entry) = refreshed.next()
          && !entry.1.is_empty()
        {
          merged.push(entry);
        }
      }
    }
  }

  merged.extend(cached);
  merged.extend(refreshed.filter(|(_, findings)| !findings.is_empty()));
  merged
}

fn refresh_record(
  database: &Database,
  record: BlockRecord,
) -> Result<Arc<[Finding]>> {
  let local = tracked_block_findings(database, record.block)?;
  let neighborhood =
    tracked_neighborhood_findings(database, record.block, record.links)?;
  let mut findings =
    Vec::with_capacity(local.len().saturating_add(neighborhood.len()));
  findings.extend(local.iter().cloned());
  findings.extend(neighborhood.iter().cloned());
  Ok(findings.into())
}

pub struct IncrementalDocumentSession {
  database: Database,
  document_input: DocumentInput,
  records: BTreeMap<BlockId, BlockRecord>,
  finding_cache: RefCell<FindingCache>,
  allocated_record_count: usize,
  text_bytes: usize,
  document: Document,
  revision: Revision,
  #[cfg(test)]
  fast_patch_block_count: usize,
}

impl IncrementalDocumentSession {
  #[must_use]
  pub fn new(engine: &RuleEngine, document: Document) -> Self {
    let text_bytes = document.text_bytes();
    let database = Database::new(engine);
    let (records, ordered) = create_records(&database, &document);
    let document_input = DocumentInput::new(
      &database,
      ordered.into(),
      document.metadata().clone(),
    );
    Self {
      database,
      document_input,
      records,
      finding_cache: RefCell::new(FindingCache::default()),
      allocated_record_count: document.blocks().len(),
      text_bytes,
      document,
      revision: Revision::initial(),
      #[cfg(test)]
      fast_patch_block_count: 0,
    }
  }

  #[must_use]
  pub const fn revision(&self) -> Revision {
    self.revision
  }

  #[must_use]
  pub const fn document(&self) -> &Document {
    &self.document
  }

  /// Returns a block by identifier without scanning the document.
  ///
  /// The lookup follows both structural and non-structural patches applied to
  /// this session.
  #[must_use]
  pub fn block(&self, block_id: &BlockId) -> Option<&DocumentBlock> {
    self
      .records
      .get(block_id)
      .and_then(|record| self.document.blocks().get(record.position))
      .filter(|block| block.id() == block_id)
  }

  pub fn analyze(&self) -> Result<AnalysisSnapshot> {
    let records = self.document_input.blocks(&self.database);
    let mut findings = self
      .finding_cache
      .borrow_mut()
      .collect(&self.database, &records)?;
    if self.database.rules().has_document_rules() {
      findings.extend(
        tracked_document_findings(&self.database, self.document_input)?
          .iter()
          .cloned(),
      );
    }
    self.validate_findings(&findings)?;
    Ok(AnalysisSnapshot::new(self.revision, findings))
  }

  fn validate_findings(&self, findings: &[Finding]) -> Result<()> {
    for finding in findings {
      self.validate_span(finding.primary())?;
      for span in finding.related() {
        self.validate_span(span)?;
      }
    }
    Ok(())
  }

  fn validate_span(&self, location: &BlockSpan) -> Result<()> {
    let Some(block) = self.block(location.block_id()) else {
      return Err(Error::UnknownBlock {
        block_id: location.block_id().clone(),
      });
    };
    validate_span_for_block(block, location)
  }

  pub fn apply_patch(&mut self, patch: &DocumentPatch) -> Result<Revision> {
    if patch.expected_revision() != self.revision {
      return Err(Error::StaleRevision {
        expected: patch.expected_revision(),
        actual: self.revision,
      });
    }
    let position_of = |block_id: &BlockId| {
      self.records.get(block_id).map(|record| record.position)
    };
    let Some(prepared) = self.document.prepare_non_structural_patch(
      patch.changes(),
      self.text_bytes,
      &position_of,
    )?
    else {
      return self.apply_structural_patch(patch);
    };
    self.apply_non_structural_patch(&prepared)
  }

  fn apply_non_structural_patch(
    &mut self,
    patch: &NonStructuralDocumentPatch,
  ) -> Result<Revision> {
    if patch.is_empty() {
      return Ok(self.revision);
    }
    let next_revision = self.revision.next()?;
    let inputs = patch
      .block_updates()
      .iter()
      .map(|update| {
        self
          .records
          .get(update.block_id())
          .map(|record| record.block)
          .ok_or_else(|| Error::UnknownBlock {
            block_id: update.block_id().clone(),
          })
      })
      .collect::<Result<Vec<_>>>()?;

    #[cfg(test)]
    {
      self.fast_patch_block_count = self
        .fast_patch_block_count
        .saturating_add(patch.block_updates().len());
    }

    self.document.apply_non_structural_patch(patch)?;
    let block_count = self.document.blocks().len();
    let radius = self.database.rules().max_neighborhood_radius();
    let mut finding_cache = self.finding_cache.borrow_mut();
    for (update, input) in patch.block_updates().iter().zip(inputs) {
      if let Some(text) = update.text() {
        input.set_text(&mut self.database).to(Arc::clone(text));
      }
      if let Some(metadata) = update.metadata() {
        input.set_metadata(&mut self.database).to(metadata.clone());
      }
      finding_cache.invalidate_around(update.position(), block_count, radius);
    }
    if let Some(metadata) = patch.document_metadata() {
      self
        .document_input
        .set_metadata(&mut self.database)
        .to(metadata.clone());
    }
    drop(finding_cache);
    self.text_bytes = patch.text_bytes();
    self.revision = next_revision;
    Ok(next_revision)
  }

  fn apply_structural_patch(
    &mut self,
    patch: &DocumentPatch,
  ) -> Result<Revision> {
    let next_document = self.document.apply_changes(patch.changes())?;
    if next_document == self.document {
      return Ok(self.revision);
    }
    let next_revision = self.revision.next()?;
    self.reconcile_inputs(&next_document);
    self.finding_cache.borrow_mut().invalidate_structure();
    self.text_bytes = next_document.text_bytes();
    self.document = next_document;
    self.revision = next_revision;
    Ok(next_revision)
  }

  fn reconcile_inputs(&mut self, document: &Document) {
    let inserted_count = document
      .blocks()
      .iter()
      .filter(|block| !self.records.contains_key(block.id()))
      .count();
    let projected_allocated =
      self.allocated_record_count.saturating_add(inserted_count);
    let projected_retired =
      projected_allocated.saturating_sub(document.blocks().len());
    if projected_retired > retired_record_limit(document.blocks().len()) {
      self.rebuild_database(document);
      return;
    }

    let mut inputs = BTreeMap::<BlockId, BlockInput>::new();
    for block in document.blocks() {
      let input = match self.records.get(block.id()) {
        Some(record) => {
          if record.block.text(&self.database).as_ref() != block.text() {
            record
              .block
              .set_text(&mut self.database)
              .to(block.text_arc());
          }
          if record.block.metadata(&self.database) != *block.metadata() {
            record
              .block
              .set_metadata(&mut self.database)
              .to(block.metadata().clone());
          }
          record.block
        }
        None => BlockInput::new(
          &self.database,
          block.id().clone(),
          block.text_arc(),
          block.metadata().clone(),
        ),
      };
      inputs.insert(block.id().clone(), input);
    }

    let ordered_inputs = document
      .blocks()
      .iter()
      .filter_map(|block| inputs.get(block.id()).copied())
      .collect::<Vec<_>>();
    let mut next_records = BTreeMap::new();
    let mut ordered_records = Vec::with_capacity(ordered_inputs.len());
    let radius = self.database.rules().max_neighborhood_radius();
    for (position, block) in ordered_inputs.iter().copied().enumerate() {
      let id = block.id(&self.database);
      let (before, after) =
        neighborhood_inputs(&ordered_inputs, position, radius);
      let links = match self.records.get(&id) {
        Some(record) => {
          if record.links.before(&self.database) != before {
            record.links.set_before(&mut self.database).to(before);
          }
          if record.links.after(&self.database) != after {
            record.links.set_after(&mut self.database).to(after);
          }
          record.links
        }
        None => LinkInput::new(&self.database, before, after),
      };
      let record = BlockRecord {
        block,
        links,
        position,
      };
      next_records.insert(id, record);
      ordered_records.push(record);
    }
    let ordered_records: Arc<[BlockRecord]> = ordered_records.into();
    if self.document_input.blocks(&self.database) != ordered_records {
      self
        .document_input
        .set_blocks(&mut self.database)
        .to(ordered_records);
    }
    if self.document_input.metadata(&self.database) != *document.metadata() {
      self
        .document_input
        .set_metadata(&mut self.database)
        .to(document.metadata().clone());
    }
    self.records = next_records;
    self.allocated_record_count = projected_allocated;
  }

  fn rebuild_database(&mut self, document: &Document) {
    let database = self.database.fresh();
    let (records, ordered) = create_records(&database, document);
    let document_input = DocumentInput::new(
      &database,
      ordered.into(),
      document.metadata().clone(),
    );
    self.database = database;
    self.document_input = document_input;
    self.records = records;
    self.allocated_record_count = document.blocks().len();
  }

  #[cfg(test)]
  fn reset_patch_and_refresh_counts(&mut self) {
    self.fast_patch_block_count = 0;
    self.finding_cache.borrow_mut().refreshed_record_count = 0;
  }

  #[cfg(test)]
  fn patch_and_refresh_counts(&self) -> (usize, usize) {
    (
      self.fast_patch_block_count,
      self.finding_cache.borrow().refreshed_record_count,
    )
  }
}

fn retired_record_limit(live_record_count: usize) -> usize {
  live_record_count.max(MIN_RETIRED_RECORD_LIMIT)
}

fn create_records(
  database: &Database,
  document: &Document,
) -> (BTreeMap<BlockId, BlockRecord>, Vec<BlockRecord>) {
  let inputs = document
    .blocks()
    .iter()
    .map(|block| {
      BlockInput::new(
        database,
        block.id().clone(),
        block.text_arc(),
        block.metadata().clone(),
      )
    })
    .collect::<Vec<_>>();
  let mut records = BTreeMap::new();
  let mut ordered = Vec::with_capacity(inputs.len());
  let radius = database.rules().max_neighborhood_radius();
  for (position, block) in inputs.iter().copied().enumerate() {
    let (before, after) = neighborhood_inputs(&inputs, position, radius);
    let links = LinkInput::new(database, before, after);
    let record = BlockRecord {
      block,
      links,
      position,
    };
    records.insert(block.id(database), record);
    ordered.push(record);
  }
  (records, ordered)
}

fn neighborhood_inputs(
  inputs: &[BlockInput],
  position: usize,
  radius: usize,
) -> (Arc<[BlockInput]>, Arc<[BlockInput]>) {
  let bounds = neighborhood_bounds(inputs.len(), position, radius);
  let before = inputs
    .get(bounds.before)
    .unwrap_or_default()
    .to_vec()
    .into();
  let after = inputs.get(bounds.after).unwrap_or_default().to_vec().into();
  (before, after)
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use super::*;
  use crate::model::{BlockId, DocumentChange, TextSpan};
  use crate::rule::{
    DocumentRule, FindingDraft, FindingKind, FindingSink, RuleContext, RuleId,
    RuleScope, RuleSpec,
  };

  struct MarkerRule {
    spec: RuleSpec,
  }

  impl DocumentRule for MarkerRule {
    fn spec(&self) -> &RuleSpec {
      &self.spec
    }

    fn evaluate(
      &self,
      context: RuleContext<'_>,
      findings: &mut FindingSink,
    ) -> std::result::Result<(), String> {
      let RuleContext::Block(context) = context else {
        return Err(String::from("wrong context"));
      };
      if context.block().text() == "marker" {
        findings.push(FindingDraft::new(
          FindingKind::new("marker").map_err(|error| error.to_string())?,
          BlockSpan::new(
            context.block().id().clone(),
            TextSpan::new(0, 0).map_err(|error| error.to_string())?,
          ),
          "marker",
        ));
      }
      Ok(())
    }
  }

  fn marker_engine() -> RuleEngine {
    RuleEngine::new(
      RuleSet::new(vec![Arc::new(MarkerRule {
        spec: RuleSpec::new(RuleId::new("marker").unwrap(), RuleScope::Block),
      })])
      .unwrap(),
    )
  }

  fn assert_send<T: Send>() {}

  fn assert_send_sync<T: Send + Sync>() {}

  #[test]
  fn public_threading_traits_match_the_database_contract() {
    assert_send_sync::<RuleEngine>();
    assert_send::<Database>();
    assert_send::<IncrementalDocumentSession>();
  }

  fn input_count(database: &Database, debug_name: &str) -> usize {
    <dyn salsa::Database>::memory_usage(database)
      .structs
      .iter()
      .find(|ingredient| ingredient.debug_name() == debug_name)
      .map_or(0, salsa::IngredientInfo::count)
  }

  #[test]
  fn structural_churn_keeps_salsa_inputs_bounded() {
    let engine = RuleEngine::new(RuleSet::new(Vec::new()).unwrap());
    let stable =
      DocumentBlock::new(BlockId::new("stable").unwrap(), "text").unwrap();
    let document = Document::new(vec![stable]).unwrap();
    let mut session = IncrementalDocumentSession::new(&engine, document);

    for index in 0..256 {
      let temporary_id = BlockId::new(format!("temporary-{index}")).unwrap();
      let temporary =
        DocumentBlock::new(temporary_id.clone(), "temporary").unwrap();
      session
        .apply_patch(&DocumentPatch::new(
          session.revision(),
          vec![DocumentChange::insert_after(None, temporary)],
        ))
        .unwrap();
      assert_eq!(
        session.block(&temporary_id).map(DocumentBlock::text),
        Some("temporary")
      );
      session
        .apply_patch(&DocumentPatch::new(
          session.revision(),
          vec![DocumentChange::remove(temporary_id.clone())],
        ))
        .unwrap();
      assert!(session.block(&temporary_id).is_none());
    }

    let live_count = session.document().blocks().len();
    let retained_limit =
      live_count.saturating_add(retired_record_limit(live_count));
    assert!(session.allocated_record_count <= retained_limit);
    assert_eq!(
      input_count(&session.database, "BlockInput"),
      session.allocated_record_count
    );
    assert_eq!(
      input_count(&session.database, "LinkInput"),
      session.allocated_record_count
    );
    assert_eq!(input_count(&session.database, "DocumentInput"), 1);
  }

  fn one_block_edit_patch_and_refresh_counts(
    block_count: usize,
  ) -> (usize, usize) {
    let engine = RuleEngine::new(RuleSet::new(Vec::new()).unwrap());
    let blocks = (0..block_count)
      .map(|index| {
        DocumentBlock::new(
          BlockId::new(format!("block-{index}")).unwrap(),
          "unchanged",
        )
        .unwrap()
      })
      .collect();
    let document = Document::new(blocks).unwrap();
    let target =
      BlockId::new(format!("block-{}", block_count.div_ceil(2))).unwrap();
    let mut session = IncrementalDocumentSession::new(&engine, document);
    session.analyze().unwrap();
    session.reset_patch_and_refresh_counts();

    session
      .apply_patch(&DocumentPatch::new(
        session.revision(),
        vec![DocumentChange::replace_text(target, "changed")],
      ))
      .unwrap();
    session.analyze().unwrap();
    session.patch_and_refresh_counts()
  }

  #[test]
  fn one_block_edit_patches_and_refreshes_one_record_at_any_document_size() {
    let small = one_block_edit_patch_and_refresh_counts(32);
    let large = one_block_edit_patch_and_refresh_counts(20_000);

    assert_eq!(small, (1, 1));
    assert_eq!(large, small);
  }

  #[test]
  fn dense_patch_folds_twenty_thousand_distinct_updates_once_each() {
    let engine = RuleEngine::new(RuleSet::new(Vec::new()).unwrap());
    let ids = (0..20_000)
      .map(|index| BlockId::new(format!("block-{index}")).unwrap())
      .collect::<Vec<_>>();
    let blocks = ids
      .iter()
      .cloned()
      .map(|id| DocumentBlock::new(id, "original").unwrap())
      .collect();
    let mut session =
      IncrementalDocumentSession::new(&engine, Document::new(blocks).unwrap());
    let changes = ids
      .iter()
      .rev()
      .cloned()
      .map(|id| DocumentChange::replace_text(id, "changed"))
      .collect();

    session.reset_patch_and_refresh_counts();
    session
      .apply_patch(&DocumentPatch::new(session.revision(), changes))
      .unwrap();

    assert_eq!(session.patch_and_refresh_counts(), (20_000, 0));
    for id in &ids {
      assert_eq!(session.block(id).map(DocumentBlock::text), Some("changed"));
    }
  }

  #[test]
  fn dense_patch_and_analysis_merge_twenty_thousand_cache_removals_once() {
    let ids = (0..20_000)
      .map(|index| BlockId::new(format!("block-{index}")).unwrap())
      .collect::<Vec<_>>();
    let blocks = ids
      .iter()
      .cloned()
      .map(|id| DocumentBlock::new(id, "marker").unwrap())
      .collect();
    let mut session = IncrementalDocumentSession::new(
      &marker_engine(),
      Document::new(blocks).unwrap(),
    );
    assert_eq!(session.analyze().unwrap().findings().len(), ids.len());
    let changes = ids
      .iter()
      .rev()
      .cloned()
      .map(|id| DocumentChange::replace_text(id, "clear"))
      .collect();

    session.reset_patch_and_refresh_counts();
    session
      .apply_patch(&DocumentPatch::new(session.revision(), changes))
      .unwrap();
    assert!(session.analyze().unwrap().findings().is_empty());
    assert_eq!(session.patch_and_refresh_counts(), (20_000, 20_000));
  }

  #[test]
  fn repeated_non_structural_changes_are_atomic_and_last_write_wins() {
    let engine = RuleEngine::new(RuleSet::new(Vec::new()).unwrap());
    let id = BlockId::new("stable").unwrap();
    let document =
      Document::new(vec![DocumentBlock::new(id.clone(), "original").unwrap()])
        .unwrap();
    let mut session = IncrementalDocumentSession::new(&engine, document);

    let unchanged = session
      .apply_patch(&DocumentPatch::new(
        Revision::initial(),
        vec![
          DocumentChange::replace_text(id.clone(), "temporary"),
          DocumentChange::replace_text(id.clone(), "original"),
        ],
      ))
      .unwrap();
    assert_eq!(unchanged, Revision::initial());
    assert_eq!(
      session.document().blocks().first().unwrap().text(),
      "original"
    );

    let unknown = session
      .apply_patch(&DocumentPatch::new(
        Revision::initial(),
        vec![
          DocumentChange::replace_text(id.clone(), "accepted"),
          DocumentChange::replace_text(
            BlockId::new("missing").unwrap(),
            "unknown",
          ),
        ],
      ))
      .unwrap_err();
    assert!(matches!(unknown, Error::UnknownBlock { .. }));
    assert_eq!(session.revision(), Revision::initial());
    assert_eq!(
      session.document().blocks().first().unwrap().text(),
      "original"
    );

    let oversized: Arc<str> = "x".repeat(0x0100_0001).into();
    let changed = session
      .apply_patch(&DocumentPatch::new(
        Revision::initial(),
        vec![
          DocumentChange::replace_text(id.clone(), Arc::clone(&oversized)),
          DocumentChange::replace_text(id.clone(), "accepted"),
        ],
      ))
      .unwrap();
    assert_eq!(changed.value(), 1);
    assert_eq!(
      session.document().blocks().first().unwrap().text(),
      "accepted"
    );

    let error = session
      .apply_patch(&DocumentPatch::new(
        changed,
        vec![
          DocumentChange::replace_text(id.clone(), "temporary"),
          DocumentChange::replace_text(id, oversized),
        ],
      ))
      .unwrap_err();
    assert!(matches!(error, Error::BlockTooLarge { .. }));
    assert_eq!(session.revision(), changed);
    assert_eq!(
      session.document().blocks().first().unwrap().text(),
      "accepted"
    );
  }
}
