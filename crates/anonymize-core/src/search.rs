use web_time::Instant;

use stella_text_search_core as text_search;

use crate::artifact_bytes::{ArtifactReader, ArtifactWriter};
use crate::types::{Error, Result, SearchEngine, SearchMatch};

const SEARCH_INDEX_ARTIFACTS_HEADER: [u8; 8] = *b"ANONIDX1";
const SEARCH_INDEX_ARTIFACTS_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub enum SearchPattern {
  Literal(String),
  LiteralWithOptions {
    pattern: String,
    case_insensitive: Option<bool>,
    whole_words: Option<bool>,
  },
  Regex(String),
  RegexWithOptions {
    pattern: String,
    lazy: bool,
    prefilter_any: Vec<String>,
    prefilter_case_insensitive: Option<bool>,
    prefilter_regex: Option<String>,
    prefilter_window_bytes: Option<usize>,
    prepared_artifact_policy: Option<PreparedArtifactPolicy>,
  },
  Fuzzy {
    pattern: String,
    distance: Option<u8>,
  },
}

#[derive(
  bon::Builder,
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct SearchOptions {
  #[builder(default)]
  pub literal: LiteralSearchOptions,
  #[builder(default)]
  pub regex: RegexSearchOptions,
  #[builder(default)]
  pub fuzzy: FuzzySearchOptions,
}

#[derive(
  bon::Builder,
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  Ord,
  PartialEq,
  PartialOrd,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct LiteralSearchOptions {
  #[builder(default)]
  pub case_insensitive: bool,
  #[builder(default)]
  pub whole_words: bool,
}

#[derive(
  bon::Builder,
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct RegexSearchOptions {
  #[builder(default)]
  pub whole_words: bool,
  #[builder(default)]
  pub overlap_all: bool,
  #[builder(default)]
  pub artifact_policy: RegexArtifactPolicy,
}

#[derive(
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum RegexArtifactPolicy {
  #[default]
  Include,
  Omit,
}

#[derive(
  Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum PreparedArtifactPolicy {
  Include,
  Omit,
}

#[derive(
  bon::Builder,
  Clone,
  Copy,
  Debug,
  Eq,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
pub struct FuzzySearchOptions {
  #[builder(default)]
  pub case_insensitive: bool,
  #[builder(default = true)]
  pub whole_words: bool,
  #[builder(default)]
  pub normalize_diacritics: bool,
}

impl Default for FuzzySearchOptions {
  fn default() -> Self {
    Self {
      case_insensitive: false,
      whole_words: true,
      normalize_diacritics: false,
    }
  }
}

