//! First-run setup: a short tour in its own window that explains what the
//! app does, asks for the permissions it needs, and ends with one real use
//! of the clipboard shortcut. The step logic is a pure function over a small
//! context; this module also owns the device-level progress and the window.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, webview::PageLoadEvent};

use crate::device_preference::DevicePreference;
use crate::feature_gate::{DesktopFeature, FeatureGates};

pub const ONBOARDING_WINDOW_LABEL: &str = "onboarding";
/// Payload-free: the window re-reads the snapshot.
pub const CHANGED_EVENT: &str = "onboarding-changed";
const PROGRESS_FILE_NAME: &str = "onboarding-v1.json";
const WINDOW_WIDTH: f64 = 620.0;
const WINDOW_HEIGHT: f64 = 540.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
  Welcome,
  Connect,
  HowItWorks,
  Permissions,
  TryIt,
  Done,
}

impl Step {
  pub const ALL: [Self; 6] = [
    Self::Welcome,
    Self::Connect,
    Self::HowItWorks,
    Self::Permissions,
    Self::TryIt,
    Self::Done,
  ];
}

/// What decides which steps appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowContext {
  pub linked: bool,
  pub has_permission_rows: bool,
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
          Step::Permissions => context.has_permission_rows,
          Step::Welcome | Step::HowItWorks | Step::TryIt | Step::Done => true,
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
  InProgress { resume: Step },
  Completed,
}

pub struct Onboarding {
  progress: Progress,
  preference: DevicePreference,
}

pub type OnboardingState = Mutex<Onboarding>;

impl Onboarding {
  /// An unreadable or unknown file means setup never finished.
  pub fn load() -> Self {
    let preference = DevicePreference::in_app_data(PROGRESS_FILE_NAME);
    let progress = preference
      .read()
      .and_then(|stored| serde_json::from_str(&stored).ok())
      .unwrap_or(Progress::InProgress {
        resume: Step::Welcome,
      });
    Self {
      progress,
      preference,
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
      Progress::InProgress { resume } => resume,
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
  pub step: Step,
  pub steps: Vec<Step>,
  pub linked: bool,
  pub activity_available: bool,
  pub document_app: Option<DocumentApp>,
}

async fn flow_context(app: &AppHandle) -> FlowContext {
  let account = app.state::<crate::account::AccountState>();
  let linked = crate::account::current(&account)
    .await
    .is_ok_and(|linked| linked.is_some());
  let probe = app.clone();
  let has_permission_rows = tauri::async_runtime::spawn_blocking(move || {
    !crate::permissions::snapshot(&probe).rows.is_empty()
  })
  .await
  .unwrap_or(false);
  FlowContext {
    linked,
    has_permission_rows,
  }
}

async fn snapshot(app: &AppHandle) -> Result<OnboardingSnapshot, String> {
  let context = flow_context(app).await;
  let state = app.state::<OnboardingState>();
  let step = {
    let mut onboarding = locked(&state)?;
    let settled = settle(onboarding.step(), context);
    if settled != onboarding.step() && onboarding.progress != Progress::Completed {
      onboarding.save(Progress::InProgress { resume: settled });
    }
    settled
  };
  let document_app = tauri::async_runtime::spawn_blocking(document_app)
    .await
    .unwrap_or(None);
  Ok(OnboardingSnapshot {
    step,
    steps: visible_steps(context, step),
    linked: context.linked,
    activity_available: app
      .state::<FeatureGates>()
      .is_enabled(DesktopFeature::ActivityTimeline),
    document_app,
  })
}

fn locked<'a>(
  state: &'a State<'_, OnboardingState>,
) -> Result<std::sync::MutexGuard<'a, Onboarding>, String> {
  state
    .lock()
    .map_err(|_| "onboarding state is unavailable".to_string())
}

/// Opens the setup window at launch until setup is finished. A login launch
/// stays in the background: setup waits for a launch the user started.
pub fn show_if_pending(app: &AppHandle, background_launch: bool) {
  if background_launch {
    return;
  }
  let pending = app
    .state::<OnboardingState>()
    .lock()
    .is_ok_and(|onboarding| onboarding.progress != Progress::Completed);
  if pending {
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
          crate::clipboard_shortcut::resume(&handle);
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

/// Called by the shortcut handler. Advances Try it; any other step ignores it.
pub fn shortcut_pressed(app: &AppHandle) {
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if apply(&app, Input::ShortcutPressed).await.is_ok() {
      let _ = app.emit_to(ONBOARDING_WINDOW_LABEL, CHANGED_EVENT, ());
    }
  });
}

async fn apply(app: &AppHandle, input: Input) -> Result<(), String> {
  let context = flow_context(app).await;
  let state = app.state::<OnboardingState>();
  let mut onboarding = locked(&state)?;
  if onboarding.progress == Progress::Completed {
    return Ok(());
  }
  let current = settle(onboarding.step(), context);
  let next = next_step(current, input, context);
  if next != onboarding.step() {
    onboarding.save(Progress::InProgress { resume: next });
  }
  Ok(())
}

#[tauri::command]
pub async fn onboarding_get_snapshot(
  app: AppHandle,
) -> Result<OnboardingSnapshot, String> {
  snapshot(&app).await
}

#[tauri::command]
pub async fn onboarding_advance(
  app: AppHandle,
  input: Input,
) -> Result<OnboardingSnapshot, String> {
  apply(&app, input).await?;
  snapshot(&app).await
}

/// Finishes setup for good; the window does not open again at launch.
#[tauri::command]
pub async fn onboarding_complete(
  app: AppHandle,
  state: State<'_, OnboardingState>,
) -> Result<(), String> {
  locked(&state)?.save(Progress::Completed);
  close_window(&app);
  Ok(())
}

/// Closes the window and keeps the resume point for the next launch.
#[tauri::command]
pub async fn onboarding_later(app: AppHandle) -> Result<(), String> {
  close_window(&app);
  Ok(())
}

/// Opens the main window's settings from the last step.
#[tauri::command]
pub async fn onboarding_open_settings(app: AppHandle) -> Result<(), String> {
  crate::ensure_main_window(&app, "general");
  Ok(())
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

/// Windows resolves the handler through registry associations that vary by
/// install; the tour names the document app generically there.
#[cfg(not(target_os = "macos"))]
fn document_app() -> Option<DocumentApp> {
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  const CONTEXTS: [FlowContext; 4] = [
    FlowContext {
      linked: false,
      has_permission_rows: false,
    },
    FlowContext {
      linked: false,
      has_permission_rows: true,
    },
    FlowContext {
      linked: true,
      has_permission_rows: false,
    },
    FlowContext {
      linked: true,
      has_permission_rows: true,
    },
  ];
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
      has_permission_rows: true,
    };
    assert!(visible_steps(linked, Step::Connect).contains(&Step::Connect));
    assert_eq!(
      next_step(Step::Connect, Input::Continue, linked),
      Step::HowItWorks
    );
  }

  #[test]
  fn progress_round_trips_through_its_stored_form() {
    for progress in [
      Progress::Completed,
      Progress::InProgress {
        resume: Step::Permissions,
      },
    ] {
      let stored = serde_json::to_string(&progress).unwrap();
      assert_eq!(serde_json::from_str::<Progress>(&stored).unwrap(), progress);
    }
    assert_eq!(
      serde_json::to_value(Progress::InProgress {
        resume: Step::TryIt
      })
      .unwrap(),
      serde_json::json!({ "status": "inProgress", "resume": "tryIt" })
    );
  }
}
