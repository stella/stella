//! The PKCS #11 calls behind a listing and a signature.
//!
//! Certificates and private keys are separate objects on a token, paired by
//! `CKA_ID`. A listing never logs in: many tokens keep their private keys
//! out of sight until a login, so a certificate whose key may be hidden is
//! listed as such, and the filter that decides what the picker offers reads
//! the certificate itself (in the desktop, shared with every other store).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
use cryptoki::error::{Error, RvError};
use cryptoki::mechanism::Mechanism;
use cryptoki::object::{Attribute, AttributeType, ObjectClass, ObjectHandle};
use cryptoki::session::{Session, UserType};
use cryptoki::slot::{Slot, TokenInfo};
use cryptoki::types::AuthPin;
use sha2::{Digest, Sha256};
use stella_desktop_pkcs11::digest_info::sha256_digest_info;
use stella_desktop_pkcs11::protocol::{
  CertificateKey, KeyType, ModuleListing, ModuleOutcome, Pin, PinEntry, PinRetries,
  Response, SignRequest, TokenCertificate, TokenListing,
};
use stella_desktop_signing_core::{SigningErrorCode, ecdsa_signature_der};

use crate::failure::classify;

/// A SHA-256 digest, the only one the desktop asks to sign.
const DIGEST_BYTES: usize = 32;

pub(crate) fn list(modules: &[PathBuf]) -> Response {
  Response::Listed {
    modules: modules
      .iter()
      .map(|module| ModuleListing {
        module: module.clone(),
        outcome: match list_module(module) {
          Ok(tokens) => ModuleOutcome::Loaded { tokens },
          Err(error) => ModuleOutcome::Unusable {
            detail: error.to_string(),
          },
        },
      })
      .collect(),
  }
}

pub(crate) fn sign(request: &SignRequest) -> Response {
  let Some(digest) = hex::decode(&request.digest_hex)
    .ok()
    .and_then(|bytes| <[u8; DIGEST_BYTES]>::try_from(bytes).ok())
  else {
    return Response::failed(
      SigningErrorCode::UnsupportedAlgorithm,
      "the digest is not a SHA-256 digest",
    );
  };
  let Ok(certificate_sha256) = hex::decode(&request.certificate_sha256) else {
    return Response::failed(
      SigningErrorCode::KeyNotFound,
      "unreadable certificate hash",
    );
  };
  match sign_with_module(request, &certificate_sha256, &digest) {
    Ok(signature) => Response::Signed {
      signature_hex: hex::encode(signature),
    },
    Err(failure) => failure.into_response(),
  }
}

fn open(module: &Path) -> Result<Pkcs11, Error> {
  if !module.is_absolute() {
    return Err(Error::InvalidValue);
  }
  let pkcs11 = Pkcs11::new(module)?;
  match pkcs11.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK)) {
    Ok(()) | Err(Error::Pkcs11(RvError::CryptokiAlreadyInitialized, _)) => Ok(pkcs11),
    Err(error) => Err(error),
  }
}

fn list_module(module: &Path) -> Result<Vec<TokenListing>, Error> {
  let pkcs11 = open(module)?;
  let mut tokens = Vec::new();
  for slot in pkcs11.get_slots_with_token()? {
    // One unreadable token (removed mid-listing, refusing sessions) must
    // not hide the others.
    if let Ok(token) = list_token(&pkcs11, slot) {
      tokens.push(token);
    }
  }
  Ok(tokens)
}

