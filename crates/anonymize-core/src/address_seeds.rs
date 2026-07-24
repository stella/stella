use std::{collections::BTreeSet, time::Instant};

use regex::Regex;

use crate::processors::PatternSlice;
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::search::{SearchIndex, SearchOptions, SearchPattern};
use crate::span_index::SpanIndex;
use crate::types::{Error, Result, SearchEngine, SearchMatch};

const ADDRESS_SCORE_BASE: f64 = 0.5;
const ADDRESS_SCORE_MAX: f64 = 0.95;
const ADDRESS_CLUSTER_MAX_GAP: usize = 150;
const ADDRESS_RIGHT_EXPAND_LIMIT: usize = 200;
const BR_CEP_CONTEXT_WINDOW: usize = 200;
const PLAIN_POSTAL_CONTEXT_WINDOW: usize = 120;
const US_ZIP_CONTEXT_WINDOW: usize = 120;

/// Lowercase connective particles that commonly sit inside street names
/// ("rue de la Paix", "van der Hoopstraat", "calle de los Reyes").
/// Deliberately a closed set: the delayed-house-number bridge in
/// `house_number_after_street_re` may only cross these particles plus a
/// single street-name word, so arbitrary prose ("rue is a French word
/// 12345") cannot connect a street word to a distant number.
const STREET_PARTICLE_ALTERNATION: &str = "de|del|della|delle|dei|degli|der\
|den|des|di|du|da|das|dos|do|el|al|la|le|les|las|los|van|von|ten|ter|op|aan\
|am|an|im|zum|zur";

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct AddressSeedData {
  #[serde(default)]
  pub boundary_words: Vec<String>,
  #[serde(default)]
  pub br_cep_cue_words: Vec<String>,
  #[serde(default)]
  pub unit_abbreviations: Vec<String>,
}

