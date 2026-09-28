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

use crate::failure::{OS_STATUS_DOMAIN, SigningErrorCode, classify};
use crate::identity::{
  SigningError, SigningIdentity, SigningKeyType, certificate_fingerprint,
  signing_identity,
};

/// `errSecItemNotFound`: an empty keychain is a result, not a failure.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

pub(crate) fn list_identities() -> Result<Vec<SigningIdentity>, SigningError> {
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map_or(0, |elapsed| {
      i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
    });
  let mut identities = Vec::new();
  for identity in keychain_identities()? {
    let Ok(certificate) = identity.certificate() else {
      continue;
    };
    let certificate_der = certificate.to_der();
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

fn private_key_for(identity_id: &str) -> Result<SecKey, SigningError> {
  for identity in keychain_identities()? {
    let Ok(certificate) = identity.certificate() else {
      continue;
    };
    if certificate_fingerprint(&certificate.to_der()) != identity_id {
      continue;
    }
    return identity
      .private_key()
      .map_err(|error| SigningError::SignatureFailed {
        code: os_status_code(&error).unwrap_or(SigningErrorCode::SigningFailed),
        detail: describe(error),
      });
  }
  Err(SigningError::IdentityNotFound)
}

fn keychain_identities() -> Result<Vec<SecIdentity>, SigningError> {
  let results = match ItemSearchOptions::new()
    .class(ItemClass::identity())
    .load_refs(true)
    .limit(Limit::All)
    .search()
  {
    Ok(results) => results,
    Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Vec::new(),
    Err(error) => {
      return Err(SigningError::KeychainUnavailable {
        code: os_status_code(&error).unwrap_or(SigningErrorCode::KeychainUnavailable),
        detail: describe(error),
      });
    }
  };

  Ok(
    results
      .into_iter()
      .filter_map(|result| match result {
        SearchResult::Ref(Reference::Identity(identity)) => Some(identity),
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
  let _ = trust.set_network_fetch_allowed(false);
  // The chain is only readable once an evaluation has run; a failed one still
  // leaves the constructed chain behind.
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