fn list_token(pkcs11: &Pkcs11, slot: Slot) -> Result<TokenListing, Error> {
  let info = pkcs11.get_token_info(slot)?;
  let session = pkcs11.open_ro_session(slot)?;
  let key_ids: HashSet<Vec<u8>> = session
    .find_objects(&[Attribute::Class(ObjectClass::PRIVATE_KEY)])?
    .into_iter()
    .filter_map(|key| object_id(&session, key))
    .collect();
  let keys_hidden = key_ids.is_empty() && info.login_required();

  let mut certificates = Vec::new();
  for handle in session.find_objects(&[Attribute::Class(ObjectClass::CERTIFICATE)])? {
    let Ok(attributes) = session.get_attributes(
      handle,
      &[
        AttributeType::Value,
        AttributeType::Id,
        AttributeType::Label,
      ],
    ) else {
      continue;
    };
    let mut der = None;
    let mut id = Vec::new();
    let mut label = String::new();
    for attribute in attributes {
      match attribute {
        Attribute::Value(value) => der = Some(value),
        Attribute::Id(value) => id = value,
        Attribute::Label(value) => {
          label = String::from_utf8_lossy(&value).trim().to_string()
        }
        _ => {}
      }
    }
    let Some(der) = der.filter(|der| !der.is_empty()) else {
      continue;
    };
    certificates.push(TokenCertificate {
      der_hex: hex::encode(der),
      label,
      key: certificate_key(&id, &key_ids, keys_hidden),
    });
  }

  Ok(TokenListing {
    slot: slot.id(),
    label: info.label().trim().to_string(),
    pin_entry: pin_entry(&info),
    pin_retries: pin_retries(&info),
    certificates,
  })
}

fn certificate_key(
  id: &[u8],
  key_ids: &HashSet<Vec<u8>>,
  keys_hidden: bool,
) -> CertificateKey {
  if id.is_empty() {
    CertificateKey::Absent
  } else if key_ids.contains(id) {
    CertificateKey::Paired
  } else if keys_hidden {
    CertificateKey::BehindLogin
  } else {
    CertificateKey::Absent
  }
}

fn pin_entry(info: &TokenInfo) -> PinEntry {
  if !info.login_required() {
    PinEntry::NotRequired
  } else if info.protected_authentication_path() {
    PinEntry::PinPad
  } else {
    PinEntry::Keyboard
  }
}

fn pin_retries(info: &TokenInfo) -> PinRetries {
  PinRetries::from_flags(
    info.user_pin_count_low(),
    info.user_pin_final_try(),
    info.user_pin_locked(),
  )
}

fn object_id(session: &Session, object: ObjectHandle) -> Option<Vec<u8>> {
  session
    .get_attributes(object, &[AttributeType::Id])
    .ok()?
    .into_iter()
    .find_map(|attribute| match attribute {
      Attribute::Id(id) if !id.is_empty() => Some(id),
      _ => None,
    })
}

/// A signing failure: what the user is told, what the log says, and, for a
/// refused PIN, what the token now says about the attempts left.
struct Failure {
  code: SigningErrorCode,
  detail: String,
  pin_retries: Option<PinRetries>,
}

impl Failure {
  fn new(code: SigningErrorCode, detail: impl Into<String>) -> Self {
    Self {
      code,
      detail: detail.into(),
      pin_retries: None,
    }
  }

  fn into_response(self) -> Response {
    Response::Failed {
      code: self.code.as_str().to_string(),
      detail: self.detail,
      pin_retries: self.pin_retries,
    }
  }
}

impl From<Error> for Failure {
  fn from(error: Error) -> Self {
    Self::new(classify(&error), error.to_string())
  }
}

/// The token holding the certificate, and the session and `CKA_ID` it was
/// found with.
struct Located {
  slot: Slot,
  session: Session,
  id: Vec<u8>,
}

