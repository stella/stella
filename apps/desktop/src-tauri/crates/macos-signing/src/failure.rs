//! Security.framework's errors, as the shared signing codes.

use stella_desktop_signing_core::SigningErrorCode;

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
