use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
  io::{self, Read},
  path::{Path, PathBuf},
};

use crate::{local_store, session_store::PersistedDesktopSession};

pub const RECOVERY_LIST_LIMIT: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String")]
pub struct AccountOwner(String);

impl TryFrom<String> for AccountOwner {
  type Error = &'static str;
  fn try_from(value: String) -> Result<Self, Self::Error> {
    if value.len() != 64
      || !value
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
      return Err("invalid document account owner");
    }
    Ok(Self(value))
  }
}

impl AccountOwner {
  pub fn for_account(account: &crate::account::LinkedAccount) -> Self {
    Self(account.local_data_namespace())
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }

  #[cfg(test)]
  pub(crate) fn fixture(label: &str) -> Self {
    Self(hex::encode(Sha256::digest(label.as_bytes())))
  }
}

pub struct OwnedSession {
  pub owner: AccountOwner,
  pub session: PersistedDesktopSession,
}

pub struct SessionPartition {
  pub active: Vec<OwnedSession>,
  pub retired: Vec<PersistedDesktopSession>,
}

pub fn partition_sessions(
  sessions: Vec<PersistedDesktopSession>,
  current: Option<&AccountOwner>,
) -> SessionPartition {
  let mut active = Vec::new();
  let mut retired = Vec::new();
  for mut session in sessions {
    match session.account_owner.take() {
      Some(owner) if current == Some(&owner) => {
        active.push(OwnedSession { owner, session })
      }
      owner => {
        session.account_owner = owner;
        retired.push(session);
      }
    }
  }
  SessionPartition { active, retired }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorState {
  #[default]
  Unknown,
  Missing,
  Attached,
  Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CopyRetirement {
  Pending {
    source: PathBuf,
    destination: PathBuf,
    synced_sha: Option<String>,
  },
  Quarantined {
    source: PathBuf,
    path: PathBuf,
    synced_sha: Option<String>,
  },
  Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenRetirement {
  Pending,
  Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredSession {
  pub editor_state: EditorState,
  pub id: String,
  pub account_owner: Option<AccountOwner>,
  pub file_name: String,
  pub session_id: String,
  pub token: TokenRetirement,
  pub copy: CopyRetirement,
}

impl RetiredSession {
  pub fn plan(
    session: PersistedDesktopSession,
    quarantine: &Path,
  ) -> Result<Self, String> {
    let source = PathBuf::from(session.file_path);
    let name = source.file_name().ok_or("invalid document copy name")?;
    let id = uuid::Uuid::new_v4().to_string();
    let namespace = session
      .account_owner
      .as_ref()
      .map_or("unassigned", AccountOwner::as_str);
    let destination = quarantine.join(namespace).join(&id).join(name);
    Ok(Self {
      editor_state: session.editor_state,
      id,
      account_owner: session.account_owner,
      file_name: session.file_name,
      session_id: session.id,
      token: TokenRetirement::Pending,
      copy: CopyRetirement::Pending {
        source,
        destination,
        synced_sha: session.last_checkpoint_sha.or(session.download_sha),
      },
    })
  }

  pub fn needs_editor_check(&self) -> bool {
    self.editor_state != EditorState::Closed
      && !matches!(self.copy, CopyRetirement::Removed)
  }

  pub fn finished(&self) -> bool {
    self.token == TokenRetirement::Deleted
      && !matches!(self.copy, CopyRetirement::Pending { .. })
  }
}

pub trait RetirementIo {
  fn delete_token(&self, session_id: &str) -> Result<(), String>;
  fn move_copy(&self, source: &Path, destination: &Path) -> io::Result<()>;
  fn copy_hash(&self, path: &Path) -> io::Result<String>;
}

pub struct NativeRetirementIo;
impl RetirementIo for NativeRetirementIo {
  fn copy_hash(&self, path: &Path) -> io::Result<String> {
    hash_file(path)
  }
  fn delete_token(&self, session_id: &str) -> Result<(), String> {
    crate::keychain::delete_token(session_id)
  }
  fn move_copy(&self, source: &Path, destination: &Path) -> io::Result<()> {
    local_store::move_private(source, destination)
  }
}

fn hash_file(path: &Path) -> io::Result<String> {
  let mut file = local_store::open_private(local_store::OpenMode::Read, path)?;
  let mut hash = Sha256::new();
  let mut buffer = [0; 64 * 1024];
  loop {
    let size = file.read(&mut buffer)?;
    if size == 0 {
      break;
    }
    hash.update(&buffer[..size]);
  }
  Ok(hex::encode(hash.finalize()))
}

fn retire_copy(
  copy: &CopyRetirement,
  editor_state: EditorState,
  edit_root: &Path,
  io: &impl RetirementIo,
) -> Result<CopyRetirement, String> {
  let (source, destination, synced_sha) = match copy {
    CopyRetirement::Pending {
      source,
      destination,
      synced_sha,
    } => {
      if !source.starts_with(edit_root) {
        return Err("document copy is outside the editing directory".into());
      }
      if editor_state != EditorState::Closed {
        return Ok(copy.clone());
      }
      let parent = destination
        .parent()
        .ok_or("invalid document recovery directory")?;
      local_store::create_private_dir(parent).map_err(|error| error.to_string())?;
      match io.move_copy(source, destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
          match local_store::open_private(local_store::OpenMode::Read, destination) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
              return Ok(CopyRetirement::Removed);
            }
            Err(error) => return Err(error.to_string()),
          }
        }
        Err(error) => return Err(error.to_string()),
      }
      (source, destination, synced_sha)
    }
    CopyRetirement::Quarantined {
      source,
      path,
      synced_sha,
    } => {
      // The reader moved or deleted the set-aside copy: nothing is left to recover.
      if editor_state == EditorState::Closed {
        match local_store::open_private(local_store::OpenMode::Read, path) {
          Ok(_) => {}
          Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(CopyRetirement::Removed);
          }
          Err(error) => return Err(error.to_string()),
        }
      }
      (source, path, synced_sha)
    }
    CopyRetirement::Removed => return Ok(CopyRetirement::Removed),
  };
  if let Some(expected) = synced_sha {
    match io.copy_hash(destination) {
      Ok(actual) if actual == *expected && editor_state == EditorState::Closed => {
        local_store::remove_private(destination).map_err(|error| error.to_string())?;
        return Ok(CopyRetirement::Removed);
      }
      Ok(_) => {}
      Err(error) => return Err(error.to_string()),
    }
  }
  Ok(CopyRetirement::Quarantined {
    source: source.clone(),
    path: destination.clone(),
    synced_sha: synced_sha.clone(),
  })
}

