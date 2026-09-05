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

const MAX_ERROR_NAME_CHARS: usize = 64;
const MAX_ERROR_MESSAGE_CHARS: usize = 200;
const MAX_ERROR_FRAME_CHARS: usize = 160;
/// Distinct error events kept per process before further reports are dropped.
const MAX_REPORTED_ERRORS: usize = 200;

/// What went wrong, without what the user was working on. The webview redacts
/// before sending; this side is the trust boundary and redacts again, so a
/// report can never carry clipboard text, search terms or document content
/// even if the webview's copy of the rules drifts.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesktopErrorDetail {
  /// The thrown value's class (`TypeError`), or its type for non-errors.
  pub error_name: String,
  pub message: String,
  /// `function@file:line:col` of the top frame; bundle file names only.
  pub frame: Option<String>,
}

impl DesktopErrorDetail {
  fn sanitized(self) -> Self {
    Self {
      error_name: bounded_identifier(&self.error_name, MAX_ERROR_NAME_CHARS)
        .unwrap_or_else(|| "unknown".to_string()),
      message: redact_error_message(&self.message),
      frame: self.frame.as_deref().and_then(sanitized_frame),
    }
  }
}

/// Keeps a value made only of identifier characters; anything else is not a
/// class name or a frame and is dropped rather than trimmed into one.
fn bounded_identifier(value: &str, max_chars: usize) -> Option<String> {
  let value = value.trim();
  let valid = !value.is_empty()
    && value.chars().count() <= max_chars
    && value
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.'));
  valid.then(|| value.to_string())
}

fn sanitized_frame(frame: &str) -> Option<String> {
  let frame = frame.trim();
  let valid = !frame.is_empty()
    && frame.chars().count() <= MAX_ERROR_FRAME_CHARS
    && frame.chars().all(|c| {
      c.is_ascii_alphanumeric()
        || matches!(c, '_' | '$' | '.' | ':' | '@' | '-' | '<' | '>')
    });
  valid.then(|| frame.to_string())
}

/// Error messages quote the data they choked on (`Unexpected token 'x', "…" is
/// not valid JSON`), so every quoted span becomes `"…"`, except single-quoted
/// code identifiers such as `'item.sourceApp.name'`, which name code, not
/// content. URLs and long unbroken tokens (blobs, base64) are dropped too.
pub(crate) fn redact_error_message(message: &str) -> String {
  let mut output = String::with_capacity(message.len());
  let mut rest = message;
  while let Some(start) = rest.find(['"', '\'', '`']) {
    let quote = rest[start..].chars().next().unwrap_or('"');
    output.push_str(&rest[..start]);
    let after = &rest[start + quote.len_utf8()..];
    let Some(end) = after.find(quote) else {
      // An unterminated quote: everything after it is content.
      output.push_str("\"…\"");
      rest = "";
      break;
    };
    let quoted = &after[..end];
    let is_code_identifier = quote == '\''
      && !quoted.is_empty()
      && quoted
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '.' | '[' | ']'));
    if is_code_identifier {
      output.push('\'');
      output.push_str(quoted);
      output.push('\'');
    } else {
      output.push_str("\"…\"");
    }
    rest = &after[end + quote.len_utf8()..];
  }
  output.push_str(rest);
  let collapsed = output
    .split_whitespace()
    .map(|token| {
      if token.starts_with("http://") || token.starts_with("https://") {
        "<url>"
      } else if token.chars().count() > 48 {
        "…"
      } else {
        token
      }
    })
    .collect::<Vec<_>>()
    .join(" ");
  let mut bounded: String = collapsed.chars().take(MAX_ERROR_MESSAGE_CHARS).collect();
  if bounded.chars().count() < collapsed.chars().count() {
    bounded.push('…');
  }
  bounded
}

