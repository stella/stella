use crate::resolution::ResolutionDocument;
use crate::types::Result;

use super::detector_contract::{StaticDetectorInput, StaticDetectorSpec};

/// Prepared access to one immutable text document.
///
/// Text remains private so a rule can only obtain it through a declared input
/// capability. Additional prepared document views can follow the same gate.
pub(super) struct PreparedDocument<'a> {
  resolution: ResolutionDocument<'a>,
}

impl<'a> PreparedDocument<'a> {
  pub(super) const fn new(text: &'a str) -> Self {
    Self {
      resolution: ResolutionDocument::new(text),
    }
  }

  pub(super) fn text(&self, spec: &StaticDetectorSpec) -> Result<&'a str> {
    spec.require_input(StaticDetectorInput::FullText)?;
    Ok(self.resolution.text())
  }

  pub(super) const fn resolution(&self) -> &ResolutionDocument<'a> {
    &self.resolution
  }

  pub(super) const fn len(&self) -> usize {
    self.resolution.text().len()
  }
}
