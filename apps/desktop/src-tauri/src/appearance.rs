//! Whether stella draws light, dark or as the system does: a preference of
//! this computer, owned here. The file below is the one source of truth.
//! Windows keep a copy in their shared web storage only so the pre-paint
//! script can draw the first frame in the right scheme before it can ask
//! (`src/shared/desktop-appearance.ts`); each window reconciles that copy
//! with `get_desktop_appearance` on start and with the change event after.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, Theme};

use crate::device_preference::DevicePreference;

/// The saved appearance as one word. Absent means "follow the system", which
/// is also what an unreadable or unrecognised file means.
const APPEARANCE_FILE_NAME: &str = "appearance";

/// Every window hears this when the appearance changes, so open windows
/// switch together.
pub const APPEARANCE_CHANGED_EVENT: &str = "desktop-appearance-changed";

/// The variants are the TypeScript `DESKTOP_APPEARANCES`, in order; a test
/// there reads them from this declaration.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Appearance {
  #[default]
  System,
  Light,
  Dark,
}

impl Appearance {
  #[cfg(test)]
  const ALL: [Self; 3] = [Self::System, Self::Light, Self::Dark];

  /// The stored word, which is also the IPC value serde writes.
  const fn stored(self) -> &'static str {
    match self {
      Self::System => "system",
      Self::Light => "light",
      Self::Dark => "dark",
    }
  }

  fn from_stored(value: &str) -> Option<Self> {
    match value {
      "system" => Some(Self::System),
      "light" => Some(Self::Light),
      "dark" => Some(Self::Dark),
      _ => None,
    }
  }

  /// The theme windows are held to; `None` leaves them following the system.
  pub const fn theme(self) -> Option<Theme> {
    match self {
      Self::System => None,
      Self::Light => Some(Theme::Light),
      Self::Dark => Some(Theme::Dark),
    }
  }
}

#[derive(Clone, Serialize)]
struct AppearanceChanged {
  appearance: Appearance,
}

fn preference() -> DevicePreference {
  DevicePreference::in_app_data(APPEARANCE_FILE_NAME)
}

fn read_from(preference: &DevicePreference) -> Appearance {
  match preference.read_stored() {
    Ok(None) => Appearance::System,
    Ok(Some(stored)) => Appearance::from_stored(&stored).unwrap_or_else(|| {
      tracing::warn!("the saved appearance is not one this build knows");
      Appearance::System
    }),
    Err(error) => {
      crate::logging::log_cause(&error, "the saved appearance could not be read");
      Appearance::System
    }
  }
}

/// The appearance saved on this computer.
pub fn saved() -> Appearance {
  read_from(&preference())
}

/// Holds the title bars, native materials and each page's
/// `prefers-color-scheme` to `appearance`. It is app-wide, so windows built
/// later open in it too.
pub fn apply<R: Runtime>(app: &AppHandle<R>, appearance: Appearance) {
  app.set_theme(appearance.theme());
}

#[tauri::command]
pub fn get_desktop_appearance() -> Appearance {
  saved()
}

/// Saves `appearance`, then applies it and tells every window. Saved first,
/// so a choice the disk refused is never shown as made.
#[tauri::command]
pub fn set_desktop_appearance(
  appearance: Appearance,
  app: AppHandle,
) -> Result<Appearance, String> {
  preference().write(appearance.stored())?;
  apply(&app, appearance);
  crate::logging::best_effort(
    app.emit(APPEARANCE_CHANGED_EVENT, AppearanceChanged { appearance }),
    "appearance change was not announced",
  );
  Ok(appearance)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_preference() -> (DevicePreference, std::path::PathBuf) {
    let directory =
      std::env::temp_dir().join(format!("stella-appearance-{}", uuid::Uuid::new_v4()));
    (
      DevicePreference::at(directory.join(APPEARANCE_FILE_NAME)),
      directory,
    )
  }

  #[test]
  fn the_stored_word_is_the_ipc_value_and_reads_back() {
    for appearance in Appearance::ALL {
      let ipc = serde_json::to_value(appearance).unwrap();
      assert_eq!(ipc, serde_json::Value::String(appearance.stored().into()));
      assert_eq!(
        serde_json::from_value::<Appearance>(ipc).unwrap(),
        appearance
      );
      assert_eq!(
        Appearance::from_stored(appearance.stored()),
        Some(appearance)
      );
    }
    assert!(serde_json::from_value::<Appearance>(serde_json::json!("sepia")).is_err());
    assert!(serde_json::from_value::<Appearance>(serde_json::json!("Dark")).is_err());
  }

  #[test]
  fn a_saved_appearance_survives_a_new_handle() {
    let (preference, directory) = temp_preference();
    for appearance in Appearance::ALL {
      preference.write(appearance.stored()).unwrap();
      assert_eq!(
        read_from(&DevicePreference::at(directory.join(APPEARANCE_FILE_NAME))),
        appearance
      );
    }
    std::fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn nothing_saved_or_an_unknown_word_follows_the_system() {
    let (preference, directory) = temp_preference();
    assert_eq!(read_from(&preference), Appearance::System);

    preference.write("sepia").unwrap();
    assert_eq!(read_from(&preference), Appearance::System);

    std::fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn an_unreadable_preference_follows_the_system() {
    let (preference, directory) = temp_preference();
    crate::local_store::create_private_dir(&directory.join(APPEARANCE_FILE_NAME))
      .unwrap();
    assert_eq!(read_from(&preference), Appearance::System);
    std::fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn only_a_chosen_scheme_holds_the_windows_to_it() {
    assert_eq!(Appearance::System.theme(), None);
    assert_eq!(Appearance::Light.theme(), Some(Theme::Light));
    assert_eq!(Appearance::Dark.theme(), Some(Theme::Dark));
  }
}
