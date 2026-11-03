//! The sign-in against a stand-in CLI: a shell script that answers
//! `auth status`, `auth login` and `auth logout` from marker files in its
//! configuration directory. Nothing here reaches Anthropic.

use std::{
  collections::HashMap,
  ffi::OsString,
  future::Future,
  io::Write,
  path::PathBuf,
  sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize},
  },
  time::Duration,
};

use super::*;
use crate::harness_archive::tests::TempDir;

const SIGN_IN_PAGE: &str = "https://claude.ai/oauth/authorize?code=true&state=fixture";

/// Records every call, keeps the login's environment, and signs in when the
/// test drops an `approve` marker or fails on a `decline` one. A status read
/// hangs while a `status-stall` marker exists.
const STAND_IN_CLI: &str = r#"#!/bin/sh
dir="$CLAUDE_CONFIG_DIR"
echo "$*" >> "$dir/calls"
case "$1 $2" in
  "auth status")
    if [ -f "$dir/status-stall" ]; then
      echo $$ > "$dir/status-pid.partial"
      mv "$dir/status-pid.partial" "$dir/status-pid"
      while [ -f "$dir/status-stall" ]; do sleep 0.05; done
    fi
    if [ -f "$dir/report" ]; then cat "$dir/report"; exit 0; fi
    if [ -f "$dir/signed-in" ]; then
      printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"person@example.com","subscriptionType":"max"}\n'
      exit 0
    fi
    printf '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n'
    exit 1 ;;
  "auth login")
    echo $$ > "$dir/login-pid"
    env > "$dir/login-env"
    if [ -f "$dir/login-output" ]; then
      cat "$dir/login-output"
    else
      printf 'Opening browser to sign in\nIf the browser did not open, visit: https://claude.ai/oauth/authorize?code=true&state=fixture\n'
    fi
    while :; do
      [ -d "$dir" ] || exit 3
      if [ -f "$dir/approve" ]; then : > "$dir/signed-in"; exit 0; fi
      if [ -f "$dir/decline" ]; then exit 1; fi
      sleep 0.05
    done ;;
  "auth logout")
    rm -f "$dir/signed-in"
    exit 0 ;;
esac
exit 2
"#;

struct Fixture {
  dir: TempDir,
  installed: Arc<AtomicBool>,
  opened: Arc<Mutex<Vec<String>>>,
  changes: Arc<AtomicUsize>,
}

impl Fixture {
  fn home(&self) -> PathBuf {
    self.dir.path().join("home")
  }

  fn mark(&self, name: &str) {
    crate::local_store::write_test_fixture(self.home().join(name), b"").unwrap();
  }

  fn write(&self, name: &str, contents: &str) {
    crate::local_store::write_test_fixture(self.home().join(name), contents).unwrap();
  }

  fn exists(&self, name: &str) -> bool {
    self.home().join(name).exists()
  }

  fn calls(&self, call: &str) -> usize {
    std::fs::read_to_string(self.home().join("calls"))
      .unwrap_or_default()
      .lines()
      .filter(|line| *line == call)
      .count()
  }

  /// Whether the last sign-in's CLI process still exists, reaped or not.
  fn login_running(&self) -> bool {
    self.running("login-pid")
  }

  /// Whether the CLI process whose id is in `pid_file` still exists.
  fn running(&self, pid_file: &str) -> bool {
    let pid = std::fs::read_to_string(self.home().join(pid_file))
      .unwrap()
      .trim()
      .parse()
      .unwrap();
    rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid).unwrap())
      .is_ok()
  }

  fn login_environment(&self) -> HashMap<String, String> {
    std::fs::read_to_string(self.home().join("login-env"))
      .unwrap()
      .lines()
      .filter_map(|line| line.split_once('='))
      .map(|(name, value)| (name.to_owned(), value.to_owned()))
      .collect()
  }
}

/// The desktop environment the CLI is started from, holding every kind of
/// override the sign-in must not pass on.
fn desktop_environment() -> Vec<(OsString, OsString)> {
  let mut environment: Vec<(OsString, OsString)> = ["HOME", "PATH"]
    .into_iter()
    .filter_map(|name| Some((name.into(), std::env::var_os(name)?)))
    .collect();
  for (name, value) in [
    ("ANTHROPIC_API_KEY", "sk-ant-fixture"),
    ("ANTHROPIC_BASE_URL", "https://proxy.example"),
    ("anthropic_auth_token", "fixture"),
    ("CLAUDE_CODE_OAUTH_TOKEN", "fixture"),
    ("CLAUDE_CODE_USE_BEDROCK", "1"),
    ("CLAUDE_CONFIG_DIR", "/elsewhere"),
    ("CLAUDECODE", "1"),
    ("AWS_BEARER_TOKEN_BEDROCK", "fixture"),
    ("DISABLE_AUTOUPDATER", "0"),
    ("KEPT_SETTING", "kept"),
  ] {
    environment.push((name.into(), value.into()));
  }
  environment
}

