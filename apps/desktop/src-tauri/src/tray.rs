use crate::logging::best_effort;
use tauri::{
  AppHandle, Manager, Wry,
  menu::{
    CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder,
  },
};

use crate::PreferencesTab;
use crate::activity::{
  ActivityRecordingStatus, StoppedHistory, TrayActivity, TrayActivitySnapshot,
};
use crate::activity_capture::ActivityStopped;
use crate::dictation::TrayDictation;
use crate::dictation_hold_key::KeyNames;
use crate::dictation_language::{self, Choice};
use crate::i18n::{active_locale, t, t_fmt, t_plural};
use crate::transcribe_recording::{MS_PER_MINUTE, TrayTranscription};
use crate::types::{AppSnapshot, SessionSnapshot};

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker as TrayMainThread;

#[cfg(not(target_os = "macos"))]
struct TrayMainThread;

const QUIT_ACTION: &str = "quit";
const OPEN_PREFERENCES_ACTION: &str = "open-preferences";
const RECONNECT_ACCOUNT_ACTION: &str = "reconnect-account";
const OPEN_CLIPBOARD_ACTION: &str = "open-clipboard";
const OPEN_ACTIVITY_ACTION: &str = "open-activity";
const OPEN_TRANSCRIBE_ACTION: &str = "open-transcribe";
/// The top-level item that brings an open Transcribe window back.
const SHOW_TRANSCRIPTION_ACTION: &str = "show-transcription";
const OPEN_DICTATION_SETTINGS_ACTION: &str = "open-dictation-settings";
const DICTATION_HINT_ITEM: &str = "dictation-hint";
/// Followed by the stored language choice (`auto` or a language code).
const DICTATION_LANGUAGE_PREFIX: &str = "dictation-language:";
const RETYPE_DICTATION_ACTION: &str = "dictation-retype";
const FIX_DICTATION_ACTION: &str = "dictation-fix";
const PAUSE_ACTIVITY_ACTION: &str = "activity-pause";
const RESUME_ACTIVITY_ACTION: &str = "activity-resume";
const ACTIVITY_STATUS_ITEM: &str = "activity-status";
const ACTIVITY_NOW_ITEM: &str = "activity-now";
/// Opens the account settings, like the top-level reconnect item.
const ACTIVITY_RECONNECT_ACTION: &str = "activity-reconnect";
const MILLIS_PER_TENTH_HOUR: u64 = 360_000;

/// One tray image and the recording badge drawn over it.
struct TrayArt {
  png: &'static [u8],
  recording_dot: image::Rgba<u8>,
  /// Separates the dot from the art underneath.
  recording_ring: image::Rgba<u8>,
}

/// macOS tints a template image to match the menu bar, so the art and its
/// badge stay monochrome and the ring is a transparent cut-out.
const TEMPLATE_TRAY_ART: TrayArt = TrayArt {
  png: include_bytes!("../icons/tray-icon-32-template.png"),
  recording_dot: image::Rgba([0, 0, 0, 255]),
  recording_ring: image::Rgba([0, 0, 0, 0]),
};

/// Windows and Linux draw the image as given, so they show the 32 px app icon
/// tile and a red dot ringed in white. Tauri hands the tray one bitmap, which
/// Windows scales to the slot (16 px at 100% up to 32 px at 200%), so 32 px
/// only ever downsamples.
const TILE_TRAY_ART: TrayArt = TrayArt {
  png: include_bytes!("../icons/32x32.png"),
  recording_dot: image::Rgba([229, 72, 77, 255]),
  recording_ring: image::Rgba([255, 255, 255, 255]),
};

/// The platform-merged `app.trayIcon.iconPath` names the same file, so the
/// tray Tauri builds at startup already shows this art.
const TRAY_ART: &TrayArt = if cfg!(target_os = "macos") {
  &TEMPLATE_TRAY_ART
} else {
  &TILE_TRAY_ART
};

fn format_activity_hours(total_ms: u64, locale: &str) -> String {
  let tenths =
    total_ms.saturating_add(MILLIS_PER_TENTH_HOUR / 2) / MILLIS_PER_TENTH_HOUR;
  let separator = match locale {
    "en" => '.',
    "ar" => '٫',
    "cs" | "de" | "es" | "et" | "fr" | "hu" | "lt" | "lv" | "pl" | "pt-BR" | "sk" => {
      ','
    }
    _ => panic!("activity tray requires a shipped locale"),
  };
  locale_digits(
    &format!("{}{separator}{}", tenths / 10, tenths % 10),
    locale,
  )
}

/// A number written in the locale's digits.
fn locale_digits(number: &str, locale: &str) -> String {
  if locale != "ar" {
    return number.to_string();
  }
  number
    .chars()
    .map(|character| match character {
      '0' => '٠',
      '1' => '١',
      '2' => '٢',
      '3' => '٣',
      '4' => '٤',
      '5' => '٥',
      '6' => '٦',
      '7' => '٧',
      '8' => '٨',
      '9' => '٩',
      other => other,
    })
    .collect()
}

