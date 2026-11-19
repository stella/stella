//! Keeps this computer from idle sleep while agents work on it, as a
//! caffeinate-style tool would, so a long local run does not stop when nobody
//! touches the keyboard.
//!
//! Each piece of work takes a [`WorkHold`] and drops it when it ends, however
//! it ends; one system assertion is held while any hold lives and the
//! member's settings allow it. Local runs hold one each while this app relays
//! them (`desktop_runner`); a run's browser steps go through the harness
//! holder within that run, so they are covered by it.
//!
//! Only idle system sleep is held off: the display still sleeps. A closed
//! Mac lid still sleeps the Mac, which no app can prevent without changing
//! system settings. On battery the computer sleeps as usual unless the member
//! allows otherwise; the power source is looked at whenever a hold is taken
//! and once a minute while one lives. Linux has no assertion here yet: holds
//! are counted, and nothing is kept awake.

use std::{
  sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
  time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
  device_preference::DevicePreference,
  feature_gate::{DesktopFeature, FeatureGates},
};

const LOG_TARGET: &str = "stella_desktop::keep_awake";
/// What the system lists as the assertion's reason (`pmset -g assertions`).
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[cfg_attr(
  test,
  allow(dead_code, reason = "tests never touch the system's power")
)]
const REASON: &str = "stella desktop: agents are working";
const ENABLED_FILE: &str = "keep-awake";
const ON_BATTERY_FILE: &str = "keep-awake-on-battery";
const ON_VALUE: &str = "on";
const OFF_VALUE: &str = "off";
/// How often the power source is looked at again while work holds the
/// computer awake on mains power only.
const POWER_RECHECK: Duration = Duration::from_secs(60);

/// The member's choice for this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeSettings {
  /// Keep the computer awake while agents work.
  pub enabled: bool,
  /// Also while it runs on battery.
  pub on_battery: bool,
}

impl Default for KeepAwakeSettings {
  fn default() -> Self {
    Self {
      enabled: true,
      on_battery: false,
    }
  }
}

/// Why no assertion is held although work wants one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NotHeld {
  /// This platform has no assertion here.
  #[cfg_attr(
    any(target_os = "macos", target_os = "windows"),
    allow(dead_code, reason = "only a platform without an assertion reports it")
  )]
  Unsupported,
  /// The system refused it.
  Refused,
}

/// The system's side: its power source and its sleep assertion.
pub(crate) trait Power: Send + Sync {
  fn on_battery(&self) -> bool;
  /// An assertion that holds off idle system sleep until it drops.
  fn prevent_idle_sleep(&self) -> Result<Box<dyn Send>, NotHeld>;
}

#[derive(Default)]
struct Inner {
  holds: usize,
  settings: KeepAwakeSettings,
  assertion: Option<Box<dyn Send>>,
  /// The app is exiting: nothing is held from now on.
  exiting: bool,
  /// An unsupported platform is logged once per stretch of work.
  logged_unsupported: bool,
}

/// The hold count and the one assertion it decides.
pub(crate) struct KeepAwake {
  power: Box<dyn Power>,
  inner: Mutex<Inner>,
}

/// Keeps the computer awake (as settings allow) until dropped.
#[must_use = "the computer is kept awake only while the hold lives"]
pub(crate) struct WorkHold {
  owner: Arc<KeepAwake>,
}

impl Drop for WorkHold {
  fn drop(&mut self) {
    self.owner.release();
  }
}

impl KeepAwake {
  pub(crate) fn new(power: Box<dyn Power>, settings: KeepAwakeSettings) -> Arc<Self> {
    Arc::new(Self {
      power,
      inner: Mutex::new(Inner {
        settings,
        ..Inner::default()
      }),
    })
  }

  fn locked(&self) -> MutexGuard<'_, Inner> {
    self.inner.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// Work started: the computer stays awake until the hold drops.
  pub(crate) fn hold(self: &Arc<Self>) -> WorkHold {
    let mut inner = self.locked();
    inner.holds = inner.holds.saturating_add(1);
    self.reconcile(&mut inner);
    drop(inner);
    WorkHold {
      owner: Arc::clone(self),
    }
  }

  fn release(&self) {
    let mut inner = self.locked();
    inner.holds = inner.holds.saturating_sub(1);
    if inner.holds == 0 {
      inner.logged_unsupported = false;
    }
    self.reconcile(&mut inner);
    drop(inner);
  }

  pub(crate) fn settings(&self) -> KeepAwakeSettings {
    self.locked().settings
  }

  /// Applies new settings at once, to work already running too.
  pub(crate) fn configure(&self, settings: KeepAwakeSettings) {
    let mut inner = self.locked();
    inner.settings = settings;
    self.reconcile(&mut inner);
    drop(inner);
  }

