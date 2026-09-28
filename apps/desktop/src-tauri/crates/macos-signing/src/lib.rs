//! Safe wrappers over the raw Security.framework calls behind PDF signing:
//! enumerating the keychain identities that can sign, and producing a
//! signature over a SHA-256 digest with the identity's private key. The
//! desktop crate forbids `unsafe` code, so the Core Foundation attribute
//! reads live here behind a minimal API that owns their soundness (every
//! pointer comes from a live Security.framework object and is read under the
//! get rule, so nothing outlives the dictionary it was read from).
//!
//! Which certificates may sign, and the codes a failure is named by, live in
//! `stella-desktop-signing-core`, shared with every other platform.
//!
//! Signing is macOS-only. Off macOS every entry point reports
//! [`SigningError::UnsupportedPlatform`], so callers keep one code path and
//! one place that names the platform limit.
//!
//! The private key is never exported: `sign_digest` hands the digest to the
//! keychain, which signs inside the Security daemon (or the Secure Enclave, or
//! a smart card). macOS asks the user for consent the first time a given
//! binary uses a given key.

// Off macOS nothing classifies a Security.framework error, but the table
// still compiles and its tests still run there.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

mod failure;
#[cfg(target_os = "macos")]
mod macos;

pub use stella_desktop_signing_core::{
  Signer, SigningError, SigningErrorCode, SigningIdentity, SigningKeyType,
};

/// The macOS keychain as a [`Signer`].
#[derive(Clone, Copy, Debug, Default)]
pub struct KeychainSigner;

impl Signer for KeychainSigner {
  fn list_identities(&self) -> Result<Vec<SigningIdentity>, SigningError> {
    list_identities()
  }

  fn sign_digest(
    &self,
    identity_id: &str,
    digest: &[u8; 32],
    key_type: SigningKeyType,
  ) -> Result<Vec<u8>, SigningError> {
    sign_digest(identity_id, digest, key_type)
  }
}

/// Every keychain identity (certificate plus private key) that can sign a
/// document now, in keychain order, filtered by
/// [`stella_desktop_signing_core::signing_identity`].
///
/// Reading identities never touches key material, so this does not prompt.
#[cfg(target_os = "macos")]
pub fn list_identities() -> Result<Vec<SigningIdentity>, SigningError> {
  macos::list_identities()
}

#[cfg(not(target_os = "macos"))]
pub fn list_identities() -> Result<Vec<SigningIdentity>, SigningError> {
  Err(SigningError::UnsupportedPlatform)
}

/// Sign a SHA-256 digest with the private key of the identity whose
/// [`SigningIdentity::id`] this is. `key_type` selects the algorithm, so the
/// caller signs with the key type it showed the user rather than one
/// rediscovered here.
///
/// This blocks on the keychain, including on the user's consent prompt.
#[cfg(target_os = "macos")]
pub fn sign_digest(
  identity_id: &str,
  digest: &[u8; 32],
  key_type: SigningKeyType,
) -> Result<Vec<u8>, SigningError> {
  macos::sign_digest(identity_id, digest, key_type)
}

#[cfg(not(target_os = "macos"))]
pub fn sign_digest(
  _identity_id: &str,
  _digest: &[u8; 32],
  _key_type: SigningKeyType,
) -> Result<Vec<u8>, SigningError> {
  Err(SigningError::UnsupportedPlatform)
}

#[cfg(test)]
mod tests {
  #[cfg(not(target_os = "macos"))]
  #[test]
  fn reports_the_platform_limit_off_macos() {
    use super::*;

    assert!(matches!(
      list_identities(),
      Err(SigningError::UnsupportedPlatform)
    ));
    assert!(matches!(
      sign_digest("", &[0; 32], SigningKeyType::Rsa),
      Err(SigningError::UnsupportedPlatform)
    ));
  }
}