/// The item that brings the Transcribe window back, named by what it shows:
/// whole minutes transcribed while it runs, ready once the whole recording
/// is done.
fn transcription_label(transcription: TrayTranscription, locale: &str) -> String {
  match transcription {
    TrayTranscription::Working {
      transcribed_ms,
      duration_ms,
    } => {
      let done = transcribed_ms / MS_PER_MINUTE;
      match duration_ms {
        Some(duration_ms) => {
          let total = duration_ms.div_ceil(MS_PER_MINUTE).max(1);
          t_fmt(
            "tray.transcriptionProgress",
            &[
              ("done", &locale_digits(&done.min(total).to_string(), locale)),
              ("total", &locale_digits(&total.to_string(), locale)),
            ],
          )
        }
        None => t_fmt(
          "tray.transcriptionProgressSoFar",
          &[("done", &locale_digits(&done.to_string(), locale))],
        ),
      }
    }
    TrayTranscription::Ready => t("tray.transcriptionReady").to_string(),
    TrayTranscription::Open => t("tray.showTranscription").to_string(),
  }
}

fn activity_status_label(snapshot: &TrayActivitySnapshot) -> String {
  let key = match snapshot.status {
    ActivityRecordingStatus::Recording => "tray.activityRecording",
    ActivityRecordingStatus::Paused => "tray.activityPaused",
    ActivityRecordingStatus::Off => return t("tray.activityOff").to_string(),
  };
  let hours = format_activity_hours(snapshot.total_ms, active_locale());
  t_fmt(key, &[("hours", &hours)])
}

fn activity_action(
  status: ActivityRecordingStatus,
) -> Option<(&'static str, &'static str)> {
  match status {
    ActivityRecordingStatus::Recording => {
      Some((PAUSE_ACTIVITY_ACTION, "tray.activityPause"))
    }
    ActivityRecordingStatus::Paused => {
      Some((RESUME_ACTIVITY_ACTION, "tray.activityResume"))
    }
    ActivityRecordingStatus::Off => None,
  }
}

/// The tray's Dictation submenu, decided apart from the native menu.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DictationMenu {
  /// Switched off: one item, opening the page where it is turned on.
  Off,
  /// On: a line naming the key to hold, typing the last dictation again
  /// (enabled while there is one), fixing a dictation's words, a quick
  /// language switch, then its settings.
  On {
    hint: String,
    can_retype: bool,
    languages: Vec<TrayLanguage>,
  },
}

/// One choice in the quick language switch.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrayLanguage {
  stored: &'static str,
  label: String,
  checked: bool,
}

/// `None` wherever the Settings window shows no Dictation page.
fn dictation_menu(
  state: Option<TrayDictation>,
  names: KeyNames,
  locale: &str,
) -> Option<DictationMenu> {
  let state = state?;
  if !state.enabled {
    return Some(DictationMenu::Off);
  }
  let language = locale.split('-').next().unwrap_or(locale);
  let key = state.hold_key.label(names, language, |key| {
    t_fmt("dictation.holdKey.right", &[("key", key)])
  });
  let languages = dictation_language::quick_choices(&state.language, &state.inferred)
    .into_iter()
    .map(|choice| TrayLanguage {
      stored: choice.stored(),
      label: match choice {
        Choice::Automatic => t("dictation.language.automatic").to_string(),
        Choice::Language(code) => dictation_language::autonym(code)
          .unwrap_or(code)
          .to_string(),
      },
      checked: choice == state.language,
    })
    .collect();
  Some(DictationMenu::On {
    hint: t_fmt("tray.dictationHint", &[("key", &key)]),
    can_retype: state.can_retype,
    languages,
  })
}

fn recording_icon(recording: bool) -> image::ImageResult<tauri::image::Image<'static>> {
  recording_icon_for(TRAY_ART, recording)
}

fn recording_icon_for(
  art: &TrayArt,
  recording: bool,
) -> image::ImageResult<tauri::image::Image<'static>> {
  let mut image = image::load_from_memory(art.png)?.to_rgba8();
  if recording {
    let radius = image.width().min(image.height()) / 10;
    let center_x = image.width().saturating_sub(radius + 2);
    let center_y = image.height().saturating_sub(radius + 2);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
      let distance =
        u64::from(x.abs_diff(center_x)).pow(2) + u64::from(y.abs_diff(center_y)).pow(2);
      if distance <= u64::from(radius).pow(2) {
        *pixel = art.recording_dot;
      } else if distance <= u64::from(radius + 1).pow(2) {
        *pixel = art.recording_ring;
      }
    }
  }
  let (width, height) = image.dimensions();
  Ok(tauri::image::Image::new_owned(
    image.into_raw(),
    width,
    height,
  ))
}

#[allow(
  clippy::disallowed_methods,
  clippy::disallowed_types,
  reason = "the tray owner updates native handles only from its main-thread refresh"
)]
fn set_tray_icon(
  tray: &tauri::tray::TrayIcon,
  icon: tauri::image::Image<'_>,
) -> tauri::Result<()> {
  // Replacing the image clears macOS template tinting.
  tray.set_icon(Some(icon))?;
  #[cfg(target_os = "macos")]
  tray.set_icon_as_template(true)?;
  Ok(())
}

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
    crate::types::SessionStatus::Opening => {
      t("tray.sessionOpeningInOffice").to_string()
    }
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

/// The line heading the open edits; `None` while there are none, so an idle
/// menu starts with its actions.
fn get_tray_status_label(snapshot: &AppSnapshot) -> Option<String> {
  if snapshot.sessions.is_empty() {
    return None;
  }
  let needs_attention = snapshot
    .sessions
    .iter()
    .any(|s| s.takeover_detected || s.status == crate::types::SessionStatus::Error);
  if needs_attention {
    return Some(t("tray.needsAttention").to_string());
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
    return Some(t_plural("tray.documentsSyncing", active_syncs));
  }

  Some(t_plural("tray.activeEdits", snapshot.sessions.len()))
}

