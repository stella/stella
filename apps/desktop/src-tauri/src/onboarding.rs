//! First-run setup: a short tour in its own window that explains what the
//! app does, asks for the permissions it needs, and ends with one real use
//! of the clipboard shortcut. The step logic is a pure function over a small
//! context; this module also owns the device-level progress and the window.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, webview::PageLoadEvent};

use crate::device_preference::DevicePreference;
use crate::feature_gate::{DesktopFeature, FeatureGates};
use crate::permissions::{
  DesktopSurface, Permission, PermissionRow, PermissionStatus, required_permissions,
};
use crate::window_placement::WorkArea;

pub const ONBOARDING_WINDOW_LABEL: &str = "onboarding";
/// Payload-free: the window re-reads the snapshot.
pub const CHANGED_EVENT: &str = "onboarding-changed";
const PROGRESS_FILE_NAME: &str = "onboarding-v1.json";
const HISTORY_FILE_NAME: &str = "onboarding-history-v1.json";
/// The setup window's size. The browser harness reads these lines and
/// renders every step at this size (`tests/desktop-window-sizes.ts`); the
/// activity step, with its permission row, sets the height.
const WINDOW_WIDTH: f64 = 620.0;
const WINDOW_HEIGHT: f64 = 680.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
  Welcome,
  Connect,
  HowItWorks,
  Activity,
  Permissions,
  TryIt,
  Done,
}

impl Step {
  pub const ALL: [Self; 7] = [
    Self::Welcome,
    Self::Connect,
    Self::HowItWorks,
    Self::Activity,
    Self::Permissions,
    Self::TryIt,
    Self::Done,
  ];
}

/// What decides which steps appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowContext {
  pub linked: bool,
  pub activity_available: bool,
  /// Rows left for the Permissions step once Activity asked for its own.
  pub has_permission_rows: bool,
  /// Clipboard history exists; managed policy can turn it off, and then
  /// there is no shortcut to try.
  pub clipboard: bool,
}

