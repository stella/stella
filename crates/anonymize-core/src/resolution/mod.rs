mod boundary;
mod common;
mod document;
mod merge;
mod sanitize;
mod types;

pub(crate) use boundary::enforce_boundary_consistency_with_document;
pub use boundary::{BoundaryParams, enforce_boundary_consistency};
pub(crate) use document::ResolutionDocument;
pub use merge::merge_and_dedup;
pub use sanitize::sanitize_entities;
pub(crate) use sanitize::sanitize_entities_with_document;
pub use types::{
  CallerDetection, CallerDetectionParams, CallerProvenance, DetectionSource,
  PipelineEntity, SourceDetail,
};
