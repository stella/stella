//! Connected desktop presence with an independent, paced wall-clock task.

use std::future::Future;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::http_client::{DesktopHttpClient, HttpClientOptions};

const WAKE_CHECK_TICK: Duration = Duration::from_secs(30);

pub(crate) fn start(handle: AppHandle) {
  tauri::async_runtime::spawn(run_loop(
    unix_seconds(),
    move || {
      let handle = handle.clone();
      async move { report(&handle).await }
    },
    || async {
      tokio::time::sleep(WAKE_CHECK_TICK).await;
      unix_seconds()
    },
  ));
}

fn unix_seconds() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
}

pub(super) async fn run_loop<Report, ReportFuture, Tick, TickFuture>(
  mut now: u64,
  mut report: Report,
  mut tick: Tick,
) where
  Report: FnMut() -> ReportFuture,
  ReportFuture: Future<Output = ()>,
  Tick: FnMut() -> TickFuture,
  TickFuture: Future<Output = u64>,
{
  let mut schedule = Schedule::default();
  loop {
    if schedule.take_due(now, WAKE_CHECK_TICK) {
      report().await;
    }
    now = tick().await;
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
  report_interval_seconds: u64,
}

fn interval_seconds() -> u64 {
  serde_json::from_str::<Policy>(include_str!(
    "../../../../packages/api-contract/src/desktop-presence-policy.json"
  ))
  .expect("the committed desktop presence policy must be valid")
  .report_interval_seconds
}

#[derive(Default)]
struct Schedule {
  last_attempt: Option<u64>,
  last_tick: Option<u64>,
}

impl Schedule {
  fn take_due(&mut self, now: u64, tick: Duration) -> bool {
    let woke = self
      .last_tick
      .is_some_and(|last| now >= last && now - last > tick.as_secs() * 2);
    self.last_tick = Some(now);
    if !woke
      && self
        .last_attempt
        .is_some_and(|last| now >= last && now - last < interval_seconds())
    {
      return false;
    }
    // Pace attempts rather than successes so an unavailable server cannot
    // turn every wake tick into a retry.
    self.last_attempt = Some(now);
    true
  }
}

fn read_desktop_id(path: &Path) -> std::io::Result<Option<Uuid>> {
  match std::fs::read(path) {
    Ok(value) => Ok(
      std::str::from_utf8(&value)
        .ok()
        .and_then(|value| Uuid::parse_str(value.trim()).ok()),
    ),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(error),
  }
}

fn load_desktop_id(path: &Path) -> std::io::Result<Uuid> {
  load_desktop_id_with(path, |_| {})
}

fn load_desktop_id_with(
  path: &Path,
  before_publish: impl FnOnce(&Path),
) -> std::io::Result<Uuid> {
  if let Some(id) = read_desktop_id(path)? {
    return Ok(id);
  }
  let parent = path.parent().expect("desktop presence data directory");
  std::fs::create_dir_all(parent)?;
  let id = Uuid::new_v4();
  let staged = parent.join(format!(".desktop-presence-id-{id}.tmp"));
  let mut file = std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&staged)?;
  let result = (|| {
    file.write_all(id.to_string().as_bytes())?;
    file.sync_all()?;
    // Close before publication so Windows can rename and remove the temporary file.
    drop(file);
    before_publish(&staged);
    match std::fs::hard_link(&staged, path) {
      Ok(()) => Ok(id),
      Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
        // Lock a stable sibling, not the inode replaced by the repair's rename.
        // Never remove the lock file: all concurrent repairs must lock the same inode.
        let repair_lock = std::fs::OpenOptions::new()
          .write(true)
          .create(true)
          .truncate(false)
          .open(path.with_extension("lock"))?;
        repair_lock.lock()?;
        if let Some(winner) = read_desktop_id(path)? {
          return Ok(winner);
        }
        std::fs::rename(&staged, path)?;
        Ok(id)
      }
      Err(error) => Err(error),
    }
  })();
  if let Err(error) = std::fs::remove_file(&staged)
    && error.kind() != std::io::ErrorKind::NotFound
  {
    tracing::warn!(%error, "desktop presence temporary identity cleanup failed");
  }
  result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
  desktop_id: String,
  version: &'a str,
  protocol: u32,
}

