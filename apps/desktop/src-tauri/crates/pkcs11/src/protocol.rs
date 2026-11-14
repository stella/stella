//! The one request a helper process answers, and its answer.
//!
//! The desktop starts `stella-pkcs11-helper` once per request, writes one
//! JSON request to its stdin, closes it, and reads one JSON response from
//! its stdout. A vendor's PKCS #11 module is native code the desktop did not
//! write; it runs only in that short-lived process, which the desktop kills
//! if it does not answer in time.
//!
//! Bytes (certificates, digests, signatures) travel as lowercase hex. A PIN
//! travels only in a sign request, as [`Pin`], whose buffers are wiped on
//! drop and which never prints.

use std::fmt;
use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use stella_desktop_signing_core::{SigningErrorCode, SigningKeyType};
use zeroize::Zeroizing;

/// A request is a list of module paths or one sign request with a PIN: far
/// below this. A larger one is refused before it is parsed.
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Enough for every certificate on several tokens; a module that returns
/// more is not answering a listing.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "op")]
pub enum Request {
  /// Every certificate on every token the modules can see, and the card in
  /// every reader. Never logs in.
  List { modules: Vec<PathBuf> },
  /// Sign a SHA-256 digest with the private key paired with the
  /// certificate whose SHA-256 this is, on whichever of the module's tokens
  /// holds it.
  Sign(SignRequest),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignRequest {
  pub module: PathBuf,
  /// The slot of the token that listed the certificate, the only one the
  /// helper looks in: a copy of the certificate on another token (one
  /// without its key) cannot stand in for it.
  pub slot: u64,
  pub certificate_sha256: String,
  pub digest_hex: String,
  pub key_type: KeyType,
  /// `None` for a token with a PIN pad (the reader asks) or one that needs
  /// no login.
  pub pin: Option<Pin>,
}

/// The signature algorithm family of the key, as the certificate names it.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyType {
  Rsa,
  Ec,
}

impl From<SigningKeyType> for KeyType {
  fn from(key_type: SigningKeyType) -> Self {
    match key_type {
      SigningKeyType::Rsa => Self::Rsa,
      SigningKeyType::Ec => Self::Ec,
    }
  }
}

/// A token PIN. The buffer is zeroed on drop; `Debug` never shows it.
pub struct Pin(Zeroizing<String>);

impl Pin {
  #[must_use]
  pub fn new(pin: Zeroizing<String>) -> Self {
    Self(pin)
  }

  /// The PIN itself, for the one call that hands it to the token.
  #[must_use]
  pub fn expose(&self) -> &str {
    &self.0
  }
}

impl fmt::Debug for Pin {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("Pin(..)")
  }
}

impl Serialize for Pin {
  fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&self.0)
  }
}

impl<'de> Deserialize<'de> for Pin {
  fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
    Ok(Self(Zeroizing::new(String::deserialize(deserializer)?)))
  }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "status"
)]
pub enum Response {
  Listed {
    modules: Vec<ModuleListing>,
    readers: ReaderScan,
  },
  Signed {
    signature_hex: String,
  },
  /// `code` is a [`SigningErrorCode`] wire name; `detail` is for the log.
  /// `pin_retries` is the token's state after a refused PIN, so the dialog
  /// can warn before the next attempt.
  Failed {
    code: String,
    detail: String,
    pin_retries: Option<PinRetries>,
  },
}

impl Response {
  #[must_use]
  pub fn failed(code: SigningErrorCode, detail: impl Into<String>) -> Self {
    Self::Failed {
      code: code.as_str().to_string(),
      detail: detail.into(),
      pin_retries: None,
    }
  }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleListing {
  pub module: PathBuf,
  pub outcome: ModuleOutcome,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "type"
)]
pub enum ModuleOutcome {
  Loaded {
    tokens: Vec<TokenListing>,
  },
  /// The module would not load or initialise; the others still answer.
  Unusable {
    detail: String,
  },
}

/// The cards in the computer's readers, read through PC/SC.
#[derive(Debug, Deserialize, Serialize)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "type"
)]
pub enum ReaderScan {
  Read {
    cards: Vec<ReaderCard>,
  },
  /// PC/SC could not be asked; the module listing stands without it.
  Unavailable {
    detail: String,
  },
}

/// A reader holding a card, and the card's ATR.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderCard {
  pub reader: String,
  pub atr_hex: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenListing {
  pub slot: u64,
  /// `CKA_SLOT_DESCRIPTION`: most modules name the PC/SC reader here, which
  /// is how a reader's card is matched to the token a module made of it.
  pub slot_description: String,
  pub label: String,
  pub pin_entry: PinEntry,
  pub pin_retries: PinRetries,
  pub certificates: Vec<TokenCertificate>,
}

