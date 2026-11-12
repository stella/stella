//! A module's failures, named by the codes the dialog has wording for.

use cryptoki::error::{Error, RvError};
use stella_desktop_signing_core::SigningErrorCode;

/// What the user is told for a PKCS #11 failure. Return values with no code
/// of their own are a signing failure, described in the log by the detail.
pub(crate) fn classify(error: &Error) -> SigningErrorCode {
  let Error::Pkcs11(rv, _) = error else {
    return SigningErrorCode::SigningFailed;
  };
  classify_rv(*rv)
}

fn classify_rv(rv: RvError) -> SigningErrorCode {
  match rv {
    // A PIN of the wrong length is a wrong PIN as far as the user goes.
    RvError::PinIncorrect | RvError::PinInvalid | RvError::PinLenRange => {
      SigningErrorCode::PinIncorrect
    }
    RvError::PinLocked => SigningErrorCode::PinLocked,
    // The reader's keypad prompt was dismissed.
    RvError::FunctionCanceled => SigningErrorCode::Cancelled,
    RvError::TokenNotPresent
    | RvError::DeviceRemoved
    | RvError::SlotIdInvalid
    | RvError::TokenNotRecognized
    | RvError::SessionHandleInvalid
    | RvError::SessionClosed => SigningErrorCode::TokenNotPresent,
    RvError::MechanismInvalid
    | RvError::MechanismParamInvalid
    | RvError::KeyTypeInconsistent
    | RvError::KeyFunctionNotPermitted
    | RvError::KeySizeRange => SigningErrorCode::UnsupportedAlgorithm,
    RvError::KeyHandleInvalid => SigningErrorCode::KeyNotFound,
    // Anything else that leaves the key unusable is the token refusing to
    // sign; the detail goes to the log.
    _ => SigningErrorCode::SigningFailed,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use cryptoki::context::Function;

  #[test]
  fn names_what_the_user_can_act_on() {
    let cases = [
      (RvError::PinIncorrect, SigningErrorCode::PinIncorrect),
      (RvError::PinLenRange, SigningErrorCode::PinIncorrect),
      (RvError::PinLocked, SigningErrorCode::PinLocked),
      (RvError::FunctionCanceled, SigningErrorCode::Cancelled),
      (RvError::DeviceRemoved, SigningErrorCode::TokenNotPresent),
      (RvError::TokenNotPresent, SigningErrorCode::TokenNotPresent),
      (
        RvError::MechanismInvalid,
        SigningErrorCode::UnsupportedAlgorithm,
      ),
      (RvError::KeyHandleInvalid, SigningErrorCode::KeyNotFound),
      (RvError::GeneralError, SigningErrorCode::SigningFailed),
    ];
    for (rv, code) in cases {
      assert_eq!(
        classify(&Error::Pkcs11(rv, Function::Login)),
        code,
        "{rv:?}"
      );
    }
    assert_eq!(
      classify(&Error::NotSupported),
      SigningErrorCode::SigningFailed
    );
  }
}
