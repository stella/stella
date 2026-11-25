//! The member's matter rules and the weights this computer learned from their
//! confirmed entries (`apps/desktop/src/activity/matter-learning.ts` computes
//! them). Held only in the account's encrypted activity store, never sent
//! anywhere, and naming matters by id only. Each save names the revision it
//! read, so the activity window and Settings never overwrite each other.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
  activity::{self, ActivityAppState},
  activity_commands::lock_error,
  activity_store::ActivityStore,
  local_window::{
    ActivityAccountFeature, ActivityCaller, ActivitySettingsCaller, LocalCaller,
  },
};

// The bounds `MATTER_LEARNING_LIMITS` in `matter-learning.ts` states.
const MAX_RULES: usize = 200;
const MAX_LEARNED: usize = 5000;
const MAX_TALLIES: usize = 500;
const MAX_VALUE_CHARS: usize = 512;
const MAX_TOKEN_CHARS: usize = 128;
const MAX_ID_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatterRuleField {
  Title,
  DocumentPath,
  App,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatterRuleOp {
  Contains,
  StartsWith,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TallyStatus {
  Counting,
  Declined,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatterRule {
  id: String,
  field: MatterRuleField,
  op: MatterRuleOp,
  value: String,
  matter_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearnedAssociation {
  token: String,
  matter_id: String,
  weight: f64,
  at_ms: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceTally {
  field: MatterRuleField,
  op: MatterRuleOp,
  value: String,
  matter_id: String,
  count: u32,
  status: TallyStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatterLearning {
  rules: Vec<MatterRule>,
  learned: Vec<LearnedAssociation>,
  tallies: Vec<EvidenceTally>,
}

/// What the store holds: the learning and the revision every save advances.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMatterLearning {
  revision: u64,
  learning: MatterLearning,
}

#[cfg(test)]
impl StoredMatterLearning {
  pub fn fixture() -> Self {
    Self {
      revision: 3,
      learning: MatterLearning {
        rules: vec![MatterRule {
          id: "rule".into(),
          field: MatterRuleField::DocumentPath,
          op: MatterRuleOp::StartsWith,
          value: "/Matters/2024-017/".into(),
          matter_id: "00000000-0000-4000-8000-000000000001".into(),
        }],
        learned: vec![LearnedAssociation {
          token: "novák".into(),
          matter_id: "00000000-0000-4000-8000-000000000001".into(),
          weight: 1.5,
          at_ms: 1_790_000_000_000.0,
        }],
        tallies: vec![],
      },
    }
  }
}

fn is_valid_id(id: &str) -> bool {
  !id.is_empty() && id.len() <= MAX_ID_BYTES && !id.chars().any(char::is_control)
}

fn is_valid_value(value: &str, max_chars: usize) -> bool {
  !value.trim().is_empty()
    && value.chars().count() <= max_chars
    && !value.chars().any(char::is_control)
}

fn validate_rules(rules: &[MatterRule]) -> Result<(), String> {
  let valid = rules.len() <= MAX_RULES
    && rules.iter().all(|rule| {
      is_valid_id(&rule.id)
        && is_valid_id(&rule.matter_id)
        && is_valid_value(&rule.value, MAX_VALUE_CHARS)
    });
  if valid {
    Ok(())
  } else {
    Err("invalid matter rules".into())
  }
}

impl MatterLearning {
  fn validate(&self) -> Result<(), String> {
    validate_rules(&self.rules)?;
    let learned = self.learned.len() <= MAX_LEARNED
      && self.learned.iter().all(|association| {
        is_valid_id(&association.matter_id)
          && is_valid_value(&association.token, MAX_TOKEN_CHARS)
          && association.weight.is_finite()
          && association.weight >= 0.0
          && association.at_ms.is_finite()
      });
    let tallies = self.tallies.len() <= MAX_TALLIES
      && self.tallies.iter().all(|tally| {
        is_valid_id(&tally.matter_id) && is_valid_value(&tally.value, MAX_VALUE_CHARS)
      });
    if learned && tallies {
      Ok(())
    } else {
      Err("invalid matter learning".into())
    }
  }
}

/// A read of the learning. `Unavailable` when history is not kept in the
/// encrypted store (memory only, or being recovered): nothing is learned
/// then, and nothing is read as empty in its place.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MatterLearningRead {
  Stored {
    revision: u64,
    learning: MatterLearning,
  },
  Unavailable,
}

/// The rules alone, for Settings: never the learned weights, which come from
/// window titles.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MatterRulesRead {
  Stored {
    revision: u64,
    rules: Vec<MatterRule>,
  },
  Unavailable,
}

/// A save's outcome: `Conflict` when another window saved since the read the
/// change was made from; the caller reads again and reapplies its change.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MatterLearningSave {
  Saved { revision: u64 },
  Conflict,
  Unavailable,
}

fn read<F: ActivityAccountFeature>(
  app: &AppHandle,
  state: &ActivityAppState,
  caller: &LocalCaller<F>,
) -> Result<Option<StoredMatterLearning>, String> {
  // Saves replace the file whole, so a read needs no lock once it has the
  // store.
  let store = {
    let manager = state.lock().map_err(lock_error)?;
    caller.require_current(app)?;
    manager.require_caller(caller)?;
    manager.encrypted_store().cloned()
  };
  let Some(store) = store else {
    return Ok(None);
  };
  let stored =
    store
      .load_matter_learning_checked()
      .map_err(crate::logging::with_cause_logged(
        "matter learning is unavailable",
      ))?;
  Ok(Some(stored.unwrap_or_default()))
}

/// Applies `change` to the stored learning if it is still at `revision`.
/// The caller holds the activity lock, so no other save interleaves.
fn save_locked(
  store: &ActivityStore,
  revision: u64,
  change: impl FnOnce(&mut MatterLearning),
) -> Result<MatterLearningSave, String> {
  let mut stored = store
    .load_matter_learning_checked()
    .map_err(crate::logging::with_cause_logged(
      "matter learning is unavailable",
    ))?
    .unwrap_or_default();
  if stored.revision != revision {
    return Ok(MatterLearningSave::Conflict);
  }
  change(&mut stored.learning);
  stored.learning.validate()?;
  stored.revision += 1;
  store.save_matter_learning(&stored)?;
  Ok(MatterLearningSave::Saved {
    revision: stored.revision,
  })
}

fn save<F: ActivityAccountFeature>(
  app: &AppHandle,
  state: &ActivityAppState,
  caller: &LocalCaller<F>,
  revision: u64,
  change: impl FnOnce(&mut MatterLearning),
) -> Result<MatterLearningSave, String> {
  let outcome = {
    let manager = state.lock().map_err(lock_error)?;
    caller.require_current(app)?;
    manager.require_caller(caller)?;
    match manager.encrypted_store() {
      Some(store) => save_locked(store, revision, change)?,
      None => MatterLearningSave::Unavailable,
    }
  };
  if matches!(outcome, MatterLearningSave::Saved { .. }) {
    activity::emit_changed(app);
  }
  Ok(outcome)
}

#[tauri::command]
pub fn activity_get_matter_learning(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
) -> Result<MatterLearningRead, String> {
  Ok(match read(&app, &state, &caller)? {
    Some(stored) => MatterLearningRead::Stored {
      revision: stored.revision,
      learning: stored.learning,
    },
    None => MatterLearningRead::Unavailable,
  })
}

#[tauri::command]
pub fn activity_save_matter_learning(
  caller: ActivityCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  revision: u64,
  learning: MatterLearning,
) -> Result<MatterLearningSave, String> {
  learning.validate()?;
  save(&app, &state, &caller, revision, |stored| *stored = learning)
}

#[tauri::command]
pub fn activity_get_matter_rules(
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
) -> Result<MatterRulesRead, String> {
  Ok(match read(&app, &state, &caller)? {
    Some(stored) => MatterRulesRead::Stored {
      revision: stored.revision,
      rules: stored.learning.rules,
    },
    None => MatterRulesRead::Unavailable,
  })
}

/// Replaces the rules only; what was learned stays.
#[tauri::command]
pub fn activity_save_matter_rules(
  caller: ActivitySettingsCaller,
  app: AppHandle,
  state: State<'_, ActivityAppState>,
  revision: u64,
  rules: Vec<MatterRule>,
) -> Result<MatterLearningSave, String> {
  validate_rules(&rules)?;
  save(&app, &state, &caller, revision, |stored| {
    stored.rules = rules;
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn learning_crosses_the_boundary_as_the_desktop_spells_it() {
    let stored = StoredMatterLearning::fixture();
    let json = serde_json::to_value(&stored).unwrap();
    assert_eq!(json["learning"]["rules"][0]["field"], "documentPath");
    assert_eq!(json["learning"]["rules"][0]["op"], "startsWith");
    assert_eq!(json["learning"]["learned"][0]["atMs"], 1_790_000_000_000.0);
    let parsed: StoredMatterLearning = serde_json::from_value(json).unwrap();
    assert_eq!(parsed, stored);
  }

  #[test]
  fn oversized_or_malformed_learning_is_refused() {
    let mut learning = StoredMatterLearning::fixture().learning;
    assert!(learning.validate().is_ok());
    learning.learned[0].weight = f64::NAN;
    assert!(learning.validate().is_err());
    let mut learning = StoredMatterLearning::fixture().learning;
    learning.rules[0].value = " ".into();
    assert!(learning.validate().is_err());
    let rule = learning.rules[0].clone();
    assert!(validate_rules(&vec![rule; MAX_RULES + 1]).is_err());
    assert!(
      serde_json::from_value::<MatterLearning>(serde_json::json!({
        "rules": [], "learned": [], "tallies": [], "titles": []
      }))
      .is_err()
    );
  }
}
