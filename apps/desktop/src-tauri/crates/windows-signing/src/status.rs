//! What a CryptoAPI or CNG status means to the signing flow.
//!
//! The values are the documented `HRESULT`s, spelled out here so the mapping
//! compiles and is tested on every platform; on Windows a compile-time check
//! pins each one to the SDK's own constant.

use stella_desktop_signing_core::{SigningError, SigningErrorCode};

/// A status code as the Windows APIs return it: an `HRESULT`, or a
/// `GetLastError` value read as one.
pub(crate) type Status = i32;

const fn status(code: u32) -> Status {
  code.cast_signed()
}

pub(crate) const NTE_BAD_ALGID: Status = status(0x8009_0008);
pub(crate) const NTE_NO_KEY: Status = status(0x8009_000D);
pub(crate) const NTE_NOT_FOUND: Status = status(0x8009_0011);
pub(crate) const NTE_BAD_PROV_TYPE: Status = status(0x8009_0014);
pub(crate) const NTE_BAD_KEYSET: Status = status(0x8009_0016);
pub(crate) const NTE_PROV_TYPE_NOT_DEF: Status = status(0x8009_0017);
pub(crate) const NTE_SILENT_CONTEXT: Status = status(0x8009_0022);
pub(crate) const NTE_NOT_SUPPORTED: Status = status(0x8009_0029);
pub(crate) const NTE_INCORRECT_PASSWORD: Status = status(0x8009_0033);
pub(crate) const NTE_USER_CANCELLED: Status = status(0x8009_0036);
pub(crate) const CRYPT_E_NO_KEY_PROPERTY: Status = status(0x8009_200B);
pub(crate) const SCARD_E_CANCELLED: Status = status(0x8010_0002);
pub(crate) const SCARD_E_NO_SMARTCARD: Status = status(0x8010_000C);
pub(crate) const SCARD_E_READER_UNAVAILABLE: Status = status(0x8010_0017);
pub(crate) const SCARD_E_NO_READERS_AVAILABLE: Status = status(0x8010_002E);
pub(crate) const SCARD_E_NO_KEY_CONTAINER: Status = status(0x8010_0030);
pub(crate) const SCARD_W_REMOVED_CARD: Status = status(0x8010_0069);
pub(crate) const SCARD_W_WRONG_CHV: Status = status(0x8010_006B);
pub(crate) const SCARD_W_CHV_BLOCKED: Status = status(0x8010_006C);
pub(crate) const SCARD_W_CANCELLED_BY_USER: Status = status(0x8010_006E);
pub(crate) const SCARD_W_CARD_NOT_AUTHENTICATED: Status = status(0x8010_006F);
/// `ERROR_CANCELLED`, as `GetLastError` reports it.
pub(crate) const ERROR_CANCELLED: Status = 1223;
/// `HRESULT_FROM_WIN32(ERROR_CANCELLED)`.
pub(crate) const E_CANCELLED: Status = status(0x8007_04C7);

/// The shared code for a failed key open or signature, or `None` for a
/// status with no code of its own.
pub(crate) fn error_code(code: Status) -> Option<SigningErrorCode> {
  use SigningErrorCode as C;
  match code {
    NTE_USER_CANCELLED
    | SCARD_W_CANCELLED_BY_USER
    | SCARD_E_CANCELLED
    | ERROR_CANCELLED
    | E_CANCELLED => Some(C::Cancelled),
    // No PIN reached the card: a provider that could not ask, not a user who
    // declined.
    SCARD_W_CARD_NOT_AUTHENTICATED => Some(C::AuthenticationRequired),
    SCARD_W_WRONG_CHV | NTE_INCORRECT_PASSWORD => Some(C::PinIncorrect),
    SCARD_W_CHV_BLOCKED => Some(C::PinLocked),
    SCARD_E_NO_SMARTCARD
    | SCARD_W_REMOVED_CARD
    | SCARD_E_NO_READERS_AVAILABLE
    | SCARD_E_READER_UNAVAILABLE => Some(C::TokenNotPresent),
    // A certificate whose key is gone, or lives in a legacy provider CNG
    // cannot open.
    NTE_BAD_KEYSET
    | NTE_NO_KEY
    | NTE_NOT_FOUND
    | CRYPT_E_NO_KEY_PROPERTY
    | SCARD_E_NO_KEY_CONTAINER
    | NTE_BAD_PROV_TYPE
    | NTE_PROV_TYPE_NOT_DEF => Some(C::KeyNotFound),
    NTE_NOT_SUPPORTED | NTE_BAD_ALGID => Some(C::UnsupportedAlgorithm),
    _ => None,
  }
}

/// The status as it reads in a log.
pub(crate) fn describe(code: Status) -> String {
  format!("error 0x{:08X}", code.cast_unsigned())
}

/// A key open or signature that failed with `code`.
pub(crate) fn signing_error(code: Status) -> SigningError {
  SigningError::SignatureFailed {
    code: error_code(code).unwrap_or(SigningErrorCode::SigningFailed),
    detail: describe(code),
  }
}

/// Whether a certificate whose key would not open silently still belongs in
/// the picker. A key that needs the user (a PIN, an absent card to insert)
/// is a key the signing step can reach once the user is asked; a key that
/// is missing is not.
pub(crate) fn listed_despite_silent_open_failure(code: Status) -> bool {
  code == NTE_SILENT_CONTEXT
    || code == SCARD_W_CARD_NOT_AUTHENTICATED
    || error_code(code) == Some(SigningErrorCode::TokenNotPresent)
}