  /// Looks at the power source again.
  pub(crate) fn recheck(&self) {
    let mut inner = self.locked();
    self.reconcile(&mut inner);
    drop(inner);
  }

  /// The app exits: the assertion goes, and none is taken again.
  pub(crate) fn release_for_exit(&self) {
    let mut inner = self.locked();
    inner.exiting = true;
    self.reconcile(&mut inner);
    drop(inner);
  }

  #[cfg(test)]
  fn holds(&self) -> usize {
    self.locked().holds
  }

  #[cfg(test)]
  fn awake(&self) -> bool {
    self.locked().assertion.is_some()
  }

  fn wanted(&self, inner: &Inner) -> bool {
    // The power source is read only when it decides anything.
    !inner.exiting
      && inner.holds > 0
      && inner.settings.enabled
      && (inner.settings.on_battery || !self.power.on_battery())
  }

  fn reconcile(&self, inner: &mut Inner) {
    let wanted = self.wanted(inner);
    if wanted && inner.assertion.is_none() {
      match self.power.prevent_idle_sleep() {
        Ok(assertion) => {
          inner.assertion = Some(assertion);
          tracing::info!(target: LOG_TARGET, "keeping this computer awake while agents work");
        }
        Err(NotHeld::Unsupported) => {
          if !inner.logged_unsupported {
            inner.logged_unsupported = true;
            tracing::info!(target: LOG_TARGET, "this platform cannot keep the computer awake while agents work");
          }
        }
        Err(NotHeld::Refused) => {
          tracing::warn!(target: LOG_TARGET, "the system refused to keep this computer awake");
        }
      }
    } else if !wanted && inner.assertion.take().is_some() {
      tracing::info!(target: LOG_TARGET, "this computer may sleep again");
    }
  }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[cfg_attr(
  test,
  allow(dead_code, reason = "tests never touch the system's power")
)]
struct SystemPower;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Power for SystemPower {
  fn on_battery(&self) -> bool {
    stella_desktop_macos::on_battery_power()
  }

  fn prevent_idle_sleep(&self) -> Result<Box<dyn Send>, NotHeld> {
    stella_desktop_macos::prevent_idle_sleep(REASON)
      .map(|assertion| Box::new(assertion) as Box<dyn Send>)
      .ok_or(NotHeld::Refused)
  }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[cfg_attr(
  test,
  allow(dead_code, reason = "tests never touch the system's power")
)]
struct SystemPower;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl Power for SystemPower {
  fn on_battery(&self) -> bool {
    false
  }

  fn prevent_idle_sleep(&self) -> Result<Box<dyn Send>, NotHeld> {
    Err(NotHeld::Unsupported)
  }
}

/// Unit tests elsewhere in the crate take holds (a test run's local runs do)
/// without holding the machine they run on awake.
#[cfg(test)]
struct NoSystemInTests;

#[cfg(test)]
impl Power for NoSystemInTests {
  fn on_battery(&self) -> bool {
    false
  }

  fn prevent_idle_sleep(&self) -> Result<Box<dyn Send>, NotHeld> {
    Ok(Box::new(()))
  }
}

/// The app's one counter, with the settings stored on this computer.
pub(crate) fn global() -> &'static Arc<KeepAwake> {
  static GLOBAL: OnceLock<Arc<KeepAwake>> = OnceLock::new();
  GLOBAL.get_or_init(|| {
    #[cfg(not(test))]
    let (power, settings): (Box<dyn Power>, _) =
      (Box::new(SystemPower), StoredSettings::in_app_data().read());
    #[cfg(test)]
    let (power, settings): (Box<dyn Power>, _) =
      (Box::new(NoSystemInTests), KeepAwakeSettings::default());
    KeepAwake::new(power, settings)
  })
}

/// Work started on the app's counter.
pub(crate) fn hold() -> WorkHold {
  global().hold()
}

/// Looks at the power source once a minute, so work that started on mains
/// power lets the computer sleep once it runs on battery, and the other way
/// round. Cheap while no work runs: nothing is read then.
pub(crate) fn watch_power_source() {
  tauri::async_runtime::spawn(async {
    let mut ticks = tokio::time::interval(POWER_RECHECK);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
      ticks.tick().await;
      global().recheck();
    }
  });
}

/// The two switches, one small file each in the app data directory.
struct StoredSettings {
  enabled: DevicePreference,
  on_battery: DevicePreference,
}

impl StoredSettings {
  fn in_app_data() -> Self {
    Self {
      enabled: DevicePreference::in_app_data(ENABLED_FILE),
      on_battery: DevicePreference::in_app_data(ON_BATTERY_FILE),
    }
  }

