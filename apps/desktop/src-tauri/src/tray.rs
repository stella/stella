use tauri::{
  menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
  AppHandle, Wry,
};

use crate::i18n::{t, t_plural};
use crate::types::{AppSnapshot, SessionSnapshot};

const QUIT_ACTION: &str = "quit";
const OPEN_PREFERENCES_ACTION: &str = "open-preferences";
const OPEN_ABOUT_ACTION: &str = "open-about";
const CHECK_FOR_UPDATES_ACTION: &str = "check-for-updates";
const OPEN_EDIT_ROOT_ACTION: &str = "open-edit-root";
const COPY_DIAGNOSTICS_ACTION: &str = "copy-diagnostics";
const EMAIL_SUPPORT_ACTION: &str = "email-support";
const OPEN_SUPPORT_ROOT_ACTION: &str = "open-support-root";
const SESSION_OPEN_PREFIX: &str = "session-open:";
const SESSION_REVEAL_PREFIX: &str = "session-reveal:";
const SESSION_FINISH_PREFIX: &str = "session-finish:";
const SESSION_RETRY_PREFIX: &str = "session-retry:";

fn format_session_status(session: &SessionSnapshot) -> String {
  if session.takeover_detected {
    return t("tray.sessionMovedToAnotherDevice").to_string();
  }
  match session.status {
    crate::types::SessionStatus::Error => t("tray.sessionNeedsAttention").to_string(),
    crate::types::SessionStatus::Finalizing => {
      t("tray.sessionCreatingRevision").to_string()
    }
    crate::types::SessionStatus::Opening => t("tray.sessionOpeningInWord").to_string(),
    crate::types::SessionStatus::Ready => if session.pending_finalize {
      t("tray.sessionFinishingEdit")
    } else {
      t("tray.sessionEditingLive")
    }
    .to_string(),
    crate::types::SessionStatus::Syncing => if session.pending_finalize {
      t("tray.sessionFinishingEdit")
    } else {
      t("tray.sessionSavingDraft")
    }
    .to_string(),
  }
}

fn can_retry_session(session: &SessionSnapshot) -> bool {
  !session.takeover_detected
    && (session.status == crate::types::SessionStatus::Error
      || session.pending_finalize)
}

fn get_tray_status_label(snapshot: &AppSnapshot) -> String {
  if snapshot.update.update_ready {
    return t("tray.updateReady").to_string();
  }

  let needs_attention = snapshot
    .sessions
    .iter()
    .any(|s| s.takeover_detected || s.status == crate::types::SessionStatus::Error);
  if needs_attention {
    return t("tray.needsAttention").to_string();
  }

  let active_syncs = snapshot
    .sessions
    .iter()
    .filter(|s| {
      s.status == crate::types::SessionStatus::Syncing
        || s.status == crate::types::SessionStatus::Finalizing
    })
    .count();
  if active_syncs > 0 {
    return t_plural("tray.documentsSyncing", active_syncs);
  }

  let active = snapshot.sessions.len();
  if active > 0 {
    return t_plural("tray.activeEdits", active);
  }

  t("tray.noActiveEdits").to_string()
}