/// Rebuilds the tray menu from `snapshot`. The menu is the one native string
/// the app caches, so both state changes and a language change come through
/// here. A failed rebuild leaves the previous menu in place.
///
/// Callers run on async workers, but AppKit status items may only be touched
/// on the main thread: dropping the last tray handle elsewhere removes the
/// status item off the main thread and aborts the process. The work hops to
/// the main thread instead.
pub fn refresh(app: &AppHandle, snapshot: &AppSnapshot) {
  let handle = app.clone();
  let snapshot = snapshot.clone();
  if app
    .run_on_main_thread(move || {
      #[cfg(target_os = "macos")]
      let main_thread =
        TrayMainThread::new().expect("tray work must run on the main thread");
      #[cfg(not(target_os = "macos"))]
      let main_thread = TrayMainThread;
      refresh_on_main_thread(&handle, &snapshot, &main_thread);
    })
    .is_err()
  {
    tracing::warn!("tray refresh skipped: the event loop is gone");
  }
}

/// Shows a short mark beside the status icon, or removes it.
#[cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine drive these")
)]
pub fn set_status_mark(app: &AppHandle, mark: Option<&'static str>) {
  let handle = app.clone();
  if app
    .run_on_main_thread(move || {
      #[cfg(target_os = "macos")]
      let main_thread =
        TrayMainThread::new().expect("tray work must run on the main thread");
      #[cfg(not(target_os = "macos"))]
      let main_thread = TrayMainThread;
      set_status_mark_on_main_thread(&handle, mark, &main_thread);
    })
    .is_err()
  {
    tracing::warn!("tray mark skipped: the event loop is gone");
  }
}

#[cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine drive these")
)]
#[allow(
  clippy::disallowed_methods,
  reason = "the tray owner: the main-thread proof keeps every native handle local"
)]
fn set_status_mark_on_main_thread(
  app: &AppHandle,
  mark: Option<&'static str>,
  _main_thread: &TrayMainThread,
) {
  if let Some(tray) = app.tray_by_id("main")
    && tray.set_title(mark).is_err()
  {
    tracing::warn!("tray mark failed");
  }
}

/// The status icon and its owning screen in one logical coordinate space;
/// `None` when there is no icon or the OS cannot place it (an icon in
/// Windows' hidden overflow area). The handle is read and dropped on the
/// main thread, like every other tray handle.
#[cfg(target_os = "macos")]
pub fn status_icon_placement(
  app: &AppHandle,
) -> Option<crate::window_placement::ScreenPlacement> {
  let handle = app.clone();
  crate::window_placement::on_main_thread(app, None, move || {
    let main_thread = TrayMainThread::new()?;
    status_icon_placement_on_main_thread(&handle, &main_thread)
  })
}

/// The status icon and its owning screen; see the macOS twin.
#[cfg(not(target_os = "macos"))]
pub fn status_icon_placement(
  app: &AppHandle,
) -> Option<crate::window_placement::ScreenPlacement> {
  status_icon_placement_on_main_thread(app, &TrayMainThread)
}

#[allow(
  clippy::disallowed_methods,
  reason = "the tray owner: the main-thread proof keeps every native handle local"
)]
fn status_icon_placement_on_main_thread(
  app: &AppHandle,
  _main_thread: &TrayMainThread,
) -> Option<crate::window_placement::ScreenPlacement> {
  let tray = app.tray_by_id("main")?;
  #[cfg(target_os = "macos")]
  {
    tray
      .with_inner_tray_icon(|inner| {
        let main_thread = TrayMainThread::new()?;
        let window = inner.ns_status_item()?.button(main_thread)?.window()?;
        crate::window_placement::native_window_placement(&window, main_thread)
      })
      .ok()
      .flatten()
  }
  #[cfg(not(target_os = "macos"))]
  {
    crate::window_placement::physical_rect_placement(app, tray.rect().ok().flatten()?)
  }
}

#[allow(
  clippy::disallowed_methods,
  reason = "the tray owner: the main-thread proof keeps every native handle local"
)]
fn refresh_on_main_thread(
  app: &AppHandle,
  snapshot: &AppSnapshot,
  main_thread: &TrayMainThread,
) {
  let binding = activity_binding(app);
  let activity = crate::activity::tray_activity(app);
  let menu =
    build_tray_menu_with_activity(app, snapshot, activity.as_ref(), main_thread);
  let Some(tray) = app.tray_by_id("main") else {
    return;
  };
  // Building native menu items can hop threads. Never install a projection
  // copied from the account that was unlinked while those items were built.
  let current = binding == activity_binding(app);
  let menu = if current {
    menu
  } else {
    let activity =
      crate::activity::tray_activity(app).map(TrayActivity::without_projection);
    build_tray_menu_with_activity(app, snapshot, activity.as_ref(), main_thread)
  };
  if let Ok(menu) = menu {
    best_effort(tray.set_menu(Some(menu)), "tray menu was not updated");
  }
  let recording = current
    && matches!(
      &activity,
      Some(TrayActivity::Live(Some(snapshot)))
        if snapshot.status == ActivityRecordingStatus::Recording
    );
  if let Ok(icon) = recording_icon(recording) {
    best_effort(set_tray_icon(&tray, icon), "tray icon was not updated");
  }
}

