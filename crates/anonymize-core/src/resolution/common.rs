use super::{DetectionSource, PipelineEntity, SourceDetail};

#[cfg(test)]
pub(crate) const fn contains_span(
  outer: &PipelineEntity,
  inner: &PipelineEntity,
) -> bool {
  outer.start <= inner.start && outer.end >= inner.end
}

pub(crate) const fn entity_len(entity: &PipelineEntity) -> u32 {
  entity.end.saturating_sub(entity.start)
}

pub(crate) const fn is_caller_owned(entity: &PipelineEntity) -> bool {
  matches!(entity.source, DetectionSource::Caller)
    || matches!(
      entity.source_detail,
      Some(SourceDetail::CustomDenyList | SourceDetail::CustomRegex)
    )
}

pub(crate) fn byte_len(text: &str) -> u32 {
  u32::try_from(text.len()).unwrap_or(u32::MAX)
}
