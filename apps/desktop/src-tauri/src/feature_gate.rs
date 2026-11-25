//! Which server-gated desktop features exist right now, and why one is off.
//!
//! The decision lives in memory only and starts undecided: a feature is on
//! only after the server said `enabled` for the linked account in this
//! process. This module holds no network code; `feature_access` reads
//! decisions and writes them here, and features read them without reaching
//! the network.

use std::{collections::HashSet, num::NonZeroUsize, sync::RwLock};

use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DesktopFeature {
  ActivityTimeline,
  Dictation,
  /// Transcription by stella AI; the audio leaves the computer.
  DictationCloud,
  /// Transcription models whose provider keeps the audio. The server lists
  /// and refuses them; the desktop only refreshes its model list.
  DictationRetainingModels,
  LocalAgents,
}

impl DesktopFeature {
  pub const ALL: &'static [Self] = &[
    Self::ActivityTimeline,
    Self::Dictation,
    Self::DictationCloud,
    Self::DictationRetainingModels,
    Self::LocalAgents,
  ];

  /// The identifier the feature-access contract uses.
  pub const fn id(self) -> &'static str {
    match self {
      Self::ActivityTimeline => "activity-timeline",
      Self::Dictation => "desktop-dictation",
      Self::DictationCloud => "desktop-dictation-cloud",
      Self::DictationRetainingModels => "desktop-dictation-retaining-models",
      Self::LocalAgents => "local-agents",
    }
  }

  pub fn from_id(id: &str) -> Option<Self> {
    Self::ALL.iter().copied().find(|feature| feature.id() == id)
  }
}

/// What one read learned about the linked account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountDecision {
  /// No account is linked.
  SignedOut,
  /// The saved link cannot be used until the member links again: this
  /// computer's device proof is gone, or the server refused the credential.
  /// The namespace is known when the saved account could be read.
  ReconnectNeeded { namespace: Option<String> },
  /// The saved account was read but the server was not reached since it was
  /// linked or the app started. Nothing is enabled; a feature that may act
  /// on a remembered grant (Activity's local recording) decides for itself.
  Unconfirmed {
    namespace: String,
    expires_at: DateTime<Utc>,
  },
  /// The server answered for this account. A feature it did not enable,
  /// including every feature after an explicit refusal, is not available.
  Answered {
    namespace: String,
    expires_at: DateTime<Utc>,
    enabled: HashSet<DesktopFeature>,
  },
}