  /// What is stored; a missing or unreadable switch reads as its default.
  fn read(&self) -> KeepAwakeSettings {
    let defaults = KeepAwakeSettings::default();
    KeepAwakeSettings {
      enabled: stored_switch(self.enabled.read().as_deref(), defaults.enabled),
      on_battery: stored_switch(self.on_battery.read().as_deref(), defaults.on_battery),
    }
  }

  fn write(&self, settings: KeepAwakeSettings) -> Result<(), String> {
    self.enabled.write(switch_value(settings.enabled))?;
    self.on_battery.write(switch_value(settings.on_battery))
  }
}

fn stored_switch(value: Option<&str>, default: bool) -> bool {
  match value {
    Some(ON_VALUE) => true,
    Some(OFF_VALUE) => false,
    _ => default,
  }
}

const fn switch_value(on: bool) -> &'static str {
  if on { ON_VALUE } else { OFF_VALUE }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeepAwakeCommandError {
  /// Local runs are off for this account, so there is nothing to keep awake for.
  FeatureDisabled,
  /// The choice could not be saved; nothing changed.
  Unsaved,
}

fn require_local_agents(gates: &FeatureGates) -> Result<(), KeepAwakeCommandError> {
  if gates.is_enabled(DesktopFeature::LocalAgents) {
    Ok(())
  } else {
    Err(KeepAwakeCommandError::FeatureDisabled)
  }
}

#[tauri::command]
pub fn keep_awake_get_settings(
  gates: State<'_, FeatureGates>,
) -> Result<KeepAwakeSettings, KeepAwakeCommandError> {
  require_local_agents(&gates)?;
  Ok(global().settings())
}

/// Saves the choice and applies it to work already running.
#[tauri::command]
pub fn keep_awake_set_settings(
  gates: State<'_, FeatureGates>,
  settings: KeepAwakeSettings,
) -> Result<KeepAwakeSettings, KeepAwakeCommandError> {
  require_local_agents(&gates)?;
  StoredSettings::in_app_data().write(settings).map_err(|error| {
    tracing::warn!(target: LOG_TARGET, %error, "the keep-awake choice could not be saved");
    KeepAwakeCommandError::Unsaved
  })?;
  global().configure(settings);
  Ok(settings)
}

#[cfg(test)]
mod tests {
  use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

  use super::*;

  /// Counts live assertions; the battery and refusals are switched by tests.
  #[derive(Clone, Default)]
  struct FakePower {
    live: Arc<AtomicUsize>,
    taken: Arc<AtomicUsize>,
    battery: Arc<AtomicBool>,
    refuse: Arc<AtomicBool>,
  }

  struct FakeAssertion(Arc<AtomicUsize>);

  impl Drop for FakeAssertion {
    fn drop(&mut self) {
      self.0.fetch_sub(1, Ordering::SeqCst);
    }
  }

  impl Power for FakePower {
    fn on_battery(&self) -> bool {
      self.battery.load(Ordering::SeqCst)
    }

    fn prevent_idle_sleep(&self) -> Result<Box<dyn Send>, NotHeld> {
      if self.refuse.load(Ordering::SeqCst) {
        return Err(NotHeld::Refused);
      }
      self.live.fetch_add(1, Ordering::SeqCst);
      self.taken.fetch_add(1, Ordering::SeqCst);
      Ok(Box::new(FakeAssertion(Arc::clone(&self.live))))
    }
  }

  impl FakePower {
    fn live(&self) -> usize {
      self.live.load(Ordering::SeqCst)
    }

    fn taken(&self) -> usize {
      self.taken.load(Ordering::SeqCst)
    }

    fn set_battery(&self, on: bool) {
      self.battery.store(on, Ordering::SeqCst);
    }
  }

  fn counter(settings: KeepAwakeSettings) -> (Arc<KeepAwake>, FakePower) {
    let power = FakePower::default();
    (KeepAwake::new(Box::new(power.clone()), settings), power)
  }

  #[test]
  fn overlapping_work_shares_one_assertion_released_with_the_last_hold() {
    let (keep_awake, power) = counter(KeepAwakeSettings::default());
    assert_eq!(power.live(), 0);

    let first = keep_awake.hold();
    let second = keep_awake.hold();
    assert_eq!((keep_awake.holds(), power.live(), power.taken()), (2, 1, 1));

    drop(first);
    assert_eq!((keep_awake.holds(), power.live()), (1, 1));
    drop(second);
    assert_eq!((keep_awake.holds(), power.live()), (0, 0));

    let again = keep_awake.hold();
    assert_eq!((power.live(), power.taken()), (1, 2));
    drop(again);
    assert_eq!(power.live(), 0);
  }

