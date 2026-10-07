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
pub struct FeatureGates(RwLock<HashSet<DesktopFeature>>);

impl FeatureGates {
  /// Off whenever the decision cannot be read: the gate fails closed.
  pub fn is_enabled(&self, feature: DesktopFeature) -> bool {
    self
      .0
      .read()
      .is_ok_and(|enabled| enabled.contains(&feature))
  }

  /// Installs a fresh decision set and returns the features whose state
  /// changed.
  pub fn replace(&self, enabled: HashSet<DesktopFeature>) -> Vec<DesktopFeature> {
    let Ok(mut current) = self.0.write() else {
      return Vec::new();
    };
    let changed = DesktopFeature::ALL
      .iter()
      .copied()
      .filter(|feature| current.contains(feature) != enabled.contains(feature))
      .collect();
    *current = enabled;
    changed
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

  #[test]
  fn identifiers_round_trip() {
    for feature in DesktopFeature::ALL {
      assert_eq!(DesktopFeature::from_id(feature.id()), Some(*feature));
    }
    assert_eq!(DesktopFeature::from_id("unknown"), None);
  }
}