/// Why a feature is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffReason {
  /// Nothing has been read for the current account yet.
  Undecided,
  /// Managed policy turned it off, whatever the server decides.
  BlockedByPolicy,
  /// No account is linked, or its credential expired.
  SignedOut,
  ReconnectNeeded,
  /// The server did not enable it for this account.
  NotAvailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeatureAccess {
  Enabled,
  Off(OffReason),
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum AccountPhase {
  #[default]
  Ready,
  Changing {
    pending: NonZeroUsize,
  },
}

#[derive(Default)]
enum Decision {
  #[default]
  Undecided,
  Read(AccountDecision),
}

#[derive(Default)]
struct GateState {
  phase: AccountPhase,
  generation: u64,
  decision: Decision,
  /// The features last reported as on. A decision lapses with its credential
  /// without being installed, so changes are reported against what was
  /// applied, not against the old decision read now.
  applied: HashSet<DesktopFeature>,
  /// Off by managed policy, whatever the server decides.
  blocked: HashSet<DesktopFeature>,
}

impl GateState {
  fn access(&self, feature: DesktopFeature, now: DateTime<Utc>) -> FeatureAccess {
    if self.blocked.contains(&feature) {
      return FeatureAccess::Off(OffReason::BlockedByPolicy);
    }
    match &self.decision {
      Decision::Undecided => FeatureAccess::Off(OffReason::Undecided),
      Decision::Read(AccountDecision::SignedOut) => {
        FeatureAccess::Off(OffReason::SignedOut)
      }
      Decision::Read(AccountDecision::ReconnectNeeded { .. }) => {
        FeatureAccess::Off(OffReason::ReconnectNeeded)
      }
      Decision::Read(AccountDecision::Unconfirmed { expires_at, .. }) => {
        if *expires_at <= now {
          FeatureAccess::Off(OffReason::SignedOut)
        } else {
          FeatureAccess::Off(OffReason::Undecided)
        }
      }
      Decision::Read(AccountDecision::Answered {
        expires_at,
        enabled,
        ..
      }) => {
        if *expires_at <= now {
          FeatureAccess::Off(OffReason::SignedOut)
        } else if enabled.contains(&feature) {
          FeatureAccess::Enabled
        } else {
          FeatureAccess::Off(OffReason::NotAvailable)
        }
      }
    }
  }

  fn namespace(&self) -> Option<&String> {
    match &self.decision {
      Decision::Undecided | Decision::Read(AccountDecision::SignedOut) => None,
      Decision::Read(AccountDecision::ReconnectNeeded { namespace }) => {
        namespace.as_ref()
      }
      Decision::Read(
        AccountDecision::Answered { namespace, .. }
        | AccountDecision::Unconfirmed { namespace, .. },
      ) => Some(namespace),
    }
  }

  fn credential_expiry(&self) -> Option<DateTime<Utc>> {
    match &self.decision {
      Decision::Undecided
      | Decision::Read(
        AccountDecision::SignedOut | AccountDecision::ReconnectNeeded { .. },
      ) => None,
      Decision::Read(
        AccountDecision::Answered { expires_at, .. }
        | AccountDecision::Unconfirmed { expires_at, .. },
      ) => Some(*expires_at),
    }
  }
}

#[derive(Default)]
pub struct FeatureGates(RwLock<GateState>);

impl FeatureGates {
  pub fn blocking(blocked: HashSet<DesktopFeature>) -> Self {
    Self(RwLock::new(GateState {
      blocked,
      ..GateState::default()
    }))
  }

  /// Whether the feature is on and, when it is off, why.
  pub fn access_at(
    &self,
    feature: DesktopFeature,
    now: DateTime<Utc>,
  ) -> FeatureAccess {
    self
      .0
      .read()
      .map_or(FeatureAccess::Off(OffReason::Undecided), |state| {
        state.access(feature, now)
      })
  }

  pub fn access(&self, feature: DesktopFeature) -> FeatureAccess {
    self.access_at(feature, Utc::now())
  }

  /// Off whenever the decision cannot be read or its account expired.
  pub fn is_enabled(&self, feature: DesktopFeature) -> bool {
    self.access(feature) == FeatureAccess::Enabled
  }

  pub fn generation(&self) -> Option<u64> {
    self.0.read().ok().map(|state| state.generation)
  }

  pub fn account_binding(&self, feature: DesktopFeature) -> Option<(u64, String)> {
    let state = self.0.read().ok()?;
    if state.access(feature, Utc::now()) != FeatureAccess::Enabled {
      return None;
    }
    Some((state.generation, state.namespace()?.clone()))
  }

  /// The account the last decision was read for, whether or not it enables
  /// anything. It names a local data namespace and grants no access.
  pub fn namespace(&self) -> Option<String> {
    self.0.read().ok()?.namespace().cloned()
  }

  /// The current generation and the account the last decision was read for,
  /// while no account change is under way. It names local data only and
  /// grants no server access.
  pub fn local_binding(&self) -> Option<(u64, String)> {
    let state = self.0.read().ok()?;
    if state.phase != AccountPhase::Ready {
      return None;
    }
    Some((state.generation, state.namespace()?.clone()))
  }

  /// When the credential the last decision was read with expires.
  pub fn credential_expiry(&self) -> Option<DateTime<Utc>> {
    self.0.read().ok()?.credential_expiry()
  }

  /// Closing access and superseding in-flight requests is one atomic change.
  pub fn invalidate(&self) {
    if let Ok(mut state) = self.0.write() {
      let pending = match state.phase {
        AccountPhase::Ready => NonZeroUsize::MIN,
        AccountPhase::Changing { pending } => pending
          .checked_add(1)
          .expect("account unload count is representable"),
      };
      state.phase = AccountPhase::Changing { pending };
      state.generation = state.generation.wrapping_add(1);
      state.decision = Decision::Undecided;
      state.applied.clear();
    }
  }

  /// New-account decisions remain closed until readable feature state has
  /// been unloaded, including periodic refreshes already in progress.
  pub fn finish_account_change(&self) {
    if let Ok(mut state) = self.0.write() {
      state.phase = match state.phase {
        AccountPhase::Changing { pending } => NonZeroUsize::new(pending.get() - 1)
          .map_or(AccountPhase::Ready, |pending| AccountPhase::Changing {
            pending,
          }),
        AccountPhase::Ready => AccountPhase::Ready,
      };
    }
  }

  /// A decision can be installed only in the generation that requested it.
  /// An unconfirmed account never replaces an answer: the last decision
  /// stands while the server cannot be reached. Returns the features that
  /// turned on or off.
  pub fn install(
    &self,
    generation: u64,
    decision: AccountDecision,
  ) -> Option<Vec<DesktopFeature>> {
    let mut state = self.0.write().ok()?;
    if generation != state.generation || state.phase != AccountPhase::Ready {
      return None;
    }
    if matches!(decision, AccountDecision::Unconfirmed { .. })
      && matches!(
        state.decision,
        Decision::Read(
          AccountDecision::SignedOut
            | AccountDecision::ReconnectNeeded { .. }
            | AccountDecision::Answered { .. }
        )
      )
    {
      return Some(Vec::new());
    }
    let now = Utc::now();
    state.decision = Decision::Read(decision);
    let enabled = DesktopFeature::ALL
      .iter()
      .copied()
      .filter(|feature| state.access(*feature, now) == FeatureAccess::Enabled)
      .collect::<HashSet<_>>();
    let changed = DesktopFeature::ALL
      .iter()
      .copied()
      .filter(|feature| state.applied.contains(feature) != enabled.contains(feature))
      .collect();
    state.applied = enabled;
    drop(state);
    Some(changed)
  }

  #[cfg(test)]
  fn replace(&self, enabled: HashSet<DesktopFeature>) -> Vec<DesktopFeature> {
    self
      .install(self.generation().unwrap(), answered("fixture", enabled))
      .unwrap()
  }
}

#[cfg(test)]
pub(crate) fn answered(
  namespace: &str,
  enabled: HashSet<DesktopFeature>,
) -> AccountDecision {
  AccountDecision::Answered {
    namespace: namespace.into(),
    expires_at: Utc::now() + chrono::Duration::hours(1),
    enabled,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn overlapping_account_unloads_keep_decisions_closed_until_all_complete() {
    for pending in 2..=4 {
      let gates = FeatureGates::default();
      for _ in 0..pending {
        gates.invalidate();
      }
      let generation = gates.generation().unwrap();
      let activity = || HashSet::from([DesktopFeature::ActivityTimeline]);
      for _ in 1..pending {
        gates.finish_account_change();
        assert!(
          gates
            .install(generation, answered("current", activity()))
            .is_none()
        );
        assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));
        assert!(
          gates
            .account_binding(DesktopFeature::ActivityTimeline)
            .is_none()
        );
      }
      gates.finish_account_change();
      assert!(
        gates
          .install(generation, answered("current", activity()))
          .is_some()
      );
      assert!(gates.is_enabled(DesktopFeature::ActivityTimeline));
      assert!(
        gates
          .install(generation - 1, answered("stale", activity()))
          .is_none()
      );
    }
  }

  #[test]
  fn features_start_closed_and_report_only_changes() {
    let gates = FeatureGates::default();
    assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));
    assert_eq!(
      gates.access(DesktopFeature::ActivityTimeline),
      FeatureAccess::Off(OffReason::Undecided)
    );

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
  fn every_decision_names_why_a_feature_is_off() {
    let now = Utc::now();
    let cases = [
      (AccountDecision::SignedOut, OffReason::SignedOut, None),
      (
        AccountDecision::ReconnectNeeded { namespace: None },
        OffReason::ReconnectNeeded,
        None,
      ),
      (
        AccountDecision::ReconnectNeeded {
          namespace: Some("a".into()),
        },
        OffReason::ReconnectNeeded,
        Some("a"),
      ),
      (
        answered("a", HashSet::from([DesktopFeature::LocalAgents])),
        OffReason::NotAvailable,
        Some("a"),
      ),
      (
        AccountDecision::Answered {
          namespace: "a".into(),
          expires_at: now - chrono::Duration::seconds(1),
          enabled: HashSet::from([DesktopFeature::ActivityTimeline]),
        },
        OffReason::SignedOut,
        Some("a"),
      ),
    ];
    for (decision, reason, namespace) in cases {
      let gates = FeatureGates::default();
      gates
        .install(gates.generation().unwrap(), decision.clone())
        .unwrap();
      assert_eq!(
        gates.access_at(DesktopFeature::ActivityTimeline, now),
        FeatureAccess::Off(reason),
        "{decision:?}"
      );
      assert_eq!(gates.namespace().as_deref(), namespace, "{decision:?}");
      assert!(
        gates
          .account_binding(DesktopFeature::ActivityTimeline)
          .is_none()
      );
    }
  }

  #[test]
  fn an_unconfirmed_account_names_its_data_but_never_replaces_an_answer() {
    let gates = FeatureGates::default();
    let expires_at = Utc::now() + chrono::Duration::hours(1);
    let unconfirmed = || AccountDecision::Unconfirmed {
      namespace: "a".into(),
      expires_at,
    };
    gates
      .install(gates.generation().unwrap(), unconfirmed())
      .unwrap();
    assert_eq!(
      gates.access(DesktopFeature::ActivityTimeline),
      FeatureAccess::Off(OffReason::Undecided)
    );
    assert_eq!(gates.local_binding(), Some((0, "a".into())));
    assert_eq!(gates.credential_expiry(), Some(expires_at));
    assert!(
      gates
        .account_binding(DesktopFeature::ActivityTimeline)
        .is_none()
    );
    assert_eq!(
      gates.access_at(DesktopFeature::ActivityTimeline, expires_at),
      FeatureAccess::Off(OffReason::SignedOut)
    );
    for answer in [
      answered("a", HashSet::from([DesktopFeature::ActivityTimeline])),
      answered("a", HashSet::new()),
      AccountDecision::ReconnectNeeded {
        namespace: Some("a".into()),
      },
    ] {
      let gates = FeatureGates::default();
      gates
        .install(gates.generation().unwrap(), answer.clone())
        .unwrap();
      let before = gates.access(DesktopFeature::ActivityTimeline);
      assert_eq!(
        gates.install(gates.generation().unwrap(), unconfirmed()),
        Some(Vec::new())
      );
      assert_eq!(
        gates.access(DesktopFeature::ActivityTimeline),
        before,
        "{answer:?}"
      );
    }
    gates.invalidate();
    assert_eq!(gates.local_binding(), None);
  }

  #[test]
  fn an_answer_stops_enabling_a_feature_once_its_credential_expires() {
    let gates = FeatureGates::default();
    let expires_at = Utc::now() + chrono::Duration::hours(1);
    gates
      .install(
        gates.generation().unwrap(),
        AccountDecision::Answered {
          namespace: "a".into(),
          expires_at,
          enabled: HashSet::from([DesktopFeature::ActivityTimeline]),
        },
      )
      .unwrap();
    assert_eq!(
      gates.access_at(
        DesktopFeature::ActivityTimeline,
        expires_at - chrono::Duration::seconds(1)
      ),
      FeatureAccess::Enabled
    );
    assert_eq!(
      gates.access_at(DesktopFeature::ActivityTimeline, expires_at),
      FeatureAccess::Off(OffReason::SignedOut)
    );
  }

  #[test]
  fn a_decision_that_lapsed_with_its_credential_still_reports_turning_off() {
    let gates = FeatureGates::default();
    let generation = gates.generation().unwrap();
    gates
      .install(
        generation,
        answered("a", HashSet::from([DesktopFeature::ActivityTimeline])),
      )
      .unwrap();
    // The credential expires between two reads.
    gates.0.write().unwrap().decision = Decision::Read(AccountDecision::Answered {
      namespace: "a".into(),
      expires_at: Utc::now() - chrono::Duration::seconds(1),
      enabled: HashSet::from([DesktopFeature::ActivityTimeline]),
    });
    assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));
    assert_eq!(
      gates
        .install(generation, AccountDecision::SignedOut)
        .unwrap(),
      [DesktopFeature::ActivityTimeline]
    );
    assert!(
      gates
        .install(generation, AccountDecision::SignedOut)
        .unwrap()
        .is_empty()
    );
  }

  #[test]
  fn a_blocked_feature_stays_off_when_the_server_enables_it() {
    let gates =
      FeatureGates::blocking(HashSet::from([DesktopFeature::ActivityTimeline]));
    assert_eq!(
      gates.access(DesktopFeature::ActivityTimeline),
      FeatureAccess::Off(OffReason::BlockedByPolicy)
    );
    let changed = gates.replace(HashSet::from([
      DesktopFeature::ActivityTimeline,
      DesktopFeature::LocalAgents,
    ]));
    assert_eq!(changed, [DesktopFeature::LocalAgents]);
    assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));
    assert_eq!(
      gates.access(DesktopFeature::ActivityTimeline),
      FeatureAccess::Off(OffReason::BlockedByPolicy)
    );
    assert!(
      gates
        .account_binding(DesktopFeature::ActivityTimeline)
        .is_none()
    );
    assert!(gates.is_enabled(DesktopFeature::LocalAgents));
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
      let activity = || HashSet::from([DesktopFeature::ActivityTimeline]);
      gates
        .install(generation_a, answered("a", activity()))
        .unwrap();
      let (complete, delayed) = tokio::sync::oneshot::channel();
      let stale_gates = std::sync::Arc::clone(&gates);
      let stale = tokio::spawn(async move {
        delayed.await.unwrap();
        stale_gates.install(generation_a, answered("a", activity()))
      });
      gates.invalidate();
      assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));
      assert!(
        gates
          .account_binding(DesktopFeature::ActivityTimeline)
          .is_none()
      );
      assert_eq!(gates.namespace(), None);
      // Even a fast B response is rejected until A's readable state is gone.
      assert!(
        gates
          .install(gates.generation().unwrap(), answered("b", activity()))
          .is_none()
      );
      assert!(!gates.is_enabled(DesktopFeature::ActivityTimeline));
      gates.finish_account_change();
      if let Some(decision) = replacement.as_ref() {
        gates
          .install(gates.generation().unwrap(), answered("b", decision.clone()))
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
