#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct IndexedSpan<T> {
  start: u32,
  end: u32,
  value: T,
}

/// Immutable spatial index for repeated queries over byte-offset spans.
///
/// Construction sorts once by start offset. Intersection queries use a
/// max-end tree, making accidental entity-by-entity rescans unnecessary at
/// detector call sites.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SpanIndex<T> {
  spans: Vec<IndexedSpan<T>>,
  ends: Vec<(u32, usize)>,
  max_end_tree: Vec<u32>,
  leaf_count: usize,
}

trait VisitWork {
  fn observe_node(&mut self);
}

struct UnmeasuredVisitWork;

impl VisitWork for UnmeasuredVisitWork {
  #[inline]
  fn observe_node(&mut self) {}
}

struct VisitState<'a, W, F> {
  work: &'a mut W,
  visit: &'a mut F,
}

#[cfg(test)]
#[derive(Default)]
struct MeasuredVisitWork {
  nodes: usize,
}

#[cfg(test)]
impl VisitWork for MeasuredVisitWork {
  fn observe_node(&mut self) {
    self.nodes = self.nodes.saturating_add(1);
  }
}

impl<T> SpanIndex<T> {
  pub(crate) fn new(spans: impl IntoIterator<Item = (u32, u32, T)>) -> Self {
    let mut spans = spans
      .into_iter()
      .map(|(start, end, value)| IndexedSpan { start, end, value })
      .collect::<Vec<_>>();
    spans.sort_by_key(|span| span.start);

    let mut ends = spans
      .iter()
      .enumerate()
      .map(|(index, span)| (span.end, index))
      .collect::<Vec<_>>();
    ends.sort_unstable_by_key(|(end, _)| *end);

    let leaf_count = spans.len().max(1).next_power_of_two();
    let mut max_end_tree = vec![0; leaf_count.saturating_mul(2)];
    for (index, span) in spans.iter().enumerate() {
      if let Some(leaf) = max_end_tree.get_mut(leaf_count.saturating_add(index))
      {
        *leaf = span.end;
      }
    }
    for index in (1..leaf_count).rev() {
      let left = max_end_tree
        .get(index.saturating_mul(2))
        .copied()
        .unwrap_or_default();
      let right = max_end_tree
        .get(index.saturating_mul(2).saturating_add(1))
        .copied()
        .unwrap_or_default();
      if let Some(node) = max_end_tree.get_mut(index) {
        *node = left.max(right);
      }
    }

    Self {
      spans,
      ends,
      max_end_tree,
      leaf_count,
    }
  }

  pub(crate) fn any_overlapping(&self, start: u32, end: u32) -> bool {
    if start >= end {
      return false;
    }
    let candidate_end = self.spans.partition_point(|span| span.start < end);
    self.range_max_end(0, candidate_end) > start
  }

  pub(crate) fn any_starting_in_with_end_after(
    &self,
    start: u32,
    end: u32,
    minimum_end: u32,
  ) -> bool {
    if start >= end {
      return false;
    }
    let first = self.spans.partition_point(|span| span.start < start);
    let last = self.spans.partition_point(|span| span.start < end);
    self.range_max_end(first, last) > minimum_end
  }

  pub(crate) fn nearest_start_after(&self, offset: u32) -> Option<u32> {
    let index = self.spans.partition_point(|span| span.start <= offset);
    self.spans.get(index).map(|span| span.start)
  }

  pub(crate) fn nearest_end_at_or_before(&self, offset: u32) -> Option<u32> {
    self
      .find_ending_at_or_before(offset, |_, _| true)
      .map(|(end, _)| end)
  }

  pub(crate) fn find_ending_at_or_before(
    &self,
    offset: u32,
    mut predicate: impl FnMut(u32, &T) -> bool,
  ) -> Option<(u32, &T)> {
    let end = self.ends.partition_point(|(end, _)| *end <= offset);
    self.ends.get(..end)?.iter().rev().find_map(|(end, index)| {
      let span = self.spans.get(*index)?;
      predicate(*end, &span.value).then_some((*end, &span.value))
    })
  }

  /// Visits spans intersecting the closed query range in stable start order.
  pub(crate) fn try_for_each_intersecting<E>(
    &self,
    start: u32,
    end: u32,
    mut visit: impl FnMut(&T) -> std::result::Result<(), E>,
  ) -> std::result::Result<(), E> {
    self.try_for_each_intersecting_with_work(
      start,
      end,
      &mut UnmeasuredVisitWork,
      &mut visit,
    )
  }