pub fn build_tray_menu(
  app: &AppHandle,
  snapshot: &AppSnapshot,
) -> tauri::Result<Menu<Wry>> {
  let mut builder = MenuBuilder::new(app);

  // Status line
  builder = builder.item(
    &MenuItemBuilder::with_id("status", get_tray_status_label(snapshot))
      .enabled(false)
      .build(app)?,
  );
  builder = builder.separator();

  // Settings
  builder = builder.item(
    &MenuItemBuilder::with_id(OPEN_PREFERENCES_ACTION, t("tray.settings"))
      .build(app)?,
  );

  // Check for updates
  builder = builder.item(
    &MenuItemBuilder::with_id(CHECK_FOR_UPDATES_ACTION, t("tray.checkForUpdates"))
      .enabled(
        snapshot.update.status != "checking"
          && snapshot.update.status != "downloading"
          && snapshot.update.status != "applying",
      )
      .build(app)?,
  );

  // Support submenu
  let support_menu = SubmenuBuilder::new(app, t("tray.support"))
    .item(
      &MenuItemBuilder::with_id(EMAIL_SUPPORT_ACTION, t("tray.supportEmailSupport"))
        .build(app)?,
    )
    .separator()
    .item(
      &MenuItemBuilder::with_id(
        COPY_DIAGNOSTICS_ACTION,
        t("tray.supportCopyDiagnostics"),
      )
      .build(app)?,
    )
    .item(
      &MenuItemBuilder::with_id(
        OPEN_SUPPORT_ROOT_ACTION,
        t("tray.supportRevealAppData"),
      )
      .build(app)?,
    )
    .build()?;
  builder = builder.item(&support_menu);

  // Active edits submenu
  let mut edits_builder = SubmenuBuilder::new(app, t("tray.activeEditsSubmenu"));
  if snapshot.sessions.is_empty() {
    edits_builder = edits_builder.item(
      &MenuItemBuilder::with_id("no-edits", t("tray.noActiveEdits"))
        .enabled(false)
        .build(app)?,
    );
  } else {
    for session in &snapshot.sessions {
      let session_menu = SubmenuBuilder::new(app, &session.file_name)
        .item(
          &MenuItemBuilder::with_id(
            format!("status-{}", session.id),
            format_session_status(session),
          )
          .enabled(false)
          .build(app)?,
        )
        .separator()
        .item(
          &MenuItemBuilder::with_id(
            format!("{SESSION_OPEN_PREFIX}{}", session.id),
            t("tray.openFile"),
          )
          .build(app)?,
        )
        .item(
          &MenuItemBuilder::with_id(
            format!("{SESSION_REVEAL_PREFIX}{}", session.id),
            t("tray.revealInFolder"),
          )
          .build(app)?,
        )
        .item(
          &MenuItemBuilder::with_id(
            format!("{SESSION_FINISH_PREFIX}{}", session.id),
            t("tray.finishEditing"),
          )
          .enabled(!session.takeover_detected)
          .build(app)?,
        )
        .item(
          &MenuItemBuilder::with_id(
            format!("{SESSION_RETRY_PREFIX}{}", session.id),
            t("tray.retryNow"),
          )
          .enabled(can_retry_session(session))
          .build(app)?,
        )
        .build()?;
      edits_builder = edits_builder.item(&session_menu);
    }
  }
  builder = builder.item(&edits_builder.build()?);

  builder = builder.separator();
  builder = builder.item(
    &MenuItemBuilder::with_id(OPEN_ABOUT_ACTION, t("tray.aboutStellaDesktop"))
      .build(app)?,
  );
  builder = builder.separator();
  builder = builder.item(
    &MenuItemBuilder::with_id(QUIT_ACTION, t("tray.quitStellaDesktop")).build(app)?,
  );

  builder.build()
}

pub fn get_session_id_from_action<'a>(
  action: &'a str,
  prefix: &str,
) -> Option<&'a str> {
  action.strip_prefix(prefix).filter(|s| !s.is_empty())
}

pub fn handle_menu_action(action: &str) -> MenuAction {
  if action == QUIT_ACTION {
    return MenuAction::Quit;
  }
  if action == OPEN_PREFERENCES_ACTION {
    return MenuAction::OpenPreferences("general");
  }
  if action == OPEN_ABOUT_ACTION {
    return MenuAction::OpenPreferences("about");
  }
  if action == CHECK_FOR_UPDATES_ACTION {
    return MenuAction::CheckForUpdates;
  }
  if action == OPEN_EDIT_ROOT_ACTION {
    return MenuAction::OpenEditRoot;
  }
  if action == COPY_DIAGNOSTICS_ACTION {
    return MenuAction::CopyDiagnostics;
  }
  if action == EMAIL_SUPPORT_ACTION {
    return MenuAction::EmailSupport;
  }
  if action == OPEN_SUPPORT_ROOT_ACTION {
    return MenuAction::RevealSupportRoot;
  }

  if let Some(id) = get_session_id_from_action(action, SESSION_OPEN_PREFIX) {
    return MenuAction::OpenSessionFile(id.to_string());
  }
  if let Some(id) = get_session_id_from_action(action, SESSION_REVEAL_PREFIX) {
    return MenuAction::RevealSession(id.to_string());
  }
  if let Some(id) = get_session_id_from_action(action, SESSION_FINISH_PREFIX) {
    return MenuAction::FinishSession(id.to_string());
  }
  if let Some(id) = get_session_id_from_action(action, SESSION_RETRY_PREFIX) {
    return MenuAction::RetrySession(id.to_string());
  }

  MenuAction::OpenPreferences("general")
}

