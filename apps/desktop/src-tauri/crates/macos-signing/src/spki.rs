//! Which key a certificate carries, read from the certificate itself.
//!
//! The obvious source is `SecKeyCopyAttributes` on the identity's private
//! key. It is the wrong one: for a key in a file-based (CDSA) keychain that
//! call reaches securityd and blocks on the user's keychain consent prompt,
//! so merely listing what can sign would interrogate the user once per key.
//! The certificate's `subjectPublicKeyInfo` says the same thing and is
//! already in hand as bytes.

use crate::identity::SigningKeyType;

/// DER tags, from X.690.
pub(crate) const TAG_INTEGER: u8 = 0x02;
pub(crate) const TAG_BIT_STRING: u8 = 0x03;
pub(crate) const TAG_OID: u8 = 0x06;
pub(crate) const TAG_SEQUENCE: u8 = 0x30;
/// `[0] EXPLICIT`: the optional version at the head of a TBSCertificate.
pub(crate) const TAG_CONTEXT_0: u8 = 0xA0;
const LONG_FORM_LENGTH: u8 = 0x80;
const LONG_FORM_BYTE_COUNT: u8 = 0x7F;
/// A length no certificate needs, and past what a `usize` shift stays sane at.
const MAX_LENGTH_BYTES: u8 = 4;

/// `rsaEncryption` (1.2.840.113549.1.1.1).
const OID_RSA_ENCRYPTION: &[u8] =
  &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01];
/// `id-ecPublicKey` (1.2.840.10045.2.1).
const OID_EC_PUBLIC_KEY: &[u8] = &[0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01];

/// One TLV: its contents, and what follows it.
pub(crate) struct Element<'a> {
  pub(crate) tag: u8,
  pub(crate) contents: &'a [u8],
  pub(crate) rest: &'a [u8],
}

pub(crate) fn read_element(input: &[u8]) -> Option<Element<'_>> {
  let (tag, after_tag) = input.split_first()?;
  let (first_length_byte, after_first) = after_tag.split_first()?;

  let (length, after_length) = if *first_length_byte < LONG_FORM_LENGTH {
    (usize::from(*first_length_byte), after_first)
  } else {
    let byte_count = *first_length_byte & LONG_FORM_BYTE_COUNT;
    if byte_count == 0 || byte_count > MAX_LENGTH_BYTES {
      return None;
    }
    let (bytes, after) = after_first.split_at_checked(usize::from(byte_count))?;
    let length = bytes
      .iter()
      .fold(0_usize, |total, byte| (total << 8) | usize::from(*byte));
    (length, after)
  };

  let (contents, rest) = after_length.split_at_checked(length)?;
  Some(Element {
    tag: *tag,
    contents,
    rest,
  })
}

pub(crate) fn read_tagged(input: &[u8], tag: u8) -> Option<Element<'_>> {
  let element = read_element(input)?;
  (element.tag == tag).then_some(element)
}

/// Skip one element, whatever it is.
pub(crate) fn skip(input: &[u8]) -> Option<&[u8]> {
  Some(read_element(input)?.rest)
}

/// The `subjectPublicKeyInfo` of an X.509 certificate:
/// `Certificate.tbsCertificate.subjectPublicKeyInfo`, reached by walking past
/// the fields that precede it (RFC 5280 §4.1).
fn subject_public_key_info(certificate_der: &[u8]) -> Option<&[u8]> {
  let certificate = read_tagged(certificate_der, TAG_SEQUENCE)?;
  let tbs = read_tagged(certificate.contents, TAG_SEQUENCE)?;

  // version is `[0] EXPLICIT INTEGER DEFAULT v1`, so a v1 certificate simply
  // starts at serialNumber.
  let after_version = match read_element(tbs.contents) {
    Some(element) if element.tag == TAG_CONTEXT_0 => element.rest,
    _ => tbs.contents,
  };
  let after_serial = read_tagged(after_version, TAG_INTEGER)?.rest;
  // signature, issuer, validity, subject: each a SEQUENCE, none of them
  // needed here.
  let mut cursor = after_serial;
  for _ in 0..4 {
    cursor = skip(cursor)?;
  }
  Some(cursor)
}

/// The key type a PDF signature algorithm can be chosen for, or `None` when
/// the certificate carries something else (Ed25519, RSASSA-PSS-only, a key
/// the parser cannot reach).
pub(crate) fn key_type_from_certificate(
  certificate_der: &[u8],
) -> Option<SigningKeyType> {
  let spki = read_tagged(subject_public_key_info(certificate_der)?, TAG_SEQUENCE)?;
  let algorithm = read_tagged(spki.contents, TAG_SEQUENCE)?;
  // The public key itself follows; its presence is what tells a truncated
  // certificate apart from a well-formed one.
  read_tagged(algorithm.rest, TAG_BIT_STRING)?;
  let oid = read_tagged(algorithm.contents, TAG_OID)?;

  match oid.contents {
    OID_RSA_ENCRYPTION => Some(SigningKeyType::Rsa),
    OID_EC_PUBLIC_KEY => Some(SigningKeyType::Ec),
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Self-signed test certificates, one per supported key type.
  const RSA_CERTIFICATE: &[u8] = include_bytes!("../fixtures/rsa-certificate.der");
  const EC_CERTIFICATE: &[u8] = include_bytes!("../fixtures/ec-certificate.der");

  #[test]
  fn reads_the_key_type_of_a_real_certificate() {
    assert_eq!(
      key_type_from_certificate(RSA_CERTIFICATE),
      Some(SigningKeyType::Rsa)
    );
    assert_eq!(
      key_type_from_certificate(EC_CERTIFICATE),
      Some(SigningKeyType::Ec)
    );
  }

  #[test]
  fn refuses_input_that_is_not_a_certificate() {
    for input in [
      b"".as_slice(),
      b"not der".as_slice(),
      &[TAG_SEQUENCE, 0x00],
      // A length that claims more than the input holds.
      &[TAG_SEQUENCE, 0x7F, 0x01],
      // Long-form length with an implausible byte count.
      &[TAG_SEQUENCE, 0x88, 0x01],
    ] {
      assert_eq!(key_type_from_certificate(input), None);
    }
  }

  #[test]
  fn refuses_a_certificate_truncated_anywhere() {
    // Every prefix of a real certificate is malformed; none may panic, and
    // none may be mistaken for a signable key.
    for end in 0..RSA_CERTIFICATE.len() {
      assert_eq!(key_type_from_certificate(&RSA_CERTIFICATE[..end]), None);
    }
  }

  #[test]
  fn refuses_a_certificate_with_a_byte_flipped() {
    // A mutation that still parses must not change which key type comes out;
    // one that does not parse must come out as None. Either way the walker
    // stays inside the buffer.
    for index in 0..RSA_CERTIFICATE.len() {
      let mut mutated = RSA_CERTIFICATE.to_vec();
      mutated[index] ^= 0xFF;
      assert!(matches!(
        key_type_from_certificate(&mutated),
        None | Some(SigningKeyType::Rsa)
      ));
    }
  }
}