fn fixture(sign_in_timeout: Duration) -> (Fixture, ClaudeCodeAuth) {
  let dir = TempDir::new();
  let executable = dir.path().join("claude");
  let mut file = crate::local_store::create_harness_file(&executable, true).unwrap();
  file.write_all(STAND_IN_CLI.as_bytes()).unwrap();
  drop(file);
  let home = dir.path().join("home");
  crate::local_store::create_private_dir(&home).unwrap();
  let installed = Arc::new(AtomicBool::new(true));
  let opened = Arc::new(Mutex::new(Vec::new()));
  let changes = Arc::new(AtomicUsize::new(0));
  let auth = {
    let installed = Arc::clone(&installed);
    let opened = Arc::clone(&opened);
    let changes = Arc::clone(&changes);
    ClaudeCodeAuth::new(
      ClaudeCodeAuthConfig {
        sign_in_timeout,
        command_timeout: Duration::from_secs(10),
      },
      ClaudeCodeAuthHooks {
        launch: Box::new(move || {
          if !installed.load(Ordering::SeqCst) {
            return Err(LaunchError::NotInstalled);
          }
          Ok(ClaudeCodeLaunch {
            executable: executable.clone(),
            config_dir: home.clone(),
            environment: desktop_environment(),
            _hold: Box::new(()),
          })
        }),
        open_browser: Box::new(move |url| {
          opened.lock().unwrap().push(url.to_owned());
          true
        }),
        changed: Box::new(move || {
          changes.fetch_add(1, Ordering::SeqCst);
        }),
      },
    )
  };
  (
    Fixture {
      dir,
      installed,
      opened,
      changes,
    },
    auth,
  )
}

/// The status once `done` holds, or a panic after a generous wait.
async fn until(
  auth: &ClaudeCodeAuth,
  done: impl Fn(&ClaudeCodeStatus) -> bool,
) -> ClaudeCodeStatus {
  for _ in 0..200 {
    let status = auth.status().await;
    if done(&status) {
      return status;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
  }
  panic!("status never settled: {:?}", auth.status().await);
}

/// Returns once the stand-in CLI has written `name`, or panics after the
/// same generous wait as [`until`].
async fn written(fixture: &Fixture, name: &str) {
  for _ in 0..200 {
    if fixture.exists(name) {
      return;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
  }
  panic!("the stand-in CLI never wrote {name}");
}

async fn page_shown(auth: &ClaudeCodeAuth) {
  until(auth, |status| {
    *status == ClaudeCodeStatus::SigningIn { sign_in_page: true }
  })
  .await;
}

/// Fixture executables run as child processes; see `test_child_processes`.
fn run<F: Future<Output = ()>>(test: impl FnOnce() -> F) {
  let _children = crate::test_child_processes::exclusive();
  tokio::runtime::Builder::new_multi_thread()
    .worker_threads(2)
    .enable_all()
    .build()
    .unwrap()
    .block_on(test());
}

const SIGNED_IN: ClaudeCodeStatus = ClaudeCodeStatus::SignedIn {
  email: None,
  plan: None,
};

fn signed_in(status: &ClaudeCodeStatus) -> bool {
  matches!(status, ClaudeCodeStatus::SignedIn { .. })
}

#[test]
fn the_status_follows_what_the_cli_reports() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    assert_eq!(auth.status().await, ClaudeCodeStatus::SignedOut);
    assert_eq!(fixture.calls("auth status --json"), 1);

    fixture.mark("signed-in");
    assert_eq!(
      auth.status().await,
      ClaudeCodeStatus::SignedIn {
        email: Some("person@example.com".into()),
        plan: Some("max".into()),
      }
    );

    fixture.write(
      "report",
      r#"{"loggedIn":true,"authMethod":"api_key","apiKeySource":"/login managed key"}"#,
    );
    assert_eq!(auth.status().await, ClaudeCodeStatus::ApiKey);

    fixture.write("report", r#"{"loggedIn":true,"email":"  "}"#);
    assert_eq!(auth.status().await, SIGNED_IN);

    fixture.write("report", "Not signed in");
    assert_eq!(
      auth.status().await,
      ClaudeCodeStatus::Failed {
        reason: ClaudeCodeFailure::Unavailable
      }
    );

    fixture.installed.store(false, Ordering::SeqCst);
    assert_eq!(auth.status().await, ClaudeCodeStatus::NotInstalled);
  });
}