  #[test]
  fn holds_dropped_on_other_threads_never_leak_an_assertion() {
    let (keep_awake, power) = counter(KeepAwakeSettings::default());
    let threads: Vec<_> = (0..8)
      .map(|_| {
        let keep_awake = Arc::clone(&keep_awake);
        std::thread::spawn(move || {
          for _ in 0..100 {
            let hold = keep_awake.hold();
            drop(hold);
          }
        })
      })
      .collect();
    for thread in threads {
      thread.join().unwrap();
    }
    assert_eq!((keep_awake.holds(), power.live()), (0, 0));
  }

  #[test]
  fn switched_off_nothing_is_held_and_switching_applies_to_running_work() {
    let (keep_awake, power) = counter(KeepAwakeSettings {
      enabled: false,
      on_battery: false,
    });
    let hold = keep_awake.hold();
    assert_eq!((keep_awake.holds(), power.live()), (1, 0));

    keep_awake.configure(KeepAwakeSettings::default());
    assert_eq!(power.live(), 1);
    keep_awake.configure(KeepAwakeSettings {
      enabled: false,
      on_battery: true,
    });
    assert_eq!(power.live(), 0);

    drop(hold);
    assert_eq!((keep_awake.holds(), power.live()), (0, 0));
  }

  #[test]
  fn on_battery_the_computer_sleeps_unless_allowed() {
    let (keep_awake, power) = counter(KeepAwakeSettings::default());
    power.set_battery(true);
    let hold = keep_awake.hold();
    assert_eq!(power.live(), 0);

    power.set_battery(false);
    keep_awake.recheck();
    assert_eq!(power.live(), 1);

    power.set_battery(true);
    keep_awake.recheck();
    assert_eq!(power.live(), 0);

    keep_awake.configure(KeepAwakeSettings {
      enabled: true,
      on_battery: true,
    });
    assert_eq!(power.live(), 1);
    drop(hold);
    assert_eq!(power.live(), 0);
  }

  #[test]
  fn a_refused_assertion_is_asked_for_again_later() {
    let (keep_awake, power) = counter(KeepAwakeSettings::default());
    power.refuse.store(true, Ordering::SeqCst);
    let hold = keep_awake.hold();
    assert!(!keep_awake.awake());

    power.refuse.store(false, Ordering::SeqCst);
    keep_awake.recheck();
    assert!(keep_awake.awake());
    drop(hold);
    assert!(!keep_awake.awake());
  }

  #[test]
  fn exiting_releases_the_assertion_and_takes_none_again() {
    let (keep_awake, power) = counter(KeepAwakeSettings::default());
    let hold = keep_awake.hold();
    assert_eq!(power.live(), 1);

    keep_awake.release_for_exit();
    assert_eq!(power.live(), 0);
    let late = keep_awake.hold();
    keep_awake.recheck();
    assert_eq!(power.live(), 0);

    drop((hold, late));
    assert_eq!((keep_awake.holds(), power.live()), (0, 0));
  }

  #[test]
  fn idle_rechecks_never_read_the_power_source() {
    struct Untouchable;
    impl Power for Untouchable {
      fn on_battery(&self) -> bool {
        panic!("the power source is read without work");
      }

      fn prevent_idle_sleep(&self) -> Result<Box<dyn Send>, NotHeld> {
        panic!("an assertion is taken without work");
      }
    }
    let keep_awake =
      KeepAwake::new(Box::new(Untouchable), KeepAwakeSettings::default());
    keep_awake.recheck();
    keep_awake.configure(KeepAwakeSettings {
      enabled: true,
      on_battery: true,
    });
    keep_awake.release_for_exit();
  }

  #[test]
  fn stored_switches_read_back_and_fall_back_to_their_defaults() {
    let root =
      std::env::temp_dir().join(format!("stella-keep-awake-{}", uuid::Uuid::new_v4()));
    let stored = StoredSettings {
      enabled: DevicePreference::at(root.join(ENABLED_FILE)),
      on_battery: DevicePreference::at(root.join(ON_BATTERY_FILE)),
    };
    assert_eq!(stored.read(), KeepAwakeSettings::default());

    let chosen = KeepAwakeSettings {
      enabled: false,
      on_battery: true,
    };
    stored.write(chosen).unwrap();
    assert_eq!(stored.read(), chosen);

    assert!(!stored_switch(Some("garbled"), false));
    assert!(stored_switch(None, true));
    std::fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn settings_and_errors_read_as_the_window_expects() {
    assert_eq!(
      serde_json::to_value(KeepAwakeSettings::default()).unwrap(),
      serde_json::json!({"enabled": true, "onBattery": false})
    );
    assert_eq!(
      serde_json::to_value(KeepAwakeCommandError::FeatureDisabled).unwrap(),
      serde_json::json!("feature_disabled")
    );
  }
}