pub struct SearchIndex {
  slots: Vec<SearchSlot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SearchIndexFindResult {
  pub matches: Vec<SearchMatch>,
  pub stats: Vec<SearchIndexFindStats>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SearchIndexFindStats {
  pub slot: usize,
  pub subslot: Option<usize>,
  pub engine: SearchEngine,
  pub pattern: Option<u32>,
  pub pattern_count: usize,
  pub match_count: usize,
  pub elapsed_us: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SearchIndexBuildStats {
  pub slot: usize,
  pub subslot: Option<usize>,
  pub engine: SearchEngine,
  pub pattern: Option<u32>,
  pub pattern_count: usize,
  pub artifact_count: usize,
  pub artifact_bytes: usize,
  pub elapsed_us: u64,
}

pub(crate) struct SearchIndexBuildResult {
  pub index: SearchIndex,
  pub stats: Vec<SearchIndexBuildStats>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SearchIndexArtifacts {
  pub slots: Vec<text_search::PreparedTextSearchArtifacts>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SearchIndexArtifactsView<'a> {
  pub slots: Vec<text_search::PreparedTextSearchArtifactsView<'a>>,
}

impl SearchIndexArtifacts {
  pub fn to_bytes(&self) -> Result<Vec<u8>> {
    let mut writer = ArtifactWriter::new(
      SEARCH_INDEX_ARTIFACTS_HEADER,
      SEARCH_INDEX_ARTIFACTS_VERSION,
    );
    writer.write_len(self.slots.len(), "search_index.slots")?;
    for slot in &self.slots {
      let slot_bytes = slot.to_bytes().map_err(|error| search_error(&error))?;
      writer.write_len_prefixed_bytes("search_index.slot", &slot_bytes)?;
    }
    Ok(writer.into_bytes())
  }

  pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
    Ok(SearchIndexArtifactsView::from_bytes(bytes)?.into_owned())
  }

  #[must_use]
  pub fn as_view(&self) -> SearchIndexArtifactsView<'_> {
    SearchIndexArtifactsView {
      slots: self.slots.iter().map(|slot| slot.as_view()).collect(),
    }
  }
}

impl<'a> SearchIndexArtifactsView<'a> {
  pub fn from_bytes(bytes: &'a [u8]) -> Result<Self> {
    let mut reader = ArtifactReader::new(
      bytes,
      SEARCH_INDEX_ARTIFACTS_HEADER,
      SEARCH_INDEX_ARTIFACTS_VERSION,
      "search_index_artifacts",
    )?;
    let count = reader.read_usize()?;
    let mut slots = Vec::new();
    for _ in 0..count {
      slots.push(
        text_search::PreparedTextSearchArtifactsView::from_bytes(
          reader.read_len_prefixed_bytes()?,
        )
        .map_err(|error| search_error(&error))?,
      );
    }
    reader.finish()?;
    Ok(Self { slots })
  }

  #[must_use]
  pub fn into_owned(self) -> SearchIndexArtifacts {
    SearchIndexArtifacts {
      slots: self
        .slots
        .into_iter()
        .map(
          stella_text_search_core::PreparedTextSearchArtifactsView::into_owned,
        )
        .collect(),
    }
  }
}

struct SearchSlot {
  engine: SlotEngine,
  search: text_search::TextSearch,
  pattern_remap: PatternRemap,
}

#[derive(Clone, Copy)]
enum SlotEngine {
  Literal,
  Regex,
  Fuzzy,
}

enum PatternRemap {
  Identity { len: usize },
  Explicit(Vec<u32>),
}

struct SearchIndexParts {
  literals: Vec<text_search::PatternEntry>,
  literal_indexes: Vec<u32>,
  regex: Vec<text_search::PatternEntry>,
  regex_indexes: Vec<u32>,
  fuzzy: Vec<text_search::PatternEntry>,
  fuzzy_indexes: Vec<u32>,
}

struct SearchIndexArtifactCursor<'a> {
  slots: &'a [text_search::PreparedTextSearchArtifactsView<'a>],
  index: usize,
}

impl<'a> SearchIndexArtifactCursor<'a> {
  const fn new(
    slots: &'a [text_search::PreparedTextSearchArtifactsView<'a>],
  ) -> Self {
    Self { slots, index: 0 }
  }

  fn next(
    &mut self,
  ) -> Result<&'a text_search::PreparedTextSearchArtifactsView<'a>> {
    let index = self.index;
    let Some(artifacts) = self.slots.get(index) else {
      return Err(search_message(format!(
        "Missing prepared text-search artifact at slot {index}"
      )));
    };
    self.index = self.index.saturating_add(1);
    Ok(artifacts)
  }

  fn finish(&self) -> Result<()> {
    if self.index == self.slots.len() {
      return Ok(());
    }
    Err(search_message(format!(
      "Expected {} prepared text-search artifacts, got {}",
      self.index,
      self.slots.len()
    )))
  }
}

impl SearchIndex {
  pub fn new(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
  ) -> Result<Self> {
    let parts = partition_patterns(patterns)?;
    Ok(build_search_index_inner(parts, options, None, false)?.index)
  }

  pub(crate) fn new_with_build_stats(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
  ) -> Result<SearchIndexBuildResult> {
    let parts = partition_patterns(patterns)?;
    build_search_index_inner(parts, options, None, true)
  }

  pub fn prepare_artifacts(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
  ) -> Result<SearchIndexArtifacts> {
    let parts = partition_patterns(patterns)?;
    let mut slots = Vec::new();
    capture_slot_artifacts(
      &mut slots,
      parts.literals,
      literal_options(options.literal),
    )?;
    capture_regex_slot_artifacts(&mut slots, parts.regex, options.regex)?;
    capture_slot_artifacts(
      &mut slots,
      parts.fuzzy,
      fuzzy_options(options.fuzzy),
    )?;
    Ok(SearchIndexArtifacts { slots })
  }

  pub fn new_with_artifacts(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
    artifacts: &SearchIndexArtifacts,
  ) -> Result<Self> {
    let artifacts = artifacts.as_view();
    Self::new_with_artifacts_view(patterns, options, &artifacts)
  }