/// How the token's user proves themselves before it signs.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PinEntry {
  /// The PIN is typed into the dialog.
  Keyboard,
  /// `CKF_PROTECTED_AUTHENTICATION_PATH`: the reader's own keypad (or the
  /// token's own prompt) asks; the dialog sends no PIN.
  PinPad,
  /// The token signs without a login.
  NotRequired,
}

/// What the token says about failed PIN attempts so far.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PinRetries {
  Normal,
  /// `CKF_USER_PIN_COUNT_LOW`: at least one wrong PIN since the last
  /// correct one.
  Low,
  /// `CKF_USER_PIN_FINAL_TRY`: one more wrong PIN locks it.
  FinalTry,
  /// `CKF_USER_PIN_LOCKED`.
  Locked,
}

impl PinRetries {
  /// The most severe of the token's flags; a token may set several.
  #[must_use]
  pub const fn from_flags(count_low: bool, final_try: bool, locked: bool) -> Self {
    if locked {
      Self::Locked
    } else if final_try {
      Self::FinalTry
    } else if count_low {
      Self::Low
    } else {
      Self::Normal
    }
  }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCertificate {
  pub der_hex: String,
  /// `CKA_LABEL`, which may be empty.
  pub label: String,
  pub key: CertificateKey,
}

/// Whether a private key goes with the certificate, as far as the token
/// shows before a login.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CertificateKey {
  /// A private key with the certificate's `CKA_ID` is visible.
  Paired,
  /// The token hides its private keys until a login, and the certificate
  /// has a `CKA_ID` a key may carry.
  BehindLogin,
  /// No private key carries the certificate's `CKA_ID`: an issuer's
  /// certificate, useful for the chain only.
  Absent,
}

impl CertificateKey {
  #[must_use]
  pub const fn can_sign(self) -> bool {
    matches!(self, Self::Paired | Self::BehindLogin)
  }
}

#[derive(Debug)]
pub enum ProtocolError {
  TooLarge,
  Malformed(String),
}

impl fmt::Display for ProtocolError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::TooLarge => f.write_str("message is larger than the protocol allows"),
      Self::Malformed(detail) => write!(f, "message is not valid: {detail}"),
    }
  }
}

impl std::error::Error for ProtocolError {}

/// A request as the helper reads it. The input buffer is the caller's to
/// wipe: it may hold a PIN.
pub fn decode_request(bytes: &[u8]) -> Result<Request, ProtocolError> {
  decode(bytes, MAX_REQUEST_BYTES)
}

pub fn decode_response(bytes: &[u8]) -> Result<Response, ProtocolError> {
  decode(bytes, MAX_RESPONSE_BYTES)
}

fn decode<T: serde::de::DeserializeOwned>(
  bytes: &[u8],
  limit: usize,
) -> Result<T, ProtocolError> {
  if bytes.len() > limit {
    return Err(ProtocolError::TooLarge);
  }
  serde_json::from_slice(bytes)
    .map_err(|error| ProtocolError::Malformed(error.to_string()))
}