#[test]
fn signing_in_runs_the_cli_login_without_credential_overrides() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    auth.start();
    assert!(matches!(
      auth.status().await,
      ClaudeCodeStatus::SigningIn { .. }
    ));
    page_shown(&auth).await;
    auth.open_sign_in_page().unwrap();
    assert_eq!(*fixture.opened.lock().unwrap(), [SIGN_IN_PAGE]);

    fixture.mark("approve");
    until(&auth, signed_in).await;
    assert_eq!(fixture.calls("auth login"), 1);
    assert!(fixture.changes.load(Ordering::SeqCst) >= 3);

    let environment = fixture.login_environment();
    assert_eq!(
      environment.get("CLAUDE_CONFIG_DIR").map(String::as_str),
      fixture.home().to_str()
    );
    assert_eq!(
      environment.get("DISABLE_AUTOUPDATER").map(String::as_str),
      Some("1")
    );
    assert_eq!(
      environment.get("KEPT_SETTING").map(String::as_str),
      Some("kept")
    );
    assert!(environment.contains_key("HOME"));
    for name in environment.keys() {
      let upper = name.to_ascii_uppercase();
      assert!(!upper.starts_with("ANTHROPIC_"), "{name} reached the CLI");
      assert!(
        !upper.starts_with("CLAUDE_")
          || [
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
          ]
          .contains(&name.as_str()),
        "{name} reached the CLI"
      );
      assert!(
        !["CLAUDECODE", "AWS_BEARER_TOKEN_BEDROCK"].contains(&upper.as_str()),
        "{name} reached the CLI"
      );
    }
  });
}

#[test]
fn a_second_start_while_signing_in_starts_no_second_cli() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    auth.start();
    auth.start();
    page_shown(&auth).await;
    auth.start();
    assert_eq!(
      auth.status().await,
      ClaudeCodeStatus::SigningIn { sign_in_page: true },
      "the running sign-in was kept"
    );
    fixture.mark("approve");
    until(&auth, signed_in).await;
    assert_eq!(fixture.calls("auth login"), 1);
  });
}

#[test]
fn cancelling_stops_the_cli_before_it_signs_in() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    auth.start();
    page_shown(&auth).await;
    assert!(fixture.login_running());
    auth.cancel();
    assert_eq!(
      auth.open_sign_in_page(),
      Err(OpenPageError::NoPage),
      "a cancelled sign-in's page is forgotten"
    );
    auth.settled().await;
    assert!(!fixture.login_running(), "the cancelled CLI kept running");
    assert!(!fixture.exists("signed-in"));
    assert_eq!(auth.status().await, ClaudeCodeStatus::SignedOut);
  });
}

#[test]
fn cancelling_during_the_status_read_after_the_login_stops_that_read() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    auth.start();
    page_shown(&auth).await;
    fixture.mark("status-stall");
    fixture.mark("approve");
    written(&fixture, "status-pid").await;
    assert!(
      fixture.running("status-pid"),
      "the status read never started"
    );
    auth.cancel();
    tokio::time::timeout(Duration::from_secs(5), auth.settled())
      .await
      .expect("the cancelled sign-in kept the sign-in busy");
    assert!(
      !fixture.running("status-pid"),
      "the cancelled status read kept running"
    );
    std::fs::remove_file(fixture.home().join("status-stall")).unwrap();
    assert!(signed_in(&auth.status().await));
  });
}

#[test]
fn a_sign_out_waiting_while_a_sign_in_starts_is_refused() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    fixture.mark("signed-in");
    let busy = auth.0.changing.lock().await;
    let mut sign_out = std::pin::pin!(auth.sign_out());
    // One poll queues the sign-out behind the busy lock.
    tokio::select! {
      biased;
      _ = &mut sign_out => panic!("the sign-out ran past the busy lock"),
      () = std::future::ready(()) => {}
    }
    auth.start();
    drop(busy);
    assert_eq!(sign_out.await, Err(SignOutError::SigningIn));
    assert_eq!(fixture.calls("auth logout"), 0);
    auth.cancel();
    auth.settled().await;
    assert!(signed_in(&auth.status().await));
  });
}

#[test]
fn a_declined_sign_in_fails_until_the_next_one_starts() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    auth.start();
    page_shown(&auth).await;
    fixture.mark("decline");
    assert_eq!(
      until(&auth, |status| matches!(
        status,
        ClaudeCodeStatus::Failed { .. }
      ))
      .await,
      ClaudeCodeStatus::Failed {
        reason: ClaudeCodeFailure::NotCompleted
      }
    );

    std::fs::remove_file(fixture.home().join("decline")).unwrap();
    auth.start();
    page_shown(&auth).await;
    fixture.mark("approve");
    until(&auth, signed_in).await;
  });
}

