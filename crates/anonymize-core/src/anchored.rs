use std::collections::BTreeMap;

use crate::resolution::PipelineEntity;
use crate::search::{SearchIndex, SearchOptions, SearchPattern};
use crate::types::{Error, Result, SearchMatch};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AnchorSpan {
  pub start: usize,
  pub end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AnchorTerm {
  text: String,
  case_insensitive: bool,
  whole_words: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AnchorRoute {
  text: String,
  case_insensitive: bool,
  whole_words: bool,
  owner: AnchorOwner,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct AnchorRoutes(Vec<AnchorRoute>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AnchorOwner {
  Date,
  Monetary,
}

pub(crate) struct PreparedAnchoredSearch {
  search: SearchIndex,
  routes: Vec<AnchorRoutes>,
}

pub(crate) struct PreparedAnchoredDocument {
  date_anchors: Vec<AnchorSpan>,
  monetary_anchors: Vec<AnchorSpan>,
  #[cfg(test)]
  full_document_scans: usize,
}

impl PreparedAnchoredSearch {
  pub(crate) fn new(
    date_terms: Vec<AnchorTerm>,
    monetary_terms: Vec<AnchorTerm>,
  ) -> Result<Option<Self>> {
    let term_count = date_terms.len().saturating_add(monetary_terms.len());
    if term_count == 0 {
      return Ok(None);
    }
    let mut patterns = Vec::with_capacity(term_count);
    let mut routes = Vec::<AnchorRoutes>::with_capacity(term_count);
    let mut pattern_indexes = BTreeMap::<String, usize>::new();
    let mut add_terms = |terms: Vec<AnchorTerm>, owner| {
      for term in terms {
        let key = term.text.to_lowercase();
        let route = AnchorRoute {
          text: term.text,
          case_insensitive: term.case_insensitive,
          whole_words: term.whole_words,
          owner,
        };
        if let Some(index) = pattern_indexes.get(&key).copied() {
          if let Some(existing) = routes.get_mut(index) {
            merge_anchor_route(existing, route);
          }
          continue;
        }
        let index = routes.len();
        pattern_indexes.insert(key.clone(), index);
        patterns.push(shared_anchor_pattern(key));
        routes.push(AnchorRoutes(vec![route]));
      }
    };
    add_terms(date_terms, AnchorOwner::Date);
    add_terms(monetary_terms, AnchorOwner::Monetary);
    Ok(Some(Self {
      search: SearchIndex::new(patterns, SearchOptions::default())?,
      routes,
    }))
  }

  pub(crate) fn scan(
    &self,
    full_text: &str,
  ) -> Result<PreparedAnchoredDocument> {
    let mut document = PreparedAnchoredDocument {
      date_anchors: Vec::new(),
      monetary_anchors: Vec::new(),
      #[cfg(test)]
      full_document_scans: 1,
    };
    for found in self.search.find_iter(full_text)? {
      let pattern = usize::try_from(found.pattern()).unwrap_or(usize::MAX);
      let route =
        self
          .routes
          .get(pattern)
          .ok_or_else(|| Error::InvalidStaticData {
            field: "anchored_search.routes",
            reason: format!("missing route for pattern {}", found.pattern()),
          })?;
      let span = anchor_span(&found);
      let date = route.0.iter().any(|candidate| {
        candidate.owner == AnchorOwner::Date
          && candidate.accepts(full_text, span)
      });
      let monetary = route.0.iter().any(|candidate| {
        candidate.owner == AnchorOwner::Monetary
          && candidate.accepts(full_text, span)
      });
      if date {
        document.date_anchors.push(span);
      }
      if monetary {
        document.monetary_anchors.push(span);
      }
    }
    Ok(document)
  }
}

impl AnchorRoute {
  fn accepts(&self, full_text: &str, span: AnchorSpan) -> bool {
    let matched_text = full_text.get(span.start..span.end).unwrap_or_default();
    (self.case_insensitive || matched_text == self.text)
      && (!self.whole_words || is_whole_word(full_text, span))
  }
}

fn merge_anchor_route(routes: &mut AnchorRoutes, route: AnchorRoute) {
  let exists = routes.0.iter().any(|existing| {
    existing.text == route.text
      && existing.case_insensitive == route.case_insensitive
      && existing.whole_words == route.whole_words
      && existing.owner == route.owner
  });
  if !exists {
    routes.0.push(route);
  }
}

impl PreparedAnchoredDocument {
  pub(crate) fn date_anchors(&self) -> &[AnchorSpan] {
    &self.date_anchors
  }

  pub(crate) fn monetary_anchors(&self) -> &[AnchorSpan] {
    &self.monetary_anchors
  }

  #[cfg(test)]
  pub(crate) const fn full_document_scans(&self) -> usize {
    self.full_document_scans
  }
}

impl AnchorTerm {
  pub(crate) const fn new(
    text: String,
    case_insensitive: bool,
    whole_words: bool,
  ) -> Self {
    Self {
      text,
      case_insensitive,
      whole_words,
    }
  }

  pub(crate) const fn word_case_insensitive(text: String) -> Self {
    Self {
      text,
      case_insensitive: true,
      whole_words: true,
    }
  }

  pub(crate) const fn word_case_sensitive(text: String) -> Self {
    Self {
      text,
      case_insensitive: false,
      whole_words: true,
    }
  }

  pub(crate) const fn symbol(text: String) -> Self {
    Self {
      text,
      case_insensitive: false,
      whole_words: false,
    }
  }
}

pub(crate) trait AnchoredRule {
  fn anchor_terms(&self) -> Vec<AnchorTerm>;

  fn extract(
    &self,
    full_text: &str,
    anchor: AnchorSpan,
  ) -> Result<Vec<PipelineEntity>>;
}

pub(crate) struct AnchoredExtractor<R> {
  rule: R,
}

impl<R: AnchoredRule> AnchoredExtractor<R> {
  pub(crate) fn new(rule: R) -> Option<Self> {
    let anchors = rule.anchor_terms();
    if anchors.is_empty() {
      return None;
    }

    Some(Self { rule })
  }

  pub(crate) fn anchor_terms(&self) -> Vec<AnchorTerm> {
    self.rule.anchor_terms()
  }

  pub(crate) fn extract(
    &self,
    full_text: &str,
    anchors: &[AnchorSpan],
  ) -> Result<Vec<PipelineEntity>> {
    let mut entities = Vec::new();
    for anchor in anchors {
      entities.extend(self.rule.extract(full_text, *anchor)?);
    }
    Ok(select_anchored_entities(entities))
  }

  pub(crate) const fn rule(&self) -> &R {
    &self.rule
  }
}

const fn shared_anchor_pattern(pattern: String) -> SearchPattern {
  SearchPattern::LiteralWithOptions {
    pattern,
    case_insensitive: Some(true),
    whole_words: Some(false),
  }
}

#[cfg(test)]
fn anchor_pattern(anchor: AnchorTerm) -> SearchPattern {
  SearchPattern::LiteralWithOptions {
    pattern: anchor.text,
    case_insensitive: Some(anchor.case_insensitive),
    whole_words: Some(anchor.whole_words),
  }
}

fn anchor_span(found: &SearchMatch) -> AnchorSpan {
  AnchorSpan {
    start: usize::try_from(found.start()).unwrap_or(usize::MAX),
    end: usize::try_from(found.end()).unwrap_or(usize::MAX),
  }
}

fn is_whole_word(full_text: &str, span: AnchorSpan) -> bool {
  // Keep this predicate aligned with stella-aho-corasick's Unicode whole-word
  // contract. The shared search deliberately returns a superset, then applies
  // each anchor owner's original boundary policy without another text scan.
  let starts_with_cjk = full_text
    .get(span.start..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(is_cjk);
  let ends_with_cjk = full_text
    .get(..span.end)
    .and_then(|head| head.chars().next_back())
    .is_some_and(is_cjk);
  let word_before = full_text
    .get(..span.start)
    .and_then(|head| head.chars().next_back())
    .is_some_and(is_unicode_word_char);
  let word_after = full_text
    .get(span.end..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(is_unicode_word_char);
  (!word_before || starts_with_cjk) && (!word_after || ends_with_cjk)
}

fn is_unicode_word_char(ch: char) -> bool {
  ch.is_alphanumeric() && !is_cjk(ch)
}

fn is_cjk(ch: char) -> bool {
  matches!(u32::from(ch),
    0x3040..=0x309F
    | 0x30A0..=0x30FF
    | 0x3400..=0x4DBF
    | 0x4E00..=0x9FFF
    | 0xAC00..=0xD7AF
    | 0xF900..=0xFAFF
    | 0x20000..=0x2FA1F
    | 0x30000..=0x323AF)
}

fn select_anchored_entities(
  mut entities: Vec<PipelineEntity>,
) -> Vec<PipelineEntity> {
  if entities.len() < 2 {
    return entities;
  }

  entities.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| right.end.cmp(&left.end))
      .then_with(|| left.label.cmp(&right.label))
  });

  let mut selected = Vec::new();
  for entity in entities {
    if selected.iter().any(|existing| {
      same_bucket(existing, &entity) && contains(existing, &entity)
    }) {
      continue;
    }

    selected.retain(|existing| {
      !same_bucket(&entity, existing) || !contains(&entity, existing)
    });
    selected.push(entity);
  }

  selected.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| left.end.cmp(&right.end))
      .then_with(|| left.label.cmp(&right.label))
  });
  selected
}

