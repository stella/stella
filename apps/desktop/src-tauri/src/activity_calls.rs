//! Calls for the activity timeline: which known call app or browser holds a
//! microphone right now. Only that an app captures input is read, never
//! audio, and only apps in the catalog below count, so dictation tools and
//! voice assistants are never mistaken for calls.
//!
//! A native call app counts from the first sample that sees it on the
//! microphone. A browser must hold it for four consecutive samples, about
//! fifteen seconds: voice notes and dictation fields open the microphone for
//! a few seconds, calls hold it for minutes. One missed sample is tolerated
//! so a brief device switch does not split a call.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CallAppKind {
  Native,
  Browser,
}

struct CatalogApp {
  /// macOS bundle identifier or Windows executable name, as the foreground
  /// lookup reports it.
  identifier: &'static str,
  name: &'static str,
  kind: CallAppKind,
}

const fn native(identifier: &'static str, name: &'static str) -> CatalogApp {
  CatalogApp {
    identifier,
    name,
    kind: CallAppKind::Native,
  }
}

const fn browser(identifier: &'static str, name: &'static str) -> CatalogApp {
  CatalogApp {
    identifier,
    name,
    kind: CallAppKind::Browser,
  }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MACOS_APPS: &[CatalogApp] = &[
  native("com.microsoft.teams2", "Microsoft Teams"),
  native("com.microsoft.teams", "Microsoft Teams"),
  native("us.zoom.xos", "Zoom"),
  native("Cisco-Systems.Spark", "Webex"),
  native("com.cisco.webexmeetingsapp", "Webex Meetings"),
  native("com.tinyspeck.slackmacgap", "Slack"),
  native("com.apple.FaceTime", "FaceTime"),
  native("com.skype.skype", "Skype"),
  native("com.hnc.Discord", "Discord"),
  native("net.whatsapp.WhatsApp", "WhatsApp"),
  native("org.whispersystems.signal-desktop", "Signal"),
  native("com.logmein.GoToMeeting", "GoTo Meeting"),
  native("com.ringcentral.glip", "RingCentral"),
  browser("com.google.Chrome", "Google Chrome"),
  browser("com.microsoft.edgemac", "Microsoft Edge"),
  browser("com.apple.Safari", "Safari"),
  browser("org.mozilla.firefox", "Firefox"),
  browser("com.brave.Browser", "Brave Browser"),
  browser("company.thebrowser.Browser", "Arc"),
  browser("com.operasoftware.Opera", "Opera"),
  browser("com.vivaldi.Vivaldi", "Vivaldi"),
];

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WINDOWS_APPS: &[CatalogApp] = &[
  native("ms-teams.exe", "Microsoft Teams"),
  native("teams.exe", "Microsoft Teams"),
  native("zoom.exe", "Zoom"),
  native("ciscocollabhost.exe", "Webex"),
  native("atmgr.exe", "Webex Meetings"),
  native("slack.exe", "Slack"),
  native("skype.exe", "Skype"),
  native("discord.exe", "Discord"),
  native("whatsapp.exe", "WhatsApp"),
  native("signal.exe", "Signal"),
  native("g2mcomm.exe", "GoTo Meeting"),
  native("ringcentral.exe", "RingCentral"),
  browser("chrome.exe", "Google Chrome"),
  browser("msedge.exe", "Microsoft Edge"),
  browser("firefox.exe", "Firefox"),
  browser("brave.exe", "Brave Browser"),
  browser("arc.exe", "Arc"),
  browser("opera.exe", "Opera"),
  browser("vivaldi.exe", "Vivaldi"),
];

/// The new Teams is a packaged app; its consent record names the package.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const WINDOWS_PACKAGES: &[(&str, &str)] = &[("MSTeams_", "ms-teams.exe")];

/// Safari captures through WebKit's shared GPU process.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SAFARI_CAPTURE_PROCESS: &str = "com.apple.WebKit.GPU";

#[derive(Debug, Clone, PartialEq, Eq)]
struct DetectedApp {
  identifier: String,
  name: &'static str,
  kind: CallAppKind,
}

/// A macOS capture process as its app: helpers such as
/// `com.google.Chrome.helper` belong to `com.google.Chrome`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn classify_macos(bundle_id: &str) -> Option<DetectedApp> {
  let bundle_id = if bundle_id.eq_ignore_ascii_case(SAFARI_CAPTURE_PROCESS) {
    "com.apple.Safari"
  } else {
    bundle_id
  };
  let lowered = bundle_id.to_ascii_lowercase();
  MACOS_APPS
    .iter()
    .find(|app| {
      let identifier = app.identifier.to_ascii_lowercase();
      lowered == identifier
        || lowered
          .strip_prefix(&identifier)
          .is_some_and(|rest| rest.starts_with('.'))
    })
    .map(|app| DetectedApp {
      identifier: app.identifier.to_string(),
      name: app.name,
      kind: app.kind,
    })
}

