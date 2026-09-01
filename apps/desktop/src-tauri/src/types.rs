use serde::{Deserialize, Serialize};

pub const DEFAULT_BRIDGE_PORT: u16 = 45_901;
pub const DOCX_MIME_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
pub const XLSX_MIME_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
pub const PPTX_MIME_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

macro_rules! define_desktop_edit_file_types {
  ($($variant:ident => $wire_name:literal),+ $(,)?) => {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[cfg_attr(test, derive(ts_rs::TS))]
    pub enum DesktopEditFileType {
      $(
        #[serde(rename = $wire_name)]
        $variant,
      )+
    }

    #[cfg(test)]
    impl DesktopEditFileType {
      pub const ALL: &[Self] = &[$(Self::$variant),+];

      pub const fn wire_name(self) -> &'static str {
        match self {
          $(Self::$variant => $wire_name),+
        }
      }
    }
  };
}

define_desktop_edit_file_types!(
  Docx => "docx",
  Xlsx => "xlsx",
  Pptx => "pptx",
);

impl DesktopEditFileType {
  pub const fn mime_type(self) -> &'static str {
    match self {
      Self::Docx => DOCX_MIME_TYPE,
      Self::Xlsx => XLSX_MIME_TYPE,
      Self::Pptx => PPTX_MIME_TYPE,
    }
  }

  pub const fn extension(self) -> &'static str {
    match self {
      Self::Docx => ".docx",
      Self::Xlsx => ".xlsx",
      Self::Pptx => ".pptx",
    }
  }

  pub const fn default_file_name(self) -> &'static str {
    match self {
      Self::Docx => "document.docx",
      Self::Xlsx => "workbook.xlsx",
      Self::Pptx => "presentation.pptx",
    }
  }

  pub const fn main_part_path(self) -> &'static str {
    match self {
      Self::Docx => "word/document.xml",
      Self::Xlsx => "xl/workbook.xml",
      Self::Pptx => "ppt/presentation.xml",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
  Opening,
  Ready,
  Syncing,
  Finalizing,
  Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
  #[cfg_attr(test, ts(type = "number"))]
  pub base_version_number: i64,
  pub entity_id: String,
  pub file_type: DesktopEditFileType,
  pub file_name: String,
  pub file_path: String,
  pub id: String,
  pub last_error: Option<String>,
  pub last_checkpoint_at: Option<String>,
  pub pending_finalize: bool,
  pub property_id: String,
  pub status: SessionStatus,
  pub takeover_detected: bool,
  pub workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationPreferences {
  pub document_ready: bool,
  pub revision_created: bool,
  pub sync_issues: bool,
}

impl Default for DesktopNotificationPreferences {
  fn default() -> Self {
    Self {
      document_ready: true,
      revision_created: true,
      sync_issues: true,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LinkedAccountSnapshot {
  pub email: String,
  pub name: Option<String>,
  pub verified_at: String,
}

const MAX_LINKED_ACCOUNT_EMAIL_LENGTH: usize = 320;
const MAX_LINKED_ACCOUNT_NAME_LENGTH: usize = 256;

pub fn is_valid_linked_account(account: &LinkedAccountSnapshot) -> bool {
  let email = account.email.trim();
  if email.is_empty()
    || email.len() > MAX_LINKED_ACCOUNT_EMAIL_LENGTH
    || !email.contains('@')
    || email.chars().any(char::is_control)
  {
    return false;
  }

  if account.name.as_ref().is_some_and(|name| {
    name.len() > MAX_LINKED_ACCOUNT_NAME_LENGTH || name.chars().any(char::is_control)
  }) {
    return false;
  }

  chrono::DateTime::parse_from_rfc3339(&account.verified_at).is_ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct LinkAccountRequest {
  pub api_base_url: String,
  pub linked_account: LinkedAccountSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenFileRemoteSession {
  #[cfg_attr(test, ts(type = "number"))]
  pub base_version_number: i64,
  pub download_url: String,
  pub file_type: DesktopEditFileType,
  pub file_name: String,
  pub last_checkpoint_at: Option<String>,
  pub resumed_from_checkpoint: bool,
  pub session_id: String,
  pub session_token: String,
  pub took_over_existing_session: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum DesktopUpdateStatus {
  Idle,
  Checking,
  Available,
  Downloading,
  Ready,
  Applying,
  UpToDate,
  Error,
  Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateSnapshot {
  pub base_url: Option<String>,
  pub channel: Option<String>,
  pub current_hash: Option<String>,
  pub current_version: Option<String>,
  pub last_checked_at: Option<String>,
  pub latest_hash: Option<String>,
  pub latest_version: Option<String>,
  pub status: DesktopUpdateStatus,
  pub status_message: String,
  pub update_available: bool,
  pub update_ready: bool,
}

impl Default for DesktopUpdateSnapshot {
  fn default() -> Self {
    Self {
      base_url: None,
      channel: None,
      current_hash: None,
      // Stamp the build's own version so the Settings panel shows
      // it immediately, before any updater check populates the
      // remote-version fields. Without this, the UI falls back to
      // the "Preview build" / "Development build" label.
      current_version: Some(env!("CARGO_PKG_VERSION").to_string()),
      last_checked_at: None,
      latest_hash: None,
      latest_version: None,
      status: DesktopUpdateStatus::Disabled,
      status_message: "Updates will appear here once configured.".to_string(),
      update_available: false,
      update_ready: false,
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TrustedSelfHostConnection {
  pub api_base_url: String,
  pub trusted_at: String,
  pub web_origin: String,
}

/// Monotonic bridge contract revision. Increment whenever the bridge
/// surface changes so the web app can require a minimum revision without
/// coupling to the desktop's literal app version.
pub const BRIDGE_VERSION: u32 = 12;

/// Versioned contracts advertised to the web app. A client requires the
/// capability it uses; breaking semantics receive a new capability id.
pub const BRIDGE_CAPABILITIES: &[&str] =
  &["office-edit.v1", "self-host.connect", "account-link.v1"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
  pub bridge_port: u16,
  /// See [`BRIDGE_VERSION`].
  pub bridge_version: u32,
  /// See [`BRIDGE_CAPABILITIES`].
  pub capabilities: Vec<String>,
  pub linked_account: Option<LinkedAccountSnapshot>,
  pub notification_preferences: DesktopNotificationPreferences,
  pub running_since: String,
  pub sessions: Vec<SessionSnapshot>,
  pub trusted_self_host_connections: Vec<TrustedSelfHostConnection>,
  pub update: DesktopUpdateSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenFileRequest {
  pub api_base_url: String,
  pub entity_id: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub handoff_id: Option<String>,
  pub linked_account: Option<LinkedAccountSnapshot>,
  pub property_id: String,
  pub remote_session: OpenFileRemoteSession,
  pub workspace_id: String,
}

/// Server-issued session identifiers are UUIDs. Locking the predicate to UUID
/// shape — 8-4-4-4-12 ASCII hex, total 36 characters — keeps the rest of the
/// desktop pipeline free of platform-specific escaping concerns (Windows
/// reserved device names, trailing dot/space normalization, mixed-case
/// collisions on case-insensitive filesystems).
pub const SESSION_ID_LEN: usize = 36;
const UUID_HYPHEN_POSITIONS: &[usize] = &[8, 13, 18, 23];

pub fn is_safe_session_id(value: &str) -> bool {
  if value.len() != SESSION_ID_LEN {
    return false;
  }
  for (idx, ch) in value.char_indices() {
    let must_be_hyphen = UUID_HYPHEN_POSITIONS.contains(&idx);
    if must_be_hyphen {
      if ch != '-' {
        return false;
      }
    } else if !ch.is_ascii_hexdigit() {
      return false;
    }
  }
  true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct OpenFileResponse {
  pub already_open: bool,
  pub file_path: String,
  pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResponse {
  pub checkpointed_at: String,
  // Serde surface: mirrors the server checkpoint contract; not branched on yet.
  #[allow(dead_code)]
  pub noop: bool,
  /// Present when the server rotates the session token on a non-noop checkpoint.
  pub rotated_session_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum FinalizeResponse {
  #[serde(rename_all = "camelCase")]
  Finalized {
    // Serde surface: mirrors the server finalize contract; not branched on yet.
    #[allow(dead_code)]
    entity_id: String,
    version_number: i64,
  },
  NoChanges,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorResponse {
  pub code: Option<String>,
  pub message: Option<String>,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn shared_desktop_edit_file_contract_matches_rust() {
    let source =
      include_str!("../../../../packages/api-contract/src/desktop-edit-file-types.ts");
    let list_prefix = "export const DESKTOP_EDIT_FILE_TYPES = [";
    let list_start = source
      .find(list_prefix)
      .unwrap_or_else(|| panic!("shared contract has no file type list"));
    let list = &source[list_start + list_prefix.len()..];
    let list_end = list
      .find("] as const;")
      .unwrap_or_else(|| panic!("shared contract file type list has no end"));
    let shared_file_types = list[..list_end]
      .split(',')
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(|value| {
        value
          .strip_prefix('"')
          .and_then(|value| value.strip_suffix('"'))
          .unwrap_or_else(|| panic!("invalid shared file type {value}"))
      })
      .collect::<Vec<_>>();
    let rust_file_types = DesktopEditFileType::ALL
      .iter()
      .map(|file_type| file_type.wire_name())
      .collect::<Vec<_>>();

    assert_eq!(shared_file_types, rust_file_types);

    for file_type in DesktopEditFileType::ALL {
      let key = file_type.wire_name();
      let block_start = source
        .find(&format!("  {key}: {{"))
        .unwrap_or_else(|| panic!("shared contract is missing {key}"));
      let block = &source[block_start..];
      let block_end = block
        .find("\n  },")
        .unwrap_or_else(|| panic!("shared contract has no end for {key}"));
      let block = &block[..block_end];

      assert!(block.contains(file_type.extension()));
      assert!(block.contains(file_type.mime_type()));
      assert!(block.contains(file_type.main_part_path()));
    }
  }

  // -- SessionStatus serde --

  #[test]
  fn test_session_status_serialize() {
    assert_eq!(
      serde_json::to_string(&SessionStatus::Opening).unwrap(),
      r#""opening""#
    );
    assert_eq!(
      serde_json::to_string(&SessionStatus::Ready).unwrap(),
      r#""ready""#
    );
    assert_eq!(
      serde_json::to_string(&SessionStatus::Syncing).unwrap(),
      r#""syncing""#
    );
    assert_eq!(
      serde_json::to_string(&SessionStatus::Finalizing).unwrap(),
      r#""finalizing""#
    );
    assert_eq!(
      serde_json::to_string(&SessionStatus::Error).unwrap(),
      r#""error""#
    );
  }

  #[test]
  fn test_session_status_deserialize() {
    assert_eq!(
      serde_json::from_str::<SessionStatus>(r#""opening""#).unwrap(),
      SessionStatus::Opening
    );
    assert_eq!(
      serde_json::from_str::<SessionStatus>(r#""error""#).unwrap(),
      SessionStatus::Error
    );
  }

  #[test]
  fn test_session_status_deserialize_invalid() {
    assert!(serde_json::from_str::<SessionStatus>(r#""unknown""#).is_err());
  }

  #[test]
  fn linked_account_validation_accepts_authenticated_snapshot() {
    assert!(is_valid_linked_account(&LinkedAccountSnapshot {
      email: "user@example.com".to_string(),
      name: Some("Test User".to_string()),
      verified_at: "2026-08-31T10:00:00Z".to_string(),
    }));
  }

  #[test]
  fn linked_account_validation_rejects_unbounded_or_invalid_fields() {
    let invalid_accounts = [
      LinkedAccountSnapshot {
        email: "not-an-email".to_string(),
        name: None,
        verified_at: "2026-08-31T10:00:00Z".to_string(),
      },
      LinkedAccountSnapshot {
        email: "user@example.com".to_string(),
        name: Some("x".repeat(MAX_LINKED_ACCOUNT_NAME_LENGTH + 1)),
        verified_at: "2026-08-31T10:00:00Z".to_string(),
      },
      LinkedAccountSnapshot {
        email: "user@example.com".to_string(),
        name: None,
        verified_at: "not-a-time".to_string(),
      },
    ];

    assert!(
      invalid_accounts
        .iter()
        .all(|account| !is_valid_linked_account(account))
    );
  }

  // -- AppSnapshot round-trip --

  #[test]
  fn test_app_snapshot_roundtrip() {
    let snapshot = AppSnapshot {
      bridge_port: 45_901,
      bridge_version: BRIDGE_VERSION,
      capabilities: BRIDGE_CAPABILITIES
        .iter()
        .map(|s| (*s).to_string())
        .collect(),
      linked_account: Some(LinkedAccountSnapshot {
        email: "test@test.com".into(),
        name: Some("Jane".into()),
        verified_at: "2026-01-01T00:00:00Z".into(),
      }),
      notification_preferences: DesktopNotificationPreferences::default(),
      running_since: "2026-01-01T00:00:00Z".into(),
      sessions: vec![SessionSnapshot {
        base_version_number: 3,
        entity_id: "ent-1".into(),
        file_type: DesktopEditFileType::Docx,
        file_name: "brief.docx".into(),
        file_path: "/tmp/brief.docx".into(),
        id: "sess-42".into(),
        last_error: None,
        last_checkpoint_at: Some("2026-01-01T12:00:00Z".into()),
        pending_finalize: false,
        property_id: "prop-1".into(),
        status: SessionStatus::Ready,
        takeover_detected: false,
        workspace_id: "ws-1".into(),
      }],
      trusted_self_host_connections: vec![TrustedSelfHostConnection {
        api_base_url: "https://api.selfhost.example".into(),
        trusted_at: "2026-01-01T00:00:00Z".into(),
        web_origin: "https://selfhost.example".into(),
      }],
      update: DesktopUpdateSnapshot::default(),
    };

    let json = serde_json::to_string(&snapshot).unwrap();
    let deserialized: AppSnapshot = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.bridge_port, 45_901);
    assert_eq!(deserialized.sessions.len(), 1);
    assert_eq!(deserialized.sessions[0].id, "sess-42");
    assert_eq!(deserialized.sessions[0].status, SessionStatus::Ready);
    assert_eq!(
      deserialized.linked_account.as_ref().unwrap().email,
      "test@test.com"
    );
  }

  // -- OpenFileRequest round-trip --

  #[test]
  fn test_open_file_request_roundtrip() {
    let req = OpenFileRequest {
      api_base_url: "https://api.example.com".into(),
      entity_id: "ent-1".into(),
      handoff_id: None,
      linked_account: None,
      property_id: "prop-1".into(),
      remote_session: OpenFileRemoteSession {
        base_version_number: 2,
        download_url: "https://s3.example.com/doc.docx".into(),
        file_type: DesktopEditFileType::Docx,
        file_name: "motion.docx".into(),
        last_checkpoint_at: None,
        resumed_from_checkpoint: false,
        session_id: "rs-1".into(),
        session_token: "tok-abc".into(),
        took_over_existing_session: false,
      },
      workspace_id: "ws-1".into(),
    };

    let json = serde_json::to_string(&req).unwrap();
    let deserialized: OpenFileRequest = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.entity_id, "ent-1");
    assert_eq!(deserialized.remote_session.session_id, "rs-1");
    assert_eq!(deserialized.remote_session.file_name, "motion.docx");
  }

  // -- OpenFileResponse round-trip --

  #[test]
  fn test_open_file_response_roundtrip() {
    let resp = OpenFileResponse {
      already_open: true,
      file_path: "/tmp/motion.docx".into(),
      session_id: "sess-99".into(),
    };

    let json = serde_json::to_string(&resp).unwrap();
    let deserialized: OpenFileResponse = serde_json::from_str(&json).unwrap();

    assert!(deserialized.already_open);
    assert_eq!(deserialized.session_id, "sess-99");
    assert_eq!(deserialized.file_path, "/tmp/motion.docx");
  }

  // -- session id validation --

  #[test]
  fn is_safe_session_id_accepts_lowercase_uuid() {
    assert!(is_safe_session_id("e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"));
    assert!(is_safe_session_id("00000000-0000-0000-0000-000000000000"));
  }

  #[test]
  fn is_safe_session_id_accepts_uppercase_hex() {
    assert!(is_safe_session_id("E8400E29-1D4A-4716-8A3A-2C83DE7AB2E6"));
  }

  #[test]
  fn is_safe_session_id_rejects_path_traversal_and_separators() {
    assert!(!is_safe_session_id(
      "../e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"
    ));
    assert!(!is_safe_session_id("e8400e29/1d4a/4716/8a3a/2c83de7ab2e6"));
    assert!(!is_safe_session_id("e8400e29\\1d4a-4716-8a3a-2c83de7ab2e6"));
    assert!(!is_safe_session_id(".."));
    assert!(!is_safe_session_id("a:b"));
  }

  #[test]
  fn is_safe_session_id_rejects_wrong_length_or_shape() {
    assert!(!is_safe_session_id(""));
    assert!(!is_safe_session_id("e8400e29-1d4a-4716-8a3a-2c83de7ab2e"));
    assert!(!is_safe_session_id("e8400e29-1d4a-4716-8a3a-2c83de7ab2e60"));
    assert!(!is_safe_session_id("e8400e2901d4a47168a3a2c83de7ab2e60000"));
    assert!(!is_safe_session_id("g8400e29-1d4a-4716-8a3a-2c83de7ab2e6"));
    assert!(!is_safe_session_id("e8400e29 1d4a 4716 8a3a 2c83de7ab2e6"));
  }

  // -- camelCase field naming --

  #[test]
  fn test_camel_case_field_names() {
    let resp = OpenFileResponse {
      already_open: false,
      file_path: "/tmp/a.docx".into(),
      session_id: "s1".into(),
    };
    let json = serde_json::to_string(&resp).unwrap();
    assert!(json.contains("alreadyOpen"));
    assert!(json.contains("filePath"));
    assert!(json.contains("sessionId"));
    // Ensure snake_case is NOT present
    assert!(!json.contains("already_open"));
    assert!(!json.contains("file_path"));
    assert!(!json.contains("session_id"));
  }
}

#[cfg(test)]
mod rpc_codegen_tests {
  use super::*;
  use std::any::TypeId;
  use std::collections::HashSet;
  use std::path::Path;
  use ts_rs::{Config, TS, TypeVisitor};

  const GENERATED_PATH: &str = "../../../packages/api-contract/src/desktop-rpc.gen.ts";
  const COMMITTED_BINDINGS: &str =
    include_str!("../../../../packages/api-contract/src/desktop-rpc.gen.ts");
  const GENERATED_HEADER: &str = "// Generated from apps/desktop/src-tauri/src/types.rs.\n// Regenerate from the repository root with `bun --filter @stll/desktop rpc:generate`.\n// Do not edit by hand.\n\n";

  type DesktopRpcContract = (
    AppSnapshot,
    LinkAccountRequest,
    OpenFileRequest,
    OpenFileResponse,
  );

  struct DeclarationVisitor<'a> {
    config: &'a Config,
    declarations: Vec<String>,
    seen: HashSet<TypeId>,
  }

  impl TypeVisitor for DeclarationVisitor<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
      if !self.seen.insert(TypeId::of::<T>()) {
        return;
      }

      if T::output_path().is_some() {
        self
          .declarations
          .push(use_bracket_array_syntax(T::decl(self.config)));
      }
      T::visit_dependencies(self);
      T::visit_generics(self);
    }
  }

  fn use_bracket_array_syntax(mut declaration: String) -> String {
    while let Some(start) = declaration.rfind("Array<") {
      let inner_start = start + "Array<".len();
      let mut depth = 1_u32;
      let mut end = None;
      for (offset, character) in declaration[inner_start..].char_indices() {
        match character {
          '<' => depth += 1,
          '>' => {
            depth -= 1;
            if depth == 0 {
              end = Some(inner_start + offset);
              break;
            }
          }
          _ => {}
        }
      }
      let end = end.unwrap_or_else(|| panic!("unclosed Array type in {declaration}"));
      let inner = &declaration[inner_start..end];
      let replacement = if inner.contains(" | ") || inner.contains(" & ") {
        format!("({inner})[]")
      } else {
        format!("{inner}[]")
      };
      declaration.replace_range(start..=end, &replacement);
    }
    declaration
      .lines()
      .map(str::trim_end)
      .collect::<Vec<_>>()
      .join("\n")
  }

  fn render_desktop_rpc_bindings() -> String {
    let config = Config::default();
    let mut visitor = DeclarationVisitor {
      config: &config,
      declarations: Vec::new(),
      seen: HashSet::new(),
    };
    DesktopRpcContract::visit_generics(&mut visitor);
    visitor.declarations.sort();

    let mut output = String::from(GENERATED_HEADER);
    for declaration in visitor.declarations {
      output.push_str("export ");
      output.push_str(&declaration);
      output.push_str("\n\n");
    }
    let content_end = output.trim_end().len();
    output.truncate(content_end);
    output.push('\n');
    output
  }

  #[test]
  fn generated_desktop_rpc_bindings_are_current() {
    assert_eq!(
      COMMITTED_BINDINGS,
      render_desktop_rpc_bindings(),
      "desktop RPC bindings are stale; run `bun --filter @stll/desktop rpc:generate`",
    );
  }

  #[test]
  fn generated_arrays_follow_repository_typescript_syntax() {
    assert_eq!(
      use_bracket_array_syntax("type Nested = Array<Array<string>>;".to_string()),
      "type Nested = string[][];"
    );
    assert_eq!(
      use_bracket_array_syntax("type Nullable = Array<string | null>;".to_string()),
      "type Nullable = (string | null)[];"
    );
  }

  #[test]
  #[ignore = "writes the committed TypeScript bindings"]
  fn generate_desktop_rpc_bindings() {
    std::fs::write(Path::new(GENERATED_PATH), render_desktop_rpc_bindings())
      .expect("generated desktop RPC bindings are writable");
  }
}

/// Golden-fixture compatibility checks for the generated bridge types.
///
/// Rust serde DTOs are the source for `packages/api-contract/src/desktop-rpc.gen.ts`. The JSON files
/// under `apps/desktop/fixtures/rpc/` independently pin representative wire
/// payloads, and `tests/rpc.golden.test.ts` validates those same fixtures
/// against the generated declarations.
///
/// The fixtures are embedded with `include_str!` (path relative to this
/// source file), the same mechanism `i18n.rs` uses for bundled language
/// packs, so `cargo test` needs no runtime file access.
#[cfg(test)]
mod fixture_tests {
  use super::*;

  const APP_SNAPSHOT: &str = include_str!("../../fixtures/rpc/app-snapshot.json");
  const SESSION_SYNCING: &str =
    include_str!("../../fixtures/rpc/session-snapshot-syncing.json");
  const SESSION_ERROR: &str =
    include_str!("../../fixtures/rpc/session-snapshot-error.json");
  const OPEN_DOCX_REQUEST: &str =
    include_str!("../../fixtures/rpc/open-docx-request.json");
  const OPEN_XLSX_REQUEST: &str =
    include_str!("../../fixtures/rpc/open-xlsx-request.json");
  const OPEN_PPTX_REQUEST: &str =
    include_str!("../../fixtures/rpc/open-pptx-request.json");
  const OPEN_DOCX_RESPONSE: &str =
    include_str!("../../fixtures/rpc/open-docx-response.json");
  const OPEN_HANDOFF_REQUEST: &str =
    include_str!("../../fixtures/rpc/open-handoff-request.json");
  const LINKED_ACCOUNT: &str = include_str!("../../fixtures/rpc/linked-account.json");
  const DESKTOP_UPDATE: &str = include_str!("../../fixtures/rpc/desktop-update.json");
  const TRUSTED_SELF_HOST: &str =
    include_str!("../../fixtures/rpc/trusted-self-host-connection.json");
  const NOTIFICATION_PREFERENCES: &str =
    include_str!("../../fixtures/rpc/notification-preferences.json");

  /// Deserialize a fixture into `T`, re-serialize it, and assert the
  /// value round-trips unchanged. Because none of these structs use
  /// `skip_serializing_if`, a missing, renamed, or ignored-unknown field
  /// makes the re-serialized value diverge from the fixture, so this is a
  /// bidirectional drift guard for symmetric types.
  fn assert_roundtrip<T>(fixture: &str)
  where
    T: serde::de::DeserializeOwned + serde::Serialize,
  {
    let original: serde_json::Value =
      serde_json::from_str(fixture).expect("fixture is valid JSON");
    let typed: T = serde_json::from_str(fixture).expect("fixture deserializes into T");
    let reserialized = serde_json::to_value(&typed).expect("T serializes");
    assert_eq!(
      reserialized, original,
      "serde round-trip diverged from the golden fixture",
    );
  }

  #[test]
  fn app_snapshot_fixture_roundtrips() {
    assert_roundtrip::<AppSnapshot>(APP_SNAPSHOT);
  }

  #[test]
  fn session_snapshot_fixtures_roundtrip() {
    assert_roundtrip::<SessionSnapshot>(SESSION_SYNCING);
    assert_roundtrip::<SessionSnapshot>(SESSION_ERROR);

    // Status strings map onto the enum variants exactly.
    let syncing: SessionSnapshot = serde_json::from_str(SESSION_SYNCING).unwrap();
    assert_eq!(syncing.status, SessionStatus::Syncing);
    let errored: SessionSnapshot = serde_json::from_str(SESSION_ERROR).unwrap();
    assert_eq!(errored.status, SessionStatus::Error);
    assert_eq!(
      errored.last_error.as_deref(),
      Some("Checkpoint upload failed: connection reset")
    );
  }

  #[test]
  fn open_file_response_fixture_roundtrips() {
    assert_roundtrip::<OpenFileResponse>(OPEN_DOCX_RESPONSE);
  }

  #[test]
  fn linked_account_fixture_roundtrips() {
    assert_roundtrip::<LinkedAccountSnapshot>(LINKED_ACCOUNT);
    let account: LinkedAccountSnapshot = serde_json::from_str(LINKED_ACCOUNT).unwrap();
    assert_eq!(account.name, None);
  }

  #[test]
  fn desktop_update_fixture_roundtrips() {
    assert_roundtrip::<DesktopUpdateSnapshot>(DESKTOP_UPDATE);
  }

  #[test]
  fn trusted_self_host_fixture_roundtrips() {
    assert_roundtrip::<TrustedSelfHostConnection>(TRUSTED_SELF_HOST);
  }

  #[test]
  fn notification_preferences_fixture_roundtrips() {
    assert_roundtrip::<DesktopNotificationPreferences>(NOTIFICATION_PREFERENCES);
  }

  #[test]
  fn open_file_request_fixtures_roundtrip_both_handoff_forms() {
    assert_roundtrip::<OpenFileRequest>(OPEN_DOCX_REQUEST);
    assert_roundtrip::<OpenFileRequest>(OPEN_HANDOFF_REQUEST);

    let request: OpenFileRequest =
      serde_json::from_str(OPEN_DOCX_REQUEST).expect("fixture deserializes");
    assert_eq!(request.api_base_url, "https://api.example.com");
    assert_eq!(request.entity_id, "11111111-1111-4111-8111-111111111111");
    assert_eq!(request.handoff_id, None);
    assert_eq!(
      request.remote_session.session_id,
      "e8400e29-1d4a-4716-8a3a-2c83de7ab2e6"
    );
    assert!(is_safe_session_id(&request.remote_session.session_id));
    assert_eq!(request.remote_session.file_name, "motion.docx");
    let linked = request.linked_account.expect("linked account present");
    assert_eq!(linked.email, "counsel@example.com");

    let handoff_request: OpenFileRequest =
      serde_json::from_str(OPEN_HANDOFF_REQUEST).expect("handoff fixture deserializes");
    assert_eq!(
      handoff_request.handoff_id.as_deref(),
      Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    );
  }

  #[test]
  fn office_file_request_fixtures_preserve_the_closed_file_type() {
    let xlsx: OpenFileRequest = serde_json::from_str(OPEN_XLSX_REQUEST).unwrap();
    assert_eq!(xlsx.remote_session.file_type, DesktopEditFileType::Xlsx);
    assert_eq!(xlsx.remote_session.file_type.mime_type(), XLSX_MIME_TYPE);

    let pptx: OpenFileRequest = serde_json::from_str(OPEN_PPTX_REQUEST).unwrap();
    assert_eq!(pptx.remote_session.file_type, DesktopEditFileType::Pptx);
    assert_eq!(pptx.remote_session.file_type.mime_type(), PPTX_MIME_TYPE);
  }
}
