//! Safe wrappers over the raw Security.framework calls behind PDF signing:
//! enumerating the keychain identities that can sign, and producing a
//! signature over a SHA-256 digest with the identity's private key. The
//! desktop crate forbids `unsafe` code, so the Core Foundation attribute
//! reads live here behind a minimal API that owns their soundness (every
//! pointer comes from a live Security.framework object and is read under the
//! get rule, so nothing outlives the dictionary it was read from).
//!
//! Signing is macOS-only. Off macOS the crate holds the data types and every
//! entry point reports [`SigningError::UnsupportedPlatform`], so callers keep
//! one code path and one place that names the platform limit.
//!
//! The private key is never exported: `sign_digest` hands the digest to the
//! keychain, which signs inside the Security daemon (or the Secure Enclave, or
//! a smart card). macOS asks the user for consent the first time a given
//! binary uses a given key.

// Off macOS nothing calls the pieces that build an identity, but they still
// compile and their tests still run there: the DER walker is
// platform-independent, and it would lose two thirds of its CI coverage if it
// were gated away.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

mod identity;
#[cfg(target_os = "macos")]
mod macos;
mod spki;

pub use identity::{SigningError, SigningIdentity, SigningKeyType};

/// Every keychain identity (certificate plus private key) that can produce a
/// signature, in keychain order. An identity whose key type is neither RSA nor
/// EC is left out: there is no PDF signature algorithm to pair it with.
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