/// A Windows consent record as its app: an executable name keeps its own
/// spelling, which is how the foreground lookup reports it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn classify_windows(record: &str) -> Option<DetectedApp> {
  let executable = WINDOWS_PACKAGES
    .iter()
    .find(|(prefix, _)| record.starts_with(prefix))
    .map_or(record, |(_, executable)| *executable);
  WINDOWS_APPS
    .iter()
    .find(|app| app.identifier.eq_ignore_ascii_case(executable))
    .map(|app| DetectedApp {
      identifier: executable.to_string(),
      name: app.name,
      kind: app.kind,
    })
}

/// The call app the detector settled on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
  pub identifier: String,
  pub name: String,
}

#[derive(Default)]
pub struct CallDetector {
  /// Consecutive samples each app has held the microphone.
  streaks: Vec<(DetectedApp, u8)>,
  active: Option<Call>,
  missed: bool,
}

impl CallDetector {
  /// Reads the microphone and returns the ongoing call, if any.
  pub fn sample(&mut self) -> Option<Call> {
    self.observe(&detected_apps())
  }

  pub fn reset(&mut self) {
    *self = Self::default();
  }

  fn observe(&mut self, apps: &[DetectedApp]) -> Option<Call> {
    let mut streaks = Vec::with_capacity(apps.len());
    for app in apps {
      if streaks
        .iter()
        .any(|(seen, _): &(DetectedApp, u8)| seen == app)
      {
        continue;
      }
      let previous = self
        .streaks
        .iter()
        .find(|(seen, _)| seen == app)
        .map_or(0, |(_, streak)| *streak);
      streaks.push((app.clone(), previous.saturating_add(1)));
    }
    self.streaks = streaks;

    let holds = |identifier: &str| {
      self
        .streaks
        .iter()
        .any(|(app, _)| app.identifier == identifier)
    };
    if let Some(active) = &self.active
      && holds(&active.identifier)
    {
      self.missed = false;
      return self.active.clone();
    }
    let confirmed = self
      .streaks
      .iter()
      .filter(|(app, streak)| *streak >= required_samples(app.kind))
      .min_by(|(left, _), (right, _)| {
        (left.kind, &left.identifier).cmp(&(right.kind, &right.identifier))
      })
      .map(|(app, _)| Call {
        identifier: app.identifier.clone(),
        name: app.name.to_string(),
      });
    if confirmed.is_none() && self.active.is_some() && !self.missed {
      self.missed = true;
      return self.active.clone();
    }
    self.active = confirmed;
    self.missed = false;
    self.active.clone()
  }
}

fn required_samples(kind: CallAppKind) -> u8 {
  match kind {
    CallAppKind::Native => 1,
    CallAppKind::Browser => 4,
  }
}

#[cfg(target_os = "macos")]
fn detected_apps() -> Vec<DetectedApp> {
  stella_desktop_macos::microphone_input_bundle_ids()
    .iter()
    .filter_map(|bundle_id| classify_macos(bundle_id))
    .collect()
}