  pub fn new_with_artifacts_view(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
    artifacts: &SearchIndexArtifactsView<'_>,
  ) -> Result<Self> {
    if patterns.is_empty() && !artifacts.slots.is_empty() {
      return Ok(
        Self::new_all_literal_with_artifacts(options, artifacts, false)?.index,
      );
    }

    let parts = partition_patterns(patterns)?;
    let mut cursor = SearchIndexArtifactCursor::new(&artifacts.slots);
    let search =
      build_search_index_inner(parts, options, Some(&mut cursor), false)?;
    cursor.finish()?;
    Ok(search.index)
  }

  pub(crate) fn new_with_artifacts_view_build_stats(
    patterns: Vec<SearchPattern>,
    options: SearchOptions,
    artifacts: &SearchIndexArtifactsView<'_>,
  ) -> Result<SearchIndexBuildResult> {
    if patterns.is_empty() && !artifacts.slots.is_empty() {
      return Self::new_all_literal_with_artifacts(options, artifacts, true);
    }

    let parts = partition_patterns(patterns)?;
    let mut cursor = SearchIndexArtifactCursor::new(&artifacts.slots);
    let search =
      build_search_index_inner(parts, options, Some(&mut cursor), true)?;
    cursor.finish()?;
    Ok(search)
  }

  fn new_all_literal_with_artifacts(
    options: SearchOptions,
    artifacts: &SearchIndexArtifactsView<'_>,
    collect_stats: bool,
  ) -> Result<SearchIndexBuildResult> {
    let mut cursor = SearchIndexArtifactCursor::new(&artifacts.slots);
    let slot_artifacts = cursor.next()?;
    let (search, stats) = if collect_stats {
      let result =
        text_search::TextSearch::with_prepared_all_literal_artifacts_view_build_stats(
          literal_options(options.literal),
          slot_artifacts,
        )
        .map_err(|error| search_error(&error))?;
      let stats = result
        .stats
        .into_iter()
        .map(|stat| search_index_build_stat(0, &stat, None))
        .collect();
      (result.search, stats)
    } else {
      (
        text_search::TextSearch::with_prepared_all_literal_artifacts_view(
          literal_options(options.literal),
          slot_artifacts,
        )
        .map_err(|error| search_error(&error))?,
        Vec::new(),
      )
    };
    let pattern_count = search.len();
    cursor.finish()?;
    Ok(SearchIndexBuildResult {
      index: Self {
        slots: vec![SearchSlot {
          engine: SlotEngine::Literal,
          pattern_remap: PatternRemap::identity(pattern_count),
          search,
        }],
      },
      stats,
    })
  }

  pub fn find_iter(&self, haystack: &str) -> Result<Vec<SearchMatch>> {
    Ok(self.find_iter_inner(haystack, false)?.matches)
  }

  pub(crate) fn find_iter_with_stats(
    &self,
    haystack: &str,
  ) -> Result<SearchIndexFindResult> {
    self.find_iter_inner(haystack, true)
  }

  fn find_iter_inner(
    &self,
    haystack: &str,
    collect_stats: bool,
  ) -> Result<SearchIndexFindResult> {
    let mut matches = Vec::new();
    let mut stats = if collect_stats {
      Vec::with_capacity(self.slots.len())
    } else {
      Vec::new()
    };
    for (slot_index, slot) in self.slots.iter().enumerate() {
      let start = collect_stats.then(Instant::now);
      let (slot_matches, child_stats) = if collect_stats {
        let result = slot
          .search
          .find_iter_with_stats(haystack)
          .map_err(|error| search_error(&error))?;
        (result.matches, result.stats)
      } else {
        (
          slot
            .search
            .find_iter(haystack)
            .map_err(|error| search_error(&error))?,
          Vec::new(),
        )
      };
      if let Some(start) = start {
        let mapped_child_stats = child_stats
          .into_iter()
          .map(|stat| search_index_find_stat(slot_index, slot, &stat))
          .collect::<Vec<_>>();
        if mapped_child_stats.is_empty() {
          stats.push(SearchIndexFindStats {
            slot: slot_index,
            subslot: None,
            engine: SearchEngine::from(slot.engine),
            pattern: None,
            pattern_count: slot.pattern_remap.len(),
            match_count: slot_matches.len(),
            elapsed_us: elapsed_us(start),
          });
        } else {
          stats.extend(mapped_child_stats);
        }
      }
      for found in slot_matches {
        let pattern = remap_pattern(slot, found.pattern)?;
        matches.push(match slot.engine {
          SlotEngine::Literal => SearchMatch::Literal {
            pattern,
            start: found.start,
            end: found.end,
          },
          SlotEngine::Regex => SearchMatch::Regex {
            pattern,
            start: found.start,
            end: found.end,
          },
          SlotEngine::Fuzzy => SearchMatch::Fuzzy {
            pattern,
            start: found.start,
            end: found.end,
            distance: found.distance.unwrap_or(0),
          },
        });
      }
    }

    if self.slots.len() > 1 {
      matches.sort_by(|left, right| {
        left
          .start()
          .cmp(&right.start())
          .then_with(|| left.end().cmp(&right.end()))
          .then_with(|| left.pattern().cmp(&right.pattern()))
      });
    }
    Ok(SearchIndexFindResult { matches, stats })
  }

