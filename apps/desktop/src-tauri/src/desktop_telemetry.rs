use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
  collections::HashSet,
  sync::{Arc, Mutex},
  time::Duration,
};
use tauri::State;
use tokio::sync::mpsc;

const ANALYTICS_CAPTURE_PATH: &str = "capture/";
const DEFAULT_ANALYTICS_HOST: &str = "https://eu.i.posthog.com/";
const ANALYTICS_KEY_PREFIX: &str = "phc_";
const REPORT_QUEUE_CAPACITY: usize = 64;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopTelemetryWindow {
  Main,
  Clipboard,
  ClipboardEditor,
  TakeoverDialog,
  SelfHostConnectDialog,
}

impl DesktopTelemetryWindow {
  fn as_str(self) -> &'static str {
    match self {
      Self::Main => "main",
      Self::Clipboard => "clipboard",
      Self::ClipboardEditor => "clipboardEditor",
      Self::TakeoverDialog => "takeoverDialog",
      Self::SelfHostConnectDialog => "selfHostConnectDialog",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopTelemetryOperation {
  Runtime,
  Render,
  ClipboardHistoryRead,
  ClipboardHistorySubscribe,
  ClipboardHistoryUpdate,
  ClipboardPaste,
  ClipboardExternalOpen,
  ClipboardEditorRead,
  ClipboardEditorSave,
  ClipboardEditorClose,
  ClipboardWatcherStart,
  ClipboardWatcherRead,
  ClipboardWindowOpen,
  ClipboardShortcutRegister,
}

impl DesktopTelemetryOperation {
  fn as_str(self) -> &'static str {
    match self {
      Self::Runtime => "runtime",
      Self::Render => "render",
      Self::ClipboardHistoryRead => "clipboardHistoryRead",
      Self::ClipboardHistorySubscribe => "clipboardHistorySubscribe",
      Self::ClipboardHistoryUpdate => "clipboardHistoryUpdate",
      Self::ClipboardPaste => "clipboardPaste",
      Self::ClipboardExternalOpen => "clipboardExternalOpen",
      Self::ClipboardEditorRead => "clipboardEditorRead",
      Self::ClipboardEditorSave => "clipboardEditorSave",
      Self::ClipboardEditorClose => "clipboardEditorClose",
      Self::ClipboardWatcherStart => "clipboardWatcherStart",
      Self::ClipboardWatcherRead => "clipboardWatcherRead",
      Self::ClipboardWindowOpen => "clipboardWindowOpen",
      Self::ClipboardShortcutRegister => "clipboardShortcutRegister",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopTelemetryErrorCode {
  UnhandledError,
  UnhandledRejection,
  ReactCaught,
  ReactRecoverable,
  ReactUncaught,
  InvalidResponse,
  InvokeFailed,
  EventSubscriptionFailed,
  ClipboardUnavailable,
  WatcherUnavailable,
  LockPoisoned,
  FormatReadFailed,
  PersistenceFailed,
  WindowUnavailable,
  ShortcutUnavailable,
}

impl DesktopTelemetryErrorCode {
  fn as_str(self) -> &'static str {
    match self {
      Self::UnhandledError => "unhandledError",
      Self::UnhandledRejection => "unhandledRejection",
      Self::ReactCaught => "reactCaught",
      Self::ReactRecoverable => "reactRecoverable",
      Self::ReactUncaught => "reactUncaught",
      Self::InvalidResponse => "invalidResponse",
      Self::InvokeFailed => "invokeFailed",
      Self::EventSubscriptionFailed => "eventSubscriptionFailed",
      Self::ClipboardUnavailable => "clipboardUnavailable",
      Self::WatcherUnavailable => "watcherUnavailable",
      Self::LockPoisoned => "lockPoisoned",
      Self::FormatReadFailed => "formatReadFailed",
      Self::PersistenceFailed => "persistenceFailed",
      Self::WindowUnavailable => "windowUnavailable",
      Self::ShortcutUnavailable => "shortcutUnavailable",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesktopErrorReport {
  pub window: DesktopTelemetryWindow,
  pub operation: DesktopTelemetryOperation,
  pub code: DesktopTelemetryErrorCode,
}

#[derive(Clone)]
pub struct DesktopTelemetry {
  reported: Arc<Mutex<HashSet<DesktopErrorReport>>>,
  sender: Option<mpsc::Sender<DesktopErrorReport>>,
}

struct AnalyticsSinkConfig {
  endpoint: Url,
  key: String,
  process_id: String,
}

impl DesktopTelemetry {
  pub fn start() -> Self {
    let reported = Arc::new(Mutex::new(HashSet::new()));
    let Some(config) = AnalyticsSinkConfig::resolve() else {
      return Self {
        reported,
        sender: None,
      };
    };
    let (sender, receiver) = mpsc::channel(REPORT_QUEUE_CAPACITY);
    tauri::async_runtime::spawn(run_observability_worker(config, receiver));
    Self {
      reported,
      sender: Some(sender),
    }
  }

  pub fn capture(&self, report: DesktopErrorReport) {
    let is_new = self
      .reported
      .lock()
      .is_ok_and(|mut reported| reported.insert(report));
    if !is_new {
      return;
    }

    tracing::error!(
      window = ?report.window,
      operation = ?report.operation,
      code = ?report.code,
      "desktop operation failed"
    );
    let Some(sender) = &self.sender else {
      return;
    };
    if sender.try_send(report).is_err() {
      tracing::warn!("desktop telemetry queue is unavailable");
    }
  }
}

impl AnalyticsSinkConfig {
  fn resolve() -> Option<Self> {
    #[cfg(debug_assertions)]
    std::env::var_os("STELLA_DESKTOP_TELEMETRY_LOCAL_DEBUG")?;

    let key = std::env::var("VITE_POSTHOG_KEY")
      .ok()
      .or_else(|| option_env!("VITE_POSTHOG_KEY").map(str::to_string))?;
    if key == ANALYTICS_KEY_PREFIX
      || !key.starts_with(ANALYTICS_KEY_PREFIX)
      || key.len() > 256
    {
      return None;
    }

    let host = std::env::var("VITE_POSTHOG_HOST")
      .ok()
      .or_else(|| option_env!("VITE_POSTHOG_HOST").map(str::to_string))
      .unwrap_or_else(|| DEFAULT_ANALYTICS_HOST.to_string());
    let mut host = Url::parse(&host).ok()?;
    let local_debug = cfg!(debug_assertions)
      && std::env::var_os("STELLA_DESKTOP_TELEMETRY_LOCAL_DEBUG").is_some();
    if (host.scheme() != "https" && !(local_debug && host.scheme() == "http"))
      || host.username() != ""
      || host.password().is_some()
      || host.query().is_some()
      || host.fragment().is_some()
    {
      return None;
    }
    if !host.path().ends_with('/') {
      host.set_path(&format!("{}/", host.path()));
    }
    let endpoint = host.join(ANALYTICS_CAPTURE_PATH).ok()?;
    Some(Self {
      endpoint,
      key,
      process_id: uuid::Uuid::new_v4().to_string(),
    })
  }
}

fn analytics_error_payload(
  config: &AnalyticsSinkConfig,
  report: DesktopErrorReport,
) -> Value {
  let window = report.window.as_str();
  let operation = report.operation.as_str();
  let code = report.code.as_str();
  let fingerprint = format!("desktop:{window}:{operation}:{code}");
  json!({
    "api_key": config.key,
    "event": "$exception",
    "properties": {
      "$exception_fingerprint": fingerprint,
      "$exception_list": [{
        "type": code,
        "value": "",
      }],
      "$exception_type": code,
      "$process_person_profile": false,
      "app_commit": option_env!("STELLA_COMMIT_SHA"),
      "app_version": env!("CARGO_PKG_VERSION"),
      "desktop_window": window,
      "distinct_id": config.process_id,
      "operation": operation,
      "service_name": "stella-desktop",
    }
  })
}

async fn run_observability_worker(
  config: AnalyticsSinkConfig,
  mut receiver: mpsc::Receiver<DesktopErrorReport>,
) {
  let Ok(client) = Client::builder().timeout(REQUEST_TIMEOUT).build() else {
    tracing::warn!("desktop telemetry client could not start");
    return;
  };
  while let Some(report) = receiver.recv().await {
    let status = client
      .post(config.endpoint.clone())
      .json(&analytics_error_payload(&config, report))
      .send()
      .await
      .map(|response| response.status());
    match status {
      Ok(status) if status.is_success() => {}
      Ok(status) => tracing::warn!(
        status = status.as_u16(),
        "desktop telemetry delivery was rejected"
      ),
      Err(_) => tracing::warn!("desktop telemetry delivery failed"),
    }
  }
}

#[tauri::command]
pub fn desktop_report_error(
  report: DesktopErrorReport,
  telemetry: State<'_, DesktopTelemetry>,
) {
  telemetry.capture(report);
}

#[cfg(test)]
mod tests {
  use super::*;

  fn config() -> AnalyticsSinkConfig {
    AnalyticsSinkConfig {
      endpoint: Url::parse("https://example.com/capture/").unwrap(),
      key: "phc_test".to_string(),
      process_id: "process-test".to_string(),
    }
  }

  fn report() -> DesktopErrorReport {
    DesktopErrorReport {
      window: DesktopTelemetryWindow::Clipboard,
      operation: DesktopTelemetryOperation::ClipboardHistoryRead,
      code: DesktopTelemetryErrorCode::InvalidResponse,
    }
  }

  #[test]
  fn report_rejects_unknown_content_fields() {
    let value = json!({
      "window": "clipboard",
      "operation": "clipboardHistoryRead",
      "code": "invalidResponse",
      "clipboardText": "must never be accepted",
    });

    assert!(serde_json::from_value::<DesktopErrorReport>(value).is_err());
  }

  #[test]
  fn payload_contains_only_allowlisted_diagnostics() {
    let payload = analytics_error_payload(&config(), report());
    let properties = payload["properties"].as_object().unwrap();

    assert_eq!(payload["event"], "$exception");
    assert_eq!(properties["desktop_window"], "clipboard");
    assert_eq!(properties["operation"], "clipboardHistoryRead");
    assert_eq!(properties["$exception_type"], "invalidResponse");
    assert!(!properties.contains_key("clipboardText"));
    assert!(!properties.contains_key("message"));
    assert!(!properties.contains_key("stack"));
  }

  #[test]
  fn non_error_metadata_cannot_deserialize_as_a_report() {
    for field in ["plainText", "html", "query", "sourceApp", "groupName"] {
      let mut value = serde_json::to_value(report()).unwrap();
      value
        .as_object_mut()
        .unwrap()
        .insert(field.to_string(), json!("private"));
      assert!(serde_json::from_value::<DesktopErrorReport>(value).is_err());
    }
  }
}
