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

use crate::clipboard_window::ClipboardStartupTrace;

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
  AutostartRead,
  AutostartUpdate,
  ClipboardHistoryRead,
  ClipboardHistorySubscribe,
  ClipboardHistoryUpdate,
  ClipboardCopy,
  ClipboardExternalOpen,
  ClipboardEditorRead,
  ClipboardEditorSave,
  ClipboardEditorClose,
  ClipboardWatcherStart,
  ClipboardWatcherRead,
  ClipboardWindowOpen,
  ClipboardWindowHide,
  ClipboardShortcutRegister,
}

impl DesktopTelemetryOperation {
  fn as_str(self) -> &'static str {
    match self {
      Self::Runtime => "runtime",
      Self::Render => "render",
      Self::AutostartRead => "autostartRead",
      Self::AutostartUpdate => "autostartUpdate",
      Self::ClipboardHistoryRead => "clipboardHistoryRead",
      Self::ClipboardHistorySubscribe => "clipboardHistorySubscribe",
      Self::ClipboardHistoryUpdate => "clipboardHistoryUpdate",
      Self::ClipboardCopy => "clipboardCopy",
      Self::ClipboardExternalOpen => "clipboardExternalOpen",
      Self::ClipboardEditorRead => "clipboardEditorRead",
      Self::ClipboardEditorSave => "clipboardEditorSave",
      Self::ClipboardEditorClose => "clipboardEditorClose",
      Self::ClipboardWatcherStart => "clipboardWatcherStart",
      Self::ClipboardWatcherRead => "clipboardWatcherRead",
      Self::ClipboardWindowOpen => "clipboardWindowOpen",
      Self::ClipboardWindowHide => "clipboardWindowHide",
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
  WindowLabelMismatch,
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
      Self::WindowLabelMismatch => "windowLabelMismatch",
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

/// Startup phases measured on the clipboard path. Spans carry durations and
/// counts only: never clipboard content, source-app identities, or search text.
// The `Clipboard` prefix is the wire namespace shared with the frontend
// contract and mirrors `DesktopTelemetryOperation`; other windows will add
// unprefixed spans, so the shared prefix is intentional, not redundant.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopTelemetrySpan {
  /// Keychain read or key creation inside clipboard initialization.
  ClipboardKeychainRead,
  /// Encrypted history file read, decryption, and parsing.
  ClipboardStoreLoad,
  /// Whole initialization: the blocking load off the mutex plus install.
  ClipboardInitialize,
  /// Show request until the WebView window builder returned.
  ClipboardWindowCreate,
  /// Show request until the page finished loading and the window was shown.
  ClipboardPageLoad,
  /// Show request until an existing window was shown and focused.
  ClipboardWindowShow,
  /// Navigation start until the React shell committed.
  ClipboardShellCommit,
  /// Time the first snapshot command waited for the manager mutex.
  ClipboardSnapshotLockWait,
  /// Time the first snapshot command spent pruning and cloning history.
  ClipboardSnapshotBuild,
  /// Frontend round trip of the first snapshot request.
  ClipboardSnapshotRequest,
  /// Navigation start until the first frame after a snapshot was applied.
  ClipboardFirstPaint,
  /// Navigation start until a snapshot with settled persistence was applied.
  ClipboardHistoryReady,
  /// Window focus after a reopen until the next painted frame.
  ClipboardReopenPaint,
}

impl DesktopTelemetrySpan {
  fn as_str(self) -> &'static str {
    match self {
      Self::ClipboardKeychainRead => "clipboardKeychainRead",
      Self::ClipboardStoreLoad => "clipboardStoreLoad",
      Self::ClipboardInitialize => "clipboardInitialize",
      Self::ClipboardWindowCreate => "clipboardWindowCreate",
      Self::ClipboardPageLoad => "clipboardPageLoad",
      Self::ClipboardWindowShow => "clipboardWindowShow",
      Self::ClipboardShellCommit => "clipboardShellCommit",
      Self::ClipboardSnapshotLockWait => "clipboardSnapshotLockWait",
      Self::ClipboardSnapshotBuild => "clipboardSnapshotBuild",
      Self::ClipboardSnapshotRequest => "clipboardSnapshotRequest",
      Self::ClipboardFirstPaint => "clipboardFirstPaint",
      Self::ClipboardHistoryReady => "clipboardHistoryReady",
      Self::ClipboardReopenPaint => "clipboardReopenPaint",
    }
  }
}

