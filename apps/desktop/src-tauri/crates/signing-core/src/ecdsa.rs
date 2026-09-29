//! One wire shape for an ECDSA signature, whichever store made it.
//!
//! The API reads an ECDSA signature as the DER `Ecdsa-Sig-Value`
//! (`SEQUENCE { r INTEGER, s INTEGER }`, RFC 3279), which is what
//! Security.framework returns. Other stores hand back the raw `r || s`
//! concatenation; this turns that into the DER form.

const TAG_INTEGER: u8 = 0x02;
const TAG_SEQUENCE: u8 = 0x30;
const LONG_FORM_ONE_BYTE: u8 = 0x81;
/// The first byte whose top bit would make a DER INTEGER negative.
const SIGN_BIT: u8 = 0x80;

/// The DER encoding of a raw `r || s` ECDSA signature, or `None` when the
/// input cannot be one: empty, odd-length, or too long for any curve.
#[must_use]
pub fn ecdsa_signature_der(raw: &[u8]) -> Option<Vec<u8>> {
  if raw.is_empty() || !raw.len().is_multiple_of(2) {
    return None;
  }
  let (r, s) = raw.split_at(raw.len() / 2);
  let mut body = Vec::with_capacity(raw.len() + 6);
  push_integer(&mut body, r)?;
  push_integer(&mut body, s)?;
  let mut der = Vec::with_capacity(body.len() + 3);
  der.push(TAG_SEQUENCE);
  push_length(&mut der, body.len())?;
  der.extend_from_slice(&body);
  Some(der)
}

/// An unsigned big-endian integer as a minimal, non-negative DER INTEGER.
fn push_integer(out: &mut Vec<u8>, magnitude: &[u8]) -> Option<()> {
  let first_significant = magnitude
    .iter()
    .position(|byte| *byte != 0)
    .unwrap_or(magnitude.len());
  let digits = &magnitude[first_significant..];
  // Zero still takes one content byte.
  let pad = digits.first().is_none_or(|first| *first >= SIGN_BIT);
  out.push(TAG_INTEGER);
  push_length(out, digits.len() + usize::from(pad))?;
  if pad {
    out.push(0);
  }
  out.extend_from_slice(digits);
  Some(())
}

/// A DER length of at most one byte: past that no curve's signature comes
/// near, so a longer one is refused rather than encoded.
fn push_length(out: &mut Vec<u8>, length: usize) -> Option<()> {
  let byte = u8::try_from(length).ok()?;
  if byte >= SIGN_BIT {
    out.push(LONG_FORM_ONE_BYTE);
  }
  out.push(byte);
  Some(())
}

#[cfg(test)]
mod tests {
  use ring::rand::SystemRandom;
  use ring::signature::{
    ECDSA_P256_SHA256_ASN1, ECDSA_P256_SHA256_FIXED_SIGNING, ECDSA_P384_SHA384_ASN1,
    ECDSA_P384_SHA384_FIXED_SIGNING, EcdsaKeyPair, EcdsaSigningAlgorithm,
    EcdsaVerificationAlgorithm, KeyPair, UnparsedPublicKey,
  };

  use super::*;

  /// Sign with the fixed `r || s` form, convert, and have an independent
  /// verifier accept the DER form. Enough rounds that r or s with a leading
  /// zero byte or a set top bit both come up.
  fn round_trips(
    signing: &'static EcdsaSigningAlgorithm,
    verifying: &'static EcdsaVerificationAlgorithm,
  ) {
    let random = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(signing, &random).unwrap();
    let key = EcdsaKeyPair::from_pkcs8(signing, pkcs8.as_ref(), &random).unwrap();
    let public_key = UnparsedPublicKey::new(verifying, key.public_key().as_ref());
    let mut saw_padded = false;
    for round in 0_u32..64 {
      let message = round.to_be_bytes();
      let raw = key.sign(&random, &message).unwrap();
      saw_padded |= raw.as_ref()[0] >= SIGN_BIT;
      let der = ecdsa_signature_der(raw.as_ref()).unwrap();
      public_key.verify(&message, &der).unwrap();
    }
    assert!(saw_padded, "no round exercised a sign-bit pad");
  }

  #[test]
  fn a_converted_p256_signature_verifies() {
    round_trips(&ECDSA_P256_SHA256_FIXED_SIGNING, &ECDSA_P256_SHA256_ASN1);
  }

  #[test]
  fn a_converted_p384_signature_verifies() {
    round_trips(&ECDSA_P384_SHA384_FIXED_SIGNING, &ECDSA_P384_SHA384_ASN1);
  }

  #[test]
  fn encodes_integers_minimally_and_non_negative() {
    // r = 0x00..01 (leading zeros dropped), s = 0x80.. (padded with 0x00).
    let mut raw = vec![0_u8; 64];
    raw[31] = 0x01;
    raw[32] = 0x80;
    let der = ecdsa_signature_der(&raw).unwrap();

    assert_eq!(&der[..5], &[TAG_SEQUENCE, 3 + 35, TAG_INTEGER, 1, 0x01]);
    assert_eq!(&der[5..8], &[TAG_INTEGER, 33, 0x00]);
    assert_eq!(der[8], 0x80);
    assert_eq!(der.len(), 2 + 3 + 35);
  }

  #[test]
  fn uses_a_long_form_length_for_p521_sized_signatures() {
    let der = ecdsa_signature_der(&[0xFF; 132]).unwrap();

    assert_eq!(&der[..3], &[TAG_SEQUENCE, LONG_FORM_ONE_BYTE, 2 * (2 + 67)]);
  }

  #[test]
  fn refuses_what_cannot_be_r_and_s() {
    assert_eq!(ecdsa_signature_der(&[]), None);
    assert_eq!(ecdsa_signature_der(&[1, 2, 3]), None);
    assert_eq!(ecdsa_signature_der(&[1; 512]), None);
  }
}
