//! The Security.framework half. Everything here blocks on the keychain and
//! must run off the async runtime.

use security_framework::base::Error as SecError;
use security_framework::certificate::SecCertificate;
use security_framework::identity::SecIdentity;
use security_framework::item::{
  ItemClass, ItemSearchOptions, Limit, Reference, SearchResult,
};
use security_framework::key::{Algorithm, SecKey};
use security_framework::policy::SecPolicy;
use security_framework::trust::SecTrust;

use stella_desktop_signing_core::{
  SigningError, SigningErrorCode, SigningIdentity, SigningKeyType,
  certificate_fingerprint, signing_identity, unix_now,
};

use crate::failure::{OS_STATUS_DOMAIN, classify};
use crate::merge::first_by_key;

/// `errSecItemNotFound`: an empty keychain, or no token inserted, is a
/// result, not a failure.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

pub(crate) fn list_identities() -> Result<Vec<SigningIdentity>, SigningError> {
  let now = unix_now();
  let mut identities = Vec::new();
  for KeychainIdentity {
    certificate,
    certificate_der,
    ..
  } in keychain_identities()?
  {
    let chain_certificate_der = certificate_der.clone();
    if let Some(signing) = signing_identity(
      certificate_der,
      &certificate.subject_summary(),
      || issuer_chain_der(&certificate, &chain_certificate_der),
      now,
    ) {
      identities.push(signing);
    }
  }
  Ok(identities)
}

pub(crate) fn sign_digest(
  identity_id: &str,
  digest: &[u8; 32],
  key_type: SigningKeyType,
) -> Result<Vec<u8>, SigningError> {
  let key = private_key_for(identity_id)?;
  let algorithm = match key_type {
    SigningKeyType::Rsa => Algorithm::RSASignatureDigestPKCS1v15SHA256,
    SigningKeyType::Ec => Algorithm::ECDSASignatureDigestX962SHA256,
  };
  key.create_signature(algorithm, digest).map_err(|error| {
    SigningError::SignatureFailed {
      code: classify(&error.domain().to_string(), error.code() as i64)
        .unwrap_or(SigningErrorCode::SigningFailed),
      detail: error.description().to_string(),
    }
  })
}

/// Searches the same two places the listing does, so a smart card's key is
/// found wherever its certificate was.
fn private_key_for(identity_id: &str) -> Result<SecKey, SigningError> {
  let identity = keychain_identities()?
    .into_iter()
    .find(|identity| identity.fingerprint == identity_id)
    .ok_or(SigningError::IdentityNotFound)?;
  identity
    .identity
    .private_key()
    .map_err(|error| SigningError::SignatureFailed {
      code: os_status_code(&error).unwrap_or(SigningErrorCode::SigningFailed),
      detail: describe(error),
    })
}

/// An identity with its certificate already read out, keyed by the
/// certificate's fingerprint.
struct KeychainIdentity {
  identity: SecIdentity,
  certificate: SecCertificate,
  certificate_der: Vec<u8>,
  fingerprint: String,
}

impl KeychainIdentity {
  /// `None` for an identity whose certificate cannot be read: nothing could
  /// name it in the picker or sign with it.
  fn read(identity: SecIdentity) -> Option<Self> {
    let certificate = identity.certificate().ok()?;
    let certificate_der = certificate.to_der();
    Some(Self {
      fingerprint: certificate_fingerprint(&certificate_der),
      identity,
      certificate,
      certificate_der,
    })
  }
}

/// Where an identity search looks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SearchScope {
  /// The file keychains: imported certificates and their keys.
  Keychains,
  /// `kSecAttrAccessGroupToken`: what CryptoTokenKit publishes for an
  /// inserted smart card or other token. Those items live outside the file
  /// keychains (TN3137 describes the split), so only a search scoped to this
  /// access group returns them; Chromium's `client_cert_store_mac` runs the
  /// same pair of searches.
  Tokens,
}

/// The file keychains' identities, then the tokens' ones it does not already
/// hold. One certificate answering both searches keeps the first entry.
///
/// Only the file keychain search can fail the listing: a token search that
/// fails (a token driver error, an entitlement the system asks for) leaves
/// the imported certificates usable and is logged instead.
fn keychain_identities() -> Result<Vec<KeychainIdentity>, SigningError> {
  let keychains = search_identities(SearchScope::Keychains).map_err(|error| {
    SigningError::KeychainUnavailable {
      code: os_status_code(&error).unwrap_or(SigningErrorCode::KeychainUnavailable),
      detail: describe(error),
    }
  })?;
  let tokens = search_identities(SearchScope::Tokens).unwrap_or_else(|error| {
    let code = error.code();
    tracing::warn!(
      code,
      error = %describe(error),
      "smart card identities could not be listed"
    );
    Vec::new()
  });
  Ok(first_by_key([keychains, tokens], |identity| {
    identity.fingerprint.as_str()
  }))
}