/// How the clipboard window came to be shown. Each kind has its own startup
/// profile and is analyzed separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardOpenKind {
  /// Revealed while the process started.
  Launch,
  /// Window created on demand by an already running process.
  FirstOpen,
  /// Existing hidden window shown again.
  Reopen,
}

impl ClipboardOpenKind {
  fn as_str(self) -> &'static str {
    match self {
      Self::Launch => "launch",
      Self::FirstOpen => "firstOpen",
      Self::Reopen => "reopen",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DesktopTimingReport {
  pub window: DesktopTelemetryWindow,
  pub span: DesktopTelemetrySpan,
  pub duration: Duration,
  pub open_kind: Option<ClipboardOpenKind>,
  pub item_count: Option<usize>,
  pub payload_bytes: Option<usize>,
}

/// Timing the frontend may submit. Only the duration crosses the IPC boundary;
/// the native side attaches the open kind from its own startup trace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesktopFrontendTimingReport {
  pub window: DesktopTelemetryWindow,
  pub span: DesktopTelemetrySpan,
  pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy)]
enum DesktopTelemetryEvent {
  Error(DesktopErrorReport),
  Timing(DesktopTimingReport),
}

#[derive(Clone)]
pub struct DesktopTelemetry {
  reported: Arc<Mutex<HashSet<DesktopErrorReport>>>,
  sender: Option<mpsc::Sender<DesktopTelemetryEvent>>,
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
    self.enqueue(DesktopTelemetryEvent::Error(report));
  }

  pub fn capture_timing(&self, report: DesktopTimingReport) {
    tracing::info!(
      window = ?report.window,
      span = ?report.span,
      duration_ms = report.duration.as_millis(),
      open_kind = ?report.open_kind,
      item_count = report.item_count,
      payload_bytes = report.payload_bytes,
      "desktop timing"
    );
    self.enqueue(DesktopTelemetryEvent::Timing(report));
  }

  fn enqueue(&self, event: DesktopTelemetryEvent) {
    let Some(sender) = &self.sender else {
      return;
    };
    if sender.try_send(event).is_err() {
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

fn analytics_timing_payload(
  config: &AnalyticsSinkConfig,
  report: DesktopTimingReport,
) -> Value {
  json!({
    "api_key": config.key,
    "event": "desktop_timing",
    "properties": {
      "$process_person_profile": false,
      "app_commit": option_env!("STELLA_COMMIT_SHA"),
      "app_version": env!("CARGO_PKG_VERSION"),
      "desktop_window": report.window.as_str(),
      "distinct_id": config.process_id,
      "duration_ms": u64::try_from(report.duration.as_millis()).unwrap_or(u64::MAX),
      "item_count": report.item_count,
      "open_kind": report.open_kind.map(ClipboardOpenKind::as_str),
      "payload_bytes": report.payload_bytes,
      "service_name": "stella-desktop",
      "span": report.span.as_str(),
    }
  })
}

fn analytics_payload(
  config: &AnalyticsSinkConfig,
  event: DesktopTelemetryEvent,
) -> Value {
  match event {
    DesktopTelemetryEvent::Error(report) => analytics_error_payload(config, report),
    DesktopTelemetryEvent::Timing(report) => analytics_timing_payload(config, report),
  }
}

async fn run_observability_worker(
  config: AnalyticsSinkConfig,
  mut receiver: mpsc::Receiver<DesktopTelemetryEvent>,
) {
  let Ok(client) = Client::builder().timeout(REQUEST_TIMEOUT).build() else {
    tracing::warn!("desktop telemetry client could not start");
    return;
  };
  while let Some(event) = receiver.recv().await {
    let status = client
      .post(config.endpoint.clone())
      .json(&analytics_payload(&config, event))
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

#[tauri::command]
pub fn desktop_report_timing(
  report: DesktopFrontendTimingReport,
  telemetry: State<'_, DesktopTelemetry>,
  startup: State<'_, ClipboardStartupTrace>,
) {
  let open_kind = match report.window {
    DesktopTelemetryWindow::Clipboard => startup.open_kind(),
    DesktopTelemetryWindow::Main
    | DesktopTelemetryWindow::ClipboardEditor
    | DesktopTelemetryWindow::TakeoverDialog
    | DesktopTelemetryWindow::SelfHostConnectDialog => None,
  };
  telemetry.capture_timing(DesktopTimingReport {
    window: report.window,
    span: report.span,
    duration: Duration::from_millis(report.duration_ms),
    open_kind,
    item_count: None,
    payload_bytes: None,
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct FrontendTelemetryContract {
    windows: Vec<DesktopTelemetryWindow>,
    operations: Vec<DesktopTelemetryOperation>,
    error_codes: Vec<DesktopTelemetryErrorCode>,
    spans: Vec<DesktopTelemetrySpan>,
  }

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

  #[test]
  fn frontend_telemetry_contract_deserializes_in_native_code() {
    let contract: FrontendTelemetryContract = serde_json::from_str(include_str!(
      "../../fixtures/desktop-telemetry-contract.json"
    ))
    .unwrap();

    for window in contract.windows {
      assert_eq!(
        serde_json::to_value(window).unwrap(),
        json!(window.as_str())
      );
    }
    for operation in contract.operations {
      assert_eq!(
        serde_json::to_value(operation).unwrap(),
        json!(operation.as_str())
      );
    }
    for error_code in contract.error_codes {
      assert_eq!(
        serde_json::to_value(error_code).unwrap(),
        json!(error_code.as_str())
      );
    }
    for span in contract.spans {
      assert_eq!(serde_json::to_value(span).unwrap(), json!(span.as_str()));
    }
  }

  #[test]
  fn frontend_timing_report_rejects_content_fields() {
    let value = json!({
      "window": "clipboard",
      "span": "clipboardFirstPaint",
      "durationMs": 12,
      "plainText": "must never be accepted",
    });

    assert!(serde_json::from_value::<DesktopFrontendTimingReport>(value).is_err());
  }

  #[test]
  fn timing_payload_contains_only_allowlisted_diagnostics() {
    let payload = analytics_timing_payload(
      &config(),
      DesktopTimingReport {
        window: DesktopTelemetryWindow::Clipboard,
        span: DesktopTelemetrySpan::ClipboardSnapshotBuild,
        duration: Duration::from_millis(7),
        open_kind: Some(ClipboardOpenKind::FirstOpen),
        item_count: Some(3),
        payload_bytes: Some(4096),
      },
    );
    let properties = payload["properties"].as_object().unwrap();

    assert_eq!(payload["event"], "desktop_timing");
    assert_eq!(properties["span"], "clipboardSnapshotBuild");
    assert_eq!(properties["duration_ms"], 7);
    assert_eq!(properties["open_kind"], "firstOpen");
    assert_eq!(properties["item_count"], 3);
    assert_eq!(properties["payload_bytes"], 4096);
    assert_eq!(properties["$process_person_profile"], false);
    let allowed = [
      "$process_person_profile",
      "app_commit",
      "app_version",
      "desktop_window",
      "distinct_id",
      "duration_ms",
      "item_count",
      "open_kind",
      "payload_bytes",
      "service_name",
      "span",
    ];
    for key in properties.keys() {
      assert!(allowed.contains(&key.as_str()), "unexpected property {key}");
    }
  }
}
