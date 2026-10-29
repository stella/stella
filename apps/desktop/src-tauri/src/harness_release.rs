//! The agent CLI releases this desktop build installs.
//!
//! `harness/pins.json` names the versions. `scripts/generate-harness-releases.ts`
//! reads the upstream metadata for them and writes `harness/releases.gen.json`:
//! URL, digest, byte size, target triple and executable path per platform.
//! Neither file is edited by hand; the tests below bind the table to the pins.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

const RELEASES: &str = include_str!("../harness/releases.gen.json");

/// An agent CLI that the desktop installs and runs from its own directory.
#[derive(
  Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
pub enum ManagedHarness {
  #[serde(rename = "codex")]
  Codex,
  #[serde(rename = "claude-code")]
  ClaudeCode,
}

impl ManagedHarness {
  pub const ALL: [Self; 2] = [Self::Codex, Self::ClaudeCode];

  /// The directory name and wire identifier.
  pub const fn id(self) -> &'static str {
    match self {
      Self::Codex => "codex",
      Self::ClaudeCode => "claude-code",
    }
  }

  /// The variable that points the CLI at its Stella-owned configuration
  /// directory, so it never reads or writes the user's own one.
  pub const fn config_env(self) -> &'static str {
    match self {
      Self::Codex => "CODEX_HOME",
      Self::ClaudeCode => "CLAUDE_CONFIG_DIR",
    }
  }

  /// Variables that keep the version probe offline and free of side effects.
  pub(crate) const fn probe_env(self) -> &'static [(&'static str, &'static str)] {
    match self {
      Self::Codex => &[],
      Self::ClaudeCode => &[
        ("DISABLE_AUTOUPDATER", "1"),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
      ],
    }
  }

  /// Whether `--version` output names exactly `version`.
  pub(crate) fn reports_version(self, output: &str, version: &str) -> bool {
    let output = output.trim();
    match self {
      Self::Codex => output.strip_prefix("codex-cli ") == Some(version),
      Self::ClaudeCode => output.strip_suffix(" (Claude Code)") == Some(version),
    }
  }
}

/// The archive digest, lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveDigest {
  Sha256(String),
  Sha512(String),
}

/// One downloadable archive of a release.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAsset {
  pub url: String,
  pub digest: ArchiveDigest,
  pub archive_bytes: u64,
  pub target: String,
  /// The executable's path inside the unpacked archive, `/`-separated.
  pub executable: String,
}

/// What one harness installs on this platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessRelease {
  /// The version the CLI reports and the directory it is installed under.
  pub version: String,
  pub asset: ReleaseAsset,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlatformAssets {
  #[serde(rename = "darwin-arm64")]
  darwin_arm64: ReleaseAsset,
  #[serde(rename = "darwin-x64")]
  darwin_x64: ReleaseAsset,
  #[serde(rename = "win32-arm64")]
  win32_arm64: ReleaseAsset,
  #[serde(rename = "win32-x64")]
  win32_x64: ReleaseAsset,
}

