//! Dictation settings for one app, or one kind of app, over the speaker's
//! global ones: whether AI cleanup runs and which language is expected.
//! The app focused at the press decides: an entry for that app first, then
//! one for its kind (`dictation_context::AppKind`), then the global setting,
//! each setting on its own. The list is a device preference on this
//! computer; apps are named by bundle identifier (macOS) or executable
//! (Windows), as the focused-app lookup reads them.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine apply these")
)]

use serde::{Deserialize, Serialize};

use crate::{
  dictation_context::AppKind, dictation_language::Choice, foreground_app::AppExclusion,
};

pub const PREFERENCE_FILE_NAME: &str = "dictation-app-settings";
/// More entries than this is not a list anyone reads.
pub const MAX_ENTRIES: usize = 50;
/// Apps dictated into since stella started, offered for a new entry.
pub const MAX_RECENT_APPS: usize = 8;

/// What an entry applies to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Target {
  /// One app; the identifier is lowercased.
  App { identifier: String, name: String },
  /// Every app of a kind that has no entry of its own.
  Kind { kind: AppKind },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cleanup {
  On,
  Off,
}

/// One entry; a setting left `None` follows the kind's entry, then the
/// global setting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSetting {
  pub target: Target,
  pub cleanup: Option<Cleanup>,
  /// `auto` or a language the speech model lists.
  pub language: Option<String>,
}

/// An app dictated into since stella started, kept only in memory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentApp {
  pub identifier: String,
  pub name: String,
  pub kind: AppKind,
}

/// The settings a dictation into one app runs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
  pub cleanup: bool,
  pub language: Choice,
}

/// The settings for the app with `identifier`, over the global `cleanup`
/// and `language`.
pub fn apply(
  entries: &[AppSetting],
  identifier: Option<&str>,
  cleanup: bool,
  language: &Choice,
) -> Applied {
  let identifier = identifier.map(|value| value.trim().to_lowercase());
  let app_kind = AppKind::of(identifier.as_deref());
  let for_app = identifier.as_deref().and_then(|identifier| {
    entries.iter().find(|entry| {
      matches!(&entry.target, Target::App { identifier: listed, .. } if listed == identifier)
    })
  });
  let for_kind = entries
    .iter()
    .find(|entry| entry.target == Target::Kind { kind: app_kind });
  let cleanup = for_app
    .and_then(|entry| entry.cleanup)
    .or_else(|| for_kind.and_then(|entry| entry.cleanup))
    .map_or(cleanup, |choice| choice == Cleanup::On);
  let language = for_app
    .and_then(|entry| entry.language.as_deref())
    .or_else(|| for_kind.and_then(|entry| entry.language.as_deref()))
    .map_or_else(|| language.clone(), |stored| Choice::parse(Some(stored)));
  Applied { cleanup, language }
}

/// The entries as stored: refused whole when one names an invalid app or a
/// language the speech model does not list, when two name the same app or
/// kind, or when there are too many.
pub fn validated(entries: Vec<AppSetting>) -> Result<Vec<AppSetting>, String> {
  if entries.len() > MAX_ENTRIES {
    return Err(format!(
      "at most {MAX_ENTRIES} apps can have their own settings"
    ));
  }
  let mut valid: Vec<AppSetting> = Vec::with_capacity(entries.len());
  for entry in entries {
    let target = match entry.target {
      Target::App { identifier, name } => {
        let app = AppExclusion::new(&identifier, &name)
          .ok_or_else(|| "this app cannot have its own settings".to_string())?;
        Target::App {
          identifier: app.identifier,
          name: app.name,
        }
      }
      Target::Kind { kind } => Target::Kind { kind },
    };
    if let Some(language) = entry.language.as_deref()
      && Choice::parse(Some(language)).stored() != language
    {
      return Err("this language is not available for dictation".to_string());
    }
    if valid.iter().any(|listed| listed.target == target) {
      return Err("an app or kind of app is listed twice".to_string());
    }
    valid.push(AppSetting { target, ..entry });
  }
  Ok(valid)
}

/// The stored entries; a preference that no longer reads as a valid list is
/// dropped with a warning, and dictation follows the global settings.
pub fn parse(stored: Option<&str>) -> Vec<AppSetting> {
  let Some(stored) = stored else {
    return Vec::new();
  };
  match serde_json::from_str::<Vec<AppSetting>>(stored)
    .map_err(|error| error.to_string())
    .and_then(validated)
  {
    Ok(entries) => entries,
    Err(error) => {
      tracing::warn!(%error, "dictation app settings were not read");
      Vec::new()
    }
  }
}

/// Puts the app dictated into first among the recent ones; whether the
/// list changed.
pub fn note_recent(recent: &mut Vec<RecentApp>, identifier: &str, name: &str) -> bool {
  let Some(app) = AppExclusion::new(identifier, name) else {
    return false;
  };
  if recent
    .first()
    .is_some_and(|first| first.identifier == app.identifier && first.name == app.name)
  {
    return false;
  }
  recent.retain(|listed| listed.identifier != app.identifier);
  recent.insert(
    0,
    RecentApp {
      kind: AppKind::of(Some(&app.identifier)),
      identifier: app.identifier,
      name: app.name,
    },
  );
  recent.truncate(MAX_RECENT_APPS);
  true
}

