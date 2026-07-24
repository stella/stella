#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct FindingSpan {
  pub(super) start: u32,
  pub(super) end: u32,
}

impl FindingSpan {
  pub(super) const fn new(start: u32, end: u32) -> Option<Self> {
    if start <= end {
      Some(Self { start, end })
    } else {
      None
    }
  }
}

pub(super) trait SpannedFinding {
  fn finding_span(&self) -> Option<FindingSpan>;
}

/// A checked span view over a rule result.
///
/// Rules may use domain-specific payloads, while the execution substrate only
/// requires a monotonic span before accepting the result.
pub(super) struct Finding<'a, Value> {
  value: &'a Value,
  span: FindingSpan,
}

impl<'a, Value: SpannedFinding> Finding<'a, Value> {
  pub(super) fn new(value: &'a Value) -> Option<Self> {
    Some(Self {
      span: value.finding_span()?,
      value,
    })
  }

  pub(super) const fn value(&self) -> &'a Value {
    self.value
  }

  pub(super) const fn span(&self) -> FindingSpan {
    self.span
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  struct TestValue {
    start: u32,
    end: u32,
  }

  impl SpannedFinding for TestValue {
    fn finding_span(&self) -> Option<FindingSpan> {
      FindingSpan::new(self.start, self.end)
    }
  }

  #[test]
  fn finding_rejects_reversed_spans() {
    let valid = TestValue { start: 2, end: 4 };
    let Some(finding) = Finding::new(&valid) else {
      return;
    };
    assert_eq!(finding.span(), FindingSpan { start: 2, end: 4 });
    assert_eq!(finding.value().start, valid.start);
    assert_eq!(finding.value().end, valid.end);
    assert!(Finding::new(&TestValue { start: 4, end: 2 }).is_none());
  }
}
