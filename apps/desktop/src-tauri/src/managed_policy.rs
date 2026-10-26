//! Settings an organization's administrator fixes for every user of a
//! machine: turning off in-app updates, keeping the activity timeline or
//! clipboard history off, and naming the self-hosted server the app trusts
//! without asking.
//!
//! macOS reads the app's preference domain through a configuration profile
//! or the machine-wide preferences file; Windows reads
//! `Software\Policies\stella\Desktop` under `HKLM`, then `HKCU` for the
//! switches that only turn features off. The server, which grants trust, is
//! read from `HKLM` alone. A process running as the user can write neither
//! source, so it cannot pre-approve a server. The policy is read once at
//! launch; a change applies on the next launch.

use std::{collections::HashSet, sync::OnceLock};

use crate::config;
use crate::feature_gate::DesktopFeature;

pub const DISABLE_UPDATES: &str = "DisableUpdates";
pub const DISABLE_ACTIVITY: &str = "DisableActivity";
pub const DISABLE_CLIPBOARD: &str = "DisableClipboard";
pub const SERVER_WEB_ORIGIN: &str = "ServerWebOrigin";
pub const SERVER_API_URL: &str = "ServerApiURL";

#[cfg(all(target_os = "windows", debug_assertions))]
const WINDOWS_POLICY_KEY: &str = r"Software\Policies\stella\Desktop Development";
#[cfg(all(target_os = "windows", not(debug_assertions)))]
const WINDOWS_POLICY_KEY: &str = r"Software\Policies\stella\Desktop";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManagedPolicy {
  pub updates_disabled: bool,
  pub activity_disabled: bool,
  /// No clipboard history: nothing is recorded, and neither the shortcut,
  /// the tray nor a link opens its window.
  pub clipboard_disabled: bool,
  pub server: Option<ManagedServer>,
}

/// A self-hosted server trusted like the build's own: no approval prompt,
/// and the server a new connection goes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedServer {
  pub web_origin: String,
  pub api_base_url: String,
}

impl ManagedPolicy {
  /// Server-gated features that stay off whatever the server decides.
  pub fn blocked_features(&self) -> HashSet<DesktopFeature> {
    DesktopFeature::ALL
      .iter()
      .copied()
      .filter(|feature| match feature {
        DesktopFeature::ActivityTimeline => self.activity_disabled,
        DesktopFeature::TimeBilling => false,
      })
      .collect()
  }

  fn from_source(source: &impl PolicySource) -> Self {
    Self {
      updates_disabled: source.flag(DISABLE_UPDATES),
      activity_disabled: source.flag(DISABLE_ACTIVITY),
      clipboard_disabled: source.flag(DISABLE_CLIPBOARD),
      server: managed_server(source),
    }
  }
}

pub fn current() -> &'static ManagedPolicy {
  static POLICY: OnceLock<ManagedPolicy> = OnceLock::new();
  POLICY.get_or_init(|| {
    let policy = ManagedPolicy::from_source(&SystemPolicy);
    if policy != ManagedPolicy::default() {
      tracing::info!(
        updates_disabled = policy.updates_disabled,
        activity_disabled = policy.activity_disabled,
        clipboard_disabled = policy.clipboard_disabled,
        server = policy
          .server
          .as_ref()
          .map(|server| server.web_origin.as_str()),
        "managed policy applies"
      );
    }
    policy
  })
}

/// Both keys or neither: a server named by half a pair is ignored, as is one
/// the self-host normalizers reject.
fn managed_server(source: &impl PolicySource) -> Option<ManagedServer> {
  let web_origin = source.text(SERVER_WEB_ORIGIN);
  let api_base_url = source.text(SERVER_API_URL);
  let (web_origin, api_base_url) = match (web_origin, api_base_url) {
    (None, None) => return None,
    (Some(web_origin), Some(api_base_url)) => (web_origin, api_base_url),
    _ => {
      tracing::warn!(
        "managed server ignored: {SERVER_WEB_ORIGIN} and {SERVER_API_URL} must both be set"
      );
      return None;
    }
  };
  let normalized =
    config::normalize_self_host_web_origin(&web_origin).and_then(|web| {
      config::normalize_self_host_api_base_url(&api_base_url).map(|api| (web, api))
    });
  match normalized {
    Ok((web_origin, api_base_url)) => Some(ManagedServer {
      web_origin,
      api_base_url,
    }),
    Err(error) => {
      tracing::warn!(%error, "managed server ignored");
      None
    }
  }
}

trait PolicySource {
  fn flag(&self, key: &str) -> bool;
  fn text(&self, key: &str) -> Option<String>;
}

struct SystemPolicy;