fn same_bucket(left: &PipelineEntity, right: &PipelineEntity) -> bool {
  left.label == right.label
    && left.source == right.source
    && left.source_detail == right.source_detail
    && left.kind == right.kind
}

const fn contains(outer: &PipelineEntity, inner: &PipelineEntity) -> bool {
  outer.start <= inner.start && outer.end >= inner.end
}

#[cfg(test)]
mod tests {
  use super::*;

  fn legacy_anchors(
    terms: Vec<AnchorTerm>,
    full_text: &str,
  ) -> Result<Vec<AnchorSpan>> {
    let search = SearchIndex::new(
      terms.into_iter().map(anchor_pattern).collect(),
      SearchOptions::default(),
    )?;
    Ok(
      search
        .find_iter(full_text)?
        .iter()
        .map(anchor_span)
        .collect(),
    )
  }

  #[test]
  fn shared_anchor_terms_route_through_one_document_scan() -> Result<()> {
    let search = PreparedAnchoredSearch::new(
      vec![AnchorTerm::word_case_insensitive(String::from("May"))],
      vec![
        AnchorTerm::word_case_insensitive(String::from("May")),
        AnchorTerm::symbol(String::from("$")),
      ],
    )?
    .ok_or_else(|| Error::InvalidStaticData {
      field: "anchored_search",
      reason: String::from("test search must not be empty"),
    })?;

    let document = search.scan("May paid $5")?;

    assert_eq!(document.full_document_scans(), 1);
    assert_eq!(document.date_anchors(), &[AnchorSpan { start: 0, end: 3 }]);
    assert_eq!(
      document.monetary_anchors(),
      &[
        AnchorSpan { start: 0, end: 3 },
        AnchorSpan { start: 9, end: 10 }
      ]
    );
    Ok(())
  }