fn activity_binding(app: &AppHandle) -> Option<(u64, String)> {
  app
    .try_state::<crate::feature_gate::FeatureGates>()?
    .account_binding(crate::feature_gate::DesktopFeature::ActivityTimeline)
}

fn build_tray_menu_with_activity(
  app: &AppHandle,
  snapshot: &AppSnapshot,
  activity: Option<&TrayActivity>,
  _main_thread: &TrayMainThread,
) -> tauri::Result<Menu<Wry>> {
  let mut builder = MenuBuilder::new(app);

  // What needs the user right now: open edits, a running transcription, a
  // lost sign-in. Idle, the menu starts with its actions.
  let mut needs_user = false;
  if let Some(status) = get_tray_status_label(snapshot) {
    builder = builder.item(
      &MenuItemBuilder::with_id("status", status)
        .enabled(false)
        .build(app)?,
    );
    for session in &snapshot.sessions {
      builder = builder.item(&build_session_menu(app, session)?);
    }
    needs_user = true;
  }
  // An open Transcribe window is easy to lose behind other apps; it comes
  // back from the top of the menu.
  if let Some(transcription) = crate::transcribe_recording::tray_state(app) {
    builder = builder.item(
      &MenuItemBuilder::with_id(
        SHOW_TRANSCRIPTION_ACTION,
        transcription_label(transcription, active_locale()),
      )
      .build(app)?,
    );
    needs_user = true;
  }
  if crate::account::reconnect_needed() {
    builder = builder.item(
      &MenuItemBuilder::with_id(RECONNECT_ACCOUNT_ACTION, t("tray.reconnectAccount"))
        .build(app)?,
    );
    needs_user = true;
  }
  if needs_user {
    builder = builder.separator();
  }

  let clipboard_enabled = !crate::managed_policy::current().clipboard_disabled;
  if clipboard_enabled {
    builder = builder.item(
      &MenuItemBuilder::with_id(OPEN_CLIPBOARD_ACTION, t("clipboard.title"))
        .build(app)?,
    );
  }
  if let Some(activity) = activity {
    builder = builder.item(&build_activity_menu(app, activity)?);
  }
  let dictation = dictation_menu(
    crate::dictation::tray_state(app),
    KeyNames::CURRENT,
    active_locale(),
  );
  if let Some(dictation) = &dictation {
    builder = builder.item(&build_dictation_menu(app, dictation)?);
  }
  if clipboard_enabled || activity.is_some() || dictation.is_some() {
    builder = builder.separator();
  }

  // Updates, support and About live in Settings; the updater checks on its
  // own.
  builder = builder.item(
    &MenuItemBuilder::with_id(OPEN_PREFERENCES_ACTION, t("tray.settings"))
      .build(app)?,
  );
  builder = builder.separator();
  builder = builder.item(
    &MenuItemBuilder::with_id(QUIT_ACTION, t("tray.quitStellaDesktop")).build(app)?,
  );

  builder.build()
}

/// One open edit: its state, then what can be done with it.
fn build_session_menu(
  app: &AppHandle,
  session: &SessionSnapshot,
) -> tauri::Result<Submenu<Wry>> {
  SubmenuBuilder::new(app, &session.file_name)
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
    .build()
}

fn build_dictation_menu(
  app: &AppHandle,
  dictation: &DictationMenu,
) -> tauri::Result<Submenu<Wry>> {
  let menu = SubmenuBuilder::new(app, t("tray.dictation"));
  // The Transcribe window has the same gate as dictation itself.
  let transcribe =
    MenuItemBuilder::with_id(OPEN_TRANSCRIBE_ACTION, t("tray.transcribeRecording"))
      .build(app)?;
  match dictation {
    // Transcribing a recording does not need dictation switched on.
    DictationMenu::Off => menu
      .item(
        &MenuItemBuilder::with_id(
          OPEN_DICTATION_SETTINGS_ACTION,
          t("tray.dictationTurnOn"),
        )
        .build(app)?,
      )
      .separator()
      .item(&transcribe),
    DictationMenu::On {
      hint,
      can_retype,
      languages,
    } => menu
      .item(
        &MenuItemBuilder::with_id(DICTATION_HINT_ITEM, hint)
          .enabled(false)
          .build(app)?,
      )
      .item(
        &MenuItemBuilder::with_id(RETYPE_DICTATION_ACTION, t("tray.dictationRetype"))
          .enabled(*can_retype)
          .build(app)?,
      )
      .item(
        &MenuItemBuilder::with_id(FIX_DICTATION_ACTION, t("tray.dictationFix"))
          .build(app)?,
      )
      .item(&build_dictation_language_menu(app, languages)?)
      .separator()
      .item(&transcribe)
      .item(
        &MenuItemBuilder::with_id(
          OPEN_DICTATION_SETTINGS_ACTION,
          t("tray.dictationSettings"),
        )
        .build(app)?,
      ),
  }
  .build()
}

fn build_dictation_language_menu(
  app: &AppHandle,
  languages: &[TrayLanguage],
) -> tauri::Result<Submenu<Wry>> {
  let mut menu = SubmenuBuilder::new(app, t("settings.language"));
  for language in languages {
    menu = menu.item(
      &CheckMenuItemBuilder::with_id(
        format!("{DICTATION_LANGUAGE_PREFIX}{}", language.stored),
        &language.label,
      )
      .checked(language.checked)
      .build(app)?,
    );
  }
  menu.build()
}

