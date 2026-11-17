//! What `CKM_RSA_PKCS` signs.
//!
//! `CKM_RSA_PKCS` pads and signs whatever it is given; the hash is the
//! caller's to name. A PKCS #1 v1.5 signature over a SHA-256 digest signs
//! the DER `DigestInfo` that names SHA-256 and carries the digest (RFC 8017,
//! section 9.2), so that is what goes to the token.

/// `DigestInfo ::= SEQUENCE { digestAlgorithm AlgorithmIdentifier (sha256,
/// NULL parameters), digest OCTET STRING (32 bytes) }`, up to the digest.
/// RFC 8017, section 9.2, note 1.
const SHA256_DIGEST_INFO_PREFIX: [u8; 19] = [
  0x30, 0x31, 0x30, 0x0D, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
  0x01, 0x05, 0x00, 0x04, 0x20,
];

/// The `DigestInfo` for a SHA-256 digest.
#[must_use]
pub fn sha256_digest_info(digest: &[u8; 32]) -> [u8; 51] {
  let mut info = [0; 51];
  info[..SHA256_DIGEST_INFO_PREFIX.len()].copy_from_slice(&SHA256_DIGEST_INFO_PREFIX);
  info[SHA256_DIGEST_INFO_PREFIX.len()..].copy_from_slice(digest);
  info
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn wraps_the_digest_in_a_sha256_digest_info() {
    let info = sha256_digest_info(&[0xAB; 32]);

    // SEQUENCE of 0x31 bytes: everything after the two header bytes.
    assert_eq!(info[0], 0x30);
    assert_eq!(usize::from(info[1]), info.len() - 2);
    // The sha256 OID, 2.16.840.1.101.3.4.2.1.
    assert_eq!(
      &info[4..15],
      &[
        0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01
      ]
    );
    // The OCTET STRING of 32 bytes ends the structure.
    assert_eq!(&info[17..19], &[0x04, 0x20]);
    assert_eq!(&info[19..], &[0xAB; 32]);
  }
}