  pub fn is_match(&self, haystack: &str) -> Result<bool> {
    for slot in &self.slots {
      if slot
        .search
        .is_match(haystack)
        .map_err(|error| search_error(&error))?
      {
        return Ok(true);
      }
    }

    Ok(false)
  }

  pub fn warm_lazy_regex(&self) -> Result<()> {
    for slot in &self.slots {
      slot
        .search
        .warm_lazy_regex()
        .map_err(|error| search_error(&error))?;
    }
    Ok(())
  }

  #[must_use]
  pub fn len(&self) -> usize {
    self
      .slots
      .iter()
      .map(|slot| slot.pattern_remap.len())
      .fold(0usize, usize::saturating_add)
  }

  #[must_use]
  pub fn is_empty(&self) -> bool {
    self.slots.iter().all(|slot| slot.pattern_remap.is_empty())
  }
}

fn partition_patterns(
  patterns: Vec<SearchPattern>,
) -> Result<SearchIndexParts> {
  let mut literals = Vec::new();
  let mut literal_indexes = Vec::new();
  let mut regex = Vec::new();
  let mut regex_indexes = Vec::new();
  let mut fuzzy = Vec::new();
  let mut fuzzy_indexes = Vec::new();

  for (index, entry) in patterns.into_iter().enumerate() {
    let pattern_index = pattern_index(index)?;
    match entry {
      SearchPattern::Literal(pattern) => {
        literals.push(text_search::PatternEntry::Auto(pattern));
        literal_indexes.push(pattern_index);
      }
      SearchPattern::LiteralWithOptions {
        pattern,
        case_insensitive,
        whole_words,
      } => {
        literals.push(text_search::PatternEntry::Literal(
          text_search::LiteralPattern {
            pattern,
            name: None,
            case_insensitive,
            whole_words,
          },
        ));
        literal_indexes.push(pattern_index);
      }
      SearchPattern::Regex(pattern) => {
        regex.push(text_search::PatternEntry::Regex(
          text_search::RegexPattern::new(pattern),
        ));
        regex_indexes.push(pattern_index);
      }
      SearchPattern::RegexWithOptions {
        pattern,
        lazy,
        prefilter_any,
        prefilter_case_insensitive,
        prefilter_regex,
        prefilter_window_bytes,
        prepared_artifact_policy,
      } => {
        let mut regex_pattern = text_search::RegexPattern::new(pattern);
        regex_pattern.lazy = lazy;
        regex_pattern.prefilter_any = prefilter_any;
        regex_pattern.prefilter_case_insensitive = prefilter_case_insensitive;
        regex_pattern.prefilter_regex = prefilter_regex;
        regex_pattern.prefilter_window_bytes = prefilter_window_bytes;
        regex_pattern.prepared_artifact_policy =
          text_search_prepared_artifact_policy(prepared_artifact_policy);
        regex.push(text_search::PatternEntry::Regex(regex_pattern));
        regex_indexes.push(pattern_index);
      }
      SearchPattern::Fuzzy { pattern, distance } => {
        fuzzy.push(text_search::PatternEntry::Fuzzy(
          text_search::FuzzyPattern::new(
            pattern,
            distance.map_or(
              text_search::FuzzyDistance::Auto,
              text_search::FuzzyDistance::Exact,
            ),
          ),
        ));
        fuzzy_indexes.push(pattern_index);
      }
    }
  }

  Ok(SearchIndexParts {
    literals,
    literal_indexes,
    regex,
    regex_indexes,
    fuzzy,
    fuzzy_indexes,
  })
}

