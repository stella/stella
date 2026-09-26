//! The platform-independent half: what an identity looks like once it has
//! left Security.framework, and how it is named.

use std::fmt;

use sha2::{Digest, Sha256};

use crate::certificate::{can_sign_documents, certificate_facts, iso_date};
use crate::spki::key_type_from_certificate;

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
  /// The issuer's common name (or organization), for the picker.
  pub issuer: Option<String>,
  /// The last day the certificate is valid, `YYYY-MM-DD` in UTC.
  pub expires_on: String,
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

/// The picker's entry for a keychain certificate, or `None` when it cannot
/// sign a document at `now` (Unix seconds): see [`crate::list_identities`].
/// Everything comes from the certificate's own bytes.
pub(crate) fn signing_identity(
  certificate_der: Vec<u8>,
  subject_summary: &str,
  chain_der: impl FnOnce() -> Vec<Vec<u8>>,
  now: i64,
) -> Option<SigningIdentity> {
  let key_type = key_type_from_certificate(&certificate_der)?;
  let facts = certificate_facts(&certificate_der)?;
  if !can_sign_documents(&facts, now) {
    return None;
  }
  let id = certificate_fingerprint(&certificate_der);
  Some(SigningIdentity {
    label: identity_label(subject_summary, &id),
    issuer: facts.issuer_name,
    expires_on: iso_date(facts.not_after),
    id,
    chain_der: chain_der(),
    certificate_der,
    key_type,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  const SIGNING: &[u8] = include_bytes!("../fixtures/signing-certificate.der");
  const CODE_SIGNING: &[u8] =
    include_bytes!("../fixtures/code-signing-certificate.der");
  /// 2026-06-01T00:00:00Z.
  const NOW: i64 = 1_780_272_000;

  #[test]
  fn describes_a_signing_certificate_for_the_picker() {
    let identity =
      signing_identity(SIGNING.to_vec(), "Jane Counsel", Vec::new, NOW).unwrap();

    assert_eq!(identity.label, "Jane Counsel");
    assert_eq!(identity.issuer.as_deref(), Some("Test Issuing CA"));
    assert_eq!(identity.expires_on, "2055-06-30");
    assert_eq!(identity.key_type, SigningKeyType::Ec);
    assert_eq!(identity.id, certificate_fingerprint(SIGNING));
  }

  #[test]
  fn leaves_out_what_cannot_sign_a_document_now() {
    // Made for code, not documents.
    assert!(signing_identity(CODE_SIGNING.to_vec(), "x", Vec::new, NOW).is_none());
    // Expired: 2060 is past the fixture's validity.
    assert!(signing_identity(SIGNING.to_vec(), "x", Vec::new, 2_840_140_800).is_none());
  }

  #[test]
  fn builds_the_chain_only_for_a_certificate_it_offers() {
    let mut built = false;
    let offered = signing_identity(
      CODE_SIGNING.to_vec(),
      "x",
      || {
        built = true;
        Vec::new()
      },
      NOW,
    );
    assert!(offered.is_none());
    assert!(
      !built,
      "chain building is keychain work; skip it when filtered"
    );
  }

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