  #[test]
  fn shared_anchor_scan_preserves_per_owner_match_contracts() -> Result<()> {
    let date_terms =
      vec![AnchorTerm::word_case_insensitive(String::from("May"))];
    let monetary_terms = vec![
      AnchorTerm::word_case_insensitive(String::from("May")),
      AnchorTerm::word_case_sensitive(String::from("USD")),
      AnchorTerm::symbol(String::from("$")),
    ];
    let full_text = "May MAY may xMay Mayx USD usd $ 日本May語 May";
    let expected_dates = legacy_anchors(date_terms.clone(), full_text)?;
    let expected_monetary = legacy_anchors(monetary_terms.clone(), full_text)?;
    let search = PreparedAnchoredSearch::new(date_terms, monetary_terms)?
      .ok_or_else(|| Error::InvalidStaticData {
        field: "anchored_search",
        reason: String::from("test search must not be empty"),
      })?;

    let document = search.scan(full_text)?;

    assert_eq!(document.full_document_scans(), 1);
    assert_eq!(document.date_anchors(), expected_dates);
    assert_eq!(document.monetary_anchors(), expected_monetary);
    Ok(())
  }

  #[test]
  #[ignore = "release-mode full-document scan budget regression check"]
  fn anchored_scan_budget_is_constant_at_one_mibibyte() -> Result<()> {
    const TARGET_BYTES: usize = 1024 * 1024;
    let fixture = "May paid $5 USD. ";
    let repeats = TARGET_BYTES.div_ceil(fixture.len());
    let full_text = fixture.repeat(repeats);
    let date_terms = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]
    .into_iter()
    .map(|term| AnchorTerm::word_case_insensitive(String::from(term)))
    .collect::<Vec<_>>();
    let monetary_terms = vec![
      AnchorTerm::word_case_sensitive(String::from("USD")),
      AnchorTerm::word_case_sensitive(String::from("EUR")),
      AnchorTerm::word_case_sensitive(String::from("GBP")),
      AnchorTerm::word_case_sensitive(String::from("CZK")),
      AnchorTerm::symbol(String::from("$")),
      AnchorTerm::symbol(String::from("€")),
      AnchorTerm::word_case_insensitive(String::from("dollars")),
      AnchorTerm::word_case_insensitive(String::from("euros")),
    ];
    let search = PreparedAnchoredSearch::new(date_terms, monetary_terms)?
      .ok_or_else(|| Error::InvalidStaticData {
        field: "anchored_search",
        reason: String::from("test search must not be empty"),
      })?;
    let document = search.scan(&full_text)?;

    assert_eq!(document.full_document_scans(), 1);
    assert_eq!(document.date_anchors().len(), repeats);
    assert_eq!(document.monetary_anchors().len(), repeats.saturating_mul(2));
    Ok(())
  }
}