pub fn retire_session(
  record: &mut RetiredSession,
  edit_root: &Path,
  io: &impl RetirementIo,
) -> Result<(), String> {
  let mut failures = Vec::new();
  match retire_copy(&record.copy, record.editor_state, edit_root, io) {
    Ok(copy) => record.copy = copy,
    Err(error) => {
      record.editor_state = EditorState::Unknown;
      failures.push(error);
    }
  }
  if record.token == TokenRetirement::Pending {
    match io.delete_token(&record.session_id) {
      Ok(()) => record.token = TokenRetirement::Deleted,
      Err(error) => failures.push(error),
    }
  }
  if failures.is_empty() {
    Ok(())
  } else {
    Err(failures.join("; "))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::{DesktopEditFileType, SessionStatus};
  use std::cell::RefCell;
  use std::collections::{HashMap, HashSet};

  #[derive(Clone, Copy)]
  enum Fault {
    None,
    Token,
    Move,
  }

  struct Io {
    tokens: RefCell<HashSet<String>>,
    fault: Fault,
  }
  impl RetirementIo for Io {
    fn copy_hash(&self, path: &Path) -> io::Result<String> {
      hash_file(path)
    }
    fn delete_token(&self, id: &str) -> Result<(), String> {
      if matches!(self.fault, Fault::Token) {
        return Err("credential unavailable".into());
      }
      self.tokens.borrow_mut().remove(id);
      Ok(())
    }
    fn move_copy(&self, source: &Path, destination: &Path) -> io::Result<()> {
      if matches!(self.fault, Fault::Move) {
        return Err(io::Error::other("move unavailable"));
      }
      local_store::move_private(source, destination)
    }
  }

  fn session(
    root: &Path,
    owner: Option<AccountOwner>,
    id: usize,
  ) -> PersistedDesktopSession {
    let file = root
      .join(owner.as_ref().map_or("legacy", AccountOwner::as_str))
      .join(id.to_string())
      .join("Příloha.docx");
    local_store::create_private_dir(file.parent().unwrap()).unwrap();
    local_store::write_private_atomic(&file, b"download").unwrap();
    PersistedDesktopSession {
      editor_state: EditorState::Attached,
      account_owner: owner,
      download_sha: Some(hex::encode(Sha256::digest(b"download"))),
      api_base_url: "https://api.example.test".into(),
      base_version_number: 1,
      entity_id: format!("entity-{id}"),
      file_type: DesktopEditFileType::Docx,
      file_name: "Příloha.docx".into(),
      file_path: file.to_string_lossy().into_owned(),
      id: id.to_string(),
      key: id.to_string(),
      last_checkpoint_at: None,
      last_checkpoint_sha: None,
      last_error: None,
      last_local_sha: "initial".into(),
      pending_finalize: false,
      property_id: "property".into(),
      status: SessionStatus::Ready,
      takeover_detected: false,
      workspace_id: "matter".into(),
    }
  }

  fn owners() -> Vec<AccountOwner> {
    use crate::account::LinkedAccount;
    use crate::types::{
      DesktopAccountCredential, DesktopAccountIdentity, LinkedAccountSnapshot,
    };
    let account = LinkedAccount {
      api_base_url: "https://api.example.test".into(),
      web_origin: "https://example.test".into(),
      account: LinkedAccountSnapshot {
        email: "desktop@example.test".into(),
        name: None,
        verified_at: "2026-01-01T00:00:00Z".into(),
      },
      identity: DesktopAccountIdentity {
        user_id: "user-a".into(),
        organization_id: "org-a".into(),
      },
      credential: DesktopAccountCredential {
        key: "fixture".into(),
        expires_at: "2099-01-01T00:00:00Z".into(),
      },
      device_key: crate::device_proof::DeviceKey::fixture(),
    };
    let mut result = vec![AccountOwner::for_account(&account)];
    for field in 0..3 {
      let mut next = account.clone();
      match field {
        0 => next.identity.user_id = "user-b".into(),
        1 => next.identity.organization_id = "org-b".into(),
        _ => next.api_base_url = "https://other.example.test".into(),
      }
      result.push(AccountOwner::for_account(&next));
    }
    assert_eq!(result.iter().collect::<HashSet<_>>().len(), 4);
    result
  }

  #[tokio::test]
  async fn account_session_journeys_preserve_edits() {
    let owners = owners();
    // Deterministic action sequences include each namespace boundary and both cleanup failures.
    for seed in 0..16_u64 {
      let sandbox =
        std::env::temp_dir().join(format!("desktop-session-{}", uuid::Uuid::new_v4()));
      let root = sandbox.join("editing");
      let quarantine = sandbox.join("recovery");
      let mut current = Some(owners[0].clone());
      let mut active = Vec::<PersistedDesktopSession>::new();
      let mut retired = Vec::<RetiredSession>::new();
      let mut unsynced = HashMap::<String, Vec<u8>>::new();
      let mut io = Io {
        tokens: RefCell::new(HashSet::new()),
        fault: Fault::None,
      };
      let mut random = seed + 1;
      let mut next_id = 0;
      for step in 0..64 {
        random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
        let action = if step < 12 {
          [0, 1, 4, 5, 0, 1, 6, 5, 0, 2, 3, 5][step]
        } else {
          (random >> 32) as usize % 9
        };
        match action {
          0 if current.is_some() => {
            let item = session(&root, current.clone(), next_id);
            next_id += 1;
            io.tokens.borrow_mut().insert(item.id.clone());
            active.push(item);
          }
          1 => {
            if let Some(item) = active.last_mut() {
              item.editor_state = EditorState::Attached;
              let bytes = format!("edited {} {step}", item.id).into_bytes();
              local_store::write_private_atomic(Path::new(&item.file_path), &bytes)
                .unwrap();
              unsynced.insert(item.id.clone(), bytes);
            }
          }
          2 => {
            if let Some(item) = active.last_mut() {
              item.last_checkpoint_sha =
                Some(hash_file(Path::new(&item.file_path)).unwrap());
              unsynced.remove(&item.id);
            }
          }
          3 => current = None,
          4 => io.fault = Fault::Token,
          5 => current = Some(owners[(step / 3) % owners.len()].clone()),
          6 => io.fault = Fault::Move,
          7 => io.fault = Fault::None,
          8 => {
            if let Some(item) = active.last_mut() {
              item.editor_state = EditorState::Closed;
            }
          }
          _ => {}
        }
        let partition = partition_sessions(active, current.as_ref());
        active = partition
          .active
          .into_iter()
          .map(|owned| {
            assert_eq!(Some(&owned.owner), current.as_ref());
            let mut item = owned.session;
            item.account_owner = Some(owned.owner);
            item
          })
          .collect();
        for item in partition.retired {
          retired.push(RetiredSession::plan(item, &quarantine).unwrap());
        }
        // Persist before cleanup, then replay the journal as on restart.
        let payload = crate::session_store::SessionStorePayload {
          retired_sessions: retired.clone(),
          sessions: active.clone(),
          cleanup_paths: Vec::new(),
          linked_account: None,
          linked_account_web_origin: None,
          selected_self_host_connection: None,
          notification_preferences: None,
          trusted_self_host_connections: Vec::new(),
        };
        let store = sandbox.join("sessions.json");
        crate::session_store::persist_session_store(&store, &payload)
          .await
          .unwrap();
        let loaded = crate::session_store::load_session_store(&store).await;
        assert!(loaded.load_issue.is_none());
        active = loaded.sessions;
        retired = loaded.retired_sessions;
        for record in &mut retired {
          let result = retire_session(record, &root, &io);
          if result.is_err() {
            assert!(!record.finished());
          }
          if record.finished() {
            assert!(!io.tokens.borrow().contains(&record.session_id));
          }
        }
        for (id, expected) in &unsynced {
          let path = active
            .iter()
            .find(|item| &item.id == id)
            .map(|item| PathBuf::from(&item.file_path))
            .or_else(|| {
              retired
                .iter()
                .find(|item| &item.session_id == id)
                .map(|record| match &record.copy {
                  CopyRetirement::Pending {
                    source,
                    destination,
                    ..
                  } => {
                    if source.exists() {
                      source.clone()
                    } else {
                      destination.clone()
                    }
                  }
                  CopyRetirement::Quarantined { path, .. } => path.clone(),
                  CopyRetirement::Removed => {
                    panic!("unsynced edit must remain recoverable")
                  }
                })
            })
            .unwrap();
          assert_eq!(
            std::fs::read(path).unwrap(),
            *expected,
            "seed {seed}, step {step}"
          );
        }
        assert!(
          active
            .iter()
            .all(|item| item.account_owner.as_ref() == current.as_ref())
        );
      }
      io.fault = Fault::None;
      for record in &mut retired {
        record.editor_state = EditorState::Closed;
        retire_session(record, &root, &io).unwrap();
      }
      assert!(retired.iter().all(|record| record.finished()));
      std::fs::remove_dir_all(sandbox).unwrap();
    }
  }

  #[test]
  fn recovery_keeps_a_copy_while_an_editor_is_attached() {
    use std::io::Write;
    let sandbox =
      std::env::temp_dir().join(format!("desktop-editor-{}", uuid::Uuid::new_v4()));
    let root = sandbox.join("editing");
    let item = session(&root, Some(AccountOwner::fixture("account")), 1);
    let mut writer = local_store::open_private(
      local_store::OpenMode::AppendExisting,
      Path::new(&item.file_path),
    )
    .unwrap();
    let mut record = RetiredSession::plan(item, &sandbox.join("recovery")).unwrap();
    let boundary = Io {
      tokens: RefCell::new(HashSet::from(["1".into()])),
      fault: Fault::None,
    };
    retire_session(&mut record, &root, &boundary).unwrap();
    let CopyRetirement::Pending { source, .. } = &record.copy else {
      panic!("an attached editor keeps its original path");
    };
    assert_eq!(std::fs::read(source).unwrap(), b"download");
    assert!(record.needs_editor_check());
    writer.write_all(b" edited").unwrap();
    writer.sync_all().unwrap();
    drop(writer);
    record.editor_state = EditorState::Closed;
    retire_session(&mut record, &root, &boundary).unwrap();
    let CopyRetirement::Quarantined { path, .. } = &record.copy else {
      panic!("changed recovery bytes remain available");
    };
    assert_eq!(std::fs::read(path).unwrap(), b"download edited");
    std::fs::remove_dir_all(sandbox).unwrap();
  }

  #[test]
  fn recovery_removes_synced_copies_after_editor_close() {
    let sandbox =
      std::env::temp_dir().join(format!("desktop-editor-{}", uuid::Uuid::new_v4()));
    let root = sandbox.join("editing");
    let item = session(&root, Some(AccountOwner::fixture("account")), 1);
    let mut record = RetiredSession::plan(item, &sandbox.join("recovery")).unwrap();
    let boundary = Io {
      tokens: RefCell::new(HashSet::from(["1".into()])),
      fault: Fault::None,
    };
    for state in [EditorState::Attached, EditorState::Unknown] {
      record.editor_state = state;
      retire_session(&mut record, &root, &boundary).unwrap();
      assert!(matches!(record.copy, CopyRetirement::Pending { .. }));
    }
    record.editor_state = EditorState::Closed;
    retire_session(&mut record, &root, &boundary).unwrap();
    assert!(matches!(record.copy, CopyRetirement::Removed));
    assert!(record.finished());
    std::fs::remove_dir_all(sandbox).unwrap();
  }

  fn recovery_uses_rename_save_after_editor_closes(editor_state: EditorState) {
    let sandbox = std::env::temp_dir()
      .join(format!("desktop-rename-save-{}", uuid::Uuid::new_v4()));
    let root = sandbox.join("editing");
    let item = session(&root, Some(AccountOwner::fixture("account")), 1);
    let source = PathBuf::from(&item.file_path);
    let mut record = RetiredSession::plan(item, &sandbox.join("recovery")).unwrap();
    record.editor_state = editor_state;
    let boundary = Io {
      tokens: RefCell::new(HashSet::from(["1".into()])),
      fault: Fault::None,
    };

    retire_session(&mut record, &root, &boundary).unwrap();
    let CopyRetirement::Pending { destination, .. } = &record.copy else {
      panic!("an open editor keeps recovery on the original path");
    };
    assert!(!destination.exists());

    let temporary = source.with_extension("tmp");
    local_store::write_private_atomic(&temporary, b"new contents").unwrap();
    local_store::rename_private(&temporary, &source).unwrap();
    record.editor_state = EditorState::Closed;
    retire_session(&mut record, &root, &boundary).unwrap();

    let CopyRetirement::Quarantined { path, .. } = &record.copy else {
      panic!("the latest editor contents remain recoverable");
    };
    assert_eq!(std::fs::read(path).unwrap(), b"new contents");
    assert!(!source.exists());
    assert!(!temporary.exists());
    assert_eq!(
      std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
      1
    );
    std::fs::remove_dir_all(sandbox).unwrap();
  }

  #[test]
  fn attached_editor_rename_save_is_recovered_after_close() {
    recovery_uses_rename_save_after_editor_closes(EditorState::Attached);
  }

  #[test]
  fn unknown_editor_rename_save_is_recovered_after_close() {
    recovery_uses_rename_save_after_editor_closes(EditorState::Unknown);
  }

  #[test]
  fn unassigned_sessions_use_manual_recovery() {
    let sandbox =
      std::env::temp_dir().join(format!("desktop-session-{}", uuid::Uuid::new_v4()));
    let root = sandbox.join("editing");
    let mut item = session(&root, None, 1);
    item.download_sha = None;
    let partition =
      partition_sessions(vec![item], Some(&AccountOwner::fixture("current")));
    assert!(partition.active.is_empty());
    let mut record = RetiredSession::plan(
      partition.retired.into_iter().next().unwrap(),
      &sandbox.join("recovery"),
    )
    .unwrap();
    let io = Io {
      tokens: RefCell::new(HashSet::from(["1".into()])),
      fault: Fault::None,
    };
    retire_session(&mut record, &root, &io).unwrap();
    assert!(
      matches!(record.copy, CopyRetirement::Pending { .. }),
      "an attached editor keeps the unassigned edit in place"
    );
    record.editor_state = EditorState::Closed;
    retire_session(&mut record, &root, &io).unwrap();
    assert!(record.account_owner.is_none());
    let CopyRetirement::Quarantined { path, .. } = record.copy else {
      panic!("manual recovery must remain available")
    };
    assert!(path.starts_with(sandbox.join("recovery/unassigned")));
    assert_eq!(std::fs::read(&path).unwrap(), b"download");
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
      );
      assert_eq!(
        std::fs::metadata(path.parent().unwrap())
          .unwrap()
          .permissions()
          .mode()
          & 0o777,
        0o700
      );
    }
    assert!(io.tokens.borrow().is_empty());
    std::fs::remove_dir_all(sandbox).unwrap();
  }
}