/// The steps shown, in order. A step that no longer applies is dropped,
/// except the one on screen: connecting mid-step keeps the Connect step
/// visible so the user sees it succeed.
pub fn visible_steps(context: FlowContext, current: Step) -> Vec<Step> {
  Step::ALL
    .into_iter()
    .filter(|step| {
      *step == current
        || match step {
          Step::Connect => !context.linked,
          Step::Activity => context.activity_available,
          Step::Permissions => context.has_permission_rows,
          Step::TryIt => context.clipboard,
          Step::Welcome | Step::HowItWorks | Step::Done => true,
        }
    })
    .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Input {
  Continue,
  Back,
  /// The clipboard shortcut fired: the only way Try it succeeds.
  ShortcutPressed,
}

/// The step after `input`. A step that is not visible (a stale resume point)
/// first settles on the next visible one.
pub fn next_step(current: Step, input: Input, context: FlowContext) -> Step {
  let steps = visible_steps(context, current);
  let Some(index) = steps.iter().position(|step| *step == current) else {
    return current;
  };
  match input {
    Input::Continue => steps.get(index + 1).copied().unwrap_or(current),
    Input::Back => index
      .checked_sub(1)
      .and_then(|previous| steps.get(previous).copied())
      .unwrap_or(current),
    Input::ShortcutPressed if current == Step::TryIt => {
      steps.get(index + 1).copied().unwrap_or(current)
    }
    Input::ShortcutPressed => current,
  }
}

/// Applies `input` only when it was sent from the step the flow is on, so a
/// repeated or stale input (a double click, a click racing a refresh) is a
/// no-op rather than a second move.
pub fn resolve(current: Step, from: Step, input: Input, context: FlowContext) -> Step {
  if from != current {
    return current;
  }
  next_step(current, input, context)
}

/// The step the flow is on. The step a window last showed stays, even when it
/// stopped applying (Connect, once linked), so the user sees it succeed and
/// leaves it with their own input; any other resume point settles first.
pub fn on_screen(stored: Step, shown: Option<Step>, context: FlowContext) -> Step {
  if shown == Some(stored) {
    return stored;
  }
  settle(stored, context)
}

/// A stored resume point may name a step that no longer applies (the account
/// was linked since); settle on the first visible step at or after it.
pub fn settle(stored: Step, context: FlowContext) -> Step {
  let order = |step: Step| Step::ALL.iter().position(|candidate| *candidate == step);
  let stored_index = order(stored);
  visible_steps(context, Step::Welcome)
    .into_iter()
    .find(|step| order(*step) >= stored_index)
    .unwrap_or(Step::Done)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Progress {
  // Earlier builds stored this value for first-run progress.
  #[serde(rename = "inProgress")]
  FirstRun {
    resume: Step,
  },
  /// Started again from settings after it was completed: it resumes like
  /// the first run but never reopens at launch.
  Replaying {
    resume: Step,
  },
  Completed,
}

impl Progress {
  /// The first run ended once; a replay from settings does not undo that.
  pub fn first_run_finished(self) -> bool {
    !matches!(self, Self::FirstRun { .. })
  }
}

/// The same tour at another step; a completed tour stays completed.
pub fn resumed(progress: Progress, step: Step) -> Progress {
  match progress {
    Progress::FirstRun { .. } => Progress::FirstRun { resume: step },
    Progress::Replaying { .. } => Progress::Replaying { resume: step },
    Progress::Completed => Progress::Completed,
  }
}

/// The tour from its first step, as settings starts it again. A first run
/// still in progress stays a first run.
pub fn restarted(progress: Progress) -> Progress {
  match progress {
    Progress::FirstRun { .. } => Progress::FirstRun {
      resume: Step::Welcome,
    },
    Progress::Replaying { .. } | Progress::Completed => Progress::Replaying {
      resume: Step::Welcome,
    },
  }
}

/// A feature setup explains on its own when it becomes available after the
/// tour. Activity keeps its account-owned consent in its own window; this
/// only introduces it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Introduction {
  ActivityTimeline,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupHistory {
  /// Permissions seen granted; one that goes missing reopens setup for it.
  pub granted: Vec<Permission>,
  pub introduced: Vec<Introduction>,
}

/// What the setup window shows: the tour, the permissions that were turned
/// off since, or a feature that became available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Mode {
  Tour,
  Fix { permissions: Vec<Permission> },
  Introduce { feature: Introduction },
}

/// Needed permissions that were granted before and are not now.
pub fn revoked(granted: &[Permission], rows: &[PermissionRow]) -> Vec<Permission> {
  rows
    .iter()
    .filter(|row| {
      granted.contains(&row.permission) && row.status != PermissionStatus::Granted
    })
    .map(|row| row.permission)
    .collect()
}

/// What setup opens at launch, if anything.
pub fn launch_mode(
  progress: Progress,
  history: &SetupHistory,
  rows: &[PermissionRow],
) -> Option<Mode> {
  match progress {
    Progress::FirstRun { .. } => Some(Mode::Tour),
    Progress::Replaying { .. } | Progress::Completed => {
      let permissions = revoked(&history.granted, rows);
      (!permissions.is_empty()).then_some(Mode::Fix { permissions })
    }
  }
}

/// Remembers every permission granted now; a permission is forgotten only
/// when the user declines to turn it back on.
pub fn remember_granted(granted: &mut Vec<Permission>, rows: &[PermissionRow]) {
  for row in rows {
    if row.status == PermissionStatus::Granted && !granted.contains(&row.permission) {
      granted.push(row.permission);
    }
  }
}

pub struct Onboarding {
  progress: Progress,
  /// The step the last snapshot reported; kept for this run only.
  shown: Option<Step>,
  preference: DevicePreference,
  history: SetupHistory,
  history_preference: DevicePreference,
  mode: Mode,
}

pub type OnboardingState = Mutex<Onboarding>;

impl Onboarding {
  /// An unreadable or unknown file means setup never finished.
  pub fn load() -> Self {
    let preference = DevicePreference::in_app_data(PROGRESS_FILE_NAME);
    let progress = preference
      .read()
      .and_then(|stored| serde_json::from_str(&stored).ok())
      .unwrap_or(Progress::FirstRun {
        resume: Step::Welcome,
      });
    let history_preference = DevicePreference::in_app_data(HISTORY_FILE_NAME);
    let history = history_preference
      .read()
      .and_then(|stored| serde_json::from_str(&stored).ok())
      .unwrap_or_default();
    Self {
      history,
      history_preference,
      mode: Mode::Tour,
      progress,
      shown: None,
      preference,
    }
  }

  fn update_history(&mut self, change: impl FnOnce(&mut SetupHistory)) {
    let before = self.history.clone();
    change(&mut self.history);
    if self.history == before {
      return;
    }
    let written = serde_json::to_string(&self.history)
      .map_err(|error| error.to_string())
      .and_then(|value| self.history_preference.write(&value));
    if let Err(error) = written {
      tracing::warn!(error = %error, "onboarding history could not be saved");
    }
  }

  fn save(&mut self, progress: Progress) {
    self.progress = progress;
    let written = serde_json::to_string(&progress)
      .map_err(|error| error.to_string())
      .and_then(|value| self.preference.write(&value));
    if let Err(error) = written {
      // The flow still works in memory; it starts over on the next launch.
      tracing::warn!(error = %error, "onboarding progress could not be saved");
    }
  }

  fn step(&self) -> Step {
    match self.progress {
      Progress::FirstRun { resume } | Progress::Replaying { resume } => resume,
      Progress::Completed => Step::Done,
    }
  }
}

/// The installed app that opens Word documents here, so the tour can name it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentApp {
  pub name: String,
  pub icon_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingSnapshot {
  pub mode: Mode,
  pub step: Step,
  pub steps: Vec<Step>,
  pub linked: bool,
  pub activity_available: bool,
  /// Asked on the Activity step, beside what they enable.
  pub activity_permissions: Vec<Permission>,
  pub document_app: Option<DocumentApp>,
  /// Read for the last step, which points at the icon.
  pub tray_location: Option<TrayLocation>,
}

async fn permission_rows(app: &AppHandle) -> Result<Vec<PermissionRow>, String> {
  let probe = app.clone();
  tauri::async_runtime::spawn_blocking(move || {
    crate::permissions::snapshot(&probe).rows
  })
  .await
  .map_err(crate::logging::with_cause_logged(
    "permission status could not be read",
  ))
}

/// The permissions the Activity step asks for; the Permissions step shows
/// every other row.
pub fn activity_step_permissions(activity_available: bool) -> &'static [Permission] {
  if activity_available {
    required_permissions(DesktopSurface::ActivityDetails)
  } else {
    &[]
  }
}