/// A webview error report: the allowlisted classification plus optional
/// redacted detail.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesktopFrontendErrorReport {
  pub window: DesktopTelemetryWindow,
  pub operation: DesktopTelemetryOperation,
  pub code: DesktopTelemetryErrorCode,
  #[serde(default)]
  pub detail: Option<DesktopErrorDetail>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DesktopErrorEvent {
  report: DesktopErrorReport,
  detail: Option<DesktopErrorDetail>,
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

#[derive(Debug, Clone)]
enum DesktopTelemetryEvent {
  Error(DesktopErrorEvent),
  Timing(DesktopTimingReport),
}

#[derive(Clone)]
pub struct DesktopTelemetry {
  reported: Arc<Mutex<HashSet<DesktopErrorEvent>>>,
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
    self.capture_event(DesktopErrorEvent {
      report,
      detail: None,
    });
  }

  /// A webview report, with its detail redacted here regardless of what the
  /// webview did.
  pub fn capture_frontend(&self, report: DesktopFrontendErrorReport) {
    self.capture_event(DesktopErrorEvent {
      report: DesktopErrorReport {
        window: report.window,
        operation: report.operation,
        code: report.code,
      },
      detail: report.detail.map(DesktopErrorDetail::sanitized),
    });
  }

  fn capture_event(&self, event: DesktopErrorEvent) {
    // Each distinct failure reports once per process; the cap stops a
    // rejection loop with a changing message from flooding the sink.
    let is_new = self.reported.lock().is_ok_and(|mut reported| {
      reported.len() < MAX_REPORTED_ERRORS && reported.insert(event.clone())
    });
    if !is_new {
      return;
    }

    let detail = event.detail.as_ref();
    tracing::error!(
      window = ?event.report.window,
      operation = ?event.report.operation,
      code = ?event.report.code,
      error_name = detail.map(|detail| detail.error_name.as_str()),
      error_message = detail.map(|detail| detail.message.as_str()),
      error_frame = detail.and_then(|detail| detail.frame.as_deref()),
      "desktop operation failed"
    );
    self.enqueue(DesktopTelemetryEvent::Error(event));
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
  event: &DesktopErrorEvent,
) -> Value {
  let window = event.report.window.as_str();
  let operation = event.report.operation.as_str();
  let code = event.report.code.as_str();
  let detail = event.detail.as_ref();
  // One issue per failure, not per classification: two different rejections
  // under `runtime/unhandledRejection` must not collapse into one group.
  let mut fingerprint = format!("desktop:{window}:{operation}:{code}");
  if let Some(detail) = detail {
    fingerprint.push(':');
    fingerprint.push_str(&detail.error_name);
    if let Some(frame) = &detail.frame {
      fingerprint.push(':');
      fingerprint.push_str(frame);
    }
  }
  json!({
    "api_key": config.key,
    "event": "$exception",
    "properties": {
      "$exception_fingerprint": fingerprint,
      "$exception_list": [{
        "type": detail.map_or(code, |detail| detail.error_name.as_str()),
        "value": detail.map_or("", |detail| detail.message.as_str()),
      }],
      "$exception_type": code,
      "$process_person_profile": false,
      "app_commit": option_env!("STELLA_COMMIT_SHA"),
      "app_version": env!("CARGO_PKG_VERSION"),
      "desktop_window": window,
      "distinct_id": config.process_id,
      "error_frame": detail.and_then(|detail| detail.frame.as_deref()),
      "error_name": detail.map(|detail| detail.error_name.as_str()),
      "operation": operation,
      "os": std::env::consts::OS,
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
      // Splits latency spans by platform: fixes like clipboard window
      // parking are platform-specific, and their effect must be readable
      // per OS.
      "os": std::env::consts::OS,
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
    DesktopTelemetryEvent::Error(event) => analytics_error_payload(config, &event),
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
  report: DesktopFrontendErrorReport,
  telemetry: State<'_, DesktopTelemetry>,
) {
  telemetry.capture_frontend(report);
}

#[tauri::command]
pub fn desktop_report_timing(
  report: DesktopFrontendTimingReport,
  telemetry: State<'_, DesktopTelemetry>,
  startup: State<'_, ClipboardStartupTrace>,
) {
  // The startup trace holds the kind the window was created with, so it only
  // labels the initial-open spans. A reopen paint is a reopen by definition;
  // reading the trace would misattribute it to launch or first open.
  let open_kind = match (report.window, report.span) {
    (DesktopTelemetryWindow::Clipboard, DesktopTelemetrySpan::ClipboardReopenPaint) => {
      Some(ClipboardOpenKind::Reopen)
    }
    (DesktopTelemetryWindow::Clipboard, _) => startup.open_kind(),
    (
      DesktopTelemetryWindow::Main
      | DesktopTelemetryWindow::ClipboardEditor
      | DesktopTelemetryWindow::TakeoverDialog
      | DesktopTelemetryWindow::SelfHostConnectDialog,
      _,
    ) => None,
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

  fn event(detail: Option<DesktopErrorDetail>) -> DesktopErrorEvent {
    DesktopErrorEvent {
      report: report(),
      detail,
    }
  }

  #[test]
  fn payload_contains_only_allowlisted_diagnostics() {
    let payload = analytics_error_payload(&config(), &event(None));
    let properties = payload["properties"].as_object().unwrap();

    assert_eq!(payload["event"], "$exception");
    assert_eq!(properties["desktop_window"], "clipboard");
    assert_eq!(properties["operation"], "clipboardHistoryRead");
    assert_eq!(properties["$exception_type"], "invalidResponse");
    assert_eq!(properties["$exception_list"][0]["type"], "invalidResponse");
    assert!(!properties.contains_key("clipboardText"));
    assert!(!properties.contains_key("message"));
    assert!(!properties.contains_key("stack"));
  }

  #[test]
  fn detail_names_the_failure_and_splits_the_fingerprint() {
    let detail = DesktopErrorDetail {
      error_name: "TypeError".to_string(),
      message: "undefined is not an object (evaluating 'item.sourceApp.name')"
        .to_string(),
      frame: Some("renderCard@index-3f2a.js:12:34".to_string()),
    };

    let payload = analytics_error_payload(&config(), &event(Some(detail)));
    let properties = payload["properties"].as_object().unwrap();

    assert_eq!(properties["$exception_list"][0]["type"], "TypeError");
    assert_eq!(
      properties["$exception_list"][0]["value"],
      "undefined is not an object (evaluating 'item.sourceApp.name')"
    );
    assert_eq!(properties["error_name"], "TypeError");
    assert_eq!(properties["error_frame"], "renderCard@index-3f2a.js:12:34");
    assert_eq!(
      properties["$exception_fingerprint"],
      "desktop:clipboard:clipboardHistoryRead:invalidResponse:TypeError:renderCard@index-3f2a.js:12:34"
    );
    // Classification stays the type PostHog filters on.
    assert_eq!(properties["$exception_type"], "invalidResponse");
  }

  #[test]
  fn detail_and_frontend_reports_reject_unknown_fields() {
    let detail = json!({
      "errorName": "TypeError",
      "message": "boom",
      "frame": null,
      "stack": "must never be accepted",
    });
    assert!(serde_json::from_value::<DesktopErrorDetail>(detail).is_err());

    let report = json!({
      "window": "clipboard",
      "operation": "runtime",
      "code": "unhandledRejection",
      "detail": { "errorName": "TypeError", "message": "boom", "frame": null },
      "plainText": "must never be accepted",
    });
    assert!(serde_json::from_value::<DesktopFrontendErrorReport>(report).is_err());
  }

  #[test]
  fn redaction_keeps_the_shape_of_a_message_and_drops_its_content() {
    assert_eq!(
      redact_error_message(
        r#"Unexpected token 'a', "Article 12 of the lease agreement" is not valid JSON"#
      ),
      r#"Unexpected token 'a', "…" is not valid JSON"#
    );
    assert_eq!(
      redact_error_message(
        "undefined is not an object (evaluating 'item.sourceApp.name')"
      ),
      "undefined is not an object (evaluating 'item.sourceApp.name')"
    );
    assert_eq!(
      redact_error_message("Cannot read 'Jan Novák' from `notes`"),
      r#"Cannot read "…" from "…""#
    );
    assert_eq!(
      redact_error_message(
        "Load failed https://example.org/contracts/42?token=abc now"
      ),
      "Load failed <url> now"
    );
    assert_eq!(
      redact_error_message(&format!("blob {} rejected", "A".repeat(80))),
      "blob … rejected"
    );
    assert_eq!(
      redact_error_message("unterminated \"quote text"),
      "unterminated \"…\""
    );
    let long = redact_error_message(&"word ".repeat(100));
    assert_eq!(long.chars().count(), MAX_ERROR_MESSAGE_CHARS + 1);
    assert!(long.ends_with('…'));
  }

  #[test]
  fn sanitized_detail_rejects_names_and_frames_that_are_not_identifiers() {
    let detail = DesktopErrorDetail {
      error_name: "Type Error; DROP".to_string(),
      message: "x".to_string(),
      frame: Some("fn@index.js:1:2 \"quoted\"".to_string()),
    }
    .sanitized();

    assert_eq!(detail.error_name, "unknown");
    assert_eq!(detail.frame, None);
    assert_eq!(
      DesktopErrorDetail {
        error_name: "string".to_string(),
        message: "clipboard item no longer exists".to_string(),
        frame: Some("@index-3f2a.js:9:1".to_string()),
      }
      .sanitized()
      .frame
      .as_deref(),
      Some("@index-3f2a.js:9:1")
    );
  }

  #[test]
  fn distinct_details_report_separately_and_the_cap_holds() {
    let telemetry = DesktopTelemetry {
      reported: Arc::new(Mutex::new(HashSet::new())),
      sender: None,
    };
    let detail = |message: &str| {
      Some(DesktopErrorDetail {
        error_name: "TypeError".to_string(),
        message: message.to_string(),
        frame: None,
      })
    };

    telemetry.capture_event(event(detail("first")));
    telemetry.capture_event(event(detail("second")));
    telemetry.capture_event(event(detail("first")));
    assert_eq!(telemetry.reported.lock().unwrap().len(), 2);

    for index in 0..MAX_REPORTED_ERRORS {
      telemetry.capture_event(event(detail(&format!("flood {index}"))));
    }
    assert_eq!(
      telemetry.reported.lock().unwrap().len(),
      MAX_REPORTED_ERRORS
    );
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
    assert_eq!(properties["os"], std::env::consts::OS);
    let allowed = [
      "$process_person_profile",
      "app_commit",
      "app_version",
      "desktop_window",
      "distinct_id",
      "duration_ms",
      "item_count",
      "open_kind",
      "os",
      "payload_bytes",
      "service_name",
      "span",
    ];
    for key in properties.keys() {
      assert!(allowed.contains(&key.as_str()), "unexpected property {key}");
    }
  }
}
