//! The runner's connection state, as the desktop UI reads it, and the delay
//! between attempts.

use std::time::Duration;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum RunnerState {
  /// The local agents feature is off for this account.
  Off,
  /// No linked account to connect with.
  SignedOut,
  #[serde(rename_all = "camelCase")]
  Connecting {
    attempt: u32,
  },
  Connected,
  #[serde(rename_all = "camelCase")]
  Retrying {
    attempt: u32,
    retry_in_ms: u64,
  },
  /// The API no longer accepts this app's protocol; an app update is needed.
  /// The socket stays closed until then.
  #[serde(rename_all = "camelCase")]
  UpgradeRequired {
    minimum_protocol: Option<u32>,
    current_protocol: Option<u32>,
  },
  /// Another socket of this installation took over; this one stays closed.
  Replaced,
}

/// Exponential backoff with equal jitter: attempt `n` waits between half and
/// all of `min(cap, base * 2^n)`.
#[derive(Debug, Clone)]
pub(crate) struct Backoff {
  base: Duration,
  cap: Duration,
  attempt: u32,
}

impl Backoff {
  pub(crate) fn new(base: Duration, cap: Duration) -> Self {
    Self {
      base,
      cap,
      attempt: 0,
    }
  }

  pub(crate) fn attempt(&self) -> u32 {
    self.attempt
  }

  /// The delay before the next attempt; `unit` is uniform in `[0, 1)`.
  pub(crate) fn next_delay(&mut self, unit: f64) -> Duration {
    let ceiling = self
      .base
      .checked_mul(1_u32.checked_shl(self.attempt.min(31)).unwrap_or(u32::MAX))
      .map_or(self.cap, |delay| delay.min(self.cap));
    self.attempt = self.attempt.saturating_add(1);
    let half = ceiling / 2;
    half + half.mul_f64(unit.clamp(0.0, 1.0))
  }

  pub(crate) fn reset(&mut self) {
    self.attempt = 0;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn delays_double_up_to_the_cap_and_jitter_stays_within_the_upper_half() {
    let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
    let mut ceilings = Vec::new();
    for _ in 0..10 {
      let mut low = backoff.clone();
      let mut high = backoff.clone();
      let least = low.next_delay(0.0);
      let most = high.next_delay(1.0);
      let delay = backoff.next_delay(0.5);
      assert!(least <= delay && delay <= most);
      assert_eq!(least * 2, most);
      ceilings.push(most.as_secs());
    }
    assert_eq!(ceilings, [1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
    assert_eq!(backoff.attempt(), 10);
    backoff.reset();
    assert_eq!(backoff.next_delay(1.0), Duration::from_secs(1));
  }

  #[test]
  fn a_long_outage_never_overflows() {
    let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(300));
    for _ in 0..200 {
      assert!(backoff.next_delay(1.0) <= Duration::from_secs(300));
    }
  }

  #[test]
  fn the_state_reads_as_the_ui_expects() {
    assert_eq!(
      serde_json::to_value(RunnerState::Retrying {
        attempt: 2,
        retry_in_ms: 1500
      })
      .unwrap(),
      serde_json::json!({"status": "retrying", "attempt": 2, "retryInMs": 1500})
    );
    assert_eq!(
      serde_json::to_value(RunnerState::UpgradeRequired {
        minimum_protocol: Some(2),
        current_protocol: Some(3)
      })
      .unwrap(),
      serde_json::json!({"status": "upgradeRequired", "minimumProtocol": 2, "currentProtocol": 3})
    );
  }
}