/// Windows records each app's microphone use in the consent store; an app
/// whose last use has a start but no stop is capturing now.
#[cfg(target_os = "windows")]
fn detected_apps() -> Vec<DetectedApp> {
  use windows_registry::{CURRENT_USER, Key};

  const CONSENT_STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
  const NON_PACKAGED: &str = "NonPackaged";

  let capturing = |key: &Key| {
    key
      .get_u64("LastUsedTimeStart")
      .is_ok_and(|start| start != 0)
      && key.get_u64("LastUsedTimeStop").is_ok_and(|stop| stop == 0)
  };
  let capturing_children = |parent: &Key| -> Vec<String> {
    parent
      .keys()
      .map(|names| {
        names
          .filter(|name| name.as_str() != NON_PACKAGED)
          .filter(|name| parent.open(name).is_ok_and(|key| capturing(&key)))
          .collect()
      })
      .unwrap_or_default()
  };
  let Ok(store) = CURRENT_USER.open(CONSENT_STORE) else {
    return Vec::new();
  };
  let mut records = capturing_children(&store);
  if let Ok(non_packaged) = store.open(NON_PACKAGED) {
    // Desktop apps are recorded by executable path, with `#` for `\`.
    records.extend(
      capturing_children(&non_packaged)
        .into_iter()
        .filter_map(|path| path.rsplit('#').next().map(str::to_string)),
    );
  }
  records
    .iter()
    .filter_map(|record| classify_windows(record))
    .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn detected_apps() -> Vec<DetectedApp> {
  Vec::new()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn app(identifier: &str, kind: CallAppKind) -> DetectedApp {
    DetectedApp {
      identifier: identifier.to_string(),
      name: "App",
      kind,
    }
  }

  fn active(detector: &mut CallDetector, apps: &[DetectedApp]) -> Option<String> {
    detector.observe(apps).map(|call| call.identifier)
  }

  #[test]
  fn macos_helpers_and_safari_map_to_their_app() {
    let chrome = classify_macos("com.google.Chrome.helper").unwrap();
    assert_eq!(chrome.identifier, "com.google.Chrome");
    assert_eq!(chrome.kind, CallAppKind::Browser);
    let teams = classify_macos("com.microsoft.teams2.helper.renderer").unwrap();
    assert_eq!(teams.identifier, "com.microsoft.teams2");
    assert_eq!(teams.kind, CallAppKind::Native);
    assert_eq!(
      classify_macos("com.apple.WebKit.GPU").unwrap().identifier,
      "com.apple.Safari"
    );
    // A prefix that is not a whole identifier segment is another app.
    assert!(classify_macos("com.google.Chromecast").is_none());
    assert!(classify_macos("com.apple.VoiceMemos").is_none());
  }

  #[test]
  fn windows_records_keep_the_executable_spelling() {
    let zoom = classify_windows("Zoom.exe").unwrap();
    assert_eq!(zoom.identifier, "Zoom.exe");
    assert_eq!(zoom.kind, CallAppKind::Native);
    assert_eq!(
      classify_windows("MSTeams_8wekyb3d8bbwe")
        .unwrap()
        .identifier,
      "ms-teams.exe"
    );
    assert!(classify_windows("notepad.exe").is_none());
  }

  #[test]
  fn a_native_app_is_a_call_at_once_and_a_browser_after_four_samples() {
    let mut detector = CallDetector::default();
    let teams = [app("teams", CallAppKind::Native)];
    assert_eq!(active(&mut detector, &teams).as_deref(), Some("teams"));

    let mut detector = CallDetector::default();
    let chrome = [app("chrome", CallAppKind::Browser)];
    for _ in 0..3 {
      assert_eq!(active(&mut detector, &chrome), None);
    }
    assert_eq!(active(&mut detector, &chrome).as_deref(), Some("chrome"));
  }

  #[test]
  fn a_short_browser_capture_never_becomes_a_call() {
    let mut detector = CallDetector::default();
    let chrome = [app("chrome", CallAppKind::Browser)];
    for _ in 0..3 {
      assert_eq!(active(&mut detector, &chrome), None);
    }
    assert_eq!(active(&mut detector, &[]), None);
    assert_eq!(active(&mut detector, &chrome), None);
  }

  #[test]
  fn one_missed_sample_keeps_the_call_and_two_end_it() {
    let mut detector = CallDetector::default();
    let teams = [app("teams", CallAppKind::Native)];
    active(&mut detector, &teams);
    assert_eq!(active(&mut detector, &[]).as_deref(), Some("teams"));
    assert_eq!(active(&mut detector, &teams).as_deref(), Some("teams"));
    assert_eq!(active(&mut detector, &[]).as_deref(), Some("teams"));
    assert_eq!(active(&mut detector, &[]), None);
  }

  #[test]
  fn an_ongoing_call_keeps_its_app_and_a_native_app_wins_a_tie() {
    let mut detector = CallDetector::default();
    let chrome = app("chrome", CallAppKind::Browser);
    let zoom = app("zoom", CallAppKind::Native);
    for _ in 0..4 {
      active(&mut detector, std::slice::from_ref(&chrome));
    }
    assert_eq!(
      active(&mut detector, &[chrome.clone(), zoom.clone()]).as_deref(),
      Some("chrome")
    );

    let mut detector = CallDetector::default();
    for _ in 0..4 {
      active(&mut detector, std::slice::from_ref(&chrome));
    }
    detector.reset();
    assert_eq!(
      active(&mut detector, &[chrome, zoom]).as_deref(),
      Some("zoom")
    );
  }
}