/// Whether the Permissions step has rows the Activity step does not ask for.
pub fn has_permission_step_rows(
  activity_available: bool,
  rows: &[PermissionRow],
) -> bool {
  let asked_by_activity = activity_step_permissions(activity_available);
  rows
    .iter()
    .any(|row| !asked_by_activity.contains(&row.permission))
}

async fn flow_context(app: &AppHandle) -> FlowContext {
  let account = app.state::<crate::account::AccountState>();
  let linked = crate::account::current(&account)
    .await
    .is_ok_and(|linked| linked.is_some());
  let activity_available = app
    .state::<FeatureGates>()
    .is_enabled(DesktopFeature::ActivityTimeline);
  // An unreadable snapshot is logged by `permission_rows`; setup then skips
  // the Permissions step rather than failing.
  let rows = permission_rows(app).await.unwrap_or_default();
  FlowContext {
    linked,
    activity_available,
    has_permission_rows: has_permission_step_rows(activity_available, &rows),
    clipboard: !crate::managed_policy::current().clipboard_disabled,
  }
}

async fn snapshot(app: &AppHandle) -> Result<OnboardingSnapshot, String> {
  let context = flow_context(app).await;
  let rows = permission_rows(app).await?;
  let state = app.state::<OnboardingState>();
  let step = {
    let mut onboarding = locked(&state)?;
    let step = on_screen(onboarding.step(), onboarding.shown, context);
    let progress = resumed(onboarding.progress, step);
    if progress != onboarding.progress {
      onboarding.save(progress);
    }
    onboarding.update_history(|history| remember_granted(&mut history.granted, &rows));
    onboarding.shown = Some(step);
    step
  };
  #[cfg(target_os = "macos")]
  let document_app = tauri::async_runtime::spawn_blocking(document_app)
    .await
    .unwrap_or(None);
  #[cfg(not(target_os = "macos"))]
  let document_app = None;
  let mode = locked(&state)?.mode.clone();
  Ok(OnboardingSnapshot {
    mode,
    step,
    steps: visible_steps(context, step),
    linked: context.linked,
    activity_available: context.activity_available,
    activity_permissions: activity_step_permissions(context.activity_available)
      .to_vec(),
    document_app,
    tray_location: if step == Step::Done {
      read_tray_location(app)
    } else {
      None
    },
  })
}

fn locked<'a>(
  state: &'a State<'_, OnboardingState>,
) -> Result<std::sync::MutexGuard<'a, Onboarding>, String> {
  state.lock().map_err(crate::logging::with_cause_logged(
    "onboarding state is unavailable",
  ))
}

/// Opens the setup window at launch until setup is finished. A login launch
/// stays in the background: setup waits for a launch the user started.
pub fn show_if_pending(app: &AppHandle, background_launch: bool) {
  if background_launch {
    return;
  }
  let state = app.state::<OnboardingState>();
  let pending = state
    .lock()
    .is_ok_and(|onboarding| !onboarding.progress.first_run_finished());
  if pending {
    show(app);
  } else {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
      let rows = match permission_rows(&app).await {
        Ok(rows) => rows,
        Err(error) => {
          tracing::warn!(error = %error, "onboarding permissions could not be read");
          return;
        }
      };
      let mode = {
        let state = app.state::<OnboardingState>();
        let Ok(mut onboarding) = state.lock() else {
          return;
        };
        let mode = launch_mode(onboarding.progress, &onboarding.history, &rows);
        onboarding
          .update_history(|history| remember_granted(&mut history.granted, &rows));
        if let Some(mode) = &mode {
          onboarding.mode = mode.clone();
        }
        mode
      };
      if mode.is_some() {
        show(&app);
      }
    });
  }
}