#[test]
fn a_sign_in_that_takes_too_long_is_stopped() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(3));
    auth.start();
    page_shown(&auth).await;
    assert_eq!(
      until(&auth, |status| matches!(
        status,
        ClaudeCodeStatus::Failed { .. }
      ))
      .await,
      ClaudeCodeStatus::Failed {
        reason: ClaudeCodeFailure::TimedOut
      }
    );
    assert!(!fixture.login_running(), "the timed-out CLI kept running");
  });
}

#[test]
fn signing_out_runs_the_cli_logout_and_waits_for_a_sign_in() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    fixture.mark("signed-in");
    auth.start();
    assert_eq!(auth.sign_out().await, Err(SignOutError::SigningIn));
    assert_eq!(fixture.calls("auth logout"), 0);
    auth.cancel();

    assert!(signed_in(&auth.status().await));
    auth.sign_out().await.unwrap();
    assert_eq!(fixture.calls("auth logout"), 1);
    assert_eq!(auth.status().await, ClaudeCodeStatus::SignedOut);

    fixture.installed.store(false, Ordering::SeqCst);
    assert_eq!(auth.sign_out().await, Err(SignOutError::NotInstalled));
  });
}

#[test]
fn a_page_on_another_host_is_never_opened() {
  run(|| async {
    let (fixture, auth) = fixture(Duration::from_secs(60));
    fixture.write(
      "login-output",
      "Visit: https://claude.ai.attacker.example/oauth/authorize?state=x\n",
    );
    // The CLI prints the page, then ends, so all of its output is read.
    fixture.mark("decline");
    auth.start();
    until(&auth, |status| {
      matches!(status, ClaudeCodeStatus::Failed { .. })
    })
    .await;
    assert_eq!(
      fixture.changes.load(Ordering::SeqCst),
      2,
      "only the start and the end were shown; no page was recorded"
    );
    assert!(fixture.opened.lock().unwrap().is_empty());
  });
}

#[test]
fn a_sign_in_page_after_a_long_preamble_is_still_found() {
  run(|| async {
    let mut output = "progress line\n".repeat(10_000);
    output.push_str("visit: ");
    output.push_str(SIGN_IN_PAGE);
    output.push('\n');
    let found = Mutex::new(Vec::new());
    cli::watch_for_sign_in_page(Some(output.as_bytes()), |url| {
      found.lock().unwrap().push(url);
    })
    .await;
    assert_eq!(*found.lock().unwrap(), [SIGN_IN_PAGE]);
  });
}

#[test]
fn only_https_pages_on_claude_hosts_count_as_the_sign_in_page() {
  for (text, page) in [
    (
      "If the browser did not open, visit: https://claude.ai/oauth/authorize?a=1&b=2\n",
      Some("https://claude.ai/oauth/authorize?a=1&b=2"),
    ),
    (
      "(see https://console.anthropic.com/oauth/code.)",
      Some("https://console.anthropic.com/oauth/code"),
    ),
    (
      "\u{1b}[4mhttps://claude.com/cai/oauth/authorize\u{1b}[24m",
      Some("https://claude.com/cai/oauth/authorize"),
    ),
    (
      "https://attacker.example/x then https://claude.ai/ok",
      Some("https://claude.ai/ok"),
    ),
    ("http://claude.ai/oauth/authorize", None),
    ("https://user@claude.ai/oauth/authorize", None),
    ("https://claude.ai.attacker.example/", None),
    ("https://notclaude.ai/", None),
    ("no link here", None),
  ] {
    assert_eq!(cli::sign_in_page(text).as_deref(), page, "{text}");
  }
}

#[test]
fn an_api_key_sign_in_never_counts_as_the_subscription() {
  for (report, sign_in) in [
    (r#"{"loggedIn":false}"#, Some(SignIn::None)),
    (
      r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}"#,
      Some(SignIn::Subscription {
        email: None,
        plan: Some("pro".into()),
      }),
    ),
    (
      r#"{"loggedIn":true,"authMethod":"claude.ai","apiKeySource":"none"}"#,
      Some(SignIn::Subscription {
        email: None,
        plan: None,
      }),
    ),
    (
      r#"{"loggedIn":true,"authMethod":"api_key"}"#,
      Some(SignIn::ApiKey),
    ),
    (
      r#"{"loggedIn":true,"authMethod":"claude.ai","apiKeySource":"ANTHROPIC_API_KEY"}"#,
      Some(SignIn::ApiKey),
    ),
    (r#"{"authMethod":"claude.ai"}"#, None),
    ("", None),
  ] {
    assert_eq!(cli::parse_status(report.as_bytes()), sign_in, "{report}");
  }
}
