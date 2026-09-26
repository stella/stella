//! What an identity looks like once it has left the platform's certificate
//! store, how it is named, and how a platform signer fails.

use std::fmt;

use sha2::{Digest, Sha256};

use crate::certificate::{can_sign_documents, certificate_facts, iso_date};
use crate::failure::SigningErrorCode;
use crate::spki::key_type_from_certificate;

/// How many leading characters of the fingerprint stand in for a certificate
/// with no subject summary. Long enough to stay unique in a picker, short
/// enough to read.
const FALLBACK_LABEL_LENGTH: usize = 16;

/// What the platform keeps its certificates in, as the log names it.
#[cfg(target_os = "windows")]
const STORE: &str = "the certificate store";
#[cfg(not(target_os = "windows"))]
const STORE: &str = "the keychain";

/// The signature algorithms a PDF signer can pair a stored key with.
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

/// A stored certificate whose private key is available for signing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SigningIdentity {
  /// SHA-256 of the leaf certificate's DER, lowercase hex. A store's own
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

/// A failure from the platform's store. `code` is what the user is told;
/// `detail` is the store's own description, for the log only.
#[derive(Debug)]
pub enum SigningError {
  /// This build has no signer for the platform it runs on.
  UnsupportedPlatform,
  /// The store could not be searched at all.
  KeychainUnavailable {
    code: SigningErrorCode,
    detail: String,
  },
  /// No identity in the store has this fingerprint any more.
  IdentityNotFound,
  /// The store refused to sign: a denied consent or PIN prompt, a locked
  /// keychain, a removed smart card.
  SignatureFailed {
    code: SigningErrorCode,
    detail: String,
  },
}

impl SigningError {
  /// What the dialog tells the user.
  #[must_use]
  pub const fn code(&self) -> SigningErrorCode {
    match self {
      Self::UnsupportedPlatform => SigningErrorCode::UnsupportedPlatform,
      Self::IdentityNotFound => SigningErrorCode::KeyNotFound,
      Self::KeychainUnavailable { code, .. } | Self::SignatureFailed { code, .. } => {
        *code
      }
    }
  }
}

impl fmt::Display for SigningError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::UnsupportedPlatform => {
        f.write_str("PDF signing is not available on this platform")
      }
      Self::KeychainUnavailable { code, detail } => {
        write!(f, "{STORE} could not be read ({}): {detail}", code.as_str())
      }
      Self::IdentityNotFound => {
        write!(f, "the selected certificate is no longer in {STORE}")
      }
      Self::SignatureFailed { code, detail } => {
        write!(
          f,
          "{STORE} did not sign the document ({}): {detail}",
          code.as_str()
        )
      }
    }
  }
}

impl std::error::Error for SigningError {}

/// The identity's stable name: the fingerprint of its leaf certificate.
#[must_use]
pub fn certificate_fingerprint(certificate_der: &[u8]) -> String {
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

/// The picker's entry for a stored certificate, or `None` when it cannot sign
/// a document at `now` (Unix seconds). Left out: a key type that is neither
/// RSA nor EC (no PDF signature algorithm pairs with it), a certificate
/// outside its validity window, one whose KeyUsage permits neither
/// digitalSignature nor nonRepudiation, and one whose extended key usages are
/// all for something else (servers, login, code, VPN endpoints).
///
/// Everything comes from the certificate's own bytes, so every platform
/// applies the same rules. `chain_der` runs only for a certificate that is
/// offered: building a chain is store work.
pub fn signing_identity(
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

/// The current time as the filter reads it: Unix seconds, clamped rather
/// than failing on a clock before 1970 or past `i64`.
#[must_use]
pub fn unix_now() -> i64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_or(0, |elapsed| {
      i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
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
      "chain building is store work; skip it when filtered"
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

  #[cfg(not(target_os = "windows"))]
  #[test]
  fn keeps_the_keychain_wording_where_the_keychain_signs() {
    let failed = SigningError::SignatureFailed {
      code: SigningErrorCode::Cancelled,
      detail: "denied".to_string(),
    };
    assert_eq!(
      failed.to_string(),
      "the keychain did not sign the document (cancelled): denied"
    );
    assert_eq!(failed.code(), SigningErrorCode::Cancelled);
  }
}
