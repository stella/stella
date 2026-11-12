//! Ordering the issuers of a certificate out of a pool of certificates that
//! came with it.
//!
//! A keychain builds chains itself. A PKCS #11 token only holds certificates:
//! the signer's own and, often, its issuing CA's. Ordering them is a walk by
//! name from the leaf to whichever certificate issued it, until a
//! self-signed root or a name the pool does not have.

use crate::certificate::{CertificateNames, certificate_names};

/// Deeper than any qualified-signature hierarchy; it bounds a pool whose
/// names loop.
const MAX_CHAIN_LENGTH: usize = 8;

/// The issuers of `leaf_der` found in `pool`, innermost first. Certificates
/// that do not chain to the leaf, or that cannot be read, are left out; so is
/// the leaf itself should the pool hold it.
#[must_use]
pub fn issuer_chain(leaf_der: &[u8], pool: &[Vec<u8>]) -> Vec<Vec<u8>> {
  let Some(leaf) = certificate_names(leaf_der) else {
    return Vec::new();
  };
  let candidates: Vec<Option<CertificateNames<'_>>> = pool
    .iter()
    .map(|der| {
      if der.as_slice() == leaf_der {
        None
      } else {
        certificate_names(der)
      }
    })
    .collect();
  walk(&leaf, &candidates)
    .into_iter()
    .filter_map(|index| pool.get(index).cloned())
    .collect()
}

/// The indexes of `candidates` from `leaf` up, each one the issuer of the
/// one before. Stops at a self-signed certificate, a name not in the pool, a
/// certificate already used, or [`MAX_CHAIN_LENGTH`].
fn walk(
  leaf: &CertificateNames<'_>,
  candidates: &[Option<CertificateNames<'_>>],
) -> Vec<usize> {
  let mut chain: Vec<usize> = Vec::new();
  let mut current_issuer = leaf.issuer;
  if leaf.issuer == leaf.subject {
    return chain;
  }
  while chain.len() < MAX_CHAIN_LENGTH {
    let next = candidates.iter().enumerate().find_map(|(index, names)| {
      let names = names.as_ref()?;
      (names.subject == current_issuer && !chain.contains(&index))
        .then_some((index, names))
    });
    let Some((index, names)) = next else {
      break;
    };
    chain.push(index);
    if names.issuer == names.subject {
      break;
    }
    current_issuer = names.issuer;
  }
  chain
}

#[cfg(test)]
mod tests {
  use super::*;

  const SIGNING: &[u8] = include_bytes!("../fixtures/signing-certificate.der");
  const SELF_SIGNED: &[u8] = include_bytes!("../fixtures/rsa-certificate.der");

  fn names<'a>(issuer: &'a [u8], subject: &'a [u8]) -> Option<CertificateNames<'a>> {
    Some(CertificateNames { issuer, subject })
  }

  #[test]
  fn orders_issuers_from_the_leaf_up_to_the_root() {
    let leaf = CertificateNames {
      issuer: b"intermediate",
      subject: b"leaf",
    };
    let pool = [
      names(b"root", b"root"),
      None,
      names(b"other", b"unrelated"),
      names(b"root", b"intermediate"),
    ];

    assert_eq!(walk(&leaf, &pool), vec![3, 0]);
  }

  #[test]
  fn stops_where_the_pool_runs_out_or_loops() {
    let leaf = CertificateNames {
      issuer: b"a",
      subject: b"leaf",
    };
    assert_eq!(walk(&leaf, &[names(b"x", b"y")]), Vec::<usize>::new());
    // a is issued by b, b by a: each is used once.
    let looping = [names(b"b", b"a"), names(b"a", b"b")];
    assert_eq!(walk(&leaf, &looping), vec![0, 1]);
  }

  #[test]
  fn a_self_signed_leaf_has_no_issuers() {
    let pool = vec![SIGNING.to_vec(), SELF_SIGNED.to_vec()];
    assert!(issuer_chain(SELF_SIGNED, &pool).is_empty());
  }

  #[test]
  fn leaves_out_certificates_that_do_not_issue_the_leaf() {
    // The pool holds the leaf itself and a self-signed stranger.
    let pool = vec![SIGNING.to_vec(), SELF_SIGNED.to_vec(), b"not der".to_vec()];
    assert!(issuer_chain(SIGNING, &pool).is_empty());
  }
}
