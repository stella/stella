//! Connected desktop presence, paced by the updater's wall-clock tick.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::http_client::{DesktopHttpClient, HttpClientOptions};

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
pub(crate) struct Schedule {
  last_attempt: Option<u64>,
  last_tick: Option<u64>,
}

impl Schedule {
  pub(crate) fn take_due(&mut self, now: u64, tick: Duration) -> bool {
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

fn load_desktop_id(path: &Path) -> std::io::Result<Uuid> {
  match std::fs::read_to_string(path) {
    Ok(value) => Uuid::parse_str(value.trim())
      .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      let parent = path.parent().expect("desktop presence data directory");
      std::fs::create_dir_all(parent)?;
      let id = Uuid::new_v4();
      let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
      file.write_all(id.to_string().as_bytes())?;
      Ok(id)
    }
    Err(error) => Err(error),
  }
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

pub(crate) async fn report(handle: &AppHandle) {
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

  #[test]
  fn installation_identity_is_stable_and_invalid_storage_is_refused() {
    let root = std::env::temp_dir().join(Uuid::new_v4().to_string());
    let path = root.join("desktop-presence-id");
    let id = load_desktop_id(&path).unwrap();
    assert_eq!(id.get_version_num(), 4);
    assert_eq!(load_desktop_id(&path).unwrap(), id);
    std::fs::write(&path, "invalid").unwrap();
    assert_eq!(
      load_desktop_id(&path).unwrap_err().kind(),
      std::io::ErrorKind::InvalidData
    );
    std::fs::remove_dir_all(root).unwrap();
  }
}
