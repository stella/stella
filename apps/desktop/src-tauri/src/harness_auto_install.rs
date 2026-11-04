//! Keeps the managed agent CLIs on the releases this build pins while the
//! local agents feature is on.
//!
//! Turning the feature on, which the first feature decision after startup
//! also does, installs every harness whose active release is not the pinned
//! one, one harness at a time. An older install counts as not pinned, so a
//! raised pin updates it. A failed install is tried again after each of
//! [`RETRY_DELAYS`] and then stays failed until the user retries it from the
//! settings. Platforms without a pinned release, a removal in progress and a
//! user's cancel end the pass for that harness. Turning the feature off stops
//! the pass and any install in progress; installed releases stay.

use std::{
  future::Future,
  pin::Pin,
  sync::{Arc, Mutex, MutexGuard, PoisonError},
  time::Duration,
};

use crate::harness_installation::{
  HarnessError, HarnessInstallState, HarnessInstallation,
};
use crate::harness_release::ManagedHarness;

/// The waits before each retry of a failed install; none after the last.
pub const RETRY_DELAYS: [Duration; 3] = [
  Duration::from_secs(30),
  Duration::from_secs(5 * 60),
  Duration::from_secs(30 * 60),
];

type Wait =
  Arc<dyn Fn(Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

pub struct HarnessAutoInstall {
  installation: HarnessInstallation,
  wait: Wait,
  pass: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl HarnessAutoInstall {
  pub fn new(installation: HarnessInstallation) -> Self {
    Self::with_wait(
      installation,
      Arc::new(|delay| Box::pin(tokio::time::sleep(delay))),
    )
  }

  fn with_wait(installation: HarnessInstallation, wait: Wait) -> Self {
    Self {
      installation,
      wait,
      pass: Mutex::new(None),
    }
  }

  fn pass(&self) -> MutexGuard<'_, Option<tauri::async_runtime::JoinHandle<()>>> {
    self.pass.lock().unwrap_or_else(PoisonError::into_inner)
  }

  /// On: starts a new pass over every harness, replacing one still waiting
  /// to retry. Off: stops the pass and cancels any install in progress.
  pub fn set_enabled(&self, enabled: bool) {
    let mut pass = self.pass();
    if let Some(running) = pass.take() {
      running.abort();
    }
    if !enabled {
      self.installation.cancel_all();
      return;
    }
    let installation = self.installation.clone();
    let wait = Arc::clone(&self.wait);
    *pass = Some(tauri::async_runtime::spawn(async move {
      for harness in ManagedHarness::ALL {
        keep_pinned(&installation, harness, &wait).await;
      }
    }));
  }

  /// Waits for the current pass to end.
  #[cfg(all(test, unix))]
  async fn finished(&self) {
    let pass = self.pass().take();
    if let Some(pass) = pass {
      tokio::time::timeout(Duration::from_secs(30), pass)
        .await
        .expect("the pass ends")
        .expect("the pass ends without panicking");
    }
  }
}

async fn keep_pinned(
  installation: &HarnessInstallation,
  harness: ManagedHarness,
  wait: &Wait,
) {
  let mut delays = RETRY_DELAYS.into_iter();
  while install_pinned(installation, harness).await == Attempt::Failed {
    let Some(delay) = delays.next() else {
      tracing::warn!(
        harness = harness.id(),
        "managed harness install failed; left for a manual retry"
      );
      return;
    };
    wait(delay).await;
  }
}

#[derive(Debug, PartialEq, Eq)]
enum Attempt {
  /// Installed, cancelled, or nothing to do here.
  Settled,
  Failed,
}

/// Starts the pinned install, or joins the one running, and waits for it.
async fn install_pinned(
  installation: &HarnessInstallation,
  harness: ManagedHarness,
) -> Attempt {
  // Subscribed first, so the end of a quick install is not missed.
  let mut changes = installation.subscribe(harness);
  let started = match installation.start(harness) {
    Ok(state) => state,
    Err(HarnessError::UnsupportedPlatform | HarnessError::Busy) => {
      return Attempt::Settled;
    }
    Err(error) => {
      tracing::warn!(
        harness = harness.id(),
        ?error,
        "managed harness install did not start"
      );
      return Attempt::Failed;
    }
  };
  let settled = if started.is_running() {
    match changes.wait_for(|state| !state.is_running()).await {
      Ok(state) => state.clone(),
      Err(_closed) => return Attempt::Settled,
    }
  } else {
    started
  };
  if matches!(settled, HarnessInstallState::Failed { .. }) {
    Attempt::Failed
  } else {
    Attempt::Settled
  }
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;
  use crate::harness_archive::tests::TempDir;
  use crate::harness_installation::InstallFailure;
  use crate::harness_installation::tests::{
    Serve, claude_code_archive, claude_code_release, codex_archive, failed, install,
    open, ready, release, run, serve,
  };
  use crate::harness_release::{HarnessRelease, HarnessReleases};
  use tokio::sync::{mpsc, oneshot};

  fn open_both(
    dir: &TempDir,
    codex: HarnessRelease,
    claude_code: HarnessRelease,
  ) -> HarnessInstallation {
    HarnessInstallation::open(
      dir.path().join("harness"),
      dir.path().join("harness-home"),
      HarnessReleases {
        codex: Some(codex),
        claude_code: Some(claude_code),
      },
    )
    .unwrap()
  }

  /// Records every retry delay and returns at once.
  fn recorded_waits() -> (Wait, Arc<Mutex<Vec<Duration>>>) {
    let waits = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&waits);
    let wait: Wait = Arc::new(move |delay| {
      recorded.lock().unwrap().push(delay);
      Box::pin(async {})
    });
    (wait, waits)
  }

  #[test]
  fn turning_the_feature_on_installs_each_missing_harness_in_turn() {
    run(|| async {
      let codex = codex_archive("1.0.0");
      let claude = claude_code_archive("2.0.0");
      let fixture = serve(vec![
        ("/codex.tar.gz", Serve::Bytes(codex.clone())),
        ("/claude.tar.gz", Serve::Bytes(claude.clone())),
      ])
      .await;
      let dir = TempDir::new();
      let installation = open_both(
        &dir,
        release("1.0.0", fixture.url("/codex.tar.gz"), &codex),
        claude_code_release("2.0.0", fixture.url("/claude.tar.gz"), &claude),
      );
      // What Codex looked like when the Claude Code install started.
      let mut claude_changes = installation.subscribe(ManagedHarness::ClaudeCode);
      let watched = installation.clone();
      let codex_when_claude_started = tokio::spawn(async move {
        claude_changes
          .wait_for(HarnessInstallState::is_running)
          .await
          .unwrap();
        watched.state(ManagedHarness::Codex)
      });
      let (wait, waits) = recorded_waits();
      let auto = HarnessAutoInstall::with_wait(installation.clone(), wait);

      auto.set_enabled(true);
      auto.finished().await;
      assert_eq!(installation.state(ManagedHarness::Codex), ready("1.0.0"));
      assert_eq!(
        installation.state(ManagedHarness::ClaudeCode),
        ready("2.0.0")
      );
      assert_eq!(
        tokio::time::timeout(Duration::from_secs(30), codex_when_claude_started)
          .await
          .expect("the Claude Code install started")
          .unwrap(),
        ready("1.0.0")
      );
      assert_eq!(fixture.requests(), 2);
      assert!(
        dir.path().join("harness-home").join("claude-code").is_dir(),
        "each installed harness has its configuration directory"
      );

      // The next start finds both pinned releases active: nothing downloads.
      auto.set_enabled(true);
      auto.finished().await;
      assert_eq!(fixture.requests(), 2);
      assert!(waits.lock().unwrap().is_empty());
    });
  }

  #[test]
  fn a_raised_pin_updates_an_older_install() {
    run(|| async {
      let v1 = codex_archive("1.0.0");
      let v2 = codex_archive("2.0.0");
      let fixture = serve(vec![
        ("/v1.tar.gz", Serve::Bytes(v1.clone())),
        ("/v2.tar.gz", Serve::Bytes(v2.clone())),
      ])
      .await;
      let dir = TempDir::new();
      let older = open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &v1));
      assert_eq!(install(&older).await, ready("1.0.0"));
      drop(older);

      let installation = open(&dir, release("2.0.0", fixture.url("/v2.tar.gz"), &v2));
      assert_eq!(installation.state(ManagedHarness::Codex), ready("1.0.0"));
      let (wait, _waits) = recorded_waits();
      let auto = HarnessAutoInstall::with_wait(installation.clone(), wait);
      auto.set_enabled(true);
      auto.finished().await;
      assert_eq!(installation.state(ManagedHarness::Codex), ready("2.0.0"));
      assert_eq!(fixture.requests(), 2);
    });
  }

  #[test]
  fn a_failing_install_is_retried_after_each_delay_then_left_failed() {
    run(|| async {
      let served = codex_archive("1.0.0");
      let mut tampered = served.clone();
      let last = tampered.len() - 1;
      tampered[last] ^= 0xff;
      let fixture = serve(vec![("/v1.tar.gz", Serve::Bytes(tampered))]).await;
      let dir = TempDir::new();
      let installation =
        open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &served));
      let (wait, waits) = recorded_waits();
      let auto = HarnessAutoInstall::with_wait(installation.clone(), wait);

      auto.set_enabled(true);
      auto.finished().await;
      assert_eq!(*waits.lock().unwrap(), RETRY_DELAYS);
      assert_eq!(fixture.requests(), 1 + RETRY_DELAYS.len());
      assert_eq!(
        installation.state(ManagedHarness::Codex),
        failed(InstallFailure::DigestMismatch, None)
      );
    });
  }

  #[test]
  fn no_install_starts_while_a_removal_runs() {
    run(|| async {
      let bytes = codex_archive("1.0.0");
      let fixture = serve(vec![("/v1.tar.gz", Serve::Bytes(bytes.clone()))]).await;
      let dir = TempDir::new();
      let installation =
        open(&dir, release("1.0.0", fixture.url("/v1.tar.gz"), &bytes));
      let (wait, waits) = recorded_waits();
      let auto = HarnessAutoInstall::with_wait(installation.clone(), wait);

      let removing = installation.removing(ManagedHarness::Codex);
      auto.set_enabled(true);
      auto.finished().await;
      assert_eq!(fixture.requests(), 0);
      assert_eq!(
        installation.state(ManagedHarness::Codex),
        HarnessInstallState::NotInstalled
      );
      assert!(waits.lock().unwrap().is_empty(), "a removal is not retried");

      // Once the removal ends, the next pass installs.
      drop(removing);
      auto.set_enabled(true);
      auto.finished().await;
      assert_eq!(installation.state(ManagedHarness::Codex), ready("1.0.0"));
      assert_eq!(fixture.requests(), 1);
    });
  }

  /// Sends on drop: tells the test the pass that held it is gone.
  struct Dropped(Option<oneshot::Sender<()>>);

  impl Drop for Dropped {
    fn drop(&mut self) {
      if let Some(sender) = self.0.take() {
        let _ = sender.send(());
      }
    }
  }

  #[test]
  fn turning_the_feature_off_stops_retrying_and_keeps_what_is_installed() {
    run(|| async {
      let served = codex_archive("1.0.0");
      let mut tampered = served.clone();
      let last = tampered.len() - 1;
      tampered[last] ^= 0xff;
      let claude = claude_code_archive("2.0.0");
      let fixture = serve(vec![
        ("/codex.tar.gz", Serve::Bytes(tampered)),
        ("/claude.tar.gz", Serve::Bytes(claude.clone())),
      ])
      .await;
      let dir = TempDir::new();
      let installation = open_both(
        &dir,
        release("1.0.0", fixture.url("/codex.tar.gz"), &served),
        claude_code_release("2.0.0", fixture.url("/claude.tar.gz"), &claude),
      );
      let mut claude_changes = installation.subscribe(ManagedHarness::ClaudeCode);
      installation.start(ManagedHarness::ClaudeCode).unwrap();
      claude_changes
        .wait_for(|state| !state.is_running())
        .await
        .unwrap();
      assert_eq!(
        installation.state(ManagedHarness::ClaudeCode),
        ready("2.0.0")
      );

      // Each wait reports its delay, then holds the pass until it is dropped.
      let (started, mut waiting) = mpsc::unbounded_channel();
      let wait: Wait = Arc::new(move |delay| {
        let (dropped, gone) = oneshot::channel();
        started.send((delay, gone)).unwrap();
        let held = Dropped(Some(dropped));
        Box::pin(async move {
          let _held = held;
          std::future::pending::<()>().await;
        })
      });
      let auto = HarnessAutoInstall::with_wait(installation.clone(), wait);
      auto.set_enabled(true);
      let (delay, gone) = tokio::time::timeout(Duration::from_secs(30), waiting.recv())
        .await
        .expect("the first install fails and waits to retry")
        .unwrap();
      assert_eq!(delay, RETRY_DELAYS[0]);
      assert_eq!(fixture.requests(), 2);

      auto.set_enabled(false);
      tokio::time::timeout(Duration::from_secs(30), gone)
        .await
        .expect("turning the feature off ends the pass")
        .unwrap();
      auto.finished().await;
      assert_eq!(fixture.requests(), 2, "no retry after the feature is off");
      assert!(waiting.try_recv().is_err());
      assert_eq!(
        installation.state(ManagedHarness::Codex),
        failed(InstallFailure::DigestMismatch, None)
      );
      assert_eq!(
        installation.state(ManagedHarness::ClaudeCode),
        ready("2.0.0")
      );
      assert!(
        dir
          .path()
          .join("harness")
          .join("claude-code")
          .join("2.0.0")
          .is_dir(),
        "turning the feature off uninstalls nothing"
      );
    });
  }
}
