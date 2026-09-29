//! Tests against the real current-user store.
//!
//! The first two hold on any machine. The rest are ignored by default: they
//! need the throwaway certificates CI installs before running them with
//! `--include-ignored`, all named `CN=<prefix>-<role>` for the prefix in
//! `STELLA_SIGNING_FIXTURE_PREFIX`.

use std::collections::BTreeSet;

use ring::digest::{SHA256, digest};
use ring::signature::{
  ECDSA_P256_SHA256_ASN1, RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey,
  VerificationAlgorithm,
};
use stella_desktop_signing_core::subject_public_key;

use super::*;

const FIXTURE_PREFIX: &str = "STELLA_SIGNING_FIXTURE_PREFIX";
/// Offered: RSA-2048 (digitalSignature + nonRepudiation) and ECDSA P-256.
const OFFERED: [&str; 2] = ["rsa", "ec"];
/// In the store with a private key, but not offered: expired, and made for
/// logging in only. Plus one with no private key at all.
const NOT_OFFERED: [&str; 3] = ["expired", "client-auth", "no-key"];
const MESSAGE: &[u8] = b"stella signs the digest of this message";

fn fixture_prefix() -> String {
  std::env::var(FIXTURE_PREFIX)
    .unwrap_or_else(|_| panic!("{FIXTURE_PREFIX} names the installed fixtures"))
}

fn fixture_label(role: &str) -> String {
  format!("{}-{role}", fixture_prefix())
}

/// Every certificate in the store under its display name, key or not.
fn stored_certificates() -> Vec<(String, Vec<u8>)> {
  let store = Store::open_personal().unwrap().unwrap();
  store
    .certificates()
    .map(|certificate| (certificate.display_name(), certificate.der().to_vec()))
    .collect()
}

fn listed_fixture(role: &str) -> SigningIdentity {
  let label = fixture_label(role);
  list_identities()
    .unwrap()
    .into_iter()
    .find(|identity| identity.label == label)
    .unwrap_or_else(|| panic!("{label} is not listed"))
}

fn digest_of(message: &[u8]) -> [u8; 32] {
  digest(&SHA256, message).as_ref().try_into().unwrap()
}

fn assert_verifies(
  identity: &SigningIdentity,
  algorithm: &'static dyn VerificationAlgorithm,
) {
  let signature =
    sign_digest(&identity.id, &digest_of(MESSAGE), identity.key_type, None).unwrap();
  let public_key = subject_public_key(&identity.certificate_der).unwrap();

  UnparsedPublicKey::new(algorithm, public_key)
    .verify(MESSAGE, &signature)
    .unwrap();
  // The signature is over this message's digest and nothing else.
  assert!(
    UnparsedPublicKey::new(algorithm, public_key)
      .verify(b"another message", &signature)
      .is_err()
  );
}

/// Whatever the store holds, nothing listed may be unaddressable, and
/// nothing may panic or prompt.
#[test]
fn every_listed_identity_is_addressable() {
  for identity in list_identities().unwrap() {
    assert_eq!(
      identity.id,
      certificate_fingerprint(&identity.certificate_der)
    );
    assert!(!identity.label.is_empty());
    assert!(
      !identity.chain_der.contains(&identity.certificate_der),
      "the chain holds issuers only"
    );
  }
}

#[test]
fn reports_a_fingerprint_no_identity_carries() {
  assert!(matches!(
    sign_digest(&"0".repeat(64), &[0; 32], SigningKeyType::Rsa, None),
    Err(SigningError::IdentityNotFound)
  ));
}

#[test]
#[ignore = "needs the fixture certificates CI installs"]
fn lists_exactly_the_certificates_that_can_sign() {
  let prefix = format!("{}-", fixture_prefix());
  // Every fixture reached the store, so each one left out was filtered.
  let stored: BTreeSet<String> = stored_certificates()
    .into_iter()
    .map(|(name, _)| name)
    .filter(|name| name.starts_with(&prefix))
    .collect();
  let every_fixture: BTreeSet<String> = OFFERED
    .iter()
    .chain(&NOT_OFFERED)
    .map(|role| fixture_label(role))
    .collect();
  assert_eq!(stored, every_fixture);

  let listed: BTreeSet<String> = list_identities()
    .unwrap()
    .into_iter()
    .map(|identity| identity.label)
    .filter(|label| label.starts_with(&prefix))
    .collect();
  let offered: BTreeSet<String> =
    OFFERED.iter().map(|role| fixture_label(role)).collect();
  assert_eq!(listed, offered);

  assert_eq!(listed_fixture("rsa").key_type, SigningKeyType::Rsa);
  assert_eq!(listed_fixture("ec").key_type, SigningKeyType::Ec);
}

#[test]
#[ignore = "needs the fixture certificates CI installs"]
fn an_rsa_signature_verifies_against_the_certificate() {
  assert_verifies(&listed_fixture("rsa"), &RSA_PKCS1_2048_8192_SHA256);
}

#[test]
#[ignore = "needs the fixture certificates CI installs"]
fn an_ecdsa_signature_verifies_against_the_certificate() {
  assert_verifies(&listed_fixture("ec"), &ECDSA_P256_SHA256_ASN1);
}

#[test]
#[ignore = "needs the fixture certificates CI installs"]
fn names_a_certificate_whose_private_key_is_missing() {
  let label = fixture_label("no-key");
  let (_, der) = stored_certificates()
    .into_iter()
    .find(|(name, _)| *name == label)
    .unwrap_or_else(|| panic!("{label} is not in the store"));

  let error = sign_digest(
    &certificate_fingerprint(&der),
    &[0; 32],
    SigningKeyType::Rsa,
    None,
  )
  .unwrap_err();
  assert_eq!(error.code(), SigningErrorCode::KeyNotFound, "{error}");
}