fn search_identities(scope: SearchScope) -> Result<Vec<KeychainIdentity>, SecError> {
  let mut options = ItemSearchOptions::new();
  options
    .class(ItemClass::identity())
    .load_refs(true)
    .limit(Limit::All);
  if scope == SearchScope::Tokens {
    options.access_group_token();
  }
  let results = match options.search() {
    Ok(results) => results,
    Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => return Ok(Vec::new()),
    Err(error) => return Err(error),
  };

  Ok(
    results
      .into_iter()
      .filter_map(|result| match result {
        SearchResult::Ref(Reference::Identity(identity)) => {
          KeychainIdentity::read(identity)
        }
        _ => None,
      })
      .collect(),
  )
}

/// The chain the system builds above the leaf, innermost issuer first. The
/// verdict is deliberately ignored: a certificate the system does not trust
/// still produces a valid signature, and whether the signature is trusted is
/// the verifier's question, not the signer's.
fn issuer_chain_der(certificate: &SecCertificate, leaf_der: &[u8]) -> Vec<Vec<u8>> {
  let Ok(mut trust) = SecTrust::create_with_certificates(
    std::slice::from_ref(certificate),
    &[SecPolicy::create_x509()],
  ) else {
    return Vec::new();
  };
  // Fetching a missing issuer over the network would put an unbounded wait in
  // front of a picker: what the system already holds is the chain the user
  // can sign with.
  #[expect(
    clippy::let_underscore_must_use,
    reason = "a refused setting only allows a network fetch the chain does not need"
  )]
  let _ = trust.set_network_fetch_allowed(false);
  // The chain is only readable once an evaluation has run; a failed one still
  // leaves the constructed chain behind.
  #[expect(
    clippy::let_underscore_must_use,
    reason = "a failed evaluation still leaves the constructed chain to read"
  )]
  let _ = trust.evaluate_with_error();

  // `SecTrustCopyCertificateChain`, which `chain()` calls, arrived in macOS
  // 12; the app's deployment target is 10.15, so a strong reference to it
  // would keep the binary from launching on the versions in between.
  #[allow(
    deprecated,
    reason = "the replacement raises the deployment target above the app's"
  )]
  let count = trust.certificate_count();
  let mut chain = Vec::new();
  for index in 0..count {
    #[allow(
      deprecated,
      reason = "the replacement raises the deployment target above the app's"
    )]
    let Some(certificate) = trust.certificate_at_index(index) else {
      continue;
    };
    let der = certificate.to_der();
    if der != leaf_der {
      chain.push(der);
    }
  }
  chain
}

fn os_status_code(error: &SecError) -> Option<SigningErrorCode> {
  classify(OS_STATUS_DOMAIN, i64::from(error.code()))
}

fn describe(error: SecError) -> String {
  error
    .message()
    .unwrap_or_else(|| format!("OSStatus {}", error.code()))
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The keychain of the machine running the tests is whatever it is, so the
  /// assertion is on the shape of what comes back, not on its contents: an
  /// empty keychain, a populated one and a container with no keychain at all
  /// are all valid outcomes, and none of them may panic or prompt.
  #[test]
  fn every_listed_identity_is_addressable_and_signable() {
    let Ok(identities) = list_identities() else {
      return;
    };
    for identity in identities {
      assert_eq!(identity.id.len(), 64);
      assert!(identity.id.chars().all(|ch| ch.is_ascii_hexdigit()));
      assert_eq!(
        identity.id,
        certificate_fingerprint(&identity.certificate_der)
      );
      assert!(!identity.label.is_empty());
      assert!(!identity.certificate_der.is_empty());
      assert!(
        !identity.chain_der.contains(&identity.certificate_der),
        "the chain holds issuers only"
      );
    }
  }

  #[test]
  fn reports_a_fingerprint_no_identity_carries() {
    assert!(matches!(
      sign_digest(&"0".repeat(64), &[0; 32], SigningKeyType::Rsa),
      Err(SigningError::IdentityNotFound)
    ));
  }
}