const fn text_search_prepared_artifact_policy(
  value: Option<PreparedArtifactPolicy>,
) -> text_search::PreparedArtifactPolicy {
  match value {
    Some(PreparedArtifactPolicy::Include) => {
      text_search::PreparedArtifactPolicy::Include
    }
    Some(PreparedArtifactPolicy::Omit) => {
      text_search::PreparedArtifactPolicy::Omit
    }
    None => text_search::PreparedArtifactPolicy::Inherit,
  }
}

fn build_search_index_inner(
  parts: SearchIndexParts,
  options: SearchOptions,
  mut artifacts: Option<&mut SearchIndexArtifactCursor<'_>>,
  collect_stats: bool,
) -> Result<SearchIndexBuildResult> {
  let mut slots = Vec::new();
  let mut collected_stats = Vec::new();
  {
    let mut stats = collect_stats.then_some(&mut collected_stats);
    let literal_artifacts = slot_artifacts(&parts.literals, &mut artifacts)?;
    push_slot(
      &mut slots,
      SlotEngine::Literal,
      parts.literals,
      parts.literal_indexes,
      literal_options(options.literal),
      literal_artifacts,
      stats.as_deref_mut(),
    )?;
    push_regex_slots(
      &mut slots,
      parts.regex,
      parts.regex_indexes,
      options.regex,
      &mut artifacts,
      stats.as_deref_mut(),
    )?;
    let fuzzy_artifacts = slot_artifacts(&parts.fuzzy, &mut artifacts)?;
    push_slot(
      &mut slots,
      SlotEngine::Fuzzy,
      parts.fuzzy,
      parts.fuzzy_indexes,
      fuzzy_options(options.fuzzy),
      fuzzy_artifacts,
      stats,
    )?;
  }
  Ok(SearchIndexBuildResult {
    index: SearchIndex { slots },
    stats: collected_stats,
  })
}

fn slot_artifacts<'a>(
  patterns: &[text_search::PatternEntry],
  artifacts: &mut Option<&mut SearchIndexArtifactCursor<'a>>,
) -> Result<Option<&'a text_search::PreparedTextSearchArtifactsView<'a>>> {
  if patterns.is_empty() {
    return Ok(None);
  }
  let Some(cursor) = artifacts else {
    return Ok(None);
  };
  cursor.next().map(Some)
}

fn capture_regex_slot_artifacts(
  slots: &mut Vec<text_search::PreparedTextSearchArtifacts>,
  patterns: Vec<text_search::PatternEntry>,
  options: RegexSearchOptions,
) -> Result<()> {
  capture_slot_artifacts(slots, patterns, regex_options(options))
}

fn push_regex_slots(
  slots: &mut Vec<SearchSlot>,
  patterns: Vec<text_search::PatternEntry>,
  pattern_indexes: Vec<u32>,
  options: RegexSearchOptions,
  artifacts: &mut Option<&mut SearchIndexArtifactCursor<'_>>,
  stats: Option<&mut Vec<SearchIndexBuildStats>>,
) -> Result<()> {
  let regex_artifacts = slot_artifacts(&patterns, artifacts)?;
  push_slot(
    slots,
    SlotEngine::Regex,
    patterns,
    pattern_indexes,
    regex_options(options),
    regex_artifacts,
    stats,
  )
}