/// What a stopped Activity entry offers: the reason, and a way back to the
/// account when linking again lets it record.
fn stopped_activity_items(
  stopped: ActivityStopped,
) -> (&'static str, Option<(&'static str, &'static str)>) {
  (
    stopped.reason.tray_key(),
    stopped
      .reason
      .reconnect_helps()
      .then_some((ACTIVITY_RECONNECT_ACTION, "tray.reconnectAccount")),
  )
}

fn build_activity_menu(
  app: &AppHandle,
  activity: &TrayActivity,
) -> tauri::Result<Submenu<Wry>> {
  let mut menu = SubmenuBuilder::new(app, t("tray.activity"));
  let snapshot = match activity {
    TrayActivity::Live(snapshot) => snapshot.as_ref(),
    TrayActivity::Stopped(stopped, history) => {
      let (status, action) = stopped_activity_items(*stopped);
      menu = menu
        .item(
          &MenuItemBuilder::with_id(ACTIVITY_STATUS_ITEM, t(status))
            .enabled(false)
            .build(app)?,
        )
        .separator();
      if let Some((action, label)) = action {
        menu = menu.item(&MenuItemBuilder::with_id(action, t(label)).build(app)?);
      }
      // What was recorded stays readable while Activity cannot record.
      match history {
        StoppedHistory::Readable => {
          menu = menu.item(
            &MenuItemBuilder::with_id(OPEN_ACTIVITY_ACTION, t("tray.openActivity"))
              .build(app)?,
          );
        }
        StoppedHistory::Unavailable => {}
      }
      return menu.build();
    }
  };
  if let Some(activity) = snapshot {
    menu = menu.item(
      &MenuItemBuilder::with_id(ACTIVITY_STATUS_ITEM, activity_status_label(activity))
        .enabled(false)
        .build(app)?,
    );
    if activity.status == ActivityRecordingStatus::Recording
      && let Some(name) = &activity.now
    {
      menu = menu.item(
        &MenuItemBuilder::with_id(
          ACTIVITY_NOW_ITEM,
          t_fmt("tray.activityNow", &[("name", name)]),
        )
        .enabled(false)
        .build(app)?,
      );
    }
    menu = menu.separator();
    if let Some((action, label)) = activity_action(activity.status) {
      menu = menu.item(&MenuItemBuilder::with_id(action, t(label)).build(app)?);
    }
  }
  menu
    .item(
      &MenuItemBuilder::with_id(OPEN_ACTIVITY_ACTION, t("tray.openActivity"))
        .build(app)?,
    )
    .build()
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
  if action == OPEN_PREFERENCES_ACTION
    || action == RECONNECT_ACCOUNT_ACTION
    || action == ACTIVITY_RECONNECT_ACTION
  {
    return MenuAction::OpenPreferences(PreferencesTab::General);
  }
  if action == OPEN_CLIPBOARD_ACTION {
    return MenuAction::OpenClipboard;
  }
  if action == OPEN_ACTIVITY_ACTION {
    return MenuAction::OpenActivity;
  }
  if action == OPEN_TRANSCRIBE_ACTION || action == SHOW_TRANSCRIPTION_ACTION {
    return MenuAction::OpenTranscribe;
  }
  if action == OPEN_DICTATION_SETTINGS_ACTION {
    return MenuAction::OpenPreferences(PreferencesTab::Dictation);
  }
  if action == RETYPE_DICTATION_ACTION {
    return MenuAction::RetypeDictation;
  }
  if action == FIX_DICTATION_ACTION {
    return MenuAction::FixDictation;
  }
  if action == PAUSE_ACTIVITY_ACTION {
    return MenuAction::SetActivityRecording(ActivityRecordingStatus::Paused);
  }
  if action == RESUME_ACTIVITY_ACTION {
    return MenuAction::SetActivityRecording(ActivityRecordingStatus::Recording);
  }

  if let Some(language) = get_session_id_from_action(action, DICTATION_LANGUAGE_PREFIX)
  {
    return MenuAction::SetDictationLanguage(language.to_string());
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

  MenuAction::OpenPreferences(PreferencesTab::General)
}

pub enum MenuAction {
  Quit,
  OpenPreferences(PreferencesTab),
  OpenClipboard,
  OpenActivity,
  OpenTranscribe,
  RetypeDictation,
  FixDictation,
  SetActivityRecording(ActivityRecordingStatus),
  /// The stored dictation language choice the quick switch picked.
  SetDictationLanguage(String),
  OpenSessionFile(String),
  RevealSession(String),
  FinishSession(String),
  RetrySession(String),
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::dictation_hold_key::HoldChoice;
  use crate::types::{
    DesktopEditFileType, DesktopNotificationPreferences, DesktopUpdateSnapshot,
    SessionStatus,
  };

  fn init_i18n() {
    crate::i18n::init_en();
  }

  #[test]
  fn activity_hours_round_and_follow_the_shipped_locale() {
    assert_eq!(format_activity_hours(0, "en"), "0.0");
    assert_eq!(format_activity_hours(18_720_000, "en"), "5.2");
    assert_eq!(format_activity_hours(179_999, "en"), "0.0");
    assert_eq!(format_activity_hours(180_000, "en"), "0.1");
    for locale in [
      "cs", "de", "es", "et", "fr", "hu", "lt", "lv", "pl", "pt-BR", "sk",
    ] {
      assert_eq!(format_activity_hours(18_720_000, locale), "5,2");
    }
    assert_eq!(format_activity_hours(18_720_000, "ar"), "٥٫٢");
    for locale in crate::i18n::shipped_locales() {
      assert!(!format_activity_hours(18_720_000, locale).is_empty());
    }
  }

  #[test]
  fn the_transcription_item_names_what_the_window_shows() {
    init_i18n();
    let working = |transcribed_ms, duration_ms| TrayTranscription::Working {
      transcribed_ms,
      duration_ms,
    };
    assert_eq!(
      transcription_label(
        working(12 * 60_000 + 59_000, Some(39 * 60_000 + 30_000)),
        "en"
      ),
      "Transcription in progress: 12 of 40 min"
    );
    assert_eq!(
      transcription_label(working(0, Some(20_000)), "en"),
      "Transcription in progress: 0 of 1 min",
      "a recording under a minute is one minute long"
    );
    assert_eq!(
      transcription_label(working(5 * 60_000, Some(4 * 60_000)), "en"),
      "Transcription in progress: 4 of 4 min",
      "never more done than the recording is long"
    );
    assert_eq!(
      transcription_label(working(3 * 60_000, None), "en"),
      "Transcription in progress: 3 min so far"
    );
    assert_eq!(
      transcription_label(TrayTranscription::Ready, "en"),
      "Transcription ready"
    );
    assert_eq!(
      transcription_label(TrayTranscription::Open, "en"),
      "Show transcription"
    );
    assert!(
      transcription_label(working(12 * 60_000, Some(40 * 60_000)), "ar").contains("١٢"),
      "minutes follow the locale's digits"
    );
  }

  #[test]
  fn the_transcription_item_brings_the_transcribe_window_back() {
    assert!(matches!(
      handle_menu_action(SHOW_TRANSCRIPTION_ACTION),
      MenuAction::OpenTranscribe
    ));
  }

  #[test]
  fn transcription_items_have_translations_in_every_locale() {
    for key in [
      "tray.transcriptionProgress",
      "tray.transcriptionProgressSoFar",
      "tray.transcriptionReady",
      "tray.showTranscription",
    ] {
      assert!(
        crate::i18n::locales_missing(key).is_empty(),
        "missing {key}"
      );
    }
  }

  #[test]
  fn reconnect_opens_the_account_settings() {
    for action in [RECONNECT_ACCOUNT_ACTION, ACTIVITY_RECONNECT_ACTION] {
      assert!(matches!(
        handle_menu_action(action),
        MenuAction::OpenPreferences(PreferencesTab::General)
      ));
    }
  }

  #[test]
  fn a_stopped_activity_names_its_reason_and_offers_reconnecting_where_it_helps() {
    use crate::activity_capture::StopReason;
    init_i18n();
    for reason in StopReason::ALL {
      let (status, action) = stopped_activity_items(ActivityStopped {
        reason: *reason,
        intent: ActivityRecordingStatus::Recording,
      });
      assert_eq!(status, reason.tray_key());
      assert_ne!(t(status), status, "{reason:?} has English text");
      let expected = match reason {
        StopReason::ReconnectNeeded | StopReason::SignedOut => {
          Some((ACTIVITY_RECONNECT_ACTION, "tray.reconnectAccount"))
        }
        StopReason::NotAvailable
        | StopReason::BlockedByPolicy
        | StopReason::NotConfirmed => None,
      };
      assert_eq!(action, expected, "{reason:?}");
    }
  }

  #[test]
  fn activity_menu_actions_pause_and_resume_without_starting_an_off_recorder() {
    assert!(matches!(
      handle_menu_action(PAUSE_ACTIVITY_ACTION),
      MenuAction::SetActivityRecording(ActivityRecordingStatus::Paused)
    ));
    assert!(matches!(
      handle_menu_action(RESUME_ACTIVITY_ACTION),
      MenuAction::SetActivityRecording(ActivityRecordingStatus::Recording)
    ));
    assert_eq!(activity_action(ActivityRecordingStatus::Off), None);
    assert_eq!(
      activity_action(ActivityRecordingStatus::Recording),
      Some((PAUSE_ACTIVITY_ACTION, "tray.activityPause"))
    );
    assert_eq!(
      activity_action(ActivityRecordingStatus::Paused),
      Some((RESUME_ACTIVITY_ACTION, "tray.activityResume"))
    );
  }

  #[test]
  fn recording_icon_adds_a_dot_without_changing_dimensions_and_restores_the_base() {
    for art in [&TEMPLATE_TRAY_ART, &TILE_TRAY_ART] {
      let base = recording_icon_for(art, false).unwrap();
      let recording = recording_icon_for(art, true).unwrap();
      assert_eq!(
        (recording.width(), recording.height()),
        (base.width(), base.height())
      );
      assert_ne!(recording.rgba(), base.rgba());
      assert_eq!(recording_icon_for(art, false).unwrap().rgba(), base.rgba());
    }
  }

  #[test]
  fn tile_recording_icon_keeps_the_tile_and_rings_the_dot() {
    let base = recording_icon_for(&TILE_TRAY_ART, false).unwrap();
    let recording = recording_icon_for(&TILE_TRAY_ART, true).unwrap();
    let width = base.width();
    let pixel = |icon: &tauri::image::Image<'_>, x: u32, y: u32| {
      icon.rgba().as_chunks::<4>().0[usize::try_from(y * width + x).unwrap()]
    };
    // The tile ground of stella-app-icon.svg (#59a1d4).
    assert_eq!(pixel(&base, 16, 1), [0x59, 0xa1, 0xd4, 255]);
    // A 32 px icon puts the dot (radius 3) at (27, 27) with a 1 px ring.
    assert_eq!(pixel(&recording, 27, 27), TILE_TRAY_ART.recording_dot.0);
    assert_eq!(pixel(&recording, 27, 23), TILE_TRAY_ART.recording_ring.0);
    for y in 0..base.height() {
      for x in 0..width {
        if x.abs_diff(27).pow(2) + y.abs_diff(27).pow(2) > 16 {
          assert_eq!(pixel(&recording, x, y), pixel(&base, x, y), "({x}, {y})");
        }
      }
    }
  }

  /// Tauri merges `tauri.<platform>.conf.json` over `tauri.conf.json` as a JSON
  /// merge patch (RFC 7396) when it builds the startup tray.
  fn merge_patch(target: &mut serde_json::Value, patch: serde_json::Value) {
    match (target, patch) {
      (serde_json::Value::Object(target), serde_json::Value::Object(patch)) => {
        for (key, value) in patch {
          if value.is_null() {
            target.remove(&key);
          } else {
            merge_patch(target.entry(key).or_insert(serde_json::Value::Null), value);
          }
        }
      }
      (target, patch) => *target = patch,
    }
  }

  fn read_config(name: &str) -> Option<serde_json::Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(name);
    match std::fs::read_to_string(&path) {
      Ok(text) => Some(serde_json::from_str(&text).unwrap()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
      Err(error) => panic!("{}: {error}", path.display()),
    }
  }

  #[test]
  fn startup_tray_config_names_the_art_each_platform_draws() {
    for (platform, art, template) in [
      ("macos", &TEMPLATE_TRAY_ART, true),
      ("windows", &TILE_TRAY_ART, false),
      ("linux", &TILE_TRAY_ART, false),
    ] {
      let mut config = read_config("tauri.conf.json").unwrap();
      if let Some(patch) = read_config(&format!("tauri.{platform}.conf.json")) {
        merge_patch(&mut config, patch);
      }
      let tray = &config["app"]["trayIcon"];
      let path = tray["iconPath"].as_str().unwrap();
      let png =
        std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
          .unwrap();
      assert_eq!(png, art.png, "{platform} startup tray icon");
      // Tauri defaults `iconAsTemplate` to false.
      assert_eq!(
        tray["iconAsTemplate"].as_bool().unwrap_or(false),
        template,
        "{platform} template flag"
      );
    }
    let expected = if cfg!(target_os = "macos") {
      TEMPLATE_TRAY_ART.png
    } else {
      TILE_TRAY_ART.png
    };
    assert_eq!(TRAY_ART.png, expected);
  }

  #[test]
  fn template_recording_icons_are_monochrome_with_alpha() {
    for recording in [false, true] {
      let icon = recording_icon_for(&TEMPLATE_TRAY_ART, recording).unwrap();
      let (pixels, _) = icon.rgba().as_chunks::<4>();
      assert!(pixels.iter().any(|pixel| pixel[3] == 0));
      assert!(pixels.iter().any(|pixel| pixel[3] == 255));
      assert!(
        pixels
          .iter()
          .all(|pixel| pixel[3] == 0 || pixel[..3] == [0, 0, 0]),
        "visible template pixels must be monochrome black"
      );
    }
  }

  #[test]
  fn dictation_is_in_the_tray_only_where_settings_has_its_page() {
    init_i18n();
    assert_eq!(dictation_menu(None, KeyNames::Mac, "en"), None);
  }

  #[test]
  fn dictation_switched_off_offers_only_turning_it_on() {
    init_i18n();
    let off = TrayDictation {
      enabled: false,
      hold_key: HoldChoice::Fn,
      language: Choice::Automatic,
      inferred: vec!["cs", "en"],
      can_retype: true,
    };
    assert_eq!(
      dictation_menu(Some(off), KeyNames::Mac, "en"),
      Some(DictationMenu::Off)
    );
  }

  #[test]
  fn the_dictation_hint_names_the_configured_key() {
    init_i18n();
    let on = |hold_key| TrayDictation {
      enabled: true,
      hold_key,
      language: Choice::Automatic,
      inferred: Vec::new(),
      can_retype: false,
    };
    let hint = |state, names| match dictation_menu(Some(state), names, "en") {
      Some(DictationMenu::On { hint, .. }) => hint,
      other => panic!("expected the on menu, got {other:?}"),
    };
    assert_eq!(
      hint(on(HoldChoice::Fn), KeyNames::Mac),
      "Hold fn to dictate"
    );
    assert_eq!(
      hint(on(HoldChoice::RightOption), KeyNames::Mac),
      "Hold Right ⌥ to dictate"
    );
    assert_eq!(
      hint(on(HoldChoice::Combination), KeyNames::Windows),
      "Hold Ctrl+Alt+Space to dictate"
    );
  }

  #[test]
  fn the_quick_language_switch_checks_the_choice_and_names_languages_their_own_way() {
    init_i18n();
    let state = TrayDictation {
      enabled: true,
      hold_key: HoldChoice::Fn,
      language: Choice::Language("de"),
      inferred: vec!["cs", "en"],
      can_retype: false,
    };
    let Some(DictationMenu::On { languages, .. }) =
      dictation_menu(Some(state), KeyNames::Mac, "en")
    else {
      panic!("expected the on menu");
    };
    let shown: Vec<(&str, &str, bool)> = languages
      .iter()
      .map(|language| (language.stored, language.label.as_str(), language.checked))
      .collect();
    assert_eq!(
      shown,
      vec![
        ("auto", "Automatic", false),
        ("cs", "Čeština", false),
        ("en", "English", false),
        ("de", "Deutsch", true),
      ]
    );
  }

  #[test]
  fn a_quick_language_switch_item_sets_the_dictation_language() {
    assert!(matches!(
      handle_menu_action(&format!("{DICTATION_LANGUAGE_PREFIX}cs")),
      MenuAction::SetDictationLanguage(language) if language == "cs"
    ));
    assert!(matches!(
      handle_menu_action(DICTATION_LANGUAGE_PREFIX),
      MenuAction::OpenPreferences(PreferencesTab::General)
    ));
  }

  #[test]
  fn typing_the_last_dictation_again_is_offered_once_there_is_one() {
    init_i18n();
    let can_retype = |can_retype| {
      let state = TrayDictation {
        enabled: true,
        hold_key: HoldChoice::Fn,
        language: Choice::Automatic,
        inferred: Vec::new(),
        can_retype,
      };
      match dictation_menu(Some(state), KeyNames::Mac, "en") {
        Some(DictationMenu::On { can_retype, .. }) => can_retype,
        other => panic!("expected the on menu, got {other:?}"),
      }
    };
    assert!(!can_retype(false));
    assert!(can_retype(true));
    assert!(matches!(
      handle_menu_action(RETYPE_DICTATION_ACTION),
      MenuAction::RetypeDictation
    ));
  }

  #[test]
  fn the_dictation_submenu_fixes_a_dictation() {
    assert!(matches!(
      handle_menu_action(FIX_DICTATION_ACTION),
      MenuAction::FixDictation
    ));
  }

  #[test]
  fn the_dictation_submenu_opens_the_transcribe_window() {
    assert!(matches!(
      handle_menu_action(OPEN_TRANSCRIBE_ACTION),
      MenuAction::OpenTranscribe
    ));
  }

  #[test]
  fn both_dictation_items_open_its_settings_page() {
    assert!(matches!(
      handle_menu_action(OPEN_DICTATION_SETTINGS_ACTION),
      MenuAction::OpenPreferences(PreferencesTab::Dictation)
    ));
  }

  #[test]
  fn dictation_entries_have_translations_in_every_locale() {
    for key in [
      "tray.dictation",
      "tray.dictationHint",
      "tray.dictationRetype",
      "tray.dictationFix",
      "tray.dictationSettings",
      "tray.dictationTurnOn",
    ] {
      assert!(
        crate::i18n::locales_missing(key).is_empty(),
        "missing {key}"
      );
    }
  }

  #[test]
  fn activity_statuses_and_actions_have_translations_in_every_locale() {
    for key in [
      "tray.activityRecording",
      "tray.activityPaused",
      "tray.activityOff",
      "tray.activityNow",
      "tray.activityPause",
      "tray.activityResume",
    ] {
      assert!(
        crate::i18n::locales_missing(key).is_empty(),
        "missing {key}"
      );
    }
  }

  fn make_session(status: SessionStatus) -> SessionSnapshot {
    SessionSnapshot {
      base_version_number: 1,
      entity_id: "ent-1".into(),
      file_type: DesktopEditFileType::Docx,
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
      document_recovery: crate::types::DocumentRecoverySnapshot::default(),
      bridge_port: 45_901,
      bridge_version: crate::types::BRIDGE_VERSION,
      capabilities: crate::types::BRIDGE_CAPABILITIES
        .iter()
        .map(|s| (*s).to_string())
        .collect(),
      notification_preferences: DesktopNotificationPreferences::default(),
      running_since: "2026-01-01T00:00:00Z".into(),
      sessions,
      trusted_self_host_connections: Vec::new(),
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
    assert_eq!(format_session_status(&s), "Opening in Office");
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
    assert_eq!(get_tray_status_label(&snap), None);
  }

  #[test]
  fn test_status_label_one_active() {
    init_i18n();
    let snap = make_snapshot(vec![make_session(SessionStatus::Ready)]);
    assert_eq!(
      get_tray_status_label(&snap).as_deref(),
      Some("1 active edit")
    );
  }

  #[test]
  fn test_status_label_needs_attention() {
    init_i18n();
    let snap = make_snapshot(vec![make_session(SessionStatus::Error)]);
    assert_eq!(
      get_tray_status_label(&snap).as_deref(),
      Some("Needs attention")
    );
  }

  #[test]
  fn test_status_label_syncing() {
    init_i18n();
    let snap = make_snapshot(vec![make_session(SessionStatus::Syncing)]);
    assert_eq!(
      get_tray_status_label(&snap).as_deref(),
      Some("1 document syncing")
    );
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
      MenuAction::OpenPreferences(PreferencesTab::General)
    ));
  }

  #[test]
  fn test_handle_menu_action_clipboard() {
    assert!(matches!(
      handle_menu_action("open-clipboard"),
      MenuAction::OpenClipboard
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
      MenuAction::OpenPreferences(PreferencesTab::General)
    ));
  }
}