/// A message as written to the other process, in a buffer wiped on drop
/// (a sign request carries the PIN).
pub fn encode<T: Serialize>(message: &T) -> Result<Zeroizing<Vec<u8>>, ProtocolError> {
  let mut buffer = Zeroizing::new(Vec::new());
  serde_json::to_writer(&mut *buffer, message)
    .map_err(|error| ProtocolError::Malformed(error.to_string()))?;
  Ok(buffer)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_a_list_request() {
    let request = decode_request(
      br#"{"op":"list","modules":["/usr/local/lib/libeTPkcs11.dylib"]}"#,
    )
    .unwrap();
    assert!(matches!(
      request,
      Request::List { modules } if modules == [PathBuf::from("/usr/local/lib/libeTPkcs11.dylib")]
    ));
  }

  #[test]
  fn reads_a_sign_request_with_and_without_a_pin() {
    let with_pin = decode_request(
      br#"{"op":"sign","module":"/m.dylib","slot":0,"certificateSha256":"ab","digestHex":"cd","keyType":"ec","pin":"1234"}"#,
    )
    .unwrap();
    let Request::Sign(sign) = with_pin else {
      panic!("not a sign request");
    };
    assert_eq!(sign.key_type, KeyType::Ec);
    assert_eq!(sign.pin.as_ref().map(Pin::expose), Some("1234"));

    let pin_pad = decode_request(
      br#"{"op":"sign","module":"/m.dylib","slot":0,"certificateSha256":"ab","digestHex":"cd","keyType":"rsa","pin":null}"#,
    )
    .unwrap();
    assert!(matches!(
      pin_pad,
      Request::Sign(SignRequest {
        pin: None,
        key_type: KeyType::Rsa,
        ..
      })
    ));
  }

  #[test]
  fn round_trips_a_sign_request() {
    let request = Request::Sign(SignRequest {
      module: PathBuf::from("/m.dylib"),
      slot: 3,
      certificate_sha256: "ab".to_string(),
      digest_hex: "cd".to_string(),
      key_type: KeyType::Rsa,
      pin: Some(Pin::new(Zeroizing::new("0000".to_string()))),
    });
    let encoded = encode(&request).unwrap();
    let Request::Sign(decoded) = decode_request(&encoded).unwrap() else {
      panic!("not a sign request");
    };
    assert_eq!(decoded.pin.as_ref().map(Pin::expose), Some("0000"));
  }

  #[test]
  fn never_prints_a_pin() {
    let request = SignRequest {
      module: PathBuf::from("/m.dylib"),
      slot: 0,
      certificate_sha256: String::new(),
      digest_hex: String::new(),
      key_type: KeyType::Ec,
      pin: Some(Pin::new(Zeroizing::new("98765".to_string()))),
    };
    let printed = format!("{request:?}");
    assert!(!printed.contains("98765"), "{printed}");
    assert!(printed.contains("Pin(..)"));
  }

  #[test]
  fn refuses_what_is_not_a_request() {
    for input in [
      b"".as_slice(),
      b"{}",
      br#"{"op":"export","modules":[]}"#,
      br#"{"op":"sign","module":"/m.dylib"}"#,
      b"not json",
    ] {
      assert!(matches!(
        decode_request(input),
        Err(ProtocolError::Malformed(_))
      ));
    }
    let oversized = vec![b' '; MAX_REQUEST_BYTES + 1];
    assert!(matches!(
      decode_request(&oversized),
      Err(ProtocolError::TooLarge)
    ));
  }

  #[test]
  fn reads_a_listing() {
    let response = decode_response(
      br#"{"status":"listed","readers":{"type":"read","cards":[{"reader":"Reader 0","atrHex":"3b00"}]},"modules":[
        {"module":"/a.dylib","outcome":{"type":"unusable","detail":"no such file"}},
        {"module":"/b.dylib","outcome":{"type":"loaded","tokens":[
          {"slot":3,"slotDescription":"Reader 0","label":"Card","pinEntry":"pinPad","pinRetries":"finalTry",
           "certificates":[{"derHex":"3000","label":"Signing","key":"behindLogin"}]}
        ]}}
      ]}"#,
    )
    .unwrap();
    let Response::Listed { modules, readers } = response else {
      panic!("not a listing");
    };
    assert!(matches!(
      readers,
      ReaderScan::Read { cards } if cards[0].reader == "Reader 0" && cards[0].atr_hex == "3b00"
    ));
    assert!(matches!(modules[0].outcome, ModuleOutcome::Unusable { .. }));
    let ModuleOutcome::Loaded { tokens } = &modules[1].outcome else {
      panic!("not loaded");
    };
    assert_eq!(tokens[0].pin_entry, PinEntry::PinPad);
    assert_eq!(tokens[0].pin_retries, PinRetries::FinalTry);
    assert!(tokens[0].certificates[0].key.can_sign());
  }

  #[test]
  fn reads_a_failure_with_the_token_state() {
    let response = decode_response(
      br#"{"status":"failed","code":"pin_incorrect","detail":"C_Login","pinRetries":"low"}"#,
    )
    .unwrap();
    assert!(matches!(
      response,
      Response::Failed { code, pin_retries: Some(PinRetries::Low), .. }
        if SigningErrorCode::from_wire(&code) == Some(SigningErrorCode::PinIncorrect)
    ));
  }

  #[test]
  fn names_the_most_severe_pin_state() {
    assert_eq!(
      PinRetries::from_flags(false, false, false),
      PinRetries::Normal
    );
    assert_eq!(PinRetries::from_flags(true, false, false), PinRetries::Low);
    assert_eq!(
      PinRetries::from_flags(true, true, false),
      PinRetries::FinalTry
    );
    assert_eq!(PinRetries::from_flags(true, true, true), PinRetries::Locked);
    assert_eq!(
      PinRetries::from_flags(false, false, true),
      PinRetries::Locked
    );
  }

  #[test]
  fn only_a_certificate_with_a_key_can_sign() {
    assert!(CertificateKey::Paired.can_sign());
    assert!(CertificateKey::BehindLogin.can_sign());
    assert!(!CertificateKey::Absent.can_sign());
  }
}