fn request(
  client: &DesktopHttpClient,
  account: &crate::account::LinkedAccount,
  report: &Report<'_>,
) -> reqwest::RequestBuilder {
  client
    .post(format!("{}/v1/desktop/presence", account.api_base_url))
    .bearer_auth(&account.credential.key)
    .json(report)
}

async fn report(handle: &AppHandle) {
  let state = handle.state::<crate::account::AccountState>();
  let account = match crate::account::current(&state).await {
    Ok(Some(account)) => account,
    Ok(None) => return,
    Err(_) => {
      tracing::warn!("desktop presence account unavailable");
      return;
    }
  };
  let Some(root) = dirs::data_dir() else {
    tracing::warn!("desktop presence has no data directory");
    return;
  };
  let Ok(id) = load_desktop_id(
    &root
      .join(crate::config::APP_DATA_DIR_NAME)
      .join("desktop-presence-id"),
  ) else {
    tracing::warn!("desktop presence identity unavailable");
    return;
  };
  let Ok(client) = DesktopHttpClient::new(HttpClientOptions {
    timeout: Some(Duration::from_secs(10)),
    redirect: reqwest::redirect::Policy::none(),
  }) else {
    tracing::warn!("desktop presence HTTP client unavailable");
    return;
  };
  let version = handle.package_info().version.to_string();
  let result = request(
    &client,
    &account,
    &Report {
      desktop_id: id.to_string(),
      version: &version,
      protocol: crate::handoff::PROTOCOL_VERSION,
    },
  )
  .send()
  .await;
  match result {
    Ok(response) if response.status().is_success() => {}
    Ok(response) => {
      tracing::warn!(status = %response.status(), "desktop presence report refused")
    }
    Err(_) => tracing::warn!("desktop presence report unavailable"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn attempts_are_paced_across_sleep_clock_reversal_and_failure() {
    let mut schedule = Schedule::default();
    let interval = interval_seconds();
    let tick = Duration::from_secs(30);
    assert!(schedule.take_due(1_000, tick));
    // Failure does not reset the attempt time.
    for elapsed in (30..interval).step_by(30) {
      assert!(!schedule.take_due(1_000 + elapsed, tick));
    }
    assert!(schedule.take_due(1_000 + interval, tick));
    assert!(schedule.take_due(1_000 + 24 * 60 * 60, tick));
    assert!(schedule.take_due(900, tick));
    assert!(!schedule.take_due(930, tick));
    assert!(schedule.take_due(1_020, tick));
    assert!(!schedule.take_due(1_050, tick));
  }

  #[test]
  fn a_short_wake_reports_before_the_normal_interval() {
    let mut schedule = Schedule::default();
    let tick = Duration::from_secs(30);
    assert!(interval_seconds() > 121);
    assert!(schedule.take_due(1_000, tick));
    assert!(!schedule.take_due(1_060, tick));
    assert!(schedule.take_due(1_121, tick));
    assert!(!schedule.take_due(1_151, tick));
  }

  #[test]
  fn report_uses_account_bearer_and_only_the_presence_contract_fields() {
    let account = serde_json::from_value(serde_json::json!({
      "apiBaseUrl": "https://api.example.test",
      "webOrigin": "https://web.example.test",
      "identity": {"userId": "user_fixture", "organizationId": "org_fixture"},
      "account": {"email": "desktop@example.test", "name": null, "verifiedAt": "2026-10-05T00:00:00Z"},
      "credential": {"key": "account-key", "expiresAt": "2026-10-06T00:00:00Z"}
    })).unwrap();
    let client = DesktopHttpClient::new(HttpClientOptions::default()).unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
      "../../../../packages/api-contract/src/desktop-presence-request.fixture.json"
    ))
    .unwrap();
    assert_eq!(fixture.as_object().unwrap().len(), 3);
    assert_eq!(fixture["protocol"], crate::handoff::PROTOCOL_VERSION);
    let id = Uuid::parse_str(fixture["desktopId"].as_str().unwrap()).unwrap();
    let req = request(
      &client,
      &account,
      &Report {
        desktop_id: id.to_string(),
        version: fixture["version"].as_str().unwrap(),
        protocol: crate::handoff::PROTOCOL_VERSION,
      },
    )
    .build()
    .unwrap();
    assert_eq!(req.method(), reqwest::Method::POST);
    assert_eq!(
      req.url().as_str(),
      "https://api.example.test/v1/desktop/presence"
    );
    assert_eq!(req.headers()["authorization"], "Bearer account-key");
    let body: serde_json::Value =
      serde_json::from_slice(req.body().unwrap().as_bytes().unwrap()).unwrap();
    assert_eq!(body, fixture);
  }

  fn identity_test_path() -> std::path::PathBuf {
    std::env::temp_dir()
      .join(Uuid::new_v4().to_string())
      .join("desktop-presence-id")
  }

  #[test]
  fn missing_identity_is_created_and_remains_stable() {
    let path = identity_test_path();
    let id = load_desktop_id_with(&path, |staged| {
      assert!(!path.exists());
      assert!(read_desktop_id(staged).unwrap().is_some());
    })
    .unwrap();
    assert_eq!(id.get_version_num(), 4);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), id.to_string());
    assert_eq!(load_desktop_id(&path).unwrap(), id);
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn valid_identity_is_preserved_without_rewriting() {
    let path = identity_test_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let id = Uuid::new_v4();
    let contents = format!(" {id}\n");
    std::fs::write(&path, &contents).unwrap();
    assert_eq!(load_desktop_id(&path).unwrap(), id);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), contents);
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  fn assert_identity_is_repaired(contents: &[u8]) {
    let path = identity_test_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, contents).unwrap();
    let id = load_desktop_id_with(&path, |staged| {
      // Until publication, only the complete temporary file contains the new id.
      assert_eq!(std::fs::read(&path).unwrap(), contents);
      let staged_id =
        Uuid::parse_str(&std::fs::read_to_string(staged).unwrap()).unwrap();
      assert_eq!(staged_id.get_version_num(), 4);
    })
    .unwrap();
    assert_eq!(id.get_version_num(), 4);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), id.to_string());
    assert_eq!(load_desktop_id(&path).unwrap(), id);
    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
  }

  #[test]
  fn empty_identity_is_repaired_atomically() {
    assert_identity_is_repaired(b"");
  }

  #[test]
  fn garbage_and_partial_identities_are_repaired_atomically() {
    for contents in [b"invalid".as_slice(), b"11111111-1111-", b"\xff\xfe"] {
      assert_identity_is_repaired(contents);
    }
  }

  fn assert_concurrent_identity(initial: Option<&[u8]>) {
    for winner_first in [true, false] {
      let path = identity_test_path();
      if let Some(contents) = initial {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, contents).unwrap();
      }
      let ready = std::sync::Barrier::new(2);
      let (published_tx, published_rx) = std::sync::mpsc::channel();
      let (winner, (loser_candidate, loser)) = std::thread::scope(|scope| {
        let path = &path;
        let ready = &ready;
        let run_winner = move || {
          let id = load_desktop_id_with(path, |staged| {
            assert!(read_desktop_id(path).unwrap().is_none());
            assert!(read_desktop_id(staged).unwrap().is_some());
            ready.wait();
          })
          .unwrap();
          published_tx.send(id).unwrap();
          id
        };
        let run_loser = move || {
          let mut candidate = Uuid::nil();
          let id = load_desktop_id_with(path, |staged| {
            assert!(read_desktop_id(path).unwrap().is_none());
            candidate = read_desktop_id(staged).unwrap().unwrap();
            ready.wait();
            let winner = published_rx.recv().unwrap();
            assert_eq!(read_desktop_id(path).unwrap(), Some(winner));
          })
          .unwrap();
          (candidate, id)
        };
        let (winner, loser) = if winner_first {
          let winner = scope.spawn(run_winner);
          let loser = scope.spawn(run_loser);
          (winner, loser)
        } else {
          let loser = scope.spawn(run_loser);
          let winner = scope.spawn(run_winner);
          (winner, loser)
        };
        (winner.join().unwrap(), loser.join().unwrap())
      });
      assert_ne!(winner, loser_candidate);
      assert_eq!(winner, loser);
      assert_eq!(load_desktop_id(&path).unwrap(), winner);
      assert_eq!(std::fs::read_to_string(&path).unwrap(), winner.to_string());
      std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
  }

  #[test]
  fn concurrent_first_runs_keep_the_already_exists_winner() {
    assert_concurrent_identity(None);
  }

  #[test]
  fn concurrent_repairs_keep_the_first_valid_identity() {
    for contents in [b"".as_slice(), b"invalid"] {
      assert_concurrent_identity(Some(contents));
    }
  }
}
