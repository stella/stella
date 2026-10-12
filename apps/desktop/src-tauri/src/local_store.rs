//! Encrypted at-rest storage shared by the local-only features.
//!
//! Every local-only store follows the same rules (see
//! `apps/desktop/docs/local-only-data.md`): its own keychain key, AES-256-GCM
//! JSON envelopes written atomically with owner-only permissions, and a key
//! that is never re-minted while encrypted data still depends on it.

pub use stella_desktop_local_store::{
  EncryptedJsonFile, StoreKey, create_private_dir, write_private_atomic,
};

use crate::keychain::{self, LocalDataKey, LocalDataKeyLookup};

/// Resolves the key for a store whose encrypted data does (or does not) exist.
///
/// A store whose key is missing must never be re-keyed: the miss may be
/// transient (a locked or migrating keychain) and minting a new key would make
/// the data undecryptable for good. Deletion-only lets the user reset it,
/// after which a new key is created.
pub fn resolve_key(key: LocalDataKey<'_>, data_exists: bool) -> StoreKey {
  resolve_key_with(
    || keychain::get_local_data_key(key),
    || keychain::create_local_data_key(key),
    data_exists,
  )
}

fn resolve_key_with(
  lookup: impl FnOnce() -> Result<LocalDataKeyLookup, String>,
  create: impl FnOnce() -> Result<[u8; 32], String>,
  data_exists: bool,
) -> StoreKey {
  let resolved = lookup().and_then(|lookup| match lookup {
    LocalDataKeyLookup::Found(key) => Ok(key),
    LocalDataKeyLookup::Missing if data_exists => {
      Err("encrypted data exists but its key is missing from the keychain".to_string())
    }
    LocalDataKeyLookup::Missing => create(),
  });
  match resolved {
    Ok(key) => StoreKey::Key(key),
    Err(error) => {
      tracing::warn!(error = %error, "local store key is unavailable");
      if data_exists {
        StoreKey::DeletionOnly
      } else {
        StoreKey::MemoryOnly
      }
    }
  }
}

/// Debug builds keep local stores in memory so development never touches the
/// production keychain item or data, unless `env` opts in.
#[cfg(debug_assertions)]
pub fn debug_build_is_memory_only(env: &str) -> bool {
  if std::env::var_os(env).is_some() {
    return false;
  }
  tracing::info!(
    env,
    "local store is memory-only in debug builds; set the variable to 1 to test encrypted persistence"
  );
  true
}

#[cfg(not(debug_assertions))]
pub fn debug_build_is_memory_only(_env: &str) -> bool {
  false
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_missing_key_is_minted_only_when_no_data_depends_on_it() {
    for data_exists in [false, true] {
      let mut minted = false;
      let resolved = resolve_key_with(
        || Ok(LocalDataKeyLookup::Missing),
        || {
          minted = true;
          Ok([1; 32])
        },
        data_exists,
      );
      assert_eq!(minted, !data_exists);
      match resolved {
        StoreKey::Key(key) => {
          assert!(!data_exists);
          assert_eq!(key, [1; 32]);
        }
        StoreKey::DeletionOnly => assert!(data_exists),
        StoreKey::MemoryOnly => panic!("a missing key must not fall back to memory"),
      }
    }
  }

  #[test]
  fn an_unreadable_keychain_never_mints_a_key() {
    for data_exists in [false, true] {
      let resolved = resolve_key_with(
        || Err("locked".to_string()),
        || panic!("must not mint"),
        data_exists,
      );
      assert!(matches!(
        (resolved, data_exists),
        (StoreKey::DeletionOnly, true) | (StoreKey::MemoryOnly, false)
      ));
    }
  }

  #[test]
  fn a_found_key_is_used_as_is() {
    let resolved = resolve_key_with(
      || Ok(LocalDataKeyLookup::Found([3; 32])),
      || panic!("must not mint"),
      true,
    );
    assert!(matches!(resolved, StoreKey::Key(key) if key == [3; 32]));
  }
}
