//! Caller-supplied detection contract: versioned requests plus offset
//! translation from UTF-16 or character offsets to UTF-8 byte offsets.

use serde::{Deserialize, Serialize};
use stella_anonymize_core::{CallerDetection, CallerDetectionParams};

use crate::error::{ContractError, Result};
use crate::offsets::{CharacterOffsetMap, Utf16OffsetMap};

pub const CALLER_DETECTION_CONTRACT_VERSION: u32 = 2;
pub const CALLER_DETECTION_MAX_COUNT: usize = 1_000_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingCallerDetection {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub score: f64,
  pub provider_id: String,
  pub detection_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BindingCallerDetectionRequest {
  pub version: u32,
  pub detections: Vec<BindingCallerDetection>,
}

pub fn caller_detections_from_binding(
  request: BindingCallerDetectionRequest,
) -> Result<Vec<CallerDetection>> {
  if request.version != CALLER_DETECTION_CONTRACT_VERSION {
    return Err(ContractError::UnsupportedCallerDetectionContractVersion {
      version: request.version,
    });
  }

  request
    .detections
    .into_iter()
    .enumerate()
    .map(|(index, detection)| {
      CallerDetection::new(CallerDetectionParams {
        start: detection.start,
        end: detection.end,
        label: detection.label,
        score: detection.score,
        provider_id: detection.provider_id,
        detection_id: detection.detection_id,
      })
      .map_err(|error| ContractError::InvalidCallerDetection {
        index,
        reason: error.to_string(),
      })
    })
    .collect()
}

pub fn caller_detections_from_utf16_binding(
  mut request: BindingCallerDetectionRequest,
  full_text: &str,
) -> Result<Vec<CallerDetection>> {
  if request.version != CALLER_DETECTION_CONTRACT_VERSION {
    return Err(ContractError::UnsupportedCallerDetectionContractVersion {
      version: request.version,
    });
  }

  let offsets = Utf16OffsetMap::new(full_text)?;
  for (index, detection) in request.detections.iter_mut().enumerate() {
    detection.start =
      offsets.byte_offset(detection.start).map_err(|error| {
        ContractError::InvalidCallerDetection {
          index,
          reason: error.to_string(),
        }
      })?;
    detection.end = offsets.byte_offset(detection.end).map_err(|error| {
      ContractError::InvalidCallerDetection {
        index,
        reason: error.to_string(),
      }
    })?;
  }
  caller_detections_from_binding(request)
}

pub fn caller_detections_from_character_binding(
  mut request: BindingCallerDetectionRequest,
  full_text: &str,
) -> Result<Vec<CallerDetection>> {
  if request.version != CALLER_DETECTION_CONTRACT_VERSION {
    return Err(ContractError::UnsupportedCallerDetectionContractVersion {
      version: request.version,
    });
  }

  let offsets = CharacterOffsetMap::new(full_text)?;
  for (index, detection) in request.detections.iter_mut().enumerate() {
    detection.start =
      offsets.byte_offset(detection.start).map_err(|error| {
        ContractError::InvalidCallerDetection {
          index,
          reason: error.to_string(),
        }
      })?;
    detection.end = offsets.byte_offset(detection.end).map_err(|error| {
      ContractError::InvalidCallerDetection {
        index,
        reason: error.to_string(),
      }
    })?;
  }
  caller_detections_from_binding(request)
}

#[cfg(test)]
mod tests {
  #![allow(clippy::unwrap_used)]

  use super::{
    BindingCallerDetection, BindingCallerDetectionRequest,
    CALLER_DETECTION_CONTRACT_VERSION, caller_detections_from_binding,
    caller_detections_from_utf16_binding,
  };
  use crate::error::ContractError;

  #[test]
  fn caller_detection_contract_is_versioned_and_validated() {
    let detections =
      caller_detections_from_binding(BindingCallerDetectionRequest {
        version: CALLER_DETECTION_CONTRACT_VERSION,
        detections: vec![BindingCallerDetection {
          start: 0,
          end: 5,
          label: String::from("person"),
          score: 0.9,
          provider_id: String::from("test-provider"),
          detection_id: String::from("person-1"),
        }],
      })
      .unwrap();

    assert_eq!(detections.len(), 1);

    let error = caller_detections_from_binding(BindingCallerDetectionRequest {
      version: CALLER_DETECTION_CONTRACT_VERSION + 1,
      detections: Vec::new(),
    })
    .unwrap_err();
    assert_eq!(
      error,
      ContractError::UnsupportedCallerDetectionContractVersion {
        version: CALLER_DETECTION_CONTRACT_VERSION + 1,
      }
    );
  }

  #[test]
  fn caller_detection_contract_reports_the_invalid_item_index() {
    let error = caller_detections_from_binding(BindingCallerDetectionRequest {
      version: CALLER_DETECTION_CONTRACT_VERSION,
      detections: vec![BindingCallerDetection {
        start: 2,
        end: 2,
        label: String::from("person"),
        score: 0.9,
        provider_id: String::from("test-provider"),
        detection_id: String::from("person-1"),
      }],
    })
    .unwrap_err();

    assert!(matches!(
      error,
      ContractError::InvalidCallerDetection { index: 0, .. }
    ));
  }

  #[test]
  fn caller_detection_contract_rejects_offsets_inside_utf16_surrogate_pairs() {
    let error = caller_detections_from_utf16_binding(
      BindingCallerDetectionRequest {
        version: CALLER_DETECTION_CONTRACT_VERSION,
        detections: vec![BindingCallerDetection {
          start: 1,
          end: 2,
          label: String::from("person"),
          score: 0.9,
          provider_id: String::from("test-provider"),
          detection_id: String::from("person-1"),
        }],
      },
      "😀Alice",
    )
    .unwrap_err();

    assert!(matches!(
      error,
      ContractError::InvalidCallerDetection { index: 0, .. }
    ));
  }
}