#[cfg(test)]
mod tests {
  use super::*;

  fn app(
    identifier: &str,
    cleanup: Option<Cleanup>,
    language: Option<&str>,
  ) -> AppSetting {
    AppSetting {
      target: Target::App {
        identifier: identifier.to_string(),
        name: "App".to_string(),
      },
      cleanup,
      language: language.map(str::to_string),
    }
  }

  fn kind(
    kind: AppKind,
    cleanup: Option<Cleanup>,
    language: Option<&str>,
  ) -> AppSetting {
    AppSetting {
      target: Target::Kind { kind },
      cleanup,
      language: language.map(str::to_string),
    }
  }

  #[test]
  fn without_entries_the_global_settings_apply() {
    let applied = apply(&[], Some("com.apple.mail"), true, &Choice::Automatic);
    assert_eq!(
      applied,
      Applied {
        cleanup: true,
        language: Choice::Automatic
      }
    );
  }

  #[test]
  fn the_app_entry_wins_over_its_kind_setting_by_setting() {
    let entries = [
      kind(AppKind::Email, Some(Cleanup::Off), Some("de")),
      app("com.apple.mail", None, Some("cs")),
    ];
    // Identifiers compare however the lookup cases them.
    let mail = apply(&entries, Some("com.apple.Mail"), true, &Choice::Automatic);
    assert_eq!(
      mail,
      Applied {
        cleanup: false,
        language: Choice::Language("cs")
      }
    );
    let outlook = apply(&entries, Some("outlook.exe"), true, &Choice::Automatic);
    assert_eq!(
      outlook,
      Applied {
        cleanup: false,
        language: Choice::Language("de")
      }
    );
    let word = apply(&entries, Some("winword.exe"), true, &Choice::Language("sk"));
    assert_eq!(
      word,
      Applied {
        cleanup: true,
        language: Choice::Language("sk")
      }
    );
  }

  #[test]
  fn an_unread_app_takes_the_entry_for_other_apps() {
    let entries = [kind(AppKind::Other, Some(Cleanup::Off), None)];
    assert!(!apply(&entries, None, true, &Choice::Automatic).cleanup);
    assert!(apply(&entries, Some("com.apple.mail"), true, &Choice::Automatic).cleanup);
  }

  #[test]
  fn an_entry_may_switch_cleanup_on_and_the_language_back_to_automatic() {
    let entries = [app("code.exe", Some(Cleanup::On), Some("auto"))];
    assert_eq!(
      apply(&entries, Some("Code.exe"), false, &Choice::Language("cs")),
      Applied {
        cleanup: true,
        language: Choice::Automatic
      }
    );
  }

  #[test]
  fn validation_lowercases_apps_and_refuses_what_could_never_apply() {
    let valid = validated(vec![app(" Com.Apple.Mail ", None, Some("cs"))]).unwrap();
    assert_eq!(
      valid[0].target,
      Target::App {
        identifier: "com.apple.mail".to_string(),
        name: "App".to_string()
      }
    );
    assert!(validated(vec![app("com.apple.mail", None, Some("xx"))]).is_err());
    assert!(validated(vec![app("", None, None)]).is_err());
    assert!(
      validated(vec![
        app("com.apple.mail", None, None),
        app("COM.APPLE.MAIL", Some(Cleanup::Off), None),
      ])
      .is_err()
    );
    assert!(
      validated(vec![
        kind(AppKind::Chat, None, None),
        kind(AppKind::Chat, None, None)
      ])
      .is_err()
    );
    let many = (0..=MAX_ENTRIES)
      .map(|index| app(&format!("app{index}.exe"), None, None))
      .collect();
    assert!(validated(many).is_err());
  }

  #[test]
  fn the_stored_list_reads_back_and_an_unreadable_one_is_dropped() {
    let entries = vec![
      kind(AppKind::Code, Some(Cleanup::Off), None),
      app("com.apple.mail", None, Some("en")),
    ];
    let stored = serde_json::to_string(&entries).unwrap();
    assert_eq!(parse(Some(&stored)), entries);
    assert_eq!(
      serde_json::to_value(&entries[0]).unwrap(),
      serde_json::json!({
        "target": { "type": "kind", "kind": "code" },
        "cleanup": "off",
        "language": null
      })
    );
    assert!(parse(Some("not json")).is_empty());
    assert!(parse(None).is_empty());
  }

  #[test]
  fn recent_apps_keep_the_latest_first_without_repeats() {
    let mut recent = Vec::new();
    for index in 0..MAX_RECENT_APPS {
      note_recent(&mut recent, &format!("app{index}.exe"), "App");
    }
    assert!(note_recent(&mut recent, "App3.exe", "App"));
    assert!(!note_recent(&mut recent, "app3.exe", "App"));
    assert_eq!(recent.len(), MAX_RECENT_APPS);
    assert_eq!(recent[0].identifier, "app3.exe");
    note_recent(&mut recent, "com.apple.mail", "Mail");
    assert_eq!(recent.len(), MAX_RECENT_APPS);
    assert_eq!(recent[0].kind, AppKind::Email);
    assert!(recent.iter().all(|listed| listed.identifier != "app0.exe"));
    assert!(!note_recent(&mut recent, "", "Nameless"));
    assert_eq!(recent[0].identifier, "com.apple.mail");
  }
}
