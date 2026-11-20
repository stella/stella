//! What a local run's commands may not read on this computer, beyond the
//! chat folders, which the host keeps unreadable but for the run's own: the
//! desktop's own data and the member's credential stores. The harness
//! adapter re-opens, inside these, only what its own turn needs.

use std::path::{Path, PathBuf};

/// Under the home folder: sign-ins and keys of the command-line tools a
/// member may use, the stored sign-ins and sessions of their own Claude Code
/// and Codex, and the macOS keychains and browser profiles. Full auto, the
/// one mode whose sandbox limits reads, runs on macOS.
const HOME_CREDENTIAL_STORES: &[&str] = &[
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".docker",
  ".kube",
  ".netrc",
  ".git-credentials",
  ".claude.json",
  ".claude/.credentials.json",
  ".claude/projects",
  ".codex/auth.json",
  ".codex/sessions",
  ".codex/archived_sessions",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Safari",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/Firefox",
];

/// The paths a run may not read: `app_data`, the desktop's own data, and
/// the credential stores under `home`, when there is one.
pub(super) fn unreadable_paths(app_data: &Path, home: Option<&Path>) -> Vec<PathBuf> {
  std::iter::once(app_data.to_path_buf())
    .chain(home.into_iter().flat_map(|home| {
      HOME_CREDENTIAL_STORES.iter().map(move |store| {
        store
          .split('/')
          .fold(home.to_path_buf(), |path, part| path.join(part))
      })
    }))
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_app_data_and_the_home_credential_stores_are_unreadable() {
    let home = Path::new("/Users/member");
    let data = home.join("Library/Application Support/legal.stella.desktop");
    let paths = unreadable_paths(&data, Some(home));
    assert_eq!(paths.first(), Some(&data));
    for store in [".ssh", ".aws", ".config/gh", "Library/Keychains"] {
      assert!(
        paths.contains(&home.join(store)),
        "{store} is not among the unreadable paths"
      );
    }
    assert!(paths.contains(&home.join("Library/Application Support/Google/Chrome")));
    // Every store sits under the home folder and none is the home itself.
    assert!(
      paths[1..]
        .iter()
        .all(|path| path.starts_with(home) && path != home)
    );
  }

  #[test]
  fn without_a_home_folder_only_the_app_data_is_unreadable() {
    let data = Path::new("/data/legal.stella.desktop");
    assert_eq!(unreadable_paths(data, None), vec![data.to_path_buf()]);
  }
}