/// Introduces a feature the server turned on after the tour, once.
pub fn feature_enabled(app: &AppHandle, feature: DesktopFeature) {
  let introduction = match feature {
    DesktopFeature::ActivityTimeline => Introduction::ActivityTimeline,
    DesktopFeature::TimeBilling | DesktopFeature::LocalAgents => return,
  };
  if app.get_webview_window(ONBOARDING_WINDOW_LABEL).is_some() {
    return;
  }
  let introduce = {
    let state = app.state::<OnboardingState>();
    let Ok(mut onboarding) = state.lock() else {
      return;
    };
    let introduce = onboarding.progress.first_run_finished()
      && !onboarding.history.introduced.contains(&introduction);
    if introduce {
      onboarding.mode = Mode::Introduce {
        feature: introduction,
      };
    }
    introduce
  };
  if introduce {
    show(app);
  }
}

pub fn show(app: &AppHandle) {
  #[cfg(target_os = "macos")]
  let _ = app.show();
  if let Some(window) = app.get_webview_window(ONBOARDING_WINDOW_LABEL) {
    if window.show().and_then(|()| window.set_focus()).is_err() {
      tracing::warn!("onboarding window could not be focused");
    }
    return;
  }
  let builder = crate::app_window::builder(app, ONBOARDING_WINDOW_LABEL, "index.html")
    .title("stella desktop")
    .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .visible(false);
  let builder = crate::window_placement::centered_on_target_screen(
    app,
    builder,
    LogicalSize::new(WINDOW_WIDTH, WINDOW_HEIGHT),
  );
  let builder = builder.on_page_load(|window, payload| {
    if payload.event() != PageLoadEvent::Finished {
      return;
    }
    if window.show().and_then(|()| window.set_focus()).is_err() {
      tracing::warn!("onboarding window could not be shown");
    }
  });
  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);
  match builder.build() {
    Ok(window) => {
      // The shortcut may have been paused by the recorder on Try it.
      let handle = app.clone();
      window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
          crate::clipboard_shortcut::resume_after_window_closed(&handle);
        }
      });
    }
    Err(error) => {
      tracing::error!(error = %error, "onboarding window could not be created")
    }
  }
}

fn close_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(ONBOARDING_WINDOW_LABEL)
    && window.close().is_err()
  {
    tracing::warn!("onboarding window could not be closed");
  }
}

/// Called by the shortcut handler. Only an open setup window on Try it takes
/// the press; with setup closed the shortcut is ordinary use, not the tour.
pub fn shortcut_pressed(app: &AppHandle) {
  if app.get_webview_window(ONBOARDING_WINDOW_LABEL).is_none() {
    return;
  }
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if apply(&app, Step::TryIt, Input::ShortcutPressed)
      .await
      .is_ok()
    {
      let _ = app.emit_to(ONBOARDING_WINDOW_LABEL, CHANGED_EVENT, ());
    }
  });
}

async fn apply(app: &AppHandle, from: Step, input: Input) -> Result<(), String> {
  let context = flow_context(app).await;
  let state = app.state::<OnboardingState>();
  let mut onboarding = locked(&state)?;
  if onboarding.mode != Mode::Tour {
    return Ok(());
  }
  if onboarding.progress == Progress::Completed {
    return Ok(());
  }
  if input == Input::ShortcutPressed && onboarding.shown != Some(Step::TryIt) {
    return Ok(());
  }
  let current = on_screen(onboarding.step(), onboarding.shown, context);
  let next = resolve(current, from, input, context);
  let progress = resumed(onboarding.progress, next);
  if progress != onboarding.progress {
    onboarding.save(progress);
  }
  drop(onboarding);
  Ok(())
}

#[tauri::command]
pub async fn onboarding_get_snapshot(
  app: AppHandle,
) -> Result<OnboardingSnapshot, String> {
  snapshot(&app).await
}

/// `from` is the step the window showed when the user acted.
#[tauri::command]
pub async fn onboarding_advance(
  app: AppHandle,
  from: Step,
  input: Input,
) -> Result<OnboardingSnapshot, String> {
  apply(&app, from, input).await?;
  snapshot(&app).await
}

/// Finishes setup for good; the window does not open again at launch.
#[tauri::command]
pub async fn onboarding_complete(
  app: AppHandle,
  state: State<'_, OnboardingState>,
) -> Result<(), String> {
  let rows = permission_rows(&app).await?;
  let activity = app
    .state::<FeatureGates>()
    .is_enabled(DesktopFeature::ActivityTimeline);
  locked(&state)?.update_history(|history| {
    remember_granted(&mut history.granted, &rows);
    if activity && !history.introduced.contains(&Introduction::ActivityTimeline) {
      history.introduced.push(Introduction::ActivityTimeline);
    }
  });
  locked(&state)?.save(Progress::Completed);
  close_window(&app);
  Ok(())
}

/// Closes a fix or an introduction. A permission still off is forgotten so
/// setup does not ask again at every launch; an introduction is not repeated.
#[tauri::command]
pub async fn onboarding_dismiss(app: AppHandle) -> Result<(), String> {
  let rows = permission_rows(&app).await?;
  let state = app.state::<OnboardingState>();
  {
    let mut onboarding = locked(&state)?;
    let mode = std::mem::replace(&mut onboarding.mode, Mode::Tour);
    onboarding.update_history(|progress| match mode {
      Mode::Tour => {}
      Mode::Fix { .. } => {
        let still_off = revoked(&progress.granted, &rows);
        progress
          .granted
          .retain(|permission| !still_off.contains(permission));
      }
      Mode::Introduce { feature } => {
        if !progress.introduced.contains(&feature) {
          progress.introduced.push(feature);
        }
      }
    });
  }
  close_window(&app);
  Ok(())
}

