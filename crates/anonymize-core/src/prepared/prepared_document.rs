use crate::types::Result;

use super::detector_contract::{StaticDetectorInput, StaticDetectorSpec};

/// Prepared access to one immutable text document.
///
/// Text remains private so a rule can only obtain it through a declared input
/// capability. Additional prepared document views can follow the same gate.
pub(super) struct PreparedDocument<'a> {
  text: &'a str,
}

impl<'a> PreparedDocument<'a> {
  pub(super) const fn new(text: &'a str) -> Self {
    Self { text }
  }

  pub(super) fn text(&self, spec: &StaticDetectorSpec) -> Result<&'a str> {
    spec.require_input(StaticDetectorInput::FullText)?;
    Ok(self.text)
  }

  pub(super) const fn len(&self) -> usize {
    self.text.len()
  }
}