#[cfg(target_os = "windows")]
mod sdk_parity {
  use windows_sys::Win32::Foundation as sdk;

  use super::*;

  const _: () = {
    assert!(NTE_BAD_ALGID == sdk::NTE_BAD_ALGID);
    assert!(NTE_NO_KEY == sdk::NTE_NO_KEY);
    assert!(NTE_NOT_FOUND == sdk::NTE_NOT_FOUND);
    assert!(NTE_BAD_PROV_TYPE == sdk::NTE_BAD_PROV_TYPE);
    assert!(NTE_BAD_KEYSET == sdk::NTE_BAD_KEYSET);
    assert!(NTE_PROV_TYPE_NOT_DEF == sdk::NTE_PROV_TYPE_NOT_DEF);
    assert!(NTE_SILENT_CONTEXT == sdk::NTE_SILENT_CONTEXT);
    assert!(NTE_NOT_SUPPORTED == sdk::NTE_NOT_SUPPORTED);
    assert!(NTE_INCORRECT_PASSWORD == sdk::NTE_INCORRECT_PASSWORD);
    assert!(NTE_USER_CANCELLED == sdk::NTE_USER_CANCELLED);
    assert!(CRYPT_E_NO_KEY_PROPERTY == sdk::CRYPT_E_NO_KEY_PROPERTY);
    assert!(SCARD_E_CANCELLED == sdk::SCARD_E_CANCELLED);
    assert!(SCARD_E_NO_SMARTCARD == sdk::SCARD_E_NO_SMARTCARD);
    assert!(SCARD_E_READER_UNAVAILABLE == sdk::SCARD_E_READER_UNAVAILABLE);
    assert!(SCARD_E_NO_READERS_AVAILABLE == sdk::SCARD_E_NO_READERS_AVAILABLE);
    assert!(SCARD_E_NO_KEY_CONTAINER == sdk::SCARD_E_NO_KEY_CONTAINER);
    assert!(SCARD_W_REMOVED_CARD == sdk::SCARD_W_REMOVED_CARD);
    assert!(SCARD_W_WRONG_CHV == sdk::SCARD_W_WRONG_CHV);
    assert!(SCARD_W_CHV_BLOCKED == sdk::SCARD_W_CHV_BLOCKED);
    assert!(SCARD_W_CANCELLED_BY_USER == sdk::SCARD_W_CANCELLED_BY_USER);
    assert!(SCARD_W_CARD_NOT_AUTHENTICATED == sdk::SCARD_W_CARD_NOT_AUTHENTICATED);
    assert!(ERROR_CANCELLED.cast_unsigned() == sdk::ERROR_CANCELLED);
  };
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_each_way_a_token_can_refuse() {
    use SigningErrorCode as C;
    for (code, expected) in [
      (NTE_USER_CANCELLED, C::Cancelled),
      (SCARD_W_CANCELLED_BY_USER, C::Cancelled),
      (ERROR_CANCELLED, C::Cancelled),
      (E_CANCELLED, C::Cancelled),
      (SCARD_W_WRONG_CHV, C::PinIncorrect),
      (SCARD_W_CHV_BLOCKED, C::PinLocked),
      (SCARD_W_CARD_NOT_AUTHENTICATED, C::AuthenticationRequired),
      (SCARD_E_NO_SMARTCARD, C::TokenNotPresent),
      (SCARD_W_REMOVED_CARD, C::TokenNotPresent),
      (NTE_BAD_KEYSET, C::KeyNotFound),
      (CRYPT_E_NO_KEY_PROPERTY, C::KeyNotFound),
      (NTE_NOT_SUPPORTED, C::UnsupportedAlgorithm),
    ] {
      assert_eq!(signing_error(code).code(), expected, "0x{code:08X}");
    }
  }

  /// Only a user who dismissed a prompt cancelled; a card that never got a
  /// PIN did not.
  #[test]
  fn tells_a_missing_pin_apart_from_a_cancelled_prompt() {
    for code in [
      NTE_USER_CANCELLED,
      SCARD_W_CANCELLED_BY_USER,
      SCARD_E_CANCELLED,
      ERROR_CANCELLED,
      E_CANCELLED,
    ] {
      assert_eq!(
        error_code(code),
        Some(SigningErrorCode::Cancelled),
        "0x{code:08X}"
      );
    }
    assert_eq!(
      error_code(SCARD_W_CARD_NOT_AUTHENTICATED),
      Some(SigningErrorCode::AuthenticationRequired)
    );
    // Listing still keeps such a card's certificate: signing asks for the PIN.
    assert!(listed_despite_silent_open_failure(
      SCARD_W_CARD_NOT_AUTHENTICATED
    ));
  }

  #[test]
  fn keeps_an_unknown_status_readable() {
    let error = signing_error(status(0x8009_0020));

    assert_eq!(error.code(), SigningErrorCode::SigningFailed);
    assert!(error.to_string().ends_with("error 0x80090020"), "{error}");
  }

  #[test]
  fn lists_a_key_that_only_needs_the_user_and_drops_one_that_is_gone() {
    for code in [
      NTE_SILENT_CONTEXT,
      SCARD_W_REMOVED_CARD,
      SCARD_E_NO_SMARTCARD,
    ] {
      assert!(listed_despite_silent_open_failure(code), "0x{code:08X}");
    }
    for code in [NTE_BAD_KEYSET, CRYPT_E_NO_KEY_PROPERTY, NTE_NOT_SUPPORTED] {
      assert!(!listed_despite_silent_open_failure(code), "0x{code:08X}");
    }
  }
}
