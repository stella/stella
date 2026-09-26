//! Why a signer could not sign, as a stable code rather than a sentence.
//!
//! The desktop's dialog holds the wording for every code in each of its
//! languages, so what the keychain, the certificate store (or a smart card,
//! or the OS) reports in English never reaches the user as such. The names
//! are the contract with that catalogue and with every platform's signer: a
//! signer maps its own errors onto this set.

/// A signer failure the dialog can explain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SigningErrorCode {
  /// The user dismissed a PIN, password or consent prompt.
  Cancelled,
  /// The PIN or password was wrong.
  PinIncorrect,
  /// Too many wrong PINs: the card or token refuses until it is unblocked.
  PinLocked,
  /// The smart card or token holding the key is not connected.
  TokenNotPresent,
  /// The certificate or its private key is no longer there.
  KeyNotFound,
  /// The key cannot make the signature the document needs.
  UnsupportedAlgorithm,
  /// The keychain is locked and may not prompt from here.
  KeychainLocked,
  /// The keychain did not answer in time.
  KeychainTimeout,
  /// The keychain wants the user to confirm access first.
  AuthenticationRequired,
  /// This platform has no signer.
  UnsupportedPlatform,
  /// The keychain could not be read, for a reason with no code of its own.
  KeychainUnavailable,
  /// The key did not sign, for a reason with no code of its own.
  SigningFailed,
}

impl SigningErrorCode {
  /// Every code, for checks that each has wording.
  pub const ALL: [Self; 12] = [
    Self::Cancelled,
    Self::PinIncorrect,
    Self::PinLocked,
    Self::TokenNotPresent,
    Self::KeyNotFound,
    Self::UnsupportedAlgorithm,
    Self::KeychainLocked,
    Self::KeychainTimeout,
    Self::AuthenticationRequired,
    Self::UnsupportedPlatform,
    Self::KeychainUnavailable,
    Self::SigningFailed,
  ];

  /// The wire name the dialog looks the wording up by.
  #[must_use]
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::Cancelled => "cancelled",
      Self::PinIncorrect => "pin_incorrect",
      Self::PinLocked => "pin_locked",
      Self::TokenNotPresent => "token_not_present",
      Self::KeyNotFound => "key_not_found",
      Self::UnsupportedAlgorithm => "unsupported_algorithm",
      Self::KeychainLocked => "keychain_locked",
      Self::KeychainTimeout => "keychain_timeout",
      Self::AuthenticationRequired => "authentication_required",
      Self::UnsupportedPlatform => "unsupported_platform",
      Self::KeychainUnavailable => "keychain_unavailable",
      Self::SigningFailed => "signing_failed",
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn wire_names_are_distinct_snake_case() {
    let mut names: Vec<&str> = SigningErrorCode::ALL
      .iter()
      .map(|code| code.as_str())
      .collect();
    assert!(
      names
        .iter()
        .all(|name| name.chars().all(|ch| ch.is_ascii_lowercase() || ch == '_'))
    );
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), SigningErrorCode::ALL.len());
  }
}