fn sign_with_module(
  request: &SignRequest,
  certificate_sha256: &[u8],
  digest: &[u8; DIGEST_BYTES],
) -> Result<Vec<u8>, Failure> {
  let pkcs11 = open(&request.module)?;
  let Some(located) = locate(&pkcs11, certificate_sha256)? else {
    return Err(Failure::new(
      SigningErrorCode::TokenNotPresent,
      "no token in this module holds the certificate",
    ));
  };
  let info = pkcs11.get_token_info(located.slot)?;
  let pin = request.pin.as_ref();
  if info.login_required() {
    login(&pkcs11, &located, &info, UserType::User, pin)?;
  }

  let key = located
    .session
    .find_objects(&[
      Attribute::Class(ObjectClass::PRIVATE_KEY),
      Attribute::Id(located.id.clone()),
    ])?
    .into_iter()
    .next()
    .ok_or_else(|| {
      Failure::new(
        SigningErrorCode::KeyNotFound,
        "no private key carries the certificate's CKA_ID",
      )
    })?;
  let always_authenticate = located
    .session
    .get_attributes(key, &[AttributeType::AlwaysAuthenticate])
    .ok()
    .is_some_and(|attributes| {
      attributes
        .iter()
        .any(|attribute| matches!(attribute, Attribute::AlwaysAuthenticate(true)))
    });

  let digest_info;
  let (mechanism, data): (Mechanism<'_>, &[u8]) = match request.key_type {
    KeyType::Ec => (Mechanism::Ecdsa, digest),
    KeyType::Rsa => {
      digest_info = sha256_digest_info(digest);
      (Mechanism::RsaPkcs, &digest_info)
    }
  };
  // A key marked CKA_ALWAYS_AUTHENTICATE (a qualified signature key, as on
  // many national ID cards) wants the PIN again for each signature, between
  // the init and the signature itself.
  let signature = if always_authenticate {
    located.session.sign_init(&mechanism, key)?;
    login(&pkcs11, &located, &info, UserType::ContextSpecific, pin)?;
    crate::context_sign::FunctionList::open(&request.module)?
      .sign(located.session.handle(), data)?
  } else {
    located.session.sign(&mechanism, key, data)?
  };
  // Best effort: the process exits next, and the module logs out with it.
  #[expect(
    clippy::let_underscore_must_use,
    reason = "the session ends with the process either way"
  )]
  let _ = located.session.logout();

  match request.key_type {
    KeyType::Rsa => Ok(signature),
    // PKCS #11 returns r || s; the API reads the DER form.
    KeyType::Ec => ecdsa_signature_der(&signature).ok_or_else(|| {
      Failure::new(
        SigningErrorCode::SigningFailed,
        "the token returned an ECDSA signature of an odd length",
      )
    }),
  }
}

fn locate(
  pkcs11: &Pkcs11,
  certificate_sha256: &[u8],
) -> Result<Option<Located>, Error> {
  for slot in pkcs11.get_slots_with_token()? {
    let Ok(session) = pkcs11.open_ro_session(slot) else {
      continue;
    };
    let Ok(certificates) =
      session.find_objects(&[Attribute::Class(ObjectClass::CERTIFICATE)])
    else {
      continue;
    };
    for handle in certificates {
      let Ok(attributes) =
        session.get_attributes(handle, &[AttributeType::Value, AttributeType::Id])
      else {
        continue;
      };
      let mut matches = false;
      let mut id = Vec::new();
      for attribute in attributes {
        match attribute {
          Attribute::Value(der) => {
            matches = Sha256::digest(&der).as_slice() == certificate_sha256;
          }
          Attribute::Id(value) => id = value,
          _ => {}
        }
      }
      if matches && !id.is_empty() {
        return Ok(Some(Located { slot, session, id }));
      }
    }
  }
  Ok(None)
}

