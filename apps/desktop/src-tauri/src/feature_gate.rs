//! Which server-gated desktop features exist right now.
//!
//! The decision lives in memory only and starts closed: a feature is on only
//! after the server said `enabled` for the linked account in this process.
//! This module holds no network code; `feature_access` fetches decisions and
//! writes them here, and features read them without reaching the network.

use std::{collections::HashSet, sync::RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DesktopFeature {
  ActivityTimeline,
}

impl DesktopFeature {
  pub const ALL: &'static [Self] = &[Self::ActivityTimeline];

  /// The identifier the feature-access contract uses.
  pub const fn id(self) -> &'static str {
    match self {
      Self::ActivityTimeline => "activity-timeline",
    }
  }

  pub fn from_id(id: &str) -> Option<Self> {
    Self::ALL.iter().copied().find(|feature| feature.id() == id)
  }
}

#[derive(Default)]
struct GateState {
  generation: u64,
  namespace: Option<String>,
  expires_at: Option<chrono::DateTime<chrono::Utc>>,
  enabled: HashSet<DesktopFeature>,
}

#[derive(Default)]
pub struct FeatureGates(RwLock<GateState>);

impl FeatureGates {
  /// Off whenever the decision cannot be read or its account expired.
  pub fn is_enabled(&self, feature: DesktopFeature) -> bool {
    self.0.read().is_ok_and(|state| {
      state
        .expires_at
        .is_some_and(|expires| expires > chrono::Utc::now())
        && state.enabled.contains(&feature)
    })
  }

  pub fn generation(&self) -> Option<u64> {
    self.0.read().ok().map(|state| state.generation)
  }

  pub fn account_binding(&self, feature: DesktopFeature) -> Option<(u64, String)> {
    let state = self.0.read().ok()?;
    if !state.enabled.contains(&feature)
      || state
        .expires_at
        .is_none_or(|expires| expires <= chrono::Utc::now())
    {
      return None;
    }
    Some((state.generation, state.namespace.clone()?))
  }

  /// Closing access and superseding in-flight requests is one atomic change.
  pub fn invalidate(&self) {
    if let Ok(mut state) = self.0.write() {
      state.generation = state.generation.wrapping_add(1);
      state.namespace = None;
      state.expires_at = None;
      state.enabled.clear();
    }
  }

  /// A response can be installed only in the generation that requested it.
  pub fn install(
    &self,
    generation: u64,
    namespace: Option<String>,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
    enabled: HashSet<DesktopFeature>,
  ) -> Option<Vec<DesktopFeature>> {
    let mut state = self.0.write().ok()?;
    if generation != state.generation {
      return None;
    }
    let enabled = if namespace.is_some()
      && expires_at.is_some_and(|expires| expires > chrono::Utc::now())
    {
      enabled
    } else {
      HashSet::new()
    };
    let changed = DesktopFeature::ALL
      .iter()
      .copied()
      .filter(|feature| state.enabled.contains(feature) != enabled.contains(feature))
      .collect();
    state.namespace = namespace;
    state.expires_at = expires_at;
    state.enabled = enabled;
    Some(changed)
  }

  #[cfg(test)]
  fn replace(&self, enabled: HashSet<DesktopFeature>) -> Vec<DesktopFeature> {
    self
      .install(
        self.generation().unwrap(),
        Some("fixture".into()),
        Some(chrono::Utc::now() + chrono::Duration::hours(1)),
        enabled,
      )
      .unwrap()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn features_start_closed_and_report_only_changes() {
    let gates = FeatureGates::default();
    assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));

    let on = HashSet::from([DesktopFeature::ActivityTimeline]);
    assert_eq!(
      gates.replace(on.clone()),
      [DesktopFeature::ActivityTimeline]
    );
    assert!(gates.is_enabled(DesktopFeature::ActivityTimeline));
    assert!(gates.replace(on).is_empty());
    assert_eq!(
      gates.replace(HashSet::new()),
      [DesktopFeature::ActivityTimeline]
    );
    assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));
  }

  #[tokio::test]
  async fn delayed_account_decisions_cannot_reopen_after_unlink_or_relink() {
    for replacement in [
      None,
      Some(HashSet::new()),
      Some(HashSet::from([DesktopFeature::ActivityTimeline])),
    ] {
      let gates = std::sync::Arc::new(FeatureGates::default());
      let generation_a = gates.generation().unwrap();
      let expiry = Some(chrono::Utc::now() + chrono::Duration::hours(1));
      gates
        .install(
          generation_a,
          Some("a".into()),
          expiry,
          HashSet::from([DesktopFeature::ActivityTimeline]),
        )
        .unwrap();
      let (complete, delayed) = tokio::sync::oneshot::channel();
      let stale_gates = std::sync::Arc::clone(&gates);
      let stale = tokio::spawn(async move {
        delayed.await.unwrap();
        stale_gates.install(
          generation_a,
          Some("a".into()),
          expiry,
          HashSet::from([DesktopFeature::ActivityTimeline]),
        )
      });
      gates.invalidate();
      assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));
      assert!(
        gates
          .account_binding(DesktopFeature::ActivityTimeline)
          .is_none()
      );
      if let Some(decision) = replacement.as_ref() {
        gates
          .install(
            gates.generation().unwrap(),
            Some("b".into()),
            expiry,
            decision.clone(),
          )
          .unwrap();
      }
      complete.send(()).unwrap();
      assert!(stale.await.unwrap().is_none());
      let expected = replacement
        .is_some_and(|decision| decision.contains(&DesktopFeature::ActivityTimeline));
      assert_eq!(gates.is_enabled(DesktopFeature::ActivityTimeline), expected);
      if expected {
        assert_eq!(
          gates
            .account_binding(DesktopFeature::ActivityTimeline)
            .unwrap()
            .1,
          "b"
        );
      }
    }
  }

  #[test]
  fn identifiers_round_trip() {
    for feature in DesktopFeature::ALL {
      assert_eq!(DesktopFeature::from_id(feature.id()), Some(*feature));
    }
    assert_eq!(DesktopFeature::from_id("unknown"), None);
  }
}