pub enum MenuAction {
  Quit,
  OpenPreferences(&'static str),
  CheckForUpdates,
  OpenEditRoot,
  CopyDiagnostics,
  EmailSupport,
  RevealSupportRoot,
  OpenSessionFile(String),
  RevealSession(String),
  FinishSession(String),
  RetrySession(String),
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::{
    DesktopNotificationPreferences, DesktopUpdateSnapshot, SessionStatus,
  };

  fn init_i18n() {
    crate::i18n::init_en();
  }

  fn make_session(status: SessionStatus) -> SessionSnapshot {
    SessionSnapshot {
      base_version_number: 1,
      entity_id: "ent-1".into(),
      file_name: "contract.docx".into(),
      file_path: "/tmp/contract.docx".into(),
      id: "sess-1".into(),
      last_error: None,
      last_checkpoint_at: None,
      pending_finalize: false,
      property_id: "prop-1".into(),
      status,
      takeover_detected: false,
      workspace_id: "ws-1".into(),
    }
  }

  fn make_snapshot(sessions: Vec<SessionSnapshot>) -> AppSnapshot {
    AppSnapshot {
      bridge_port: 45_901,
      bridge_version: crate::types::BRIDGE_VERSION,
      capabilities: crate::types::BRIDGE_CAPABILITIES
        .iter()
        .map(|s| (*s).to_string())
        .collect(),
      linked_account: None,
      notification_preferences: DesktopNotificationPreferences::default(),
      running_since: "2026-01-01T00:00:00Z".into(),
      sessions,
      update: DesktopUpdateSnapshot::default(),
    }
  }

  // -- format_session_status --

  #[test]
  fn test_format_session_status_error() {
    init_i18n();
    let s = make_session(SessionStatus::Error);
    assert_eq!(format_session_status(&s), "Needs attention");
  }

  #[test]
  fn test_format_session_status_finalizing() {
    init_i18n();
    let s = make_session(SessionStatus::Finalizing);
    assert_eq!(format_session_status(&s), "Creating final revision");
  }

  #[test]
  fn test_format_session_status_opening() {
    init_i18n();
    let s = make_session(SessionStatus::Opening);
    assert_eq!(format_session_status(&s), "Opening in Word");
  }

  #[test]
  fn test_format_session_status_ready() {
    init_i18n();
    let s = make_session(SessionStatus::Ready);
    assert_eq!(format_session_status(&s), "Editing live");
  }

  #[test]
  fn test_format_session_status_ready_pending_finalize() {
    init_i18n();
    let mut s = make_session(SessionStatus::Ready);
    s.pending_finalize = true;
    assert_eq!(format_session_status(&s), "Finishing edit");
  }

  #[test]
  fn test_format_session_status_syncing() {
    init_i18n();
    let s = make_session(SessionStatus::Syncing);
    assert_eq!(format_session_status(&s), "Saving draft");
  }

  #[test]
  fn test_format_session_status_syncing_pending_finalize() {
    init_i18n();
    let mut s = make_session(SessionStatus::Syncing);
    s.pending_finalize = true;
    assert_eq!(format_session_status(&s), "Finishing edit");
  }

  #[test]
  fn test_format_session_status_takeover() {
    init_i18n();
    let mut s = make_session(SessionStatus::Ready);
    s.takeover_detected = true;
    assert_eq!(format_session_status(&s), "Moved to another device");
  }

  // -- can_retry_session --

  #[test]
  fn test_can_retry_error_no_takeover() {
    let s = make_session(SessionStatus::Error);
    assert!(can_retry_session(&s));
  }

  #[test]
  fn test_can_retry_pending_finalize() {
    let mut s = make_session(SessionStatus::Ready);
    s.pending_finalize = true;
    assert!(can_retry_session(&s));
  }

  #[test]
  fn test_cannot_retry_takeover() {
    let mut s = make_session(SessionStatus::Error);
    s.takeover_detected = true;
    assert!(!can_retry_session(&s));
  }

  #[test]
  fn test_cannot_retry_ready_normal() {
    let s = make_session(SessionStatus::Ready);
    assert!(!can_retry_session(&s));
  }

  // -- get_tray_status_label --

  #[test]
  fn test_status_label_no_sessions() {
    init_i18n();
    let snap = make_snapshot(vec![]);
    assert_eq!(get_tray_status_label(&snap), "No active edits");
  }

  #[test]
  fn test_status_label_one_active() {
    init_i18n();
    let snap = make_snapshot(vec![make_session(SessionStatus::Ready)]);
    assert_eq!(get_tray_status_label(&snap), "1 active edit");
  }

  #[test]
  fn test_status_label_needs_attention() {
    init_i18n();
    let snap = make_snapshot(vec![make_session(SessionStatus::Error)]);
    assert_eq!(get_tray_status_label(&snap), "Needs attention");
  }

  #[test]
  fn test_status_label_syncing() {
    init_i18n();
    let snap = make_snapshot(vec![make_session(SessionStatus::Syncing)]);
    assert_eq!(get_tray_status_label(&snap), "1 document syncing");
  }

  #[test]
  fn test_status_label_update_ready() {
    init_i18n();
    let mut snap = make_snapshot(vec![make_session(SessionStatus::Ready)]);
    snap.update.update_ready = true;
    assert_eq!(get_tray_status_label(&snap), "Update ready");
  }

  // -- get_session_id_from_action --

  #[test]
  fn test_session_id_from_action_valid() {
    assert_eq!(
      get_session_id_from_action("session-open:abc-123", "session-open:"),
      Some("abc-123")
    );
  }

  #[test]
  fn test_session_id_from_action_wrong_prefix() {
    assert_eq!(
      get_session_id_from_action("session-open:abc", "session-finish:"),
      None
    );
  }

  #[test]
  fn test_session_id_from_action_empty_id() {
    assert_eq!(
      get_session_id_from_action("session-open:", "session-open:"),
      None
    );
  }

  // -- handle_menu_action --

  #[test]
  fn test_handle_menu_action_quit() {
    assert!(matches!(handle_menu_action("quit"), MenuAction::Quit));
  }

  #[test]
  fn test_handle_menu_action_preferences() {
    assert!(matches!(
      handle_menu_action("open-preferences"),
      MenuAction::OpenPreferences("general")
    ));
  }

  #[test]
  fn test_handle_menu_action_about() {
    assert!(matches!(
      handle_menu_action("open-about"),
      MenuAction::OpenPreferences("about")
    ));
  }

  #[test]
  fn test_handle_menu_action_check_updates() {
    assert!(matches!(
      handle_menu_action("check-for-updates"),
      MenuAction::CheckForUpdates
    ));
  }

  #[test]
  fn test_handle_menu_action_copy_diagnostics() {
    assert!(matches!(
      handle_menu_action("copy-diagnostics"),
      MenuAction::CopyDiagnostics
    ));
  }

  #[test]
  fn test_handle_menu_action_email_support() {
    assert!(matches!(
      handle_menu_action("email-support"),
      MenuAction::EmailSupport
    ));
  }

  #[test]
  fn test_handle_menu_action_session_open() {
    match handle_menu_action("session-open:abc") {
      MenuAction::OpenSessionFile(id) => assert_eq!(id, "abc"),
      _ => panic!("expected OpenSessionFile"),
    }
  }

  #[test]
  fn test_handle_menu_action_session_reveal() {
    match handle_menu_action("session-reveal:xyz") {
      MenuAction::RevealSession(id) => assert_eq!(id, "xyz"),
      _ => panic!("expected RevealSession"),
    }
  }

  #[test]
  fn test_handle_menu_action_session_finish() {
    match handle_menu_action("session-finish:s1") {
      MenuAction::FinishSession(id) => assert_eq!(id, "s1"),
      _ => panic!("expected FinishSession"),
    }
  }

  #[test]
  fn test_handle_menu_action_session_retry() {
    match handle_menu_action("session-retry:s2") {
      MenuAction::RetrySession(id) => assert_eq!(id, "s2"),
      _ => panic!("expected RetrySession"),
    }
  }

  #[test]
  fn test_handle_menu_action_unknown_defaults_to_preferences() {
    assert!(matches!(
      handle_menu_action("some-unknown-action"),
      MenuAction::OpenPreferences("general")
    ));
  }
}