/// Opens the activity window from its introduction, where its own consent
/// starts recording.
#[tauri::command]
pub async fn onboarding_open_activity(app: AppHandle) -> Result<(), String> {
  onboarding_dismiss(app.clone()).await?;
  crate::activity_window::show(&app);
  Ok(())
}

/// Closes the window and keeps the resume point for the next launch.
#[tauri::command]
pub async fn onboarding_later(app: AppHandle) -> Result<(), String> {
  close_window(&app);
  Ok(())
}

/// Starts the tour again from settings. Its window is reused, whatever it
/// was showing.
#[tauri::command]
pub async fn onboarding_restart(app: AppHandle) -> Result<(), String> {
  {
    let state = app.state::<OnboardingState>();
    let mut onboarding = locked(&state)?;
    onboarding.mode = Mode::Tour;
    onboarding.shown = None;
    let progress = restarted(onboarding.progress);
    onboarding.save(progress);
  }
  let _ = app.emit_to(ONBOARDING_WINDOW_LABEL, CHANGED_EVENT, ());
  show(&app);
  Ok(())
}

/// Opens the main window's settings from the last step.
#[tauri::command]
pub async fn onboarding_open_settings(app: AppHandle) -> Result<(), String> {
  crate::ensure_main_window(&app, "general");
  Ok(())
}

/// The screen edge the app's status icon sits on: the menu bar on macOS,
/// usually the taskbar's notification area on Windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenEdge {
  Top,
  Bottom,
  Left,
  Right,
}

/// Where the status icon sits on its screen, so the last setup step can
/// point at the real icon rather than describe it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLocation {
  pub edge: ScreenEdge,
  /// The icon's centre along that edge: 0 at its left (or top) end, 1 at
  /// its right (or bottom) end.
  pub along: f64,
}

/// Places `icon` on the nearest edge of `screen`. `None` when the icon has
/// no size or its centre is off that screen, as for an icon Windows keeps in
/// its hidden overflow.
fn tray_location(icon: WorkArea, screen: WorkArea) -> Option<TrayLocation> {
  if icon.width <= 0.0
    || icon.height <= 0.0
    || screen.width <= 0.0
    || screen.height <= 0.0
  {
    return None;
  }
  let centre_x = icon.x + icon.width / 2.0 - screen.x;
  let centre_y = icon.y + icon.height / 2.0 - screen.y;
  if !(0.0..=screen.width).contains(&centre_x)
    || !(0.0..=screen.height).contains(&centre_y)
  {
    return None;
  }
  let distances = [
    (ScreenEdge::Top, centre_y),
    (ScreenEdge::Bottom, screen.height - centre_y),
    (ScreenEdge::Left, centre_x),
    (ScreenEdge::Right, screen.width - centre_x),
  ];
  let (edge, _) = distances
    .into_iter()
    .min_by(|(_, left), (_, right)| left.total_cmp(right))?;
  let along = match edge {
    ScreenEdge::Top | ScreenEdge::Bottom => centre_x / screen.width,
    ScreenEdge::Left | ScreenEdge::Right => centre_y / screen.height,
  };
  Some(TrayLocation { edge, along })
}

/// Where the status icon is now, read from the OS; `None` when it cannot
/// tell (no icon yet, or one hidden in an overflow area).
fn read_tray_location(app: &AppHandle) -> Option<TrayLocation> {
  let placement = crate::tray::status_icon_placement(app)?;
  tray_location(placement.frame, placement.screen)
}