  fn try_for_each_intersecting_with_work<E>(
    &self,
    start: u32,
    end: u32,
    work: &mut impl VisitWork,
    visit: &mut impl FnMut(&T) -> std::result::Result<(), E>,
  ) -> std::result::Result<(), E> {
    if start > end || self.spans.is_empty() {
      return Ok(());
    }
    let candidate_end = self.spans.partition_point(|span| span.start <= end);
    let mut state = VisitState { work, visit };
    self.visit_tree(1, 0, self.leaf_count, candidate_end, start, &mut state)
  }

  fn visit_tree<E, W: VisitWork, F: FnMut(&T) -> std::result::Result<(), E>>(
    &self,
    node: usize,
    left: usize,
    right: usize,
    candidate_end: usize,
    minimum_end: u32,
    state: &mut VisitState<'_, W, F>,
  ) -> std::result::Result<(), E> {
    state.work.observe_node();
    if left >= candidate_end
      || self.max_end_tree.get(node).copied().unwrap_or_default() < minimum_end
    {
      return Ok(());
    }
    if right.saturating_sub(left) == 1 {
      if let Some(span) = self.spans.get(left) {
        (state.visit)(&span.value)?;
      }
      return Ok(());
    }

    let midpoint = left.saturating_add(right).saturating_div(2);
    self.visit_tree(
      node.saturating_mul(2),
      left,
      midpoint,
      candidate_end,
      minimum_end,
      state,
    )?;
    self.visit_tree(
      node.saturating_mul(2).saturating_add(1),
      midpoint,
      right,
      candidate_end,
      minimum_end,
      state,
    )
  }

  #[cfg(test)]
  pub(crate) fn intersecting_query_work(&self, start: u32, end: u32) -> usize {
    let mut work = MeasuredVisitWork::default();
    let result = self.try_for_each_intersecting_with_work(
      start,
      end,
      &mut work,
      &mut |_| Ok::<_, ()>(()),
    );
    debug_assert!(result.is_ok(), "the test visitor is infallible");
    work.nodes
  }

  fn range_max_end(&self, start: usize, end: usize) -> u32 {
    let mut left = self.leaf_count.saturating_add(start);
    let mut right = self.leaf_count.saturating_add(end);
    let mut max_end = 0_u32;
    while left < right {
      if left % 2 == 1 {
        max_end =
          max_end.max(self.max_end_tree.get(left).copied().unwrap_or_default());
        left = left.saturating_add(1);
      }
      if right % 2 == 1 {
        right = right.saturating_sub(1);
        max_end = max_end
          .max(self.max_end_tree.get(right).copied().unwrap_or_default());
      }
      left /= 2;
      right /= 2;
    }
    max_end
  }
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::SpanIndex;

  proptest! {
    #[test]
    fn indexed_queries_match_linear_scans(
      ranges in proptest::collection::vec((any::<u16>(), any::<u16>()), 0..512),
      first in any::<u16>(),
      second in any::<u16>(),
    ) {
      let spans = ranges
        .iter()
        .enumerate()
        .map(|(index, (left, right))| {
          (u32::from(*left), u32::from(*right), index)
        })
        .collect::<Vec<_>>();
      let index = SpanIndex::new(spans.clone());
      let start = u32::from(first.min(second));
      let end = u32::from(first.max(second));

      let expected_overlap = spans.iter().any(|(span_start, span_end, _)| {
        *span_start < end && *span_end > start
      });
      prop_assert_eq!(index.any_overlapping(start, end), expected_overlap);

      let expected_starting = spans.iter().any(|(span_start, span_end, _)| {
        *span_start >= start && *span_start < end && *span_end > start
      });
      prop_assert_eq!(
        index.any_starting_in_with_end_after(start, end, start),
        expected_starting,
      );

      let expected_right = spans
        .iter()
        .filter_map(|(span_start, _, _)| (*span_start > start).then_some(*span_start))
        .min();
      prop_assert_eq!(index.nearest_start_after(start), expected_right);

      let expected_left = spans
        .iter()
        .filter_map(|(_, span_end, _)| (*span_end <= start).then_some(*span_end))
        .max();
      prop_assert_eq!(index.nearest_end_at_or_before(start), expected_left);

      let mut actual = Vec::new();
      let visit_result = index
        .try_for_each_intersecting(start, end, |value| {
          actual.push(*value);
          Ok::<_, ()>(())
        });
      prop_assert_eq!(visit_result, Ok(()));
      let mut expected_spans = spans
        .iter()
        .filter(|(span_start, span_end, _)| {
          *span_start <= end && *span_end >= start
        })
        .collect::<Vec<_>>();
      expected_spans.sort_by_key(|(span_start, _, _)| *span_start);
      let expected = expected_spans
        .into_iter()
        .map(|(_, _, value)| *value)
        .collect::<Vec<_>>();
      prop_assert_eq!(actual, expected);
    }
  }
}