fn push_slot(
  slots: &mut Vec<SearchSlot>,
  engine: SlotEngine,
  patterns: Vec<text_search::PatternEntry>,
  pattern_indexes: Vec<u32>,
  options: text_search::TextSearchOptions,
  artifacts: Option<&text_search::PreparedTextSearchArtifactsView<'_>>,
  stats: Option<&mut Vec<SearchIndexBuildStats>>,
) -> Result<()> {
  if patterns.is_empty() {
    return Ok(());
  }

  let slot = slots.len();
  let pattern_count = pattern_indexes.len();
  let artifact_count = artifacts.map_or(0, prepared_artifact_count);
  let artifact_bytes = artifacts.map_or(0, prepared_artifact_bytes);
  let collect_stats = stats.is_some();
  let start = collect_stats.then(Instant::now);
  let (search, child_stats) = if collect_stats {
    let result = if let Some(artifacts) = artifacts {
      text_search::TextSearch::with_prepared_artifacts_view_build_stats(
        patterns, options, artifacts,
      )
    } else {
      text_search::TextSearch::new_with_build_stats(patterns, options)
    }
    .map_err(|error| search_error(&error))?;
    (result.search, result.stats)
  } else if let Some(artifacts) = artifacts {
    (
      text_search::TextSearch::with_prepared_artifacts_view(
        patterns, options, artifacts,
      )
      .map_err(|error| search_error(&error))?,
      Vec::new(),
    )
  } else {
    (
      text_search::TextSearch::new(patterns, options)
        .map_err(|error| search_error(&error))?,
      Vec::new(),
    )
  };
  let mapped_child_stats = child_stats
    .into_iter()
    .map(|stat| search_index_build_stat(slot, &stat, Some(&pattern_indexes)))
    .collect::<Vec<_>>();
  slots.push(SearchSlot {
    engine,
    search,
    pattern_remap: PatternRemap::from_indexes(pattern_indexes),
  });
  if let (Some(stats), Some(start)) = (stats, start) {
    if mapped_child_stats.is_empty() {
      stats.push(SearchIndexBuildStats {
        slot,
        subslot: None,
        engine: SearchEngine::from(engine),
        pattern: None,
        pattern_count,
        artifact_count,
        artifact_bytes,
        elapsed_us: elapsed_us(start),
      });
    } else {
      stats.extend(mapped_child_stats);
    }
  }
  Ok(())
}

fn search_index_find_stat(
  slot: usize,
  search_slot: &SearchSlot,
  stat: &text_search::FindStats,
) -> SearchIndexFindStats {
  SearchIndexFindStats {
    slot,
    subslot: stat.subslot.or(Some(stat.slot)),
    engine: search_engine_from_text_kind(stat.engine),
    pattern: stat
      .first_pattern
      .and_then(|pattern| search_slot.pattern_remap.get(pattern)),
    pattern_count: stat.pattern_count,
    match_count: stat.match_count,
    elapsed_us: stat.elapsed_us,
  }
}

fn search_index_build_stat(
  slot: usize,
  stat: &text_search::BuildStats,
  pattern_indexes: Option<&[u32]>,
) -> SearchIndexBuildStats {
  SearchIndexBuildStats {
    slot,
    subslot: Some(stat.slot),
    engine: search_engine_from_text_kind(stat.engine),
    pattern: stat
      .first_pattern
      .and_then(|pattern| remap_build_pattern(pattern_indexes, pattern)),
    pattern_count: stat.pattern_count,
    artifact_count: stat
      .aho_artifact_count
      .saturating_add(stat.regex_artifact_count),
    artifact_bytes: stat
      .aho_artifact_bytes
      .saturating_add(stat.regex_artifact_bytes),
    elapsed_us: stat.elapsed_us,
  }
}

fn remap_build_pattern(
  pattern_indexes: Option<&[u32]>,
  pattern: u32,
) -> Option<u32> {
  let Some(pattern_indexes) = pattern_indexes else {
    return Some(pattern);
  };
  let Ok(index) = usize::try_from(pattern) else {
    return None;
  };
  pattern_indexes.get(index).copied()
}

const fn search_engine_from_text_kind(
  kind: text_search::EngineKind,
) -> SearchEngine {
  match kind {
    text_search::EngineKind::Literal
    | text_search::EngineKind::SplitLiteral => SearchEngine::Literal,
    text_search::EngineKind::Regex => SearchEngine::Regex,
    text_search::EngineKind::Fuzzy => SearchEngine::Fuzzy,
  }
}

const fn prepared_artifact_count(
  artifacts: &text_search::PreparedTextSearchArtifactsView<'_>,
) -> usize {
  artifacts
    .aho_automata
    .len()
    .saturating_add(artifacts.regex_sets.len())
}

fn prepared_artifact_bytes(
  artifacts: &text_search::PreparedTextSearchArtifactsView<'_>,
) -> usize {
  artifacts
    .aho_automata
    .iter()
    .map(|artifact| artifact.bytes.len())
    .chain(
      artifacts
        .regex_sets
        .iter()
        .map(|artifact| artifact.bytes.len()),
    )
    .fold(0usize, usize::saturating_add)
}