/// The default app for `.docx`, read from the OS. macOS answers for a file,
/// so a short-lived empty probe file in the temp directory carries the type.
#[cfg(target_os = "macos")]
fn document_app() -> Option<DocumentApp> {
  use objc2_app_kit::NSWorkspace;
  use objc2_foundation::{NSString, NSURL};

  let probe = std::env::temp_dir()
    .join(format!("stella-document-app-{}.docx", uuid::Uuid::new_v4()));
  std::fs::write(&probe, []).ok()?;
  let url = NSURL::fileURLWithPath(&NSString::from_str(probe.to_str()?));
  let app_path = NSWorkspace::sharedWorkspace()
    .URLForApplicationToOpenURL(&url)
    .and_then(|app| app.path())
    .map(|path| std::path::PathBuf::from(path.to_string()));
  let _ = std::fs::remove_file(&probe);
  let app_path = app_path?;
  let info = plist::Value::from_file(app_path.join("Contents/Info.plist")).ok()?;
  let info = info.as_dictionary()?;
  let name = ["CFBundleDisplayName", "CFBundleName"]
    .iter()
    .find_map(|key| info.get(key).and_then(plist::Value::as_string))
    .map(str::to_string)
    .or_else(|| app_path.file_stem()?.to_str().map(str::to_string))?;
  Some(DocumentApp {
    name,
    icon_data_url: crate::foreground_app_visual::bundle_icon_data_url(&app_path),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Every combination with clipboard history; its absence has its own test.
  const CONTEXTS: [FlowContext; 8] = {
    let mut contexts = [FlowContext {
      linked: false,
      activity_available: false,
      has_permission_rows: false,
      clipboard: true,
    }; 8];
    let mut index = 0;
    while index < 8 {
      contexts[index] = FlowContext {
        linked: index & 1 != 0,
        activity_available: index & 2 != 0,
        has_permission_rows: index & 4 != 0,
        clipboard: true,
      };
      index += 1;
    }
    contexts
  };
  const INPUTS: [Input; 3] = [Input::Continue, Input::Back, Input::ShortcutPressed];

  /// Every input sequence of length `depth` from Welcome, deterministically.
  fn walks(depth: usize) -> Vec<Vec<Input>> {
    (0..INPUTS.len().pow(depth as u32))
      .map(|mut code| {
        (0..depth)
          .map(|_| {
            let input = INPUTS[code % INPUTS.len()];
            code /= INPUTS.len();
            input
          })
          .collect()
      })
      .collect()
  }

  #[test]
  fn done_is_reached_only_through_try_it() {
    for context in CONTEXTS {
      for walk in walks(7) {
        let mut step = Step::Welcome;
        for input in walk {
          let next = next_step(step, input, context);
          if next == Step::Done && step != Step::Done {
            assert_eq!(step, Step::TryIt, "{context:?}");
          }
          step = next;
        }
      }
    }
  }

  #[test]
  fn every_step_reached_is_visible_and_inapplicable_steps_never_appear() {
    for context in CONTEXTS {
      for walk in walks(7) {
        let mut step = Step::Welcome;
        for input in walk {
          step = next_step(step, input, context);
          assert!(visible_steps(context, step).contains(&step));
          if context.linked {
            assert_ne!(step, Step::Connect);
          }
          if !context.has_permission_rows {
            assert_ne!(step, Step::Permissions);
          }
          if !context.activity_available {
            assert_ne!(step, Step::Activity);
          }
        }
      }
    }
  }

  #[test]
  fn try_it_succeeds_only_by_the_shortcut_or_an_explicit_continue() {
    for context in CONTEXTS {
      assert_eq!(
        next_step(Step::TryIt, Input::ShortcutPressed, context),
        Step::Done
      );
      assert_eq!(next_step(Step::TryIt, Input::Continue, context), Step::Done);
      for step in Step::ALL.into_iter().filter(|step| *step != Step::TryIt) {
        assert_eq!(next_step(step, Input::ShortcutPressed, context), step);
      }
    }
  }

  #[test]
  fn a_stale_resume_point_settles_on_a_visible_step_at_or_after_it() {
    for context in CONTEXTS {
      for stored in Step::ALL {
        let settled = settle(stored, context);
        assert!(visible_steps(context, settled).contains(&settled));
        let order = |step: Step| Step::ALL.iter().position(|s| *s == step);
        assert!(order(settled) >= order(stored));
      }
    }
  }

  #[test]
  fn connecting_during_the_connect_step_keeps_it_on_screen() {
    let linked = FlowContext {
      linked: true,
      activity_available: true,
      has_permission_rows: true,
      clipboard: true,
    };
    assert!(visible_steps(linked, Step::Connect).contains(&Step::Connect));
    let current = on_screen(Step::Connect, Some(Step::Connect), linked);
    assert_eq!(current, Step::Connect);
    assert_eq!(
      resolve(current, Step::Connect, Input::Continue, linked),
      Step::HowItWorks
    );
    // A resume point no window has shown in this run still settles past it.
    assert_eq!(on_screen(Step::Connect, None, linked), Step::HowItWorks);
  }

  #[test]
  fn a_repeated_or_stale_input_never_moves_the_flow_twice() {
    for context in CONTEXTS {
      for walk in walks(6) {
        let mut step = Step::Welcome;
        for input in walk {
          let from = step;
          step = resolve(step, from, input, context);
          assert_eq!(resolve(step, from, input, context), step, "{context:?}");
        }
      }
    }
  }

  #[test]
  fn the_shortcut_moves_the_flow_only_from_try_it() {
    for context in CONTEXTS {
      for step in Step::ALL {
        let expected = if step == Step::TryIt {
          Step::Done
        } else {
          step
        };
        assert_eq!(
          resolve(step, Step::TryIt, Input::ShortcutPressed, context),
          expected
        );
      }
    }
  }

  #[test]
  fn without_clipboard_history_setup_ends_without_try_it() {
    for context in CONTEXTS.map(|context| FlowContext {
      clipboard: false,
      ..context
    }) {
      for walk in walks(6) {
        let mut step = Step::Welcome;
        for input in walk {
          step = next_step(step, input, context);
          assert_ne!(step, Step::TryIt, "{context:?}");
        }
      }
      let before_done = if context.has_permission_rows {
        Step::Permissions
      } else if context.activity_available {
        Step::Activity
      } else {
        Step::HowItWorks
      };
      assert_eq!(next_step(before_done, Input::Continue, context), Step::Done);
      // A resume point saved on Try it before the policy settles on Done.
      assert_eq!(settle(Step::TryIt, context), Step::Done);
    }
  }

  #[test]
  fn progress_round_trips_through_its_stored_form() {
    for progress in [
      Progress::Completed,
      Progress::FirstRun {
        resume: Step::Permissions,
      },
      Progress::Replaying {
        resume: Step::Activity,
      },
    ] {
      let stored = serde_json::to_string(&progress).unwrap();
      assert_eq!(serde_json::from_str::<Progress>(&stored).unwrap(), progress);
    }
    assert_eq!(
      serde_json::to_value(Progress::FirstRun {
        resume: Step::TryIt
      })
      .unwrap(),
      serde_json::json!({ "status": "inProgress", "resume": "tryIt" })
    );
  }

  #[test]
  fn setup_history_round_trips_independently_of_tour_progress() {
    for history in [
      SetupHistory::default(),
      SetupHistory {
        granted: vec![Permission::Notifications, Permission::Accessibility],
        introduced: vec![Introduction::ActivityTimeline],
      },
    ] {
      let stored = serde_json::to_string(&history).unwrap();
      assert_eq!(
        serde_json::from_str::<SetupHistory>(&stored).unwrap(),
        history
      );
    }
  }

  fn rows(statuses: &[(Permission, PermissionStatus)]) -> Vec<PermissionRow> {
    statuses
      .iter()
      .map(|(permission, status)| PermissionRow {
        permission: *permission,
        status: *status,
      })
      .collect()
  }

  const STATUSES: [PermissionStatus; 5] = [
    PermissionStatus::NotDetermined,
    PermissionStatus::Granted,
    PermissionStatus::Denied,
    PermissionStatus::Managed,
    PermissionStatus::NotApplicable,
  ];

  #[test]
  fn only_a_permission_granted_before_and_not_now_is_revoked() {
    for before in [false, true] {
      for status in STATUSES {
        let granted = if before {
          vec![Permission::Notifications]
        } else {
          vec![]
        };
        let current = rows(&[(Permission::Notifications, status)]);
        let expected = before && status != PermissionStatus::Granted;
        assert_eq!(
          revoked(&granted, &current) == vec![Permission::Notifications],
          expected,
          "{before} {status:?}"
        );
      }
    }
  }

  #[test]
  fn launch_opens_the_tour_until_completed_and_then_only_for_revoked_permissions() {
    let current = rows(&[
      (Permission::Notifications, PermissionStatus::Denied),
      (Permission::OpenAtLogin, PermissionStatus::Granted),
    ]);
    let mut history = SetupHistory {
      granted: vec![Permission::Notifications, Permission::OpenAtLogin],
      ..SetupHistory::default()
    };
    assert_eq!(
      launch_mode(
        Progress::FirstRun {
          resume: Step::Welcome
        },
        &history,
        &current,
      ),
      Some(Mode::Tour)
    );
    assert_eq!(
      launch_mode(Progress::Completed, &history, &current),
      Some(Mode::Fix {
        permissions: vec![Permission::Notifications]
      })
    );
    history.granted = vec![Permission::OpenAtLogin];
    assert_eq!(launch_mode(Progress::Completed, &history, &current), None);
  }

  #[test]
  fn activity_is_explained_after_how_it_works_and_before_permissions() {
    for context in CONTEXTS
      .into_iter()
      .filter(|context| context.activity_available)
    {
      let steps = visible_steps(context, Step::Welcome);
      let position = |step: Step| steps.iter().position(|s| *s == step);
      assert_eq!(
        position(Step::Activity),
        position(Step::HowItWorks).map(|index| index + 1)
      );
    }
  }

  #[test]
  fn the_activity_step_owns_its_permissions_and_the_permissions_step_the_rest() {
    let accessibility_only =
      rows(&[(Permission::Accessibility, PermissionStatus::NotDetermined)]);
    assert!(!has_permission_step_rows(true, &accessibility_only));
    assert!(has_permission_step_rows(false, &accessibility_only));
    let mixed = rows(&[
      (Permission::Notifications, PermissionStatus::NotDetermined),
      (Permission::Accessibility, PermissionStatus::NotDetermined),
    ]);
    assert!(has_permission_step_rows(true, &mixed));
    assert!(!has_permission_step_rows(true, &[]));
    assert_eq!(
      activity_step_permissions(true),
      required_permissions(DesktopSurface::ActivityDetails)
    );
    assert!(activity_step_permissions(false).is_empty());
  }

  #[test]
  fn a_restart_replays_a_finished_tour_from_welcome_without_reopening_at_launch() {
    let history = SetupHistory::default();
    for progress in [
      Progress::Completed,
      Progress::Replaying {
        resume: Step::TryIt,
      },
    ] {
      let replay = restarted(progress);
      assert_eq!(
        replay,
        Progress::Replaying {
          resume: Step::Welcome
        }
      );
      assert!(replay.first_run_finished());
      assert_eq!(launch_mode(replay, &history, &[]), None);
    }
    for step in Step::ALL {
      let first_run = Progress::FirstRun { resume: step };
      assert!(!first_run.first_run_finished());
      assert_eq!(
        restarted(first_run),
        Progress::FirstRun {
          resume: Step::Welcome
        }
      );
      assert_eq!(
        resumed(
          Progress::FirstRun {
            resume: Step::Welcome
          },
          step
        ),
        first_run
      );
      assert_eq!(
        resumed(
          Progress::Replaying {
            resume: Step::Welcome
          },
          step
        ),
        Progress::Replaying { resume: step }
      );
      assert_eq!(resumed(Progress::Completed, step), Progress::Completed);
    }
  }

  #[test]
  fn remembering_grants_adds_and_never_forgets() {
    let mut granted = vec![Permission::Accessibility];
    remember_granted(
      &mut granted,
      &rows(&[
        (Permission::Notifications, PermissionStatus::Granted),
        (Permission::Accessibility, PermissionStatus::Denied),
        (Permission::OpenAtLogin, PermissionStatus::NotDetermined),
      ]),
    );
    assert_eq!(
      granted,
      vec![Permission::Accessibility, Permission::Notifications]
    );
    let before = granted.clone();
    remember_granted(
      &mut granted,
      &rows(&[(Permission::Notifications, PermissionStatus::Granted)]),
    );
    assert_eq!(granted, before);
  }

  const SCREEN: WorkArea = WorkArea {
    x: 0.0,
    y: 0.0,
    width: 2880.0,
    height: 1800.0,
  };

  fn icon_at(x: f64, y: f64) -> WorkArea {
    WorkArea {
      x,
      y,
      width: 44.0,
      height: 44.0,
    }
  }

  #[test]
  fn a_menu_bar_icon_sits_on_the_top_edge_where_it_is_drawn() {
    let location = tray_location(icon_at(2178.0, 0.0), SCREEN).unwrap();
    assert_eq!(location.edge, ScreenEdge::Top);
    assert!((location.along - 2200.0 / 2880.0).abs() < 1e-9);
  }

  #[test]
  fn a_taskbar_icon_sits_on_the_bottom_edge_of_its_own_screen() {
    let second = WorkArea {
      x: 2880.0,
      y: 0.0,
      width: 1920.0,
      height: 1080.0,
    };
    let location = tray_location(icon_at(2880.0 + 1700.0, 1040.0), second).unwrap();
    assert_eq!(location.edge, ScreenEdge::Bottom);
    assert!((location.along - 1722.0 / 1920.0).abs() < 1e-9);
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn native_screen_frames_keep_a_secondary_menu_bar_in_its_own_points() {
    use crate::window_placement::logical_work_area;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    // A 1x display beside a 1920-point 2x primary. Global physical
    // coordinates would also place this icon inside the primary display.
    let screen = NSRect::new(NSPoint::new(1920.0, 0.0), NSSize::new(1920.0, 1080.0));
    let icon = NSRect::new(NSPoint::new(2989.0, 1058.0), NSSize::new(22.0, 22.0));
    let location = tray_location(
      logical_work_area(1080.0, icon),
      logical_work_area(1080.0, screen),
    )
    .unwrap();

    assert_eq!(location.edge, ScreenEdge::Top);
    assert!((location.along - 1080.0 / 1920.0).abs() < 1e-9);
  }

  #[test]
  fn a_vertical_taskbar_reports_the_position_down_its_edge() {
    let location = tray_location(icon_at(4.0, 1500.0), SCREEN).unwrap();
    assert_eq!(location.edge, ScreenEdge::Left);
    assert!((location.along - 1522.0 / 1800.0).abs() < 1e-9);
  }

  #[test]
  fn an_icon_without_a_size_or_off_its_screen_has_no_location() {
    let hidden = WorkArea {
      width: 0.0,
      height: 0.0,
      ..icon_at(100.0, 100.0)
    };
    assert_eq!(tray_location(hidden, SCREEN), None);
    assert_eq!(tray_location(icon_at(-400.0, 10.0), SCREEN), None);
  }

  #[test]
  fn every_location_is_a_fraction_of_its_edge() {
    for x in (0..2880).step_by(97) {
      for y in (0..1800).step_by(83) {
        let icon = icon_at(f64::from(x) - 22.0, f64::from(y) - 22.0);
        let location = tray_location(icon, SCREEN).unwrap();
        assert!((0.0..=1.0).contains(&location.along), "{location:?}");
      }
    }
  }
}
