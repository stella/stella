use web_time::Instant;

use crate::diagnostics::{DiagnosticStage, StaticRedactionDiagnostics};
use crate::normalize::{
  NormalizedSearchText, normalize_for_search_with_byte_map,
};
use crate::types::{Result, SearchMatch};

use super::PreparedEngine;
use super::results::PreparedEngineMatches;
use super::search_matcher::{
  combine_regex_matches, join_optional_timed_match_handle,
  normalized_index_matches, offset_index_matches,
  timed_normalized_index_matches, timed_offset_index_matches,
};
use super::timing::{TimedMatches, TimedSearchBranches, elapsed_us};

const PARALLEL_SEARCH_MIN_BYTES: usize = 32 * 1024;

impl PreparedEngine {
  pub fn find_matches(&self, full_text: &str) -> Result<PreparedEngineMatches> {
    self.find_matches_inner(full_text, None)
  }

  pub(super) fn find_matches_inner(
    &self,
    full_text: &str,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
  ) -> Result<PreparedEngineMatches> {
    let total_start = Instant::now();
    let normalized = normalize_search_text(full_text, &mut diagnostics)?;
    if full_text.len() >= PARALLEL_SEARCH_MIN_BYTES {
      return self.find_matches_parallel(
        full_text,
        &normalized,
        diagnostics,
        total_start,
      );
    }

    self.find_matches_sequential(
      full_text,
      &normalized,
      diagnostics,
      total_start,
    )
  }

  fn find_matches_sequential(
    &self,
    full_text: &str,
    normalized: &NormalizedSearchText,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    total_start: Instant,
  ) -> Result<PreparedEngineMatches> {
    let regex_start = Instant::now();
    let regex = offset_index_matches(
      &self.indexes.regex,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindRegex,
      full_text.len(),
      self.policy.slices.regex.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchRegex,
      &regex,
      full_text,
      regex_start,
    );

    let legal_form_start = Instant::now();
    let legal_forms = normalized_index_matches(
      &self.indexes.legal_forms,
      normalized,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindLegalForm,
      full_text.len(),
      self.policy.slices.legal_forms.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchLegalForm,
      &legal_forms,
      full_text,
      legal_form_start,
    );

    let trigger_start = Instant::now();
    let triggers = offset_index_matches(
      &self.indexes.triggers,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindTrigger,
      full_text.len(),
      self.policy.slices.triggers.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchTrigger,
      &triggers,
      full_text,
      trigger_start,
    );

    let custom_regex_start = Instant::now();
    let custom_regex = offset_index_matches(
      &self.indexes.custom_regex,
      full_text,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindCustomRegex,
      full_text.len(),
      self.policy.slices.custom_regex.start,
    )?;
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchCustomRegex,
      &custom_regex,
      full_text,
      custom_regex_start,
    );

    let literal_start = Instant::now();
    let literal = normalized_index_matches(
      &self.indexes.literals,
      normalized,
      diagnostics.as_deref_mut(),
      DiagnosticStage::FindLiteral,
      full_text.len(),
      0,
    )?;
    let regex = combine_regex_matches(regex, legal_forms, triggers);
    record_search_matches(
      &mut diagnostics,
      DiagnosticStage::SearchLiteral,
      &literal,
      full_text,
      literal_start,
    );
    record_find_matches_summary(
      &mut diagnostics,
      &regex,
      &custom_regex,
      &literal,
      full_text,
      total_start,
    );