fn capture_slot_artifacts(
  slots: &mut Vec<text_search::PreparedTextSearchArtifacts>,
  patterns: Vec<text_search::PatternEntry>,
  options: text_search::TextSearchOptions,
) -> Result<()> {
  if patterns.is_empty() {
    return Ok(());
  }
  slots.push(
    text_search::TextSearch::prepare_artifacts(patterns, options)
      .map_err(|error| search_error(&error))?,
  );
  Ok(())
}

fn literal_options(
  options: LiteralSearchOptions,
) -> text_search::TextSearchOptions {
  text_search::TextSearchOptions {
    case_insensitive: options.case_insensitive,
    whole_words: options.whole_words,
    overlap_strategy: text_search::OverlapStrategy::All,
    all_literal: true,
    ..text_search::TextSearchOptions::default()
  }
}

fn regex_options(
  options: RegexSearchOptions,
) -> text_search::TextSearchOptions {
  text_search::TextSearchOptions {
    whole_words: options.whole_words,
    regex_artifact_policy: match options.artifact_policy {
      RegexArtifactPolicy::Include => text_search::RegexArtifactPolicy::Include,
      RegexArtifactPolicy::Omit => text_search::RegexArtifactPolicy::Omit,
    },
    overlap_strategy: if options.overlap_all {
      text_search::OverlapStrategy::All
    } else {
      text_search::OverlapStrategy::Longest
    },
    ..text_search::TextSearchOptions::default()
  }
}

fn fuzzy_options(
  options: FuzzySearchOptions,
) -> text_search::TextSearchOptions {
  text_search::TextSearchOptions {
    case_insensitive: options.case_insensitive,
    whole_words: options.whole_words,
    normalize_diacritics: options.normalize_diacritics,
    ..text_search::TextSearchOptions::default()
  }
}

fn remap_pattern(slot: &SearchSlot, local_pattern: u32) -> Result<u32> {
  slot
    .pattern_remap
    .get(local_pattern)
    .ok_or_else(|| Error::Search {
      engine: slot.engine.into(),
      reason: format!("Missing pattern map entry for {local_pattern}"),
    })
}

fn search_error(error: &text_search::Error) -> Error {
  search_message(error.to_string())
}

const fn search_message(reason: String) -> Error {
  Error::Search {
    engine: SearchEngine::Text,
    reason,
  }
}

fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}

impl From<SlotEngine> for SearchEngine {
  fn from(value: SlotEngine) -> Self {
    match value {
      SlotEngine::Literal => Self::Literal,
      SlotEngine::Regex => Self::Regex,
      SlotEngine::Fuzzy => Self::Fuzzy,
    }
  }
}

fn pattern_index(index: usize) -> Result<u32> {
  u32::try_from(index).map_err(|_| Error::PatternIndexOutOfRange { index })
}

impl PatternRemap {
  const fn identity(len: usize) -> Self {
    Self::Identity { len }
  }

  fn from_indexes(indexes: Vec<u32>) -> Self {
    if indexes
      .iter()
      .enumerate()
      .all(|(index, value)| *value == u32::try_from(index).unwrap_or(u32::MAX))
    {
      return Self::Identity { len: indexes.len() };
    }
    Self::Explicit(indexes)
  }

  const fn len(&self) -> usize {
    match self {
      Self::Identity { len } => *len,
      Self::Explicit(indexes) => indexes.len(),
    }
  }

  const fn is_empty(&self) -> bool {
    self.len() == 0
  }

  fn get(&self, local_pattern: u32) -> Option<u32> {
    let index = usize::try_from(local_pattern).ok()?;
    match self {
      Self::Identity { len } => (index < *len).then_some(local_pattern),
      Self::Explicit(indexes) => indexes.get(index).copied(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::PatternRemap;

  #[test]
  fn pattern_remap_uses_identity_for_contiguous_indexes() {
    let remap = PatternRemap::from_indexes(vec![0, 1, 2]);

    assert_eq!(remap.len(), 3);
    assert_eq!(remap.get(2), Some(2));
    assert_eq!(remap.get(3), None);
  }

  #[test]
  fn pattern_remap_keeps_explicit_non_contiguous_indexes() {
    let remap = PatternRemap::from_indexes(vec![2, 4]);

    assert_eq!(remap.len(), 2);
    assert_eq!(remap.get(0), Some(2));
    assert_eq!(remap.get(1), Some(4));
    assert_eq!(remap.get(2), None);
  }
}