#[cfg(target_os = "macos")]
impl PolicySource for SystemPolicy {
  fn flag(&self, key: &str) -> bool {
    use stella_desktop_macos::{ManagedPreference, managed_preference};
    match managed_preference(config::APP_DATA_DIR_NAME, key) {
      Some(ManagedPreference::Bool(value)) => value,
      None => false,
      Some(_) => {
        tracing::warn!(key, "managed preference ignored: expected a boolean");
        false
      }
    }
  }

  fn text(&self, key: &str) -> Option<String> {
    use stella_desktop_macos::{ManagedPreference, managed_preference};
    match managed_preference(config::APP_DATA_DIR_NAME, key)? {
      ManagedPreference::String(value) => non_empty(value),
      _ => {
        tracing::warn!(key, "managed preference ignored: expected a string");
        None
      }
    }
  }
}

#[cfg(target_os = "windows")]
impl PolicySource for SystemPolicy {
  fn flag(&self, key: &str) -> bool {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    [LOCAL_MACHINE, CURRENT_USER]
      .iter()
      .find_map(|root| {
        root
          .open(WINDOWS_POLICY_KEY)
          .and_then(|policy| policy.get_u32(key))
          .ok()
      })
      .is_some_and(|value| value != 0)
  }

  // Only the server keys are text, and they grant trust: machine policy only.
  fn text(&self, key: &str) -> Option<String> {
    windows_registry::LOCAL_MACHINE
      .open(WINDOWS_POLICY_KEY)
      .and_then(|policy| policy.get_string(key))
      .ok()
      .and_then(non_empty)
  }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl PolicySource for SystemPolicy {
  fn flag(&self, _key: &str) -> bool {
    false
  }

  fn text(&self, _key: &str) -> Option<String> {
    None
  }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn non_empty(value: String) -> Option<String> {
  let value = value.trim();
  (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
  use std::collections::HashMap;

  use super::*;

  #[derive(Default)]
  struct Fixture {
    flags: HashMap<&'static str, bool>,
    texts: HashMap<&'static str, &'static str>,
  }

  impl PolicySource for Fixture {
    fn flag(&self, key: &str) -> bool {
      self.flags.get(key).copied().unwrap_or(false)
    }

    fn text(&self, key: &str) -> Option<String> {
      self.texts.get(key).map(|value| (*value).to_string())
    }
  }

  fn server_fixture(web: &'static str, api: &'static str) -> Fixture {
    Fixture {
      texts: HashMap::from([(SERVER_WEB_ORIGIN, web), (SERVER_API_URL, api)]),
      ..Fixture::default()
    }
  }

  #[test]
  fn nothing_set_changes_nothing() {
    assert_eq!(
      ManagedPolicy::from_source(&Fixture::default()),
      ManagedPolicy::default()
    );
  }

  #[test]
  fn the_clipboard_flag_turns_off_clipboard_history_only() {
    let policy = ManagedPolicy::from_source(&Fixture {
      flags: HashMap::from([(DISABLE_CLIPBOARD, true)]),
      ..Fixture::default()
    });
    assert!(policy.clipboard_disabled);
    assert!(!policy.updates_disabled);
    assert!(policy.blocked_features().is_empty());
  }

  #[test]
  fn flags_turn_off_updates_and_the_activity_timeline_only() {
    let policy = ManagedPolicy::from_source(&Fixture {
      flags: HashMap::from([(DISABLE_UPDATES, true), (DISABLE_ACTIVITY, true)]),
      ..Fixture::default()
    });
    assert!(policy.updates_disabled);
    assert_eq!(
      policy.blocked_features(),
      HashSet::from([DesktopFeature::ActivityTimeline])
    );
  }

  #[test]
  fn a_server_is_normalized_like_an_approved_self_host() {
    let policy = ManagedPolicy::from_source(&server_fixture(
      "https://stella.firm.example/",
      "https://API.firm.example:443/",
    ));
    assert_eq!(
      policy.server,
      Some(ManagedServer {
        web_origin: "https://stella.firm.example".into(),
        api_base_url: "https://api.firm.example".into(),
      })
    );
  }

  #[test]
  fn half_a_server_or_an_insecure_one_is_ignored() {
    let half = Fixture {
      texts: HashMap::from([(SERVER_WEB_ORIGIN, "https://stella.firm.example")]),
      ..Fixture::default()
    };
    assert_eq!(ManagedPolicy::from_source(&half).server, None);
    for (web, api) in [
      ("http://stella.firm.example", "https://api.firm.example"),
      ("https://stella.firm.example", "http://api.firm.example"),
      (
        "https://stella.firm.example/app",
        "https://api.firm.example",
      ),
    ] {
      assert_eq!(
        ManagedPolicy::from_source(&server_fixture(web, api)).server,
        None,
        "{web} {api}"
      );
    }
  }
}