/// Log in as `user`: through the reader's keypad when it has one, with the
/// PIN otherwise. Already logged in (another session on the same token) is
/// logged in. A refused PIN comes back with the token's PIN state read
/// again, so the dialog can warn about the attempts left.
fn login(
  pkcs11: &Pkcs11,
  located: &Located,
  info: &TokenInfo,
  user: UserType,
  pin: Option<&Pin>,
) -> Result<(), Failure> {
  let result = if info.protected_authentication_path() {
    located.session.login(user, None)
  } else {
    let Some(pin) = pin else {
      return Err(Failure::new(
        SigningErrorCode::AuthenticationRequired,
        "the token needs a PIN and none was given",
      ));
    };
    let pin = AuthPin::new(pin.expose().into());
    located.session.login(user, Some(&pin))
  };
  match result {
    Ok(()) | Err(Error::Pkcs11(RvError::UserAlreadyLoggedIn, _)) => Ok(()),
    Err(error) => {
      let mut failure = Failure::from(error);
      if matches!(
        failure.code,
        SigningErrorCode::PinIncorrect | SigningErrorCode::PinLocked
      ) {
        failure.pin_retries = pkcs11
          .get_token_info(located.slot)
          .ok()
          .map(|info| pin_retries(&info));
      }
      Err(failure)
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn pairs_a_certificate_with_its_key_by_id() {
    let keys: HashSet<Vec<u8>> = [vec![1], vec![2]].into_iter().collect();

    assert_eq!(certificate_key(&[1], &keys, false), CertificateKey::Paired);
    assert_eq!(certificate_key(&[3], &keys, false), CertificateKey::Absent);
    assert_eq!(certificate_key(&[], &keys, false), CertificateKey::Absent);
  }

  #[test]
  fn a_token_that_hides_its_keys_may_hold_one_for_any_identified_certificate() {
    let none = HashSet::new();

    assert_eq!(
      certificate_key(&[1], &none, true),
      CertificateKey::BehindLogin
    );
    assert_eq!(certificate_key(&[], &none, true), CertificateKey::Absent);
    assert_eq!(certificate_key(&[1], &none, false), CertificateKey::Absent);
  }

  #[test]
  fn refuses_a_relative_module_path() {
    assert!(matches!(
      open(Path::new("libeTPkcs11.dylib")),
      Err(Error::InvalidValue)
    ));
  }

  #[test]
  fn refuses_a_digest_that_is_not_sha256() {
    let request = SignRequest {
      module: PathBuf::from("/nonexistent.dylib"),
      certificate_sha256: "00".repeat(32),
      digest_hex: "ab".repeat(20),
      key_type: KeyType::Rsa,
      pin: None,
    };
    assert!(matches!(
      sign(&request),
      Response::Failed { code, .. } if code == "unsupported_algorithm"
    ));
  }

  #[test]
  fn a_module_that_will_not_load_is_unusable_and_the_rest_still_answer() {
    let Response::Listed { modules } = list(&[
      PathBuf::from("/nonexistent/one.dylib"),
      PathBuf::from("relative.dylib"),
    ]) else {
      panic!("not a listing");
    };
    assert_eq!(modules.len(), 2);
    assert!(
      modules
        .iter()
        .all(|module| matches!(module.outcome, ModuleOutcome::Unusable { .. }))
    );
  }

  /// Lists and signs against a real PKCS #11 module: SoftHSM2, given by
  /// `SOFTHSM2_MODULE` (its library) with `SOFTHSM2_CONF` naming a
  /// configuration whose token directory is empty and writable. It
  /// initialises a token, creates an EC and an RSA key with a certificate
  /// object each, signs through the helper's own path and verifies both
  /// signatures independently, which also checks the RSA `DigestInfo`.
  ///
  /// `SOFTHSM2_MODULE=$(brew --prefix softhsm)/lib/softhsm/libsofthsm2.so
  /// SOFTHSM2_CONF=/tmp/softhsm2.conf cargo test -p stella-pkcs11-helper --
  /// --ignored`
  #[test]
  #[ignore = "needs SoftHSM2; see the doc comment"]
  fn signs_with_a_softhsm_token() {
    use cryptoki::object::CertificateType;
    use ring::signature::{
      ECDSA_P256_SHA256_ASN1, RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents,
      UnparsedPublicKey,
    };

    const SO_PIN: &str = "so-pin-1234";
    const USER_PIN: &str = "user-pin-1234";
    /// prime256v1 (1.2.840.10045.3.1.7).
    const P256: &[u8] = &[0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07];
    const EC_CERTIFICATE: &[u8] =
      include_bytes!("../../signing-core/fixtures/ec-certificate.der");
    const RSA_CERTIFICATE: &[u8] =
      include_bytes!("../../signing-core/fixtures/rsa-certificate.der");

    let module = PathBuf::from(
      std::env::var("SOFTHSM2_MODULE").expect("SOFTHSM2_MODULE names libsofthsm2"),
    );
    let pkcs11 = open(&module).unwrap();
    let slot = pkcs11.get_slots_with_token().unwrap().remove(0);
    pkcs11
      .init_token(slot, &AuthPin::new(SO_PIN.into()), "stella test")
      .unwrap();
    let session = pkcs11.open_rw_session(slot).unwrap();
    session
      .login(UserType::So, Some(&AuthPin::new(SO_PIN.into())))
      .unwrap();
    session.init_pin(&AuthPin::new(USER_PIN.into())).unwrap();
    session.logout().unwrap();
    session
      .login(UserType::User, Some(&AuthPin::new(USER_PIN.into())))
      .unwrap();

    let store_certificate = |id: &[u8], der: &[u8]| {
      session
        .create_object(&[
          Attribute::Class(ObjectClass::CERTIFICATE),
          Attribute::CertificateType(CertificateType::X_509),
          Attribute::Token(true),
          Attribute::Id(id.to_vec()),
          Attribute::Subject(b"stella test".to_vec()),
          Attribute::Value(der.to_vec()),
        ])
        .unwrap();
    };
    let private_template = |id: &[u8]| {
      vec![
        Attribute::Token(true),
        Attribute::Private(true),
        Attribute::Sensitive(true),
        Attribute::Sign(true),
        Attribute::Id(id.to_vec()),
      ]
    };
    let (ec_public, _) = session
      .generate_key_pair(
        &Mechanism::EccKeyPairGen,
        &[
          Attribute::Token(true),
          Attribute::Verify(true),
          Attribute::EcParams(P256.to_vec()),
          Attribute::Id(vec![1]),
        ],
        &private_template(&[1]),
      )
      .unwrap();
    store_certificate(&[1], EC_CERTIFICATE);
    let (rsa_public, _) = session
      .generate_key_pair(
        &Mechanism::RsaPkcsKeyPairGen,
        &[
          Attribute::Token(true),
          Attribute::Verify(true),
          Attribute::ModulusBits(2048.into()),
          Attribute::PublicExponent(vec![0x01, 0x00, 0x01]),
          Attribute::Id(vec![2]),
        ],
        &private_template(&[2]),
      )
      .unwrap();
    store_certificate(&[2], RSA_CERTIFICATE);

    let ec_point = match session
      .get_attributes(ec_public, &[AttributeType::EcPoint])
      .unwrap()
      .remove(0)
    {
      // An OCTET STRING around the uncompressed point.
      Attribute::EcPoint(point) => point[2..].to_vec(),
      other => panic!("{other:?}"),
    };
    let mut modulus = Vec::new();
    let mut exponent = Vec::new();
    for attribute in session
      .get_attributes(
        rsa_public,
        &[AttributeType::Modulus, AttributeType::PublicExponent],
      )
      .unwrap()
    {
      match attribute {
        Attribute::Modulus(value) => modulus = value,
        Attribute::PublicExponent(value) => exponent = value,
        _ => {}
      }
    }
    session.logout().unwrap();
    drop(session);

    let Response::Listed { modules } = list(std::slice::from_ref(&module)) else {
      panic!("not a listing");
    };
    let ModuleOutcome::Loaded { tokens } = &modules[0].outcome else {
      panic!("module did not load");
    };
    let token = tokens
      .iter()
      .find(|token| token.label == "stella test")
      .unwrap();
    assert_eq!(token.pin_entry, PinEntry::Keyboard);
    assert_eq!(token.certificates.len(), 2);
    assert!(
      token
        .certificates
        .iter()
        .all(|certificate| certificate.key.can_sign())
    );

    let message = b"stella signs this";
    let digest_hex = hex::encode(Sha256::digest(message));
    let sign_with = |certificate: &[u8], key_type: KeyType, pin: &str| {
      sign(&SignRequest {
        module: module.clone(),
        certificate_sha256: hex::encode(Sha256::digest(certificate)),
        digest_hex: digest_hex.clone(),
        key_type,
        pin: Some(Pin::new(zeroize::Zeroizing::new(pin.to_string()))),
      })
    };

    let Response::Signed { signature_hex } =
      sign_with(EC_CERTIFICATE, KeyType::Ec, USER_PIN)
    else {
      panic!("no EC signature");
    };
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, &ec_point)
      .verify(message, &hex::decode(signature_hex).unwrap())
      .unwrap();

    let Response::Signed { signature_hex } =
      sign_with(RSA_CERTIFICATE, KeyType::Rsa, USER_PIN)
    else {
      panic!("no RSA signature");
    };
    RsaPublicKeyComponents {
      n: &modulus,
      e: &exponent,
    }
    .verify(
      &RSA_PKCS1_2048_8192_SHA256,
      message,
      &hex::decode(signature_hex).unwrap(),
    )
    .unwrap();

    let refused = sign_with(EC_CERTIFICATE, KeyType::Ec, "wrong");
    assert!(
      matches!(
        &refused,
        Response::Failed { code, pin_retries: Some(_), .. } if code == "pin_incorrect"
      ),
      "{refused:?}"
    );
  }
}
