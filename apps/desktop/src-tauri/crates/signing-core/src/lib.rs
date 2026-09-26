//! The platform-independent half of PDF signing.
//!
//! Every platform lists the certificates it can sign with and signs a
//! SHA-256 digest with one of them; how is the platform's business, behind
//! [`Signer`]. Which certificates the picker offers is not: the rules read the
//! certificate's own bytes (key type, validity window, key usages, issuer)
//! and live here once, so each platform filters and describes identically.
//! Nor is how a failure is named: every signer maps its own errors onto
//! [`SigningErrorCode`], the codes the dialog has wording for.

mod certificate;
mod ecdsa;
mod failure;
mod identity;
mod spki;

pub use ecdsa::ecdsa_signature_der;
pub use failure::SigningErrorCode;
pub use identity::{
  SigningError, SigningIdentity, SigningKeyType, certificate_fingerprint,
  signing_identity, unix_now,
};
pub use spki::subject_public_key;

/// A platform's certificate store, as the signing flow sees it. Both calls
/// block on the store and belong off the async runtime.
pub trait Signer: Send {
  /// Every identity (certificate plus private key) that can sign a document
  /// now, in store order, filtered by [`signing_identity`]. Listing must
  /// never prompt: it reads certificates, not keys.
  fn list_identities(&self) -> Result<Vec<SigningIdentity>, SigningError>;

  /// Sign a SHA-256 digest with the private key of the identity whose
  /// [`SigningIdentity::id`] this is. `key_type` selects the algorithm, so
  /// the caller signs with the key type it showed the user rather than one
  /// rediscovered here. An ECDSA signature comes back DER encoded
  /// (`Ecdsa-Sig-Value`), an RSA one as PKCS #1 v1.5 bytes.
  ///
  /// This is the one call that may show the platform's PIN or consent
  /// prompt, and it blocks until the user answers it.
  fn sign_digest(
    &self,
    identity_id: &str,
    digest: &[u8; 32],
    key_type: SigningKeyType,
  ) -> Result<Vec<u8>, SigningError>;
}

/// The signer of a platform with no certificate store support: every call
/// reports [`SigningError::UnsupportedPlatform`].
#[derive(Clone, Copy, Debug, Default)]
pub struct UnsupportedSigner;

impl Signer for UnsupportedSigner {
  fn list_identities(&self) -> Result<Vec<SigningIdentity>, SigningError> {
    Err(SigningError::UnsupportedPlatform)
  }

  fn sign_digest(
    &self,
    _identity_id: &str,
    _digest: &[u8; 32],
    _key_type: SigningKeyType,
  ) -> Result<Vec<u8>, SigningError> {
    Err(SigningError::UnsupportedPlatform)
  }
}
