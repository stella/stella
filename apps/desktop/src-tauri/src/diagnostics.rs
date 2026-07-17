use serde::Serialize;

use crate::types::SessionStatus;

pub(crate) struct DiagnosticsInput<'a> {
  pub generated_at: String,
  pub bridge_port: u16,
  pub running_since: &'a str,
  pub linked_account_present: bool,
  pub store_load_issue: Option<DiagnosticStoreLoadIssue>,
  pub notification_preferences: DiagnosticNotificationPreferences,
  pub update: DiagnosticUpdate<'a>,
  pub sessions: Vec<DiagnosticSession>,
  pub cleanup_paths_queued: usize,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DiagnosticStoreLoadIssue {
  InvalidStore,
  UnreadableStore,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticUpdate<'a> {
  pub configured: bool,
  pub channel_configured: bool,
  pub current_version: Option<&'a str>,
  pub last_checked_at: Option<&'a str>,
  pub latest_version: Option<&'a str>,
  pub update_available: bool,
  pub update_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticNotificationPreferences {
  pub document_ready: bool,
  pub revision_created: bool,
  pub sync_issues: bool,
}

pub(crate) struct DiagnosticSession {
  pub status: SessionStatus,
  pub has_last_checkpoint: bool,
  pub has_last_error: bool,
  pub pending_finalize: bool,
  pub takeover_detected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsExport<'a> {
  generated_at: String,
  platform: DiagnosticPlatform,
  app: DiagnosticApp<'a>,
  linked_account_present: bool,
  store_load_issue: Option<DiagnosticStoreLoadIssue>,
  notification_preferences: DiagnosticNotificationPreferences,
  update: DiagnosticUpdate<'a>,
  sessions: DiagnosticSessionSummary,
  cleanup_paths_queued: usize,
}

#[derive(Serialize)]
struct DiagnosticPlatform {
  arch: &'static str,
  os: &'static str,
  framework: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticApp<'a> {
  bridge_port: u16,
  running_since: &'a str,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticSessionSummary {
  total: usize,
  by_status: DiagnosticSessionStatusCounts,
  with_last_checkpoint: usize,
  with_last_error: usize,
  pending_finalize: usize,
  takeover_detected: usize,
}

#[derive(Default, Serialize)]
struct DiagnosticSessionStatusCounts {
  opening: usize,
  ready: usize,
  syncing: usize,
  finalizing: usize,
  error: usize,
}

pub(crate) fn render_diagnostics(input: DiagnosticsInput<'_>) -> String {
  let diagnostics = DiagnosticsExport {
    generated_at: input.generated_at,
    platform: DiagnosticPlatform {
      arch: std::env::consts::ARCH,
      os: std::env::consts::OS,
      framework: "tauri",
    },
    app: DiagnosticApp {
      bridge_port: input.bridge_port,
      running_since: input.running_since,
    },
    linked_account_present: input.linked_account_present,
    store_load_issue: input.store_load_issue,
    notification_preferences: input.notification_preferences,
    update: input.update,
    sessions: summarize_sessions(input.sessions),
    cleanup_paths_queued: input.cleanup_paths_queued,
  };

  serde_json::to_string_pretty(&diagnostics).unwrap_or_default()
}

fn summarize_sessions(
  sessions: impl IntoIterator<Item = DiagnosticSession>,
) -> DiagnosticSessionSummary {
  let mut summary = DiagnosticSessionSummary::default();

  for session in sessions {
    summary.total += 1;
    match session.status {
      SessionStatus::Opening => summary.by_status.opening += 1,
      SessionStatus::Ready => summary.by_status.ready += 1,
      SessionStatus::Syncing => summary.by_status.syncing += 1,
      SessionStatus::Finalizing => summary.by_status.finalizing += 1,
      SessionStatus::Error => summary.by_status.error += 1,
    }
    summary.with_last_checkpoint += usize::from(session.has_last_checkpoint);
    summary.with_last_error += usize::from(session.has_last_error);
    summary.pending_finalize += usize::from(session.pending_finalize);
    summary.takeover_detected += usize::from(session.takeover_detected);
  }

  summary
}