    Ok(PreparedEngineMatches {
      regex,
      custom_regex,
      literal,
    })
  }

  fn find_matches_parallel(
    &self,
    full_text: &str,
    normalized: &NormalizedSearchText,
    mut diagnostics: Option<&mut StaticRedactionDiagnostics>,
    total_start: Instant,
  ) -> Result<PreparedEngineMatches> {
    let collect_stats = diagnostics.is_some();
    let matches = crate::exec::scope(|scope| {
      let regex = (!self.indexes.regex.is_empty()).then(|| {
        scope.spawn(|| {
          timed_offset_index_matches(
            &self.indexes.regex,
            full_text,
            self.policy.slices.regex.start,
            collect_stats,
          )
        })
      });
      let legal_forms = (!self.indexes.legal_forms.is_empty()).then(|| {
        scope.spawn(|| {
          timed_normalized_index_matches(
            &self.indexes.legal_forms,
            normalized,
            self.policy.slices.legal_forms.start,
            collect_stats,
          )
        })
      });
      let triggers = (!self.indexes.triggers.is_empty()).then(|| {
        scope.spawn(|| {
          timed_offset_index_matches(
            &self.indexes.triggers,
            full_text,
            self.policy.slices.triggers.start,
            collect_stats,
          )
        })
      });
      let custom_regex = (!self.indexes.custom_regex.is_empty()).then(|| {
        scope.spawn(|| {
          timed_offset_index_matches(
            &self.indexes.custom_regex,
            full_text,
            self.policy.slices.custom_regex.start,
            collect_stats,
          )
        })
      });
      let literal = (!self.indexes.literals.is_empty()).then(|| {
        scope.spawn(|| {
          timed_normalized_index_matches(
            &self.indexes.literals,
            normalized,
            0,
            collect_stats,
          )
        })
      });

      let regex = join_optional_timed_match_handle(regex, "regex")?;
      let legal_forms =
        join_optional_timed_match_handle(legal_forms, "legal_forms")?;
      let triggers = join_optional_timed_match_handle(triggers, "triggers")?;
      let custom_regex =
        join_optional_timed_match_handle(custom_regex, "custom_regex")?;
      let literal = join_optional_timed_match_handle(literal, "literals")?;

      Ok(finish_parallel_matches(
        &mut diagnostics,
        full_text,
        total_start,
        TimedSearchBranches {
          regex,
          legal_forms,
          triggers,
          custom_regex,
          literal,
        },
      ))
    })?;

    Ok(matches)
  }
}

fn normalize_search_text(
  full_text: &str,
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
) -> Result<NormalizedSearchText> {
  let start = Instant::now();
  let normalized = normalize_for_search_with_byte_map(full_text)?;
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_stage(
      DiagnosticStage::Normalize,
      None,
      Some(elapsed_us(start)),
      Some(full_text.len()),
    );
  }
  Ok(normalized)
}

fn record_search_matches(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  stage: DiagnosticStage,
  matches: &[SearchMatch],
  full_text: &str,
  start: Instant,
) {
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_search_matches(
      stage,
      matches,
      full_text,
      Some(elapsed_us(start)),
    );
  }
}

fn record_parallel_search_matches(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  stage: DiagnosticStage,
  matches: &TimedMatches,
  full_text: &str,
) {
  if let Some(diagnostics) = diagnostics {
    diagnostics.record_search_matches(
      stage,
      &matches.matches,
      full_text,
      Some(matches.elapsed_us),
    );
    diagnostics.record_search_slot_summaries(
      stage,
      &matches.stats,
      full_text.len(),
    );
  }
}

fn finish_parallel_matches(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  full_text: &str,
  total_start: Instant,
  branches: TimedSearchBranches,
) -> PreparedEngineMatches {
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchRegex,
    &branches.regex,
    full_text,
  );
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchLegalForm,
    &branches.legal_forms,
    full_text,
  );
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchTrigger,
    &branches.triggers,
    full_text,
  );
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchCustomRegex,
    &branches.custom_regex,
    full_text,
  );
  record_parallel_search_matches(
    diagnostics,
    DiagnosticStage::SearchLiteral,
    &branches.literal,
    full_text,
  );

  let regex = combine_regex_matches(
    branches.regex.matches,
    branches.legal_forms.matches,
    branches.triggers.matches,
  );
  record_find_matches_summary(
    diagnostics,
    &regex,
    &branches.custom_regex.matches,
    &branches.literal.matches,
    full_text,
    total_start,
  );

  PreparedEngineMatches {
    regex,
    custom_regex: branches.custom_regex.matches,
    literal: branches.literal.matches,
  }
}

fn record_find_matches_summary(
  diagnostics: &mut Option<&mut StaticRedactionDiagnostics>,
  regex: &[SearchMatch],
  custom_regex: &[SearchMatch],
  literal: &[SearchMatch],
  full_text: &str,
  start: Instant,
) {
  let Some(diagnostics) = diagnostics else {
    return;
  };
  diagnostics.record_stage(
    DiagnosticStage::FindMatches,
    Some(
      regex
        .len()
        .saturating_add(custom_regex.len())
        .saturating_add(literal.len()),
    ),
    Some(elapsed_us(start)),
    Some(full_text.len()),
  );
}
