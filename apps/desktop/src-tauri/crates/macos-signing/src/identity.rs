//! The platform-independent half: what an identity looks like once it has
//! left Security.framework, and how it is named.

use std::fmt;

use sha2::{Digest, Sha256};

/// How many leading characters of the fingerprint stand in for a certificate
/// with no subject summary. Long enough to stay unique in a picker, short
/// enough to read.
const FALLBACK_LABEL_LENGTH: usize = 16;

/// The signature algorithms a PDF signer can pair a keychain key with.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SigningKeyType {
  Rsa,
  Ec,
}

impl SigningKeyType {
  /// The wire name the API uses for the algorithm this key type signs with.
  #[must_use]
  pub const fn signature_algorithm(self) -> &'static str {
    match self {
      Self::Rsa => "RSASSA-PKCS1-v1_5",
      Self::Ec => "ECDSA",
    }
  }
}

/// A certificate in the keychain whose private key is available for signing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningIdentity {
  /// SHA-256 of the leaf certificate's DER, lowercase hex. The keychain's own
  /// handles are process-local and its ordering is not stable, so the
  /// fingerprint is what travels to the dialog and comes back to sign with.
  pub id: String,
  /// The certificate's subject summary, for the picker.
  pub label: String,
  /// The leaf certificate, DER encoded.
  pub certificate_der: Vec<u8>,
  /// The issuers above the leaf, innermost first. Empty when the system
  /// cannot build a chain, which a self-signed or orphaned certificate is
  /// entitled to be.
  pub chain_der: Vec<Vec<u8>>,
  pub key_type: SigningKeyType,
}

#[derive(Debug)]
pub enum SigningError {
  /// Signing needs Security.framework; this build does not run on macOS.
  UnsupportedPlatform,
  /// The keychain could not be searched at all.
  KeychainUnavailable(String),
  /// No identity in the keychain has this fingerprint any more.
  IdentityNotFound,
  /// The keychain refused to sign: a denied consent prompt, a locked
  /// keychain, a removed smart card.
  SignatureFailed(String),
}

impl fmt::Display for SigningError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::UnsupportedPlatform => {
        f.write_str("PDF signing is available on macOS only")
      }
      Self::KeychainUnavailable(error) => {
        write!(f, "the keychain could not be read: {error}")
      }
      Self::IdentityNotFound => {
        f.write_str("the selected certificate is no longer in the keychain")
      }
      Self::SignatureFailed(error) => {
        write!(f, "the keychain did not sign the document: {error}")
      }
    }
  }
}

impl std::error::Error for SigningError {}

/// The identity's stable name: the fingerprint of its leaf certificate.
pub(crate) fn certificate_fingerprint(certificate_der: &[u8]) -> String {
  hex::encode(Sha256::digest(certificate_der))
}

/// A certificate with no subject summary still has to be pickable, so it is
/// named after its fingerprint rather than after a translated placeholder the
/// dialog would have to carry.
pub(crate) fn identity_label(subject_summary: &str, fingerprint: &str) -> String {
  let trimmed = subject_summary.trim();
  if trimmed.is_empty() {
    return fingerprint.chars().take(FALLBACK_LABEL_LENGTH).collect();
  }
  trimmed.to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fingerprints_a_certificate_as_lowercase_hex_sha256() {
    // SHA-256 of the empty input, the one digest every implementation agrees
    // on without a fixture.
    assert_eq!(
      certificate_fingerprint(b""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(certificate_fingerprint(b"stella").len(), 64);
  }

  #[test]
  fn keeps_a_subject_summary_as_the_label() {
    assert_eq!(identity_label("  Jane Counsel  ", "abcdef"), "Jane Counsel");
  }

  #[test]
  fn falls_back_to_the_fingerprint_when_the_subject_summary_is_empty() {
    let fingerprint = certificate_fingerprint(b"stella");

    assert_eq!(
      identity_label("   ", &fingerprint),
      fingerprint.get(..16).unwrap()
    );
  }

  #[test]
  fn names_one_signature_algorithm_per_key_type() {
    assert_eq!(
      SigningKeyType::Rsa.signature_algorithm(),
      "RSASSA-PKCS1-v1_5"
    );
    assert_eq!(SigningKeyType::Ec.signature_algorithm(), "ECDSA");
  }

  #[cfg(not(target_os = "macos"))]
  #[test]
  fn reports_the_platform_limit_off_macos() {
    assert!(matches!(
      crate::list_identities(),
      Err(SigningError::UnsupportedPlatform)
    ));
    assert!(matches!(
      crate::sign_digest("", &[0; 32], SigningKeyType::Rsa),
      Err(SigningError::UnsupportedPlatform)
    ));
  }
}
