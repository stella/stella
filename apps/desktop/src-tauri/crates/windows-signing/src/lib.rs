//! Safe wrappers over the raw CryptoAPI and CNG calls behind PDF signing on
//! Windows: enumerating the current user's personal certificates that can
//! sign, and signing a SHA-256 digest with one's private key. The desktop
//! crate forbids `unsafe` code, so the raw handles live here behind a
//! minimal API that owns their soundness.
//!
//! Which certificates may sign is decided from their bytes in
//! `stella-desktop-signing-core`, shared with every other platform. Listing
//! opens keys only silently, so it never prompts; signing lets the key's
//! provider ask for a PIN, over the window the caller names.
//!
//! The private key is never exported: the digest goes to the key storage
//! provider (software, TPM, smart card or token), which signs it.
//!
//! Off Windows every entry point reports
//! [`SigningError::UnsupportedPlatform`].

// Off Windows nothing calls the status mapping, but it still compiles and its
// tests still run there, so the table stays checked on every CI platform.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

mod status;
#[cfg(target_os = "windows")]
mod windows;

pub use stella_desktop_signing_core::{
  Signer, SigningError, SigningIdentity, SigningKeyType,
};

/// The current user's personal certificate store as a [`Signer`].
#[derive(Clone, Copy, Debug, Default)]
pub struct CertificateStoreSigner {
  /// The raw `HWND` a PIN prompt is shown over, when there is a window to
  /// show it over.
  prompt_owner: Option<isize>,
}

impl CertificateStoreSigner {
  /// A signer whose PIN prompts sit on top of `prompt_owner`, a raw `HWND`.
  #[must_use]
  pub const fn new(prompt_owner: Option<isize>) -> Self {
    Self { prompt_owner }
  }
}

#[cfg(target_os = "windows")]
impl Signer for CertificateStoreSigner {
  fn list_identities(&self) -> Result<Vec<SigningIdentity>, SigningError> {
    windows::list_identities()
  }

  fn sign_digest(
    &self,
    identity_id: &str,
    digest: &[u8; 32],
    key_type: SigningKeyType,
  ) -> Result<Vec<u8>, SigningError> {
    windows::sign_digest(identity_id, digest, key_type, self.prompt_owner)
  }
}

#[cfg(not(target_os = "windows"))]
impl Signer for CertificateStoreSigner {
  fn list_identities(&self) -> Result<Vec<SigningIdentity>, SigningError> {
    Err(SigningError::UnsupportedPlatform)
  }

  fn sign_digest(
    &self,
    _identity_id: &str,
    _digest: &[u8; 32],
    _key_type: SigningKeyType,
  ) -> Result<Vec<u8>, SigningError> {
    let _ = self.prompt_owner;
    Err(SigningError::UnsupportedPlatform)
  }
}

#[cfg(test)]
mod tests {
  #[cfg(not(target_os = "windows"))]
  #[test]
  fn reports_the_platform_limit_off_windows() {
    use super::*;

    let signer = CertificateStoreSigner::default();
    assert!(matches!(
      signer.list_identities(),
      Err(SigningError::UnsupportedPlatform)
    ));
    assert!(matches!(
      signer.sign_digest("", &[0; 32], SigningKeyType::Rsa),
      Err(SigningError::UnsupportedPlatform)
    ));
  }
}
