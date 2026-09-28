//! Why a signer could not sign, as a stable code rather than a sentence.
//!
//! The desktop's dialog holds the wording for every code in each of its
//! languages, so what the keychain (or a smart card, or the OS) reports in
//! English never reaches the user as such. The names are the contract with
//! that catalogue and with every platform's signer: a signer maps its own
//! errors onto this set.

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

/// `NSOSStatusErrorDomain`: Security.framework's own `OSStatus` results.
pub(crate) const OS_STATUS_DOMAIN: &str = "NSOSStatusErrorDomain";
/// CryptoTokenKit: smart cards and other tokens behind the keychain.
const CRYPTO_TOKEN_KIT_DOMAIN: &str = "CryptoTokenKit";
/// LocalAuthentication: Touch ID and the password sheet in front of a key.
const LOCAL_AUTHENTICATION_DOMAIN: &str = "com.apple.LocalAuthentication";

/// The code for an error the keychain reported, by its domain and number, or
/// `None` for one with no code of its own (the caller picks the generic one).
pub(crate) fn classify(domain: &str, code: i64) -> Option<SigningErrorCode> {
  use SigningErrorCode as C;
  match (domain, code) {
    // errSecUnimplemented: what a key answers for an algorithm it lacks.
    (OS_STATUS_DOMAIN, -4) => Some(C::UnsupportedAlgorithm),
    // errSecUserCanceled
    (OS_STATUS_DOMAIN, -128) => Some(C::Cancelled),
    // errSecAuthFailed
    (OS_STATUS_DOMAIN, -25293) => Some(C::PinIncorrect),
    // errSecNotAvailable, errSecNoSuchKeychain
    (OS_STATUS_DOMAIN, -25291 | -25294) => Some(C::KeychainUnavailable),
    // errSecItemNotFound
    (OS_STATUS_DOMAIN, -25300) => Some(C::KeyNotFound),
    // errSecInteractionNotAllowed: a locked keychain that may not prompt.
    (OS_STATUS_DOMAIN, -25308) => Some(C::KeychainLocked),
    // errSecInteractionRequired
    (OS_STATUS_DOMAIN, -25315) => Some(C::AuthenticationRequired),
    // TKErrorCodeCommunicationError, TKErrorCodeTokenNotFound
    (CRYPTO_TOKEN_KIT_DOMAIN, -2 | -7) => Some(C::TokenNotPresent),
    // TKErrorCodeCanceledByUser
    (CRYPTO_TOKEN_KIT_DOMAIN, -4) => Some(C::Cancelled),
    // TKErrorCodeAuthenticationFailed
    (CRYPTO_TOKEN_KIT_DOMAIN, -5) => Some(C::PinIncorrect),
    // TKErrorCodeObjectNotFound
    (CRYPTO_TOKEN_KIT_DOMAIN, -6) => Some(C::KeyNotFound),
    // TKErrorCodeAuthenticationNeeded
    (CRYPTO_TOKEN_KIT_DOMAIN, -9) => Some(C::AuthenticationRequired),
    // LAErrorAuthenticationFailed
    (LOCAL_AUTHENTICATION_DOMAIN, -1) => Some(C::PinIncorrect),
    // LAErrorUserCancel, LAErrorSystemCancel, LAErrorAppCancel
    (LOCAL_AUTHENTICATION_DOMAIN, -2 | -4 | -9) => Some(C::Cancelled),
    // LAErrorBiometryLockout
    (LOCAL_AUTHENTICATION_DOMAIN, -8) => Some(C::PinLocked),
    _ => None,
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

  #[test]
  fn names_the_prompts_and_cards_a_signer_meets() {
    use SigningErrorCode as C;
    for (domain, code, expected) in [
      (OS_STATUS_DOMAIN, -128, C::Cancelled),
      (OS_STATUS_DOMAIN, -25293, C::PinIncorrect),
      (OS_STATUS_DOMAIN, -25308, C::KeychainLocked),
      (OS_STATUS_DOMAIN, -25315, C::AuthenticationRequired),
      (OS_STATUS_DOMAIN, -25300, C::KeyNotFound),
      (CRYPTO_TOKEN_KIT_DOMAIN, -7, C::TokenNotPresent),
      (CRYPTO_TOKEN_KIT_DOMAIN, -5, C::PinIncorrect),
      (CRYPTO_TOKEN_KIT_DOMAIN, -4, C::Cancelled),
      (LOCAL_AUTHENTICATION_DOMAIN, -8, C::PinLocked),
    ] {
      assert_eq!(classify(domain, code), Some(expected), "{domain} {code}");
    }
  }

  #[test]
  fn leaves_an_unknown_error_to_the_generic_code() {
    assert_eq!(classify(OS_STATUS_DOMAIN, -50), None);
    assert_eq!(classify("SomeOtherDomain", -128), None);
  }
}
