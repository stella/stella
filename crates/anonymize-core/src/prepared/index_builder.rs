use web_time::Instant;

use crate::search::{
  SearchIndex, SearchIndexArtifactsView, SearchIndexBuildStats, SearchOptions,
  SearchPattern,
};
use crate::types::{Error, Result};

use super::artifacts::PreparedEngineArtifactsView;
use super::index_patterns::{
  legal_form_search_options, trigger_search_options,
};
use super::timing::elapsed_us;

pub(super) struct TimedSearchIndex {
  pub(super) index: SearchIndex,
  pub(super) elapsed_us: u64,
  pub(super) stats: Vec<SearchIndexBuildStats>,
}

pub(super) struct PreparedEngineIndexes {
  pub(super) regex: TimedSearchIndex,
  pub(super) custom_regex: TimedSearchIndex,
  pub(super) legal_forms: TimedSearchIndex,
  pub(super) triggers: TimedSearchIndex,
  pub(super) literals: TimedSearchIndex,
}

pub(super) struct SearchIndexBuildInputs {
  pub(super) regex_patterns: Vec<SearchPattern>,
  pub(super) regex_options: SearchOptions,
  pub(super) custom_regex_patterns: Vec<SearchPattern>,
  pub(super) custom_regex_options: SearchOptions,
  pub(super) legal_form_patterns: Vec<SearchPattern>,
  pub(super) trigger_patterns: Vec<SearchPattern>,
  pub(super) literal_patterns: Vec<SearchPattern>,
  pub(super) literal_options: SearchOptions,
}

pub(super) fn build_search_indexes(
  inputs: SearchIndexBuildInputs,
  artifacts: Option<&PreparedEngineArtifactsView<'_>>,
  collect_stats: bool,
) -> Result<PreparedEngineIndexes> {
  let SearchIndexBuildInputs {
    regex_patterns,
    regex_options,
    custom_regex_patterns,
    custom_regex_options,
    legal_form_patterns,
    trigger_patterns,
    literal_patterns,
    literal_options,
  } = inputs;

  let regex_artifacts = artifacts.map(|value| &value.regex);
  let custom_regex_artifacts = artifacts.map(|value| &value.custom_regex);
  let legal_form_artifacts = artifacts.map(|value| &value.legal_forms);
  let trigger_artifacts = artifacts.map(|value| &value.triggers);
  let literal_artifacts = artifacts.map(|value| &value.literals);

  crate::exec::scope(|scope| {
    let regex = scope.spawn(move || {
      build_search_index(
        regex_patterns,
        regex_options,
        regex_artifacts,
        collect_stats,
      )
    });
    let custom_regex = scope.spawn(move || {
      build_search_index(
        custom_regex_patterns,
        custom_regex_options,
        custom_regex_artifacts,
        collect_stats,
      )
    });
    let legal_forms = scope.spawn(move || {
      build_search_index(
        legal_form_patterns,
        legal_form_search_options(),
        legal_form_artifacts,
        collect_stats,
      )
    });
    let triggers = scope.spawn(move || {
      build_search_index(
        trigger_patterns,
        trigger_search_options(),
        trigger_artifacts,
        collect_stats,
      )
    });
    let literals = scope.spawn(move || {
      build_search_index(
        literal_patterns,
        literal_options,
        literal_artifacts,
        collect_stats,
      )
    });

    Ok(PreparedEngineIndexes {
      regex: join_search_index(regex, "regex")?,
      custom_regex: join_search_index(custom_regex, "custom_regex")?,
      legal_forms: join_search_index(legal_forms, "legal_forms")?,
      triggers: join_search_index(triggers, "triggers")?,
      literals: join_search_index(literals, "literals")?,
    })
  })
}

fn build_search_index(
  patterns: Vec<SearchPattern>,
  options: SearchOptions,
  artifacts: Option<&SearchIndexArtifactsView<'_>>,
  collect_stats: bool,
) -> Result<TimedSearchIndex> {
  let start = Instant::now();
  let (index, stats) = if collect_stats {
    let result = if let Some(artifacts) = artifacts {
      SearchIndex::new_with_artifacts_view_build_stats(
        patterns, options, artifacts,
      )?
    } else {
      SearchIndex::new_with_build_stats(patterns, options)?
    };
    (result.index, result.stats)
  } else if let Some(artifacts) = artifacts {
    (
      SearchIndex::new_with_artifacts_view(patterns, options, artifacts)?,
      Vec::new(),
    )
  } else {
    (SearchIndex::new(patterns, options)?, Vec::new())
  };
  Ok(TimedSearchIndex {
    index,
    elapsed_us: elapsed_us(start),
    stats,
  })
}

fn join_search_index(
  handle: crate::exec::JoinHandle<'_, Result<TimedSearchIndex>>,
  field: &'static str,
) -> Result<TimedSearchIndex> {
  handle.join().map_err(|_| Error::InvalidStaticData {
    field,
    reason: "search index builder panicked".to_owned(),
  })?
}