pub(crate) struct PreparedAddressSeedData {
  boundary_search: Option<SearchIndex>,
  boundary_phrase_re: Option<Regex>,
  br_cep_cue_search: Option<SearchIndex>,
  unit_abbreviations: BTreeSet<String>,
  postal_code_re: Regex,
  br_cep_shape_re: Regex,
  us_zip_plus_four_shape_re: Regex,
  us_state_before_zip_re: Regex,
  house_number_before_street_re: Regex,
  house_number_after_street_re: Regex,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct AddressSeedDetectionProfile {
  pub(crate) seed_count: usize,
  pub(crate) collect_elapsed_us: u64,
  pub(crate) street_type_seed_count: usize,
  pub(crate) street_type_elapsed_us: u64,
  pub(crate) existing_seed_count: usize,
  pub(crate) existing_elapsed_us: u64,
  pub(crate) street_number_seed_count: usize,
  pub(crate) street_number_elapsed_us: u64,
  pub(crate) postal_code_seed_count: usize,
  pub(crate) postal_code_elapsed_us: u64,
  pub(crate) italian_cap_seed_count: usize,
  pub(crate) italian_cap_elapsed_us: u64,
  pub(crate) cluster_count: usize,
  pub(crate) cluster_elapsed_us: u64,
  pub(crate) boundary_count: usize,
  pub(crate) boundary_elapsed_us: u64,
  pub(crate) expanded_count: usize,
  pub(crate) expand_elapsed_us: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct AddressSeedDetection {
  pub(crate) entities: Vec<PipelineEntity>,
  pub(crate) profile: AddressSeedDetectionProfile,
}

impl PreparedAddressSeedData {
  pub(crate) fn new(data: AddressSeedData) -> Result<Self> {
    let (boundary_search, boundary_phrase_re) =
      boundary_searches(data.boundary_words)?;
    Ok(Self {
      boundary_search,
      boundary_phrase_re,
      br_cep_cue_search: literal_search(data.br_cep_cue_words)?,
      unit_abbreviations: lowercased_set(data.unit_abbreviations),
      postal_code_re: compile_regex(
        r"(?u)(?:\d{5}[-‐‑‒–—―]\d{4}|\d{5}[-‐‑‒–—―]\d{3}|\d{3}\s\d{2}|\d{2}[-‐‑‒–—―]\d{3}|\d{5})",
      )?,
      br_cep_shape_re: compile_regex(r"(?u)^\d{5}[-‐‑‒–—―]\d{3}$")?,
      us_zip_plus_four_shape_re: compile_regex(r"(?u)^\d{5}[-‐‑‒–—―]\d{4}$")?,
      us_state_before_zip_re: compile_regex(
        r"(?u)(?:^|[^A-Za-z0-9])(?P<state>A[KLRZ]|C[AOT]|D[CE]|F[LM]|G[AU]|HI|I[ADLN]|K[SY]|LA|M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])\s*,?\s*$",
      )?,
      house_number_before_street_re: compile_regex(
        r"(?u)\b\d{1,6}(?:[-/]\d{1,6})?\s+(?:\p{Lu}\p{L}+[^\S\n\t]+){0,4}$",
      )?,
      // Mirrors `house_number_before_street_re`'s tolerance for a short run
      // of intervening words (e.g. "rue de la Paix 10", where the house
      // number trails the street word) instead of requiring the digits to
      // sit immediately after the street word. Like the "before" variant
      // (which only tolerates `\p{Lu}\p{L}+` words), the bridge is
      // restricted: up to three known street-name particles plus at most
      // one capitalized street-name word directly ahead of the number, so
      // ordinary prose ("rue is a French word 12345", "Road docket
      // 94304-1050") cannot supply house-number evidence.
      house_number_after_street_re: compile_regex(&format!(
        r"(?u)^[^\S\n\t]+(?:(?i:{STREET_PARTICLE_ALTERNATION})[^\S\n\t]+){{0,3}}(?:\p{{Lu}}\p{{L}}+[^\S\n\t]+)?\d{{1,6}}(?:[-/]\d{{1,6}})?\b"
      ))?,
    })
  }

  pub(crate) fn process_profiled(
    &self,
    matches: &[SearchMatch],
    street_type_slice: PatternSlice,
    full_text: &str,
    existing_entities: &[PipelineEntity],
  ) -> Result<AddressSeedDetection> {
    let mut profile = AddressSeedDetectionProfile::default();
    let entity_index = NonAddressEntityIndex::new(existing_entities);
    let collect_start = Instant::now();
    let seeds = self.collect_seeds_profiled(
      matches,
      street_type_slice,
      full_text,
      existing_entities,
      &entity_index,
      &mut profile,
    )?;
    profile.collect_elapsed_us = elapsed_us(collect_start);
    profile.seed_count = seeds.len();

    let cluster_start = Instant::now();
    let clusters = cluster_seeds(&seeds, full_text, &entity_index);
    profile.cluster_elapsed_us = elapsed_us(cluster_start);
    profile.cluster_count = clusters.len();

    if clusters.is_empty() {
      return Ok(AddressSeedDetection {
        entities: Vec::new(),
        profile,
      });
    }
    let mut boundary_starts = None;
    let mut results = Vec::new();

    for cluster in clusters {
      let score = score_cluster(&cluster);
      if score < 0.6 {
        continue;
      }
      let boundary_starts = if cluster.has_expandable_address_context() {
        if boundary_starts.is_none() {
          let boundary_start = Instant::now();
          let starts = self.boundary_starts(full_text);
          profile.boundary_elapsed_us = elapsed_us(boundary_start);
          profile.boundary_count = starts.len();
          boundary_starts = Some(starts);
        }
        boundary_starts.as_deref().unwrap_or_default()
      } else {
        &[]
      };
      let expand_start = Instant::now();
      let span = self.expand_cluster(
        full_text,
        &cluster,
        &entity_index,
        boundary_starts,
      );
      profile.expand_elapsed_us = profile
        .expand_elapsed_us
        .saturating_add(elapsed_us(expand_start));
      let Some(raw_text) = full_text.get(span.start..span.end) else {
        continue;
      };
      let resolution = resolve_newline_boundary(span.start, raw_text, &cluster);
      if resolution == NewlineBoundaryResolution::Drop {
        continue;
      }
      let relative_end = match resolution {
        NewlineBoundaryResolution::Keep => raw_text.len(),
        NewlineBoundaryResolution::Drop => 0,
        NewlineBoundaryResolution::Trim { relative_end } => relative_end,
      };
      let effective_raw = raw_text.get(..relative_end).unwrap_or_default();
      let leading = effective_raw
        .len()
        .saturating_sub(effective_raw.trim_start().len());
      let start = span.start.saturating_add(leading);
      let end = trim_address_tail(
        full_text,
        start,
        span.start.saturating_add(effective_raw.len()),
      );
      let effective_text = full_text.get(start..end).unwrap_or_default();
      let effective_len = text_units(effective_text);
      if !(5..=300).contains(&effective_len) {
        continue;
      }
      results.push(PipelineEntity::detected(
        u32::try_from(start).unwrap_or(u32::MAX),
        u32::try_from(end).unwrap_or(u32::MAX),
        "address",
        effective_text,
        score,
        DetectionSource::Regex,
      ));
    }
    profile.expanded_count = results.len();

    Ok(AddressSeedDetection {
      entities: results,
      profile,
    })
  }

  fn collect_seeds_profiled(
    &self,
    matches: &[SearchMatch],
    street_type_slice: PatternSlice,
    full_text: &str,
    existing_entities: &[PipelineEntity],
    entity_index: &NonAddressEntityIndex,
    profile: &mut AddressSeedDetectionProfile,
  ) -> Result<Vec<Seed>> {
    let street_type_start = Instant::now();
    let mut seeds =
      self.collect_street_type_seeds(matches, street_type_slice, full_text)?;
    profile.street_type_elapsed_us = elapsed_us(street_type_start);
    profile.street_type_seed_count = seeds.len();

    let existing_start = Instant::now();
    let before_existing = seeds.len();
    collect_existing_entity_seeds(
      &mut seeds,
      full_text,
      existing_entities,
      entity_index,
    );
    profile.existing_elapsed_us = elapsed_us(existing_start);
    profile.existing_seed_count = seeds.len().saturating_sub(before_existing);

    let street_number_start = Instant::now();
    let before_street_number = seeds.len();
    Self::collect_street_number_seeds(&mut seeds, full_text, entity_index);
    profile.street_number_elapsed_us = elapsed_us(street_number_start);
    profile.street_number_seed_count =
      seeds.len().saturating_sub(before_street_number);

    let postal_code_start = Instant::now();
    let before_postal_code = seeds.len();
    self.collect_postal_code_seeds(&mut seeds, full_text);
    profile.postal_code_elapsed_us = elapsed_us(postal_code_start);
    profile.postal_code_seed_count =
      seeds.len().saturating_sub(before_postal_code);

    let italian_cap_start = Instant::now();
    let before_italian_cap = seeds.len();
    Self::collect_italian_cap_seeds(&mut seeds, full_text);
    profile.italian_cap_elapsed_us = elapsed_us(italian_cap_start);
    profile.italian_cap_seed_count =
      seeds.len().saturating_sub(before_italian_cap);

    seeds.sort_by(compare_seeds);
    Ok(seeds)
  }

  fn collect_street_type_seeds(
    &self,
    matches: &[SearchMatch],
    street_type_slice: PatternSlice,
    full_text: &str,
  ) -> Result<Vec<Seed>> {
    let mut seeds = Vec::new();
    for found in matches {
      if street_type_slice.local_index(found.pattern()).is_none() {
        continue;
      }
      let Some(seed) = seed_from_match(full_text, found, SeedType::StreetWord)?
      else {
        continue;
      };
      if is_lowercase_street_word_in_prose(full_text, &seed, self) {
        continue;
      }
      seeds.push(seed);
    }
    Ok(seeds)
  }

  fn collect_postal_code_seeds(&self, seeds: &mut Vec<Seed>, full_text: &str) {
    seeds.sort_by(compare_seeds);
    let context_seed_count = seeds.len();
    let coverage = SeedCoverageIndex::new(seeds);
    // `find_iter` yields non-overlapping candidates in ascending order, so a
    // postal seed added here cannot cover a later candidate. State seeds are
    // taken from immediately before their ZIP+4 candidate, so one added for
    // an earlier candidate cannot cover or provide comma/whitespace-only
    // context for a later candidate either. Keep the immutable context slice
    // separate: the loop only appends State and PostalCode seeds, while the
    // ZIP+4 fallback ignores both kinds.
    for found in self.postal_code_re.find_iter(full_text) {
      let start = found.start();
      let end = found.end();
      let text = found.as_str();
      if !postal_boundaries(full_text, start, end) {
        continue;
      }
      let is_plain_five_digit = is_plain_five_digit_postal_code(text);
      if coverage.covers(start, end) && !is_plain_five_digit {
        continue;
      }
      if is_plain_five_digit
        && !self.has_plain_postal_context(
          full_text,
          start,
          end,
          seeds.get(..context_seed_count).unwrap_or_default(),
        )
      {
        continue;
      }
      if self.br_cep_shape_re.is_match(text)
        && !self.has_br_cue_nearby(full_text, start, end)
      {
        continue;
      }
      if self.us_zip_plus_four_shape_re.is_match(text) {
        let context = self.us_zip_plus_four_context(
          full_text,
          start,
          seeds.get(..context_seed_count).unwrap_or_default(),
        );
        if !context.has_context {
          continue;
        }
        if let Some(state_seed) = context.state_seed
          && !coverage.covers(state_seed.start, state_seed.end)
        {
          seeds.push(state_seed);
        }
      }
      seeds.push(Seed {
        kind: SeedType::PostalCode,
        start,
        end,
        text: text.to_owned(),
      });
    }
  }

  fn has_plain_postal_context(
    &self,
    full_text: &str,
    start: usize,
    end: usize,
    sorted_seeds: &[Seed],
  ) -> bool {
    seed_start_window(sorted_seeds, start, PLAIN_POSTAL_CONTEXT_WINDOW)
      .iter()
      .any(|seed| {
        within_text_window(
          full_text,
          seed.start,
          start,
          PLAIN_POSTAL_CONTEXT_WINDOW,
        ) && match seed.kind {
          SeedType::AddressTrigger => true,
          SeedType::City | SeedType::State => {
            seed.end >= start && seed.start <= end.saturating_add(4)
              || seed.end <= start
                && full_text.get(seed.end..start).is_some_and(is_city_zip_gap)
          }
          SeedType::StreetWord => {
            has_house_number_near_street_word(full_text, seed, self)
          }
          SeedType::PostalCode => false,
        }
      })
  }

  fn collect_italian_cap_seeds(seeds: &mut Vec<Seed>, full_text: &str) {
    if seeds.is_empty() {
      return;
    }
    for found in italian_cap_candidates(full_text) {
      if seed_covered(seeds, found.start, found.end) {
        continue;
      }
      if !has_nearby_italian_cap_evidence(full_text, seeds, found.start) {
        continue;
      }
      seeds.push(Seed {
        kind: SeedType::PostalCode,
        start: found.start,
        end: found.end,
        text: found.text.to_owned(),
      });
    }
  }

  fn collect_street_number_seeds(
    seeds: &mut Vec<Seed>,
    full_text: &str,
    entity_index: &NonAddressEntityIndex,
  ) {
    for found in street_number_candidates(full_text) {
      if entity_index.overlaps(found.start, found.end) {
        continue;
      }
      seeds.push(Seed {
        kind: SeedType::StreetWord,
        start: found.start,
        end: found.end,
        text: format!("{} {}", found.street, found.number),
      });
    }
  }

  fn has_br_cue_nearby(
    &self,
    full_text: &str,
    start: usize,
    end: usize,
  ) -> bool {
    let Some(search) = &self.br_cep_cue_search else {
      return false;
    };
    let window_start =
      offset_before_text_units(full_text, start, BR_CEP_CONTEXT_WINDOW);
    let window_end =
      offset_after_text_units(full_text, end, BR_CEP_CONTEXT_WINDOW);
    full_text
      .get(window_start..window_end)
      .is_some_and(|window| search.is_match(window).unwrap_or(false))
  }

  fn us_zip_plus_four_context(
    &self,
    full_text: &str,
    start: usize,
    seeds: &[Seed],
  ) -> UsZipPlusFourContext {
    if let Some(state_seed) = self.us_state_seed_before_zip(full_text, start) {
      return UsZipPlusFourContext {
        state_seed: Some(state_seed),
        has_context: true,
      };
    }

    let has_context = seed_start_window(seeds, start, US_ZIP_CONTEXT_WINDOW)
      .iter()
      .any(|seed| {
        within_text_window(full_text, seed.start, start, US_ZIP_CONTEXT_WINDOW)
          && match seed.kind {
            SeedType::AddressTrigger => true,
            SeedType::City => {
              seed.end <= start
                && full_text.get(seed.end..start).is_some_and(is_city_zip_gap)
            }
            SeedType::StreetWord => {
              has_house_number_near_street_word(full_text, seed, self)
            }
            SeedType::PostalCode | SeedType::State => false,
          }
      });

    UsZipPlusFourContext {
      state_seed: None,
      has_context,
    }
  }

  fn us_state_seed_before_zip(
    &self,
    full_text: &str,
    start: usize,
  ) -> Option<Seed> {
    let window_start = floor_char_boundary(full_text, start.saturating_sub(24));
    let window = full_text.get(window_start..start)?;
    let captures = self.us_state_before_zip_re.captures(window)?;
    let state = captures.name("state")?;
    Some(Seed {
      kind: SeedType::State,
      start: window_start.saturating_add(state.start()),
      end: window_start.saturating_add(state.end()),
      text: state.as_str().to_owned(),
    })
  }

  fn expand_cluster(
    &self,
    full_text: &str,
    cluster: &SeedCluster,
    entity_index: &NonAddressEntityIndex,
    boundary_starts: &[usize],
  ) -> Span {
    let left_bound = nearest_left_non_address(
      full_text,
      cluster.start,
      entity_index,
      cluster_starts_with_street_type_word(cluster),
    );
    let left_pos = expand_left(full_text, cluster.start, left_bound);
    if !cluster.has_expandable_address_context() {
      return Span {
        start: left_pos.min(cluster.start),
        end: cluster.end,
      };
    }

    let right_pos =
      self.expand_right(full_text, cluster, entity_index, boundary_starts);
    Span {
      start: left_pos.min(cluster.start),
      end: right_pos.max(cluster.end),
    }
  }

  fn expand_right(
    &self,
    full_text: &str,
    cluster: &SeedCluster,
    entity_index: &NonAddressEntityIndex,
    boundary_starts: &[usize],
  ) -> usize {
    let right_pos = cluster.end;
    let remaining = full_text.get(right_pos..).unwrap_or_default();
    let mut nearest_boundary =
      utf16_cap_at_char_boundary(remaining, ADDRESS_RIGHT_EXPAND_LIMIT);

    if let Some(boundary) =
      Self::nearest_boundary_word(right_pos, boundary_starts)
    {
      nearest_boundary = nearest_boundary.min(boundary);
    }
    if let Some(entity_boundary) = entity_index.nearest_right(right_pos) {
      nearest_boundary = nearest_boundary.min(entity_boundary);
    }
    if let Some(double_newline) = remaining.find("\n\n") {
      nearest_boundary = nearest_boundary.min(double_newline);
    }
    if let Some(sentence_boundary) =
      sentence_boundary(remaining, &self.unit_abbreviations)
    {
      nearest_boundary = nearest_boundary.min(sentence_boundary);
    }

    let end = right_pos.saturating_add(nearest_boundary);
    trim_address_tail(full_text, right_pos, end)
  }

  fn boundary_starts(&self, full_text: &str) -> Vec<usize> {
    let literal_starts = self
      .boundary_search
      .as_ref()
      .and_then(|search| search.find_iter(full_text).ok())
      .into_iter()
      .flatten()
      .filter_map(|found| usize::try_from(found.start()).ok())
      .collect::<Vec<_>>();
    let phrase_starts = self
      .boundary_phrase_re
      .as_ref()
      .into_iter()
      .flat_map(|phrase_re| phrase_re.find_iter(full_text))
      .map(|found| found.start())
      .collect::<Vec<_>>();
    merge_sorted_starts(literal_starts, phrase_starts)
  }

  fn nearest_boundary_word(
    right_pos: usize,
    boundary_starts: &[usize],
  ) -> Option<usize> {
    let index = boundary_starts.partition_point(|start| *start < right_pos);
    boundary_starts
      .get(index)
      .map(|start| start.saturating_sub(right_pos))
  }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum SeedType {
  StreetWord,
  PostalCode,
  City,
  State,
  AddressTrigger,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Seed {
  kind: SeedType,
  start: usize,
  end: usize,
  text: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct SeedCoverageIndex {
  starts: Vec<usize>,
  prefix_max_ends: Vec<usize>,
}

impl SeedCoverageIndex {
  fn new(sorted_seeds: &[Seed]) -> Self {
    let mut starts = Vec::with_capacity(sorted_seeds.len());
    let mut prefix_max_ends = Vec::with_capacity(sorted_seeds.len());
    let mut max_end = 0usize;
    for seed in sorted_seeds {
      starts.push(seed.start);
      max_end = max_end.max(seed.end);
      prefix_max_ends.push(max_end);
    }
    Self {
      starts,
      prefix_max_ends,
    }
  }

  fn covers(&self, start: usize, end: usize) -> bool {
    let count = self
      .starts
      .partition_point(|seed_start| *seed_start <= start);
    count
      .checked_sub(1)
      .and_then(|index| self.prefix_max_ends.get(index))
      .is_some_and(|max_end| *max_end >= end)
  }
}

fn compare_seeds(left: &Seed, right: &Seed) -> std::cmp::Ordering {
  left
    .start
    .cmp(&right.start)
    .then_with(|| left.end.cmp(&right.end))
    .then_with(|| left.kind.cmp(&right.kind))
}

fn seed_start_window(
  sorted_seeds: &[Seed],
  start: usize,
  max_units: usize,
) -> &[Seed] {
  // A Unicode scalar occupies at most four UTF-8 bytes per UTF-16 code unit,
  // so a seed outside this byte window cannot pass `within_text_window`.
  let max_byte_distance = max_units.saturating_mul(4);
  let range_start = start.saturating_sub(max_byte_distance);
  let range_end = start.saturating_add(max_byte_distance);
  let first = sorted_seeds.partition_point(|seed| seed.start < range_start);
  let last = sorted_seeds.partition_point(|seed| seed.start <= range_end);
  sorted_seeds.get(first..last).unwrap_or_default()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StreetNumberCandidate<'a> {
  start: usize,
  end: usize,
  street: &'a str,
  number: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ItalianCapCandidate<'a> {
  start: usize,
  end: usize,
  text: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SeedCluster {
  seeds: Vec<Seed>,
  start: usize,
  end: usize,
}

impl SeedCluster {
  fn has_expandable_address_context(&self) -> bool {
    self.seeds.iter().any(|seed| {
      matches!(
        seed.kind,
        SeedType::StreetWord | SeedType::PostalCode | SeedType::AddressTrigger
      )
    })
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Span {
  start: usize,
  end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct UsZipPlusFourContext {
  state_seed: Option<Seed>,
  has_context: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NewlineBoundaryResolution {
  Keep,
  Drop,
  Trim { relative_end: usize },
}

fn literal_search(patterns: Vec<String>) -> Result<Option<SearchIndex>> {
  let patterns = patterns
    .into_iter()
    .filter(|pattern| !pattern.is_empty())
    .map(|pattern| SearchPattern::LiteralWithOptions {
      pattern,
      case_insensitive: Some(true),
      whole_words: Some(true),
    })
    .collect::<Vec<_>>();
  if patterns.is_empty() {
    return Ok(None);
  }
  Ok(Some(SearchIndex::new(patterns, SearchOptions::default())?))
}

/// Keep single-token boundary words on the literal index, while compiling
/// multi-token phrases into one automaton whose separators accept one or more
/// Unicode whitespace characters. Regex matches retain byte offsets into the
/// original text, so wrapped legal prose needs no normalized text copy.
fn boundary_searches(
  patterns: Vec<String>,
) -> Result<(Option<SearchIndex>, Option<Regex>)> {
  let mut literals = Vec::new();
  let mut phrases = Vec::new();
  for pattern in patterns.into_iter().filter(|pattern| !pattern.is_empty()) {
    if pattern.split_whitespace().nth(1).is_some() {
      phrases.push(pattern);
    } else {
      literals.push(pattern);
    }
  }
  Ok((literal_search(literals)?, flexible_phrase_regex(&phrases)?))
}

fn flexible_phrase_regex(patterns: &[String]) -> Result<Option<Regex>> {
  let mut groups: [Vec<String>; 4] = std::array::from_fn(|_| Vec::new());
  for pattern in patterns {
    let tokens = pattern.split_whitespace().collect::<Vec<_>>();
    let Some((first, last)) = tokens
      .first()
      .and_then(|token| token.chars().next())
      .zip(tokens.last().and_then(|token| token.chars().next_back()))
    else {
      continue;
    };
    let group = match (
      is_regex_word_character(first),
      is_regex_word_character(last),
    ) {
      (false, false) => 0,
      (false, true) => 1,
      (true, false) => 2,
      (true, true) => 3,
    };
    if let Some(group) = groups.get_mut(group) {
      group.push(
        tokens
          .into_iter()
          .map(regex::escape)
          .collect::<Vec<_>>()
          .join(r"\s+"),
      );
    }
  }
  let alternatives = groups
    .into_iter()
    .enumerate()
    .filter(|(_, group)| !group.is_empty())
    .map(|(edge_shape, group)| {
      let leading_boundary = if edge_shape & 2 == 2 { r"\b" } else { "" };
      let trailing_boundary = if edge_shape & 1 == 1 {
        r"\b"
      } else {
        r"(?:$|[^\w])"
      };
      format!(
        "{leading_boundary}(?:{}){trailing_boundary}",
        group.join("|")
      )
    })
    .collect::<Vec<_>>();
  if alternatives.is_empty() {
    return Ok(None);
  }
  compile_regex(&format!(r"(?iu)(?:{})", alternatives.join("|"))).map(Some)
}

fn is_regex_word_character(character: char) -> bool {
  character.is_alphanumeric() || character == '_'
}

fn merge_sorted_starts(left: Vec<usize>, right: Vec<usize>) -> Vec<usize> {
  let mut starts = Vec::with_capacity(left.len().saturating_add(right.len()));
  let mut left = left.into_iter().peekable();
  let mut right = right.into_iter().peekable();
  while left.peek().is_some() || right.peek().is_some() {
    let next = match (left.peek(), right.peek()) {
      (Some(left_start), Some(right_start)) if left_start <= right_start => {
        left.next()
      }
      (Some(_) | None, Some(_)) => right.next(),
      (Some(_), None) => left.next(),
      (None, None) => None,
    };
    if let Some(start) = next
      && starts.last() != Some(&start)
    {
      starts.push(start);
    }
  }
  starts
}

fn lowercased_set(values: Vec<String>) -> BTreeSet<String> {
  values
    .into_iter()
    .map(|value| value.to_lowercase())
    .collect()
}

fn compile_regex(pattern: &str) -> Result<Regex> {
  Regex::new(pattern).map_err(|error| Error::Search {
    engine: SearchEngine::Regex,
    reason: error.to_string(),
  })
}

fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}

fn seed_from_match(
  full_text: &str,
  found: &SearchMatch,
  kind: SeedType,
) -> Result<Option<Seed>> {
  let start = usize::try_from(found.start()).map_err(|_| {
    Error::PatternIndexNotAddressable {
      pattern: found.pattern(),
    }
  })?;
  let end = usize::try_from(found.end()).map_err(|_| {
    Error::PatternIndexNotAddressable {
      pattern: found.pattern(),
    }
  })?;
  let Some(text) = full_text.get(start..end) else {
    return Ok(None);
  };
  Ok(Some(Seed {
    kind,
    start,
    end,
    text: text.to_owned(),
  }))
}

fn collect_existing_entity_seeds(
  seeds: &mut Vec<Seed>,
  full_text: &str,
  existing_entities: &[PipelineEntity],
  entity_index: &NonAddressEntityIndex,
) {
  for entity in existing_entities {
    if entity.label != "address" {
      continue;
    }
    if entity.source_detail == Some(SourceDetail::CustomDenyList) {
      continue;
    }
    if entity_index.overlaps_entity(entity) {
      continue;
    }
    let Some(kind) = kind_for_existing_entity(entity) else {
      continue;
    };
    if let Some(seed) = postal_seed_from_existing_address(full_text, entity) {
      seeds.push(seed);
    }
    seeds.push(Seed {
      kind,
      start: usize::try_from(entity.start).unwrap_or(usize::MAX),
      end: usize::try_from(entity.end).unwrap_or(usize::MAX),
      text: entity.text.clone(),
    });
  }
}

fn postal_seed_from_existing_address(
  full_text: &str,
  entity: &PipelineEntity,
) -> Option<Seed> {
  if entity.source != DetectionSource::DenyList {
    return None;
  }
  let mut start = usize::try_from(entity.start).ok()?;
  let entity_end = usize::try_from(entity.end).ok()?;
  while let Some((previous_start, ch)) = previous_char(full_text, start) {
    if !ch.is_ascii_digit() {
      break;
    }
    start = previous_start;
  }

  let mut end = start;
  while let Some((next_start, ch)) = next_char(full_text, end) {
    if !ch.is_ascii_digit() {
      break;
    }
    end = next_start.saturating_add(ch.len_utf8());
  }
  if end > entity_end {
    return None;
  }
  let text = full_text.get(start..end)?;
  if !is_plain_five_digit_postal_code(text) {
    return None;
  }
  Some(Seed {
    kind: SeedType::PostalCode,
    start,
    end,
    text: text.to_owned(),
  })
}

fn kind_for_existing_entity(entity: &PipelineEntity) -> Option<SeedType> {
  match entity.source {
    DetectionSource::DenyList => Some(SeedType::City),
    DetectionSource::Trigger if starts_with_digit(&entity.text) => {
      Some(SeedType::PostalCode)
    }
    DetectionSource::Trigger => Some(SeedType::AddressTrigger),
    _ => None,
  }
}

fn starts_with_digit(text: &str) -> bool {
  text.chars().next().is_some_and(|ch| ch.is_ascii_digit())
}

fn is_lowercase_street_word_in_prose(
  full_text: &str,
  seed: &Seed,
  data: &PreparedAddressSeedData,
) -> bool {
  starts_lowercase(&seed.text)
    && full_text
      .get(seed.end..)
      .is_some_and(starts_with_whitespace_then_lowercase)
    && !has_house_number_near_street_word(full_text, seed, data)
}

fn starts_lowercase(text: &str) -> bool {
  text.chars().next().is_some_and(char::is_lowercase)
}

fn starts_with_whitespace_then_lowercase(text: &str) -> bool {
  let mut saw_whitespace = false;
  for ch in text.chars() {
    if ch.is_whitespace() {
      saw_whitespace = true;
      continue;
    }
    return saw_whitespace && ch.is_lowercase();
  }
  false
}

fn has_house_number_near_street_word(
  full_text: &str,
  seed: &Seed,
  data: &PreparedAddressSeedData,
) -> bool {
  if seed.text.chars().any(|ch| ch.is_ascii_digit()) {
    return true;
  }

  let before_start =
    floor_char_boundary(full_text, seed.start.saturating_sub(50));
  let before = full_text.get(before_start..seed.start).unwrap_or_default();
  if data.house_number_before_street_re.is_match(before) {
    return true;
  }

  // Widened from 24 to accommodate the bounded intervening-word tolerance
  // added to `house_number_after_street_re` (up to 3 street-name particles
  // plus one street-name word before the house number).
  let after_end = ceil_char_boundary(
    full_text,
    seed.end.saturating_add(60).min(full_text.len()),
  );
  let after = full_text.get(seed.end..after_end).unwrap_or_default();
  data.house_number_after_street_re.is_match(after)
}

fn postal_boundaries(full_text: &str, start: usize, end: usize) -> bool {
  let before_ok = previous_char(full_text, start)
    .is_none_or(|(_, ch)| !is_postal_adjacent(ch));
  let after_ok =
    next_char(full_text, end).is_none_or(|(_, ch)| !is_postal_adjacent(ch));
  before_ok && after_ok
}

fn is_postal_adjacent(ch: char) -> bool {
  ch.is_alphanumeric() || ch == '_' || is_dash(ch)
}

fn is_plain_five_digit_postal_code(text: &str) -> bool {
  text.len() == 5 && text.chars().all(|ch| ch.is_ascii_digit())
}

const fn is_dash(ch: char) -> bool {
  matches!(ch, '-' | '‐' | '‑' | '‒' | '–' | '—' | '―')
}

fn street_number_candidates(
  full_text: &str,
) -> impl Iterator<Item = StreetNumberCandidate<'_>> {
  full_text
    .char_indices()
    .filter_map(|(start, ch)| street_number_candidate_at(full_text, start, ch))
}

fn street_number_candidate_at(
  full_text: &str,
  start: usize,
  first: char,
) -> Option<StreetNumberCandidate<'_>> {
  if !first.is_uppercase() || !has_left_word_boundary(full_text, start) {
    return None;
  }
  let street_end = scan_title_word_tail(full_text, start, first)?;
  let number_start = skip_required_whitespace(full_text, street_end)?;
  let number_end = scan_house_number(full_text, number_start)?;
  if !has_comma_or_newline_after_optional_whitespace(full_text, number_end) {
    return None;
  }
  Some(StreetNumberCandidate {
    start,
    end: number_end,
    street: full_text.get(start..street_end)?,
    number: full_text.get(number_start..number_end)?,
  })
}

fn italian_cap_candidates(
  full_text: &str,
) -> impl Iterator<Item = ItalianCapCandidate<'_>> {
  full_text
    .char_indices()
    .filter_map(|(start, ch)| italian_cap_candidate_at(full_text, start, ch))
}

fn italian_cap_candidate_at(
  full_text: &str,
  start: usize,
  first: char,
) -> Option<ItalianCapCandidate<'_>> {
  if !first.is_ascii_digit() || !has_left_word_boundary(full_text, start) {
    return None;
  }
  let cap_end = scan_exact_ascii_digits(full_text, start, 5)?;
  let city_start = skip_required_whitespace(full_text, cap_end)?;
  let (_, city_first) = next_char(full_text, city_start)?;
  if !city_first.is_uppercase() {
    return None;
  }
  let city_tail_start = city_start.saturating_add(city_first.len_utf8());
  if !starts_with_letter(full_text, city_tail_start) {
    return None;
  }
  Some(ItalianCapCandidate {
    start,
    end: cap_end,
    text: full_text.get(start..cap_end)?,
  })
}

fn scan_title_word_tail(
  full_text: &str,
  start: usize,
  first: char,
) -> Option<usize> {
  let mut cursor = start.saturating_add(first.len_utf8());
  let mut lowercase_count = 0usize;
  while let Some((index, ch)) = next_char(full_text, cursor) {
    if !ch.is_lowercase() {
      break;
    }
    lowercase_count = lowercase_count.saturating_add(1);
    cursor = index.saturating_add(ch.len_utf8());
  }
  (lowercase_count >= 2).then_some(cursor)
}

fn skip_required_whitespace(full_text: &str, start: usize) -> Option<usize> {
  let mut cursor = start;
  let mut saw_whitespace = false;
  while let Some((index, ch)) = next_char(full_text, cursor) {
    if !ch.is_whitespace() {
      break;
    }
    saw_whitespace = true;
    cursor = index.saturating_add(ch.len_utf8());
  }
  saw_whitespace.then_some(cursor)
}

fn scan_house_number(full_text: &str, start: usize) -> Option<usize> {
  let mut end = scan_ascii_digits(full_text, start, 1, 5)?;
  let Some((slash_start, '/')) = next_char(full_text, end) else {
    return Some(end);
  };
  let slash_end = slash_start.saturating_add('/'.len_utf8());
  if let Some(next_end) = scan_ascii_digits(full_text, slash_end, 1, 5) {
    end = next_end;
  }
  Some(end)
}

fn scan_exact_ascii_digits(
  full_text: &str,
  start: usize,
  count: usize,
) -> Option<usize> {
  let end = scan_ascii_digits(full_text, start, count, count)?;
  let next_is_digit =
    next_char(full_text, end).is_some_and(|(_, ch)| ch.is_ascii_digit());
  (!next_is_digit).then_some(end)
}

fn scan_ascii_digits(
  full_text: &str,
  start: usize,
  min: usize,
  max: usize,
) -> Option<usize> {
  let mut cursor = start;
  let mut count = 0usize;
  while count < max {
    let Some((index, ch)) = next_char(full_text, cursor) else {
      break;
    };
    if !ch.is_ascii_digit() {
      break;
    }
    count = count.saturating_add(1);
    cursor = index.saturating_add(ch.len_utf8());
  }
  (count >= min).then_some(cursor)
}

fn has_comma_or_newline_after_optional_whitespace(
  full_text: &str,
  start: usize,
) -> bool {
  let mut cursor = start;
  while let Some((index, ch)) = next_char(full_text, cursor) {
    if ch == ',' || ch == '\n' {
      return true;
    }
    if !ch.is_whitespace() {
      return false;
    }
    cursor = index.saturating_add(ch.len_utf8());
  }
  false
}

fn starts_with_letter(full_text: &str, start: usize) -> bool {
  next_char(full_text, start).is_some_and(|(_, ch)| ch.is_alphabetic())
}

fn has_left_word_boundary(full_text: &str, start: usize) -> bool {
  previous_char(full_text, start).is_none_or(|(_, ch)| !is_word_like(ch))
}

fn is_word_like(ch: char) -> bool {
  ch.is_alphanumeric() || ch == '_'
}

fn seed_covered(seeds: &[Seed], start: usize, end: usize) -> bool {
  seeds
    .iter()
    .any(|seed| seed.start <= start && seed.end >= end)
}

fn has_nearby_italian_cap_evidence(
  full_text: &str,
  seeds: &[Seed],
  start: usize,
) -> bool {
  seeds.iter().any(|seed| {
    within_text_window(full_text, seed.start, start, 80)
      && match seed.kind {
        SeedType::AddressTrigger | SeedType::City | SeedType::PostalCode => {
          true
        }
        SeedType::StreetWord => seed.text.to_lowercase() != "via",
        SeedType::State => false,
      }
  })
}

fn is_city_zip_gap(text: &str) -> bool {
  !text.is_empty() && text.chars().all(|ch| ch.is_whitespace() || ch == ',')
}

fn cluster_seeds(
  seeds: &[Seed],
  full_text: &str,
  entity_index: &NonAddressEntityIndex,
) -> Vec<SeedCluster> {
  let Some(first) = seeds.first() else {
    return Vec::new();
  };

  let mut clusters = Vec::new();
  let mut current = SeedCluster {
    seeds: vec![first.clone()],
    start: first.start,
    end: first.end,
  };
  for seed in seeds.iter().skip(1) {
    let gap_ok = within_text_window(
      full_text,
      current.end,
      seed.start,
      ADDRESS_CLUSTER_MAX_GAP,
    ) && !has_cluster_barrier(
      full_text,
      current.end,
      seed.start,
      entity_index,
    );
    if gap_ok {
      current.seeds.push(seed.clone());
      current.end = current.end.max(seed.end);
      continue;
    }
    clusters.push(current);
    current = SeedCluster {
      seeds: vec![seed.clone()],
      start: seed.start,
      end: seed.end,
    };
  }
  clusters.push(current);
  clusters
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct NonAddressEntityIndex {
  spans: SpanIndex<bool>,
}

impl NonAddressEntityIndex {
  fn new(existing_entities: &[PipelineEntity]) -> Self {
    Self {
      spans: SpanIndex::new(
        existing_entities
          .iter()
          .filter(|entity| non_address_label(&entity.label))
          .map(|entity| (entity.start, entity.end, date_label(&entity.label))),
      ),
    }
  }

  fn has_barrier(&self, gap_start: usize, gap_end: usize) -> bool {
    let Ok(gap_start) = u32::try_from(gap_start) else {
      return false;
    };
    let Ok(gap_end) = u32::try_from(gap_end) else {
      return false;
    };
    self
      .spans
      .any_starting_in_with_end_after(gap_start, gap_end, gap_start)
  }

  fn overlaps(&self, start: usize, end: usize) -> bool {
    u32::try_from(start)
      .ok()
      .zip(u32::try_from(end).ok())
      .is_some_and(|(start, end)| self.spans.any_overlapping(start, end))
  }

  fn overlaps_entity(&self, entity: &PipelineEntity) -> bool {
    self.spans.any_overlapping(entity.start, entity.end)
  }

  fn nearest_left(
    &self,
    full_text: &str,
    start: usize,
    ignore_date_prefix: bool,
  ) -> usize {
    let Ok(start_offset) = u32::try_from(start) else {
      return 0;
    };
    if !ignore_date_prefix {
      return self
        .spans
        .nearest_end_at_or_before(start_offset)
        .and_then(|end| usize::try_from(end).ok())
        .unwrap_or(0);
    }
    self
      .spans
      .find_ending_at_or_before(start_offset, |end, is_date| {
        !*is_date
          || !usize::try_from(end)
            .is_ok_and(|end| date_can_prefix_street_name(full_text, end, start))
      })
      .and_then(|(end, _)| usize::try_from(end).ok())
      .unwrap_or(0)
  }

  fn nearest_right(&self, offset: usize) -> Option<usize> {
    let offset = u32::try_from(offset).ok()?;
    let start = self.spans.nearest_start_after(offset)?;
    usize::try_from(start.saturating_sub(offset)).ok()
  }
}

fn within_text_window(
  full_text: &str,
  left: usize,
  right: usize,
  max_units: usize,
) -> bool {
  let start = left.min(right);
  let end = left.max(right);
  let Some(gap) = full_text.get(start..end) else {
    return false;
  };
  let byte_len = end.saturating_sub(start);
  if byte_len <= max_units {
    return true;
  }
  if byte_len > max_units.saturating_mul(4) {
    return false;
  }
  text_units(gap) <= max_units
}

fn text_units(text: &str) -> usize {
  text.chars().map(char::len_utf16).sum()
}

fn offset_before_text_units(
  full_text: &str,
  end: usize,
  max_units: usize,
) -> usize {
  let Some(prefix) = full_text.get(..end) else {
    return 0;
  };
  let mut units = 0usize;
  for (index, ch) in prefix.char_indices().rev() {
    let width = ch.len_utf16();
    if units.saturating_add(width) > max_units {
      return index.saturating_add(ch.len_utf8());
    }
    units = units.saturating_add(width);
  }
  0
}

fn offset_after_text_units(
  full_text: &str,
  start: usize,
  max_units: usize,
) -> usize {
  let Some(tail) = full_text.get(start..) else {
    return full_text.len();
  };
  let mut units = 0usize;
  for (relative, ch) in tail.char_indices() {
    let width = ch.len_utf16();
    if units.saturating_add(width) > max_units {
      return start.saturating_add(relative);
    }
    units = units.saturating_add(width);
  }
  full_text.len()
}

fn has_cluster_barrier(
  full_text: &str,
  gap_start: usize,
  gap_end: usize,
  entity_index: &NonAddressEntityIndex,
) -> bool {
  full_text
    .get(gap_start..gap_end)
    .is_some_and(has_paragraph_break)
    || entity_index.has_barrier(gap_start, gap_end)
}

fn has_paragraph_break(text: &str) -> bool {
  let mut saw_newline = false;
  for ch in text.chars() {
    if ch == '\n' {
      if saw_newline {
        return true;
      }
      saw_newline = true;
      continue;
    }
    if !ch.is_whitespace() {
      saw_newline = false;
    }
  }
  false
}

fn score_cluster(cluster: &SeedCluster) -> f64 {
  let mut has_street_word = false;
  let mut has_postal_code = false;
  let mut has_city = false;
  let mut has_state = false;
  let mut has_address_trigger = false;

  for seed in &cluster.seeds {
    match seed.kind {
      SeedType::StreetWord => has_street_word = true,
      SeedType::PostalCode => has_postal_code = true,
      SeedType::City => has_city = true,
      SeedType::State => has_state = true,
      SeedType::AddressTrigger => has_address_trigger = true,
    }
  }

  let type_count = [
    has_street_word,
    has_postal_code,
    has_city,
    has_state,
    has_address_trigger,
  ]
  .into_iter()
  .filter(|seen| *seen)
  .count();
  if type_count < 2 {
    return 0.0;
  }

  let mut score = ADDRESS_SCORE_BASE;
  if has_postal_code {
    score += 0.15;
  }
  if has_city {
    score += 0.15;
  }
  if has_state {
    score += 0.15;
  }
  if has_street_word {
    score += 0.15;
  }
  if has_address_trigger {
    score += 0.1;
  }
  score.min(ADDRESS_SCORE_MAX)
}

fn nearest_left_non_address(
  full_text: &str,
  start: usize,
  entity_index: &NonAddressEntityIndex,
  ignore_date_prefix: bool,
) -> usize {
  entity_index.nearest_left(full_text, start, ignore_date_prefix)
}

fn non_address_label(label: &str) -> bool {
  matches!(
    label,
    "registration number"
      | "case number"
      | "tax identification number"
      | "national identification number"
      | "social security number"
      | "birth number"
      | "identity card number"
      | "date"
      | "date of birth"
      | "person"
      | "bank account number"
      | "email address"
      | "phone number"
      | "organization"
      | "iban"
  )
}

fn date_label(label: &str) -> bool {
  matches!(label, "date" | "date of birth")
}

fn cluster_starts_with_street_type_word(cluster: &SeedCluster) -> bool {
  cluster.seeds.iter().any(|seed| {
    seed.start == cluster.start
      && seed.kind == SeedType::StreetWord
      && !seed.text.chars().any(|ch| ch.is_ascii_digit())
  })
}

fn date_can_prefix_street_name(
  full_text: &str,
  date_end: usize,
  street_start: usize,
) -> bool {
  if date_end > street_start {
    return false;
  }
  full_text.get(date_end..street_start).is_some_and(|gap| {
    !gap.contains('\n') && gap.chars().all(char::is_whitespace)
  })
}

fn expand_left(full_text: &str, start: usize, left_bound: usize) -> usize {
  let mut left_pos = start;
  while left_pos > left_bound {
    let Some((word_start, word_end, word)) =
      word_before_for_address(full_text, left_pos, left_bound)
    else {
      break;
    };
    if word.len() < 2
      || !starts_uppercase_or_digit(word)
      || is_left_address_label(word)
    {
      break;
    }
    if full_text
      .get(word_start..left_pos)
      .is_some_and(|slice| slice.contains('\n'))
    {
      break;
    }
    left_pos = word_start;
    if word_end <= left_bound {
      break;
    }
  }
  left_pos
}

fn word_before_for_address(
  text: &str,
  pos: usize,
  left_bound: usize,
) -> Option<(usize, usize, &str)> {
  let mut end = pos;
  while end > left_bound {
    let Some((prev_start, ch)) = previous_char(text, end) else {
      break;
    };
    if ch == ' ' || ch == ',' {
      end = prev_start;
      continue;
    }
    break;
  }
  if end <= left_bound {
    return None;
  }

  let mut start = end;
  while start > left_bound {
    let Some((prev_start, ch)) = previous_char(text, start) else {
      break;
    };
    if ch.is_whitespace() {
      break;
    }
    start = prev_start;
  }
  let word = text.get(start..end)?;
  Some((start, end, word))
}

fn starts_uppercase_or_digit(text: &str) -> bool {
  text
    .chars()
    .next()
    .is_some_and(|ch| ch.is_uppercase() || ch.is_ascii_digit())
}

fn is_left_address_label(text: &str) -> bool {
  text.ends_with(':')
}

fn trim_address_tail(full_text: &str, start: usize, mut end: usize) -> usize {
  while end > start {
    let Some((prev_start, ch)) = previous_char(full_text, end) else {
      break;
    };
    if is_address_trailing_trim(ch) {
      end = prev_start;
      continue;
    }
    break;
  }
  end
}

fn sentence_boundary(
  text: &str,
  unit_abbreviations: &BTreeSet<String>,
) -> Option<usize> {
  let mut iter = text.char_indices().peekable();
  while let Some((index, ch)) = iter.next() {
    if !matches!(ch, '.' | '!' | '?') {
      continue;
    }
    if ch == '.' && is_unit_abbreviation(text, index, unit_abbreviations) {
      continue;
    }
    let mut saw_whitespace = false;
    while let Some((_, next)) = iter.peek().copied() {
      if !next.is_whitespace() {
        break;
      }
      saw_whitespace = true;
      iter.next();
    }
    let Some((_, next)) = iter.peek().copied() else {
      return Some(index);
    };
    if saw_whitespace && (next.is_uppercase() || next.is_ascii_digit()) {
      return Some(index);
    }
  }
  None
}

fn is_unit_abbreviation(
  text: &str,
  dot_index: usize,
  unit_abbreviations: &BTreeSet<String>,
) -> bool {
  let mut start = dot_index;
  while let Some((previous_start, ch)) = previous_char(text, start) {
    if ch.is_alphanumeric() || ch == '.' {
      start = previous_start;
      continue;
    }
    break;
  }
  if start == dot_index {
    return false;
  }
  text
    .get(start..dot_index.saturating_add(1))
    .is_some_and(|token| unit_abbreviations.contains(&token.to_lowercase()))
}

const fn is_address_trailing_trim(ch: char) -> bool {
  ch.is_whitespace()
    || matches!(
      ch,
      ','
        | ';'
        | ':'
        | '('
        | '['
        | '{'
        | '"'
        | '\''
        | '“'
        | '”'
        | '‘'
        | '’'
        | '′'
    )
}

fn resolve_newline_boundary(
  span_start: usize,
  text: &str,
  cluster: &SeedCluster,
) -> NewlineBoundaryResolution {
  let mut newline_positions = text.match_indices('\n').map(|(index, _)| index);
  let Some(relative_newline) = newline_positions.next() else {
    return NewlineBoundaryResolution::Keep;
  };
  if newline_positions.next().is_some() {
    return NewlineBoundaryResolution::Drop;
  }

  let newline_abs = span_start.saturating_add(relative_newline);
  let mut street_above = false;
  let mut street_below = false;
  let mut destination_above = false;
  let mut destination_below = false;

  for seed in &cluster.seeds {
    let is_above = seed.end <= newline_abs;
    let is_street = matches!(seed.kind, SeedType::StreetWord);
    let is_destination =
      matches!(seed.kind, SeedType::PostalCode | SeedType::City);
    if is_street && is_above {
      street_above = true;
    }
    if is_street && !is_above {
      street_below = true;
    }
    if is_destination && is_above {
      destination_above = true;
    }
    if is_destination && !is_above {
      destination_below = true;
    }
  }

  if (street_above && destination_below) || (street_below && destination_above)
  {
    return NewlineBoundaryResolution::Keep;
  }
  if street_above && destination_above {
    return NewlineBoundaryResolution::Trim {
      relative_end: relative_newline,
    };
  }
  NewlineBoundaryResolution::Drop
}

fn utf16_cap_at_char_boundary(text: &str, cap: usize) -> usize {
  let mut units = 0usize;
  for (index, ch) in text.char_indices() {
    let width = ch.len_utf16();
    if units.saturating_add(width) > cap {
      return index;
    }
    units = units.saturating_add(width);
  }
  text.len()
}

fn floor_char_boundary(text: &str, mut byte: usize) -> usize {
  byte = byte.min(text.len());
  while byte > 0 && !text.is_char_boundary(byte) {
    byte = byte.saturating_sub(1);
  }
  byte
}

fn ceil_char_boundary(text: &str, mut byte: usize) -> usize {
  byte = byte.min(text.len());
  while byte < text.len() && !text.is_char_boundary(byte) {
    byte = byte.saturating_add(1);
  }
  byte
}

fn previous_char(text: &str, byte: usize) -> Option<(usize, char)> {
  text.get(..byte)?.char_indices().next_back()
}

fn next_char(text: &str, byte: usize) -> Option<(usize, char)> {
  let suffix = text.get(byte..)?;
  let (relative, ch) = suffix.char_indices().next()?;
  Some((byte.saturating_add(relative), ch))
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::*;

  proptest! {
    #[test]
    fn bounded_text_window_matches_full_utf16_count(
      chars in proptest::collection::vec(any::<char>(), 0..256),
      left_index in any::<usize>(),
      right_index in any::<usize>(),
      max_units in 0_usize..512,
    ) {
      let full_text = chars.into_iter().collect::<String>();
      let mut boundaries = full_text
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
      boundaries.push(full_text.len());
      let left = left_index
        .checked_rem(boundaries.len())
        .and_then(|index| boundaries.get(index))
        .copied()
        .unwrap_or_default();
      let right = right_index
        .checked_rem(boundaries.len())
        .and_then(|index| boundaries.get(index))
        .copied()
        .unwrap_or_default();
      let start = left.min(right);
      let end = left.max(right);
      let expected = full_text
        .get(start..end)
        .is_some_and(|gap| text_units(gap) <= max_units);

      prop_assert_eq!(
        within_text_window(&full_text, left, right, max_units),
        expected,
      );
    }

    #[test]
    fn seed_coverage_index_matches_linear_scan(
      ranges in proptest::collection::vec((0_usize..4096, 0_usize..256), 0..256),
      query_start in 0_usize..4096,
      query_len in 0_usize..256,
    ) {
      let mut seeds = ranges
        .into_iter()
        .map(|(start, len)| Seed {
          kind: SeedType::City,
          start,
          end: start.saturating_add(len),
          text: String::new(),
        })
        .collect::<Vec<_>>();
      seeds.sort_by(compare_seeds);
      let query_end = query_start.saturating_add(query_len);

      prop_assert_eq!(
        SeedCoverageIndex::new(&seeds).covers(query_start, query_end),
        seed_covered(&seeds, query_start, query_end),
      );
    }

    #[test]
    fn bounded_seed_window_matches_linear_context_scan(
      chars in proptest::collection::vec(any::<char>(), 0..256),
      seed_indices in proptest::collection::vec(any::<usize>(), 0..256),
      query_index in any::<usize>(),
      max_units in 0_usize..512,
    ) {
      let full_text = chars.into_iter().collect::<String>();
      let mut boundaries = full_text
        .char_indices()
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
      boundaries.push(full_text.len());
      let mut seeds = seed_indices
        .into_iter()
        .filter_map(|index| {
          index
            .checked_rem(boundaries.len())
            .and_then(|bounded| boundaries.get(bounded))
        })
        .copied()
        .map(|start| Seed {
          kind: SeedType::City,
          start,
          end: start,
          text: String::new(),
        })
        .collect::<Vec<_>>();
      seeds.sort_by(compare_seeds);
      let query = query_index
        .checked_rem(boundaries.len())
        .and_then(|bounded| boundaries.get(bounded))
        .copied()
        .unwrap_or_default();
      let expected = seeds
        .iter()
        .filter(|seed| {
          within_text_window(&full_text, seed.start, query, max_units)
        })
        .map(|seed| seed.start)
        .collect::<Vec<_>>();
      let actual = seed_start_window(&seeds, query, max_units)
        .iter()
        .filter(|seed| {
          within_text_window(&full_text, seed.start, query, max_units)
        })
        .map(|seed| seed.start)
        .collect::<Vec<_>>();

      prop_assert_eq!(actual, expected);
    }

    #[test]
    fn indexed_postal_collection_matches_legacy_scan(
      fragments in proptest::collection::vec(any::<u8>(), 0..128),
    ) {
      let data = PreparedAddressSeedData::new(AddressSeedData::default())?;
      let (full_text, initial_seeds) = postal_equivalence_fixture(&fragments);
      let mut expected = initial_seeds.clone();
      collect_postal_code_seeds_legacy(&data, &mut expected, &full_text);
      expected.sort_by(compare_seeds);
      let mut actual = initial_seeds;
      data.collect_postal_code_seeds(&mut actual, &full_text);
      actual.sort_by(compare_seeds);

      prop_assert_eq!(actual, expected);
    }

    #[test]
    fn non_address_entity_index_matches_linear_queries(
      ranges in proptest::collection::vec(
        (any::<u32>(), any::<u32>(), any::<bool>()),
        0..512,
      ),
      gap_start in any::<u32>(),
      gap_end in any::<u32>(),
    ) {
      let entities = ranges
        .into_iter()
        .map(|(start, end, is_address)| {
          PipelineEntity::detected(
            start,
            end,
            if is_address { "address" } else { "person" },
            "fixture",
            0.9,
            DetectionSource::Regex,
          )
        })
        .collect::<Vec<_>>();
      let gap_start = usize::try_from(gap_start).unwrap_or(usize::MAX);
      let gap_end = usize::try_from(gap_end).unwrap_or(usize::MAX);
      let expected = entities.iter().any(|entity| {
        non_address_label(&entity.label)
          && usize::try_from(entity.start)
            .is_ok_and(|start| start >= gap_start && start < gap_end)
          && usize::try_from(entity.end).is_ok_and(|end| end > gap_start)
      });

      prop_assert_eq!(
        NonAddressEntityIndex::new(&entities)
          .has_barrier(gap_start, gap_end),
        expected,
      );

      let index = NonAddressEntityIndex::new(&entities);
      if gap_start < gap_end {
        let expected_overlap = entities.iter().any(|entity| {
          non_address_label(&entity.label)
            && usize::try_from(entity.start).is_ok_and(|start| start < gap_end)
            && usize::try_from(entity.end).is_ok_and(|end| end > gap_start)
        });
        prop_assert_eq!(index.overlaps(gap_start, gap_end), expected_overlap);
      }

      let expected_left = entities
        .iter()
        .filter(|entity| non_address_label(&entity.label))
        .filter_map(|entity| {
          usize::try_from(entity.end)
            .ok()
            .filter(|end| *end <= gap_start)
        })
        .max()
        .unwrap_or(0);
      prop_assert_eq!(
        index.nearest_left("", gap_start, false),
        expected_left,
      );

      let expected_right = entities
        .iter()
        .filter(|entity| non_address_label(&entity.label))
        .filter_map(|entity| {
          usize::try_from(entity.start).ok().and_then(|start| {
            let distance = start.saturating_sub(gap_start);
            (distance > 0).then_some(distance)
          })
        })
        .min();
      prop_assert_eq!(index.nearest_right(gap_start), expected_right);
    }
  }

  #[test]
  fn boundary_phrases_match_original_offsets_across_unicode_whitespace()
  -> Result<()> {
    let data = PreparedAddressSeedData::new(AddressSeedData {
      boundary_words: vec![
        String::from("or emailed to"),
        String::from("or sent"),
        String::from("con C.I.F."),
        String::from("con N.I.F."),
        String::from("con D.N.I."),
        String::from("con N.I.E."),
        String::from("sp. zn."),
        String::from("stop"),
      ],
      ..AddressSeedData::default()
    })?;
    for phrase in [
      "or emailed to",
      "or\nemailed to",
      "or\r\nemailed\tto",
      "or  \t emailed\u{2003}to",
    ] {
      let full_text = format!("§ {phrase} recipient");
      assert_eq!(data.boundary_starts(&full_text), vec!["§ ".len()]);
    }
    assert_eq!(data.boundary_starts("stop here"), vec![0]);
    for phrase in [
      "con C.I.F.",
      "con N.I.F.",
      "con D.N.I.",
      "con N.I.E.",
      "sp. zn.",
    ] {
      assert_eq!(
        data.boundary_starts(&format!("{phrase} recipient")),
        vec![0]
      );
      assert_eq!(data.boundary_starts(&phrase.replace(' ', "\n")), vec![0]);
      assert!(data.boundary_starts(&format!("{phrase}foo")).is_empty());
    }
    assert!(
      data
        .boundary_starts(
          "nonstop xor emailed to recipient or emailed toxin or sentry xcon C.I.F.",
        )
        .is_empty()
    );
    Ok(())
  }

  #[test]
  #[ignore = "release-mode boundary phrase scaling regression check"]
  fn boundary_phrase_search_scales_with_input_size() -> Result<()> {
    let data = PreparedAddressSeedData::new(AddressSeedData {
      boundary_words: (0..128)
        .map(|index| format!("marker {index} terminus"))
        .collect(),
      ..AddressSeedData::default()
    })?;
    let small = boundary_phrase_sample(&data, 64 * 1024);
    let large = boundary_phrase_sample(&data, 1024 * 1024);
    let samples = [&small, &large];
    assert!(
      large
        .1
        .as_nanos()
        .saturating_mul(u128::try_from(small.0).unwrap_or(u128::MAX))
        <= small
          .1
          .as_nanos()
          .saturating_mul(u128::try_from(large.0).unwrap_or(u128::MAX))
          .saturating_mul(3),
      "boundary phrase search time per byte regressed: {samples:?}",
    );
    assert!(
      large.1 <= std::time::Duration::from_millis(500),
      "boundary phrase search exceeded 500 ms at 1 MiB: {samples:?}",
    );
    Ok(())
  }

  fn boundary_phrase_sample(
    data: &PreparedAddressSeedData,
    target_bytes: usize,
  ) -> (usize, std::time::Duration) {
    let fixture = "ordinary legal prose marker\r\n127\tterminus follows.\n";
    let repeats = target_bytes.div_ceil(fixture.len());
    let full_text = fixture.repeat(repeats);
    let expected = repeats;
    assert_eq!(data.boundary_starts(&full_text).len(), expected);
    let mut best = std::time::Duration::MAX;
    for _ in 0..5 {
      let start = Instant::now();
      let starts = data.boundary_starts(&full_text);
      best = best.min(start.elapsed());
      assert_eq!(starts.len(), expected);
    }
    (full_text.len(), best)
  }

  #[test]
  #[ignore = "release-mode postal context scaling regression check"]
  fn postal_context_collection_scales_for_dynamic_states_and_zip_plus_four()
  -> Result<()> {
    let data = PreparedAddressSeedData::new(AddressSeedData::default())?;
    assert_postal_collection_scales(&data, PostalScalingCase::StateBacked);
    assert_postal_collection_scales(
      &data,
      PostalScalingCase::StreetBackedWithoutState,
    );
    Ok(())
  }

  #[derive(Clone, Copy, Debug)]
  enum PostalScalingCase {
    StateBacked,
    StreetBackedWithoutState,
  }

  impl PostalScalingCase {
    fn fixture(self) -> &'static str {
      match self {
        Self::StateBacked => "MA 02101-1234.\n\n",
        Self::StreetBackedWithoutState => "100 Main Street 02101-1234.\n\n",
      }
    }

    fn initial_seeds(self, repeats: usize) -> Vec<Seed> {
      match self {
        Self::StateBacked => Vec::new(),
        Self::StreetBackedWithoutState => {
          let fixture_len = self.fixture().len();
          (0..repeats)
            .map(|repeat| {
              let base = repeat.saturating_mul(fixture_len);
              Seed {
                kind: SeedType::StreetWord,
                start: base.saturating_add(9),
                end: base.saturating_add(15),
                text: String::from("Street"),
              }
            })
            .collect()
        }
      }
    }
  }

  fn assert_postal_collection_scales(
    data: &PreparedAddressSeedData,
    case: PostalScalingCase,
  ) {
    let small = postal_collection_sample(data, case, 64 * 1024);
    let large = postal_collection_sample(data, case, 1024 * 1024);
    let samples = [&small, &large];
    assert!(
      large
        .1
        .as_nanos()
        .saturating_mul(u128::try_from(small.0).unwrap_or(u128::MAX))
        <= small
          .1
          .as_nanos()
          .saturating_mul(u128::try_from(large.0).unwrap_or(u128::MAX))
          .saturating_mul(3),
      "{case:?} postal collection time per byte regressed: {samples:?}",
    );
    assert!(
      large.1 <= std::time::Duration::from_millis(500),
      "{case:?} postal collection exceeded 500 ms at 1 MiB: {samples:?}",
    );
  }

  fn postal_collection_sample(
    data: &PreparedAddressSeedData,
    case: PostalScalingCase,
    target_bytes: usize,
  ) -> (usize, std::time::Duration) {
    let fixture = case.fixture();
    let repeats = target_bytes.div_ceil(fixture.len());
    let full_text = fixture.repeat(repeats);
    let initial_seeds = case.initial_seeds(repeats);
    let expected_seed_count = repeats.saturating_mul(2);
    let mut best = std::time::Duration::MAX;
    for _ in 0..5 {
      let mut seeds = initial_seeds.clone();
      let start = Instant::now();
      data.collect_postal_code_seeds(&mut seeds, &full_text);
      best = best.min(start.elapsed());
      assert_eq!(seeds.len(), expected_seed_count, "{case:?}");
      std::hint::black_box(seeds);
    }
    (full_text.len(), best)
  }

  fn postal_equivalence_fixture(fragments: &[u8]) -> (String, Vec<Seed>) {
    let mut full_text = String::new();
    let mut seeds = Vec::new();
    for fragment in fragments {
      match fragment % 7 {
        0 => full_text.push_str("MA 02101-1234 "),
        1 => {
          let base = full_text.len();
          full_text.push_str("100 Main Street 02101-1234 ");
          seeds.push(Seed {
            kind: SeedType::StreetWord,
            start: base.saturating_add(9),
            end: base.saturating_add(15),
            text: String::from("Street"),
          });
        }
        2 => {
          let base = full_text.len();
          full_text.push_str("Boston, 02101 ");
          seeds.push(Seed {
            kind: SeedType::City,
            start: base,
            end: base.saturating_add(6),
            text: String::from("Boston"),
          });
        }
        3 => full_text.push_str("Notice 54321 "),
        4 => full_text.push_str("CA, 94304-1050 "),
        5 => {
          let base = full_text.len();
          full_text.push_str("100 Broad Road 94304-1050 ");
          seeds.push(Seed {
            kind: SeedType::StreetWord,
            start: base.saturating_add(10),
            end: base.saturating_add(14),
            text: String::from("Road"),
          });
        }
        _ => full_text.push_str("§§ 12345 — "),
      }
    }
    (full_text, seeds)
  }

  fn collect_postal_code_seeds_legacy(
    data: &PreparedAddressSeedData,
    seeds: &mut Vec<Seed>,
    full_text: &str,
  ) {
    for found in data.postal_code_re.find_iter(full_text) {
      let start = found.start();
      let end = found.end();
      let text = found.as_str();
      if !postal_boundaries(full_text, start, end) {
        continue;
      }
      let is_plain_five_digit = is_plain_five_digit_postal_code(text);
      if seed_covered(seeds, start, end) && !is_plain_five_digit {
        continue;
      }
      if is_plain_five_digit
        && !has_plain_postal_context_legacy(data, full_text, start, end, seeds)
      {
        continue;
      }
      if data.br_cep_shape_re.is_match(text)
        && !data.has_br_cue_nearby(full_text, start, end)
      {
        continue;
      }
      if data.us_zip_plus_four_shape_re.is_match(text) {
        let context =
          us_zip_plus_four_context_legacy(data, full_text, start, seeds);
        if !context.has_context {
          continue;
        }
        if let Some(state_seed) = context.state_seed
          && !seed_covered(seeds, state_seed.start, state_seed.end)
        {
          seeds.push(state_seed);
        }
      }
      seeds.push(Seed {
        kind: SeedType::PostalCode,
        start,
        end,
        text: text.to_owned(),
      });
    }
  }

  fn has_plain_postal_context_legacy(
    data: &PreparedAddressSeedData,
    full_text: &str,
    start: usize,
    end: usize,
    seeds: &[Seed],
  ) -> bool {
    seeds.iter().any(|seed| {
      within_text_window(
        full_text,
        seed.start,
        start,
        PLAIN_POSTAL_CONTEXT_WINDOW,
      ) && match seed.kind {
        SeedType::AddressTrigger => true,
        SeedType::City | SeedType::State => {
          seed.end >= start && seed.start <= end.saturating_add(4)
            || seed.end <= start
              && full_text.get(seed.end..start).is_some_and(is_city_zip_gap)
        }
        SeedType::StreetWord => {
          has_house_number_near_street_word(full_text, seed, data)
        }
        SeedType::PostalCode => false,
      }
    })
  }

  fn us_zip_plus_four_context_legacy(
    data: &PreparedAddressSeedData,
    full_text: &str,
    start: usize,
    seeds: &[Seed],
  ) -> UsZipPlusFourContext {
    if let Some(state_seed) = data.us_state_seed_before_zip(full_text, start) {
      return UsZipPlusFourContext {
        state_seed: Some(state_seed),
        has_context: true,
      };
    }

    let has_context = seeds.iter().any(|seed| {
      within_text_window(full_text, seed.start, start, US_ZIP_CONTEXT_WINDOW)
        && match seed.kind {
          SeedType::AddressTrigger => true,
          SeedType::City => {
            seed.end <= start
              && full_text.get(seed.end..start).is_some_and(is_city_zip_gap)
          }
          SeedType::StreetWord => {
            has_house_number_near_street_word(full_text, seed, data)
          }
          SeedType::PostalCode | SeedType::State => false,
        }
    });

    UsZipPlusFourContext {
      state_seed: None,
      has_context,
    }
  }

  fn entity(
    full_text: &str,
    text: &str,
    label: &str,
    source: DetectionSource,
  ) -> Result<PipelineEntity> {
    let Some(start) = full_text.find(text) else {
      return Err(Error::InvalidStaticData {
        field: "address_seed_test_fixture",
        reason: String::from("fixture text should exist"),
      });
    };
    let end = start.saturating_add(text.len());
    Ok(PipelineEntity::detected(
      u32::try_from(start).map_err(|_| Error::InvalidStaticData {
        field: "address_seed_test_fixture",
        reason: String::from("fixture start should fit u32"),
      })?,
      u32::try_from(end).map_err(|_| Error::InvalidStaticData {
        field: "address_seed_test_fixture",
        reason: String::from("fixture end should fit u32"),
      })?,
      label,
      text,
      0.9,
      source,
    ))
  }

  #[test]
  fn expands_compound_street_with_plain_postal_city() -> Result<()> {
    let data = PreparedAddressSeedData::new(AddressSeedData {
      boundary_words: vec![String::from("steuer-id")],
      br_cep_cue_words: Vec::new(),
      unit_abbreviations: Vec::new(),
    })?;
    let full_text = concat!(
      "(2) Frau Karoline M. Brentano,\n",
      "    geboren am 09. Juli 1982,\n",
      "    wohnhaft Bismarckring 18, 65183 Wiesbaden,\n",
      "    Steuer-ID: 78 123 456 789",
    );
    let existing = vec![
      entity(
        full_text,
        "Frau Karoline M. Brentano",
        "person",
        DetectionSource::DenyList,
      )?,
      entity(
        full_text,
        "09. Juli 1982",
        "date of birth",
        DetectionSource::Trigger,
      )?,
      entity(
        full_text,
        "5183 Wiesbaden",
        "address",
        DetectionSource::DenyList,
      )?,
    ];

    let result = data
      .process_profiled(&[], PatternSlice::default(), full_text, &existing)?
      .entities;

    assert!(
      result
        .iter()
        .any(|entity| entity.text == "Bismarckring 18, 65183 Wiesbaden"),
      "address seed entities: {result:?}",
    );
    Ok(())
  }

  #[test]
  fn lowercase_street_word_with_distant_house_number_counts_as_evidence()
  -> Result<()> {
    // "rue de la Paix 10": the house number trails the (lowercase) street
    // word by two particles and the street-name word, mirroring the bounded
    // intervening-word tolerance `house_number_before_street_re` already
    // gives capitalized words ahead of a street word.
    let data = PreparedAddressSeedData::new(AddressSeedData::default())?;
    let full_text = "rue de la Paix 10";
    let seed = Seed {
      kind: SeedType::StreetWord,
      start: 0,
      end: 3,
      text: String::from("rue"),
    };

    assert!(
      has_house_number_near_street_word(full_text, &seed, &data),
      "a house number three bridge words after the street word should count as nearby evidence"
    );
    assert!(
      !is_lowercase_street_word_in_prose(full_text, &seed, &data),
      "rue should not be suppressed as bare lowercase prose once a trailing house number is recognized"
    );

    Ok(())
  }

  #[test]
  fn lowercase_street_word_without_house_number_is_still_treated_as_prose()
  -> Result<()> {
    let data = PreparedAddressSeedData::new(AddressSeedData::default())?;
    let full_text = "rue is a French word for street, not an address here";
    let seed = Seed {
      kind: SeedType::StreetWord,
      start: 0,
      end: 3,
      text: String::from("rue"),
    };

    assert!(
      !has_house_number_near_street_word(full_text, &seed, &data),
      "no house number is nearby, so the widened regex should still not match"
    );
    assert!(
      is_lowercase_street_word_in_prose(full_text, &seed, &data),
      "rue used as a plain word with no nearby house number should still be treated as prose"
    );

    Ok(())
  }

  #[test]
  fn prose_words_do_not_bridge_street_word_to_distant_number() -> Result<()> {
    // The delayed-house-number bridge only crosses street-name particles
    // (de, la, van, ...) plus at most one street-name word. Arbitrary prose
    // between the street word and a number must not count as house-number
    // evidence; otherwise a trailing figure in an explanatory sentence
    // would defeat the lowercase-prose suppression.
    let data = PreparedAddressSeedData::new(AddressSeedData::default())?;
    let full_text = "rue is a French word 12345";
    let seed = Seed {
      kind: SeedType::StreetWord,
      start: 0,
      end: 3,
      text: String::from("rue"),
    };

    assert!(
      !has_house_number_near_street_word(full_text, &seed, &data),
      "prose words must not bridge a street word to a distant number"
    );
    assert!(
      is_lowercase_street_word_in_prose(full_text, &seed, &data),
      "rue followed by prose and an unrelated number should stay suppressed as prose"
    );

    // A single lowercase word must not bridge either ("Road docket
    // 94304-1050" is a docket identifier, not a house number); only the
    // capitalized street-name slot may sit directly ahead of the digits.
    let docket_text = "The Road docket 94304-1050 is closed.";
    let docket_seed = Seed {
      kind: SeedType::StreetWord,
      start: 4,
      end: 8,
      text: String::from("Road"),
    };
    assert!(
      !has_house_number_near_street_word(docket_text, &docket_seed, &data),
      "a lowercase non-particle word must not bridge to a ZIP-shaped number"
    );

    Ok(())
  }
}