impl PlatformAssets {
  fn current(self) -> Option<ReleaseAsset> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
      Some(self.darwin_arm64)
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
      Some(self.darwin_x64)
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
      Some(self.win32_arm64)
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
      Some(self.win32_x64)
    } else {
      None
    }
  }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TableRelease {
  version: String,
  assets: PlatformAssets,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Harnesses {
  codex: TableRelease,
  #[serde(rename = "claude-code")]
  claude_code: TableRelease,
}

/// The table also repeats the pins it was generated from; only the tests
/// read them, to bind the table to `pins.json`.
#[derive(Deserialize)]
struct Table {
  harnesses: Harnesses,
}

fn table() -> Table {
  serde_json::from_str(RELEASES).expect("the committed harness release table is valid")
}

/// The releases for the platform this build runs on. A harness is absent on
/// a platform its vendor publishes no build for.
#[derive(Debug, Clone)]
pub struct HarnessReleases {
  pub codex: Option<HarnessRelease>,
  pub claude_code: Option<HarnessRelease>,
}

impl HarnessReleases {
  pub fn pinned() -> Self {
    let Harnesses { codex, claude_code } = table().harnesses;
    let release = |TableRelease { version, assets }: TableRelease| {
      assets
        .current()
        .map(|asset| HarnessRelease { version, asset })
    };
    Self {
      codex: release(codex),
      claude_code: release(claude_code),
    }
  }

  pub fn get(&self, harness: ManagedHarness) -> Option<&HarnessRelease> {
    match harness {
      ManagedHarness::Codex => self.codex.as_ref(),
      ManagedHarness::ClaudeCode => self.claude_code.as_ref(),
    }
  }
}

/// A release version usable as a directory name: `MAJOR.MINOR.PATCH` with an
/// optional `-prerelease` of ASCII letters, digits, dots and hyphens.
pub(crate) fn is_release_version(version: &str) -> bool {
  let (core, prerelease) = match version.split_once('-') {
    Some((core, prerelease)) => (core, Some(prerelease)),
    None => (version, None),
  };
  let numeric = core.split('.').collect::<Vec<_>>();
  version.len() <= 64
    && numeric.len() == 3
    && numeric
      .iter()
      .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    && prerelease.is_none_or(|prerelease| {
      !prerelease.is_empty()
        && prerelease
          .bytes()
          .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    })
}

/// A `/`-separated path that stays inside the directory it is joined to.
pub(crate) fn is_contained_relative(path: &str) -> bool {
  !path.is_empty()
    && !path.contains('\\')
    && !path.contains(':')
    && path
      .split('/')
      .all(|part| !part.is_empty() && part != "." && part != "..")
    && Path::new(path)
      .components()
      .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
  use super::*;

  const PINS: &str = include_str!("../harness/pins.json");

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase", deny_unknown_fields)]
  struct Pins {
    codex: String,
    claude_agent_sdk: String,
  }

  #[derive(Deserialize)]
  #[serde(deny_unknown_fields)]
  struct PinnedTable {
    pins: Pins,
    harnesses: Harnesses,
  }

  fn assets(release: TableRelease) -> [(&'static str, ReleaseAsset); 4] {
    let PlatformAssets {
      darwin_arm64,
      darwin_x64,
      win32_arm64,
      win32_x64,
    } = release.assets;
    [
      ("darwin-arm64", darwin_arm64),
      ("darwin-x64", darwin_x64),
      ("win32-arm64", win32_arm64),
      ("win32-x64", win32_x64),
    ]
  }

  const TARGETS: [(&str, &str); 4] = [
    ("darwin-arm64", "aarch64-apple-darwin"),
    ("darwin-x64", "x86_64-apple-darwin"),
    ("win32-arm64", "aarch64-pc-windows-msvc"),
    ("win32-x64", "x86_64-pc-windows-msvc"),
  ];

  fn target(platform: &str) -> &'static str {
    TARGETS
      .iter()
      .find(|(name, _)| *name == platform)
      .map(|(_, target)| *target)
      .unwrap()
  }

  fn is_hex(value: &str, len: usize) -> bool {
    value.len() == len
      && value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
  }

  #[test]
  fn the_release_table_was_generated_from_the_committed_pins() {
    let pins: Pins = serde_json::from_str(PINS).unwrap();
    let PinnedTable {
      pins: table_pins,
      harnesses: Harnesses { codex, claude_code },
    } = serde_json::from_str(RELEASES).unwrap();
    assert_eq!(table_pins.codex, pins.codex);
    assert_eq!(table_pins.claude_agent_sdk, pins.claude_agent_sdk);
    assert!(is_release_version(&pins.codex));
    assert!(is_release_version(&pins.claude_agent_sdk));

    assert_eq!(codex.version, pins.codex);
    let downloads = format!(
      "https://github.com/openai/codex/releases/download/rust-v{}/",
      pins.codex
    );
    for (platform, asset) in assets(codex) {
      let exe = if platform.starts_with("win32") {
        ".exe"
      } else {
        ""
      };
      assert_eq!(asset.target, target(platform));
      assert_eq!(
        asset.url,
        format!("{downloads}codex-package-{}.tar.gz", target(platform))
      );
      assert!(matches!(&asset.digest, ArchiveDigest::Sha256(hex) if is_hex(hex, 64)));
      assert!(asset.archive_bytes > 0);
      assert_eq!(asset.executable, format!("bin/codex{exe}"));
    }

    assert!(is_release_version(&claude_code.version));
    for (platform, asset) in assets(claude_code) {
      let exe = if platform.starts_with("win32") {
        ".exe"
      } else {
        ""
      };
      let package = format!("claude-agent-sdk-{platform}");
      assert_eq!(asset.target, target(platform));
      assert_eq!(
        asset.url,
        format!(
          "https://registry.npmjs.org/@anthropic-ai/{package}/-/{package}-{}.tgz",
          pins.claude_agent_sdk
        )
      );
      assert!(matches!(&asset.digest, ArchiveDigest::Sha512(hex) if is_hex(hex, 128)));
      assert!(asset.archive_bytes > 0);
      assert_eq!(asset.executable, format!("package/claude{exe}"));
    }
  }

  #[test]
  fn every_shipped_platform_has_both_harnesses() {
    let releases = HarnessReleases::pinned();
    let shipped = cfg!(any(target_os = "macos", target_os = "windows"));
    for harness in ManagedHarness::ALL {
      let release = releases.get(harness);
      assert_eq!(release.is_some(), shipped, "{}", harness.id());
      if let Some(release) = release {
        assert!(is_contained_relative(&release.asset.executable));
      }
    }
  }

  #[test]
  fn probes_accept_only_the_exact_version_line() {
    assert!(ManagedHarness::Codex.reports_version("codex-cli 0.164.0\n", "0.164.0"));
    assert!(!ManagedHarness::Codex.reports_version("codex-cli 0.164.1", "0.164.0"));
    assert!(!ManagedHarness::Codex.reports_version("0.164.0", "0.164.0"));
    assert!(
      ManagedHarness::ClaudeCode.reports_version("2.1.309 (Claude Code)\n", "2.1.309")
    );
    assert!(!ManagedHarness::ClaudeCode.reports_version("2.1.309", "2.1.309"));
    assert!(
      !ManagedHarness::ClaudeCode.reports_version("12.1.309 (Claude Code)", "2.1.309")
    );
  }

  #[test]
  fn versions_and_relative_paths_cannot_leave_their_directory() {
    for valid in ["0.164.0", "2.1.309", "1.0.0-alpha.1"] {
      assert!(is_release_version(valid), "{valid}");
    }
    for invalid in [
      "",
      "..",
      "1.0",
      "1.0.0.0",
      "../1.0.0",
      "1.0.0/..",
      "1.0.0-",
      "1.0.0-a/b",
      "v1.0.0",
      "1.0.0 ",
    ] {
      assert!(!is_release_version(invalid), "{invalid}");
    }
    for valid in ["bin/codex", "package/claude.exe"] {
      assert!(is_contained_relative(valid), "{valid}");
    }
    for invalid in [
      "",
      "/bin/codex",
      "../codex",
      "bin/../codex",
      "bin//codex",
      "./bin/codex",
      "bin\\codex",
      "C:/codex",
      "bin/",
    ] {
      assert!(!is_contained_relative(invalid), "{invalid}");
    }
  }
}
