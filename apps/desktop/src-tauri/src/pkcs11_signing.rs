//! Smart cards and USB tokens that reach macOS only through their vendor's
//! PKCS #11 module.
//!
//! The module is native code from the card's vendor. It never loads into
//! this process: `stella-pkcs11-helper`, bundled beside the app's own
//! executable, loads it, answers one request and exits. Each call here starts
//! the helper, writes the request, reads the answer, and kills the helper if
//! it does not answer in time (a vendor module can hang on a reader that
//! stopped responding).
//!
//! The certificates the helper finds go through the same filter as the
//! keychain's ([`stella_desktop_signing_core::signing_identity`]), so a card
//! offers what the keychain would offer for the same certificate. A card in a
//! reader that no module turns into a token is named by its ATR, with the
//! driver it needs.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use stella_desktop_pkcs11::atr::driver_for_atr;
use stella_desktop_pkcs11::drivers::{
  InstalledModule, ModuleOrigin, installed_modules, known_driver,
};
use stella_desktop_pkcs11::macho::ModuleCheck;
use stella_desktop_pkcs11::protocol::{
  MAX_RESPONSE_BYTES, ModuleOutcome, Pin, PinEntry, PinRetries, ReaderCard, ReaderScan,
  Request, Response, SignRequest, TokenListing, decode_response, encode,
};
use stella_desktop_signing_core::{
  SigningErrorCode, SigningIdentity, issuer_chain, signing_identity,
  subject_display_name,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HELPER_NAME: &str = "stella-pkcs11-helper";
/// Loading and initialising a module, then reading each token's
/// certificates: a few seconds for a slow card, never this long.
const LISTING_TIMEOUT: Duration = Duration::from_secs(15);
/// A PIN pad waits on the user's fingers. Kept under the signing flow's own
/// limit, so the helper is killed before the flow gives up on it.
const SIGNING_TIMEOUT: Duration = Duration::from_secs(170);

/// Failures the token path reports itself. Neither names the keychain: the
/// card is what failed.
pub const CODE_TOKEN_TIMEOUT: &str = "token_timeout";
pub const CODE_TOKEN_SIGNING_FAILED: &str = "token_signing_failed";

/// Where a certificate offered from a token lives, so the signature goes to
/// the module and token that listed it.
#[derive(Clone, Debug)]
pub struct TokenSource {
  pub module: PathBuf,
  pub slot: u64,
  pub token_label: String,
  pub pin_entry: PinEntry,
  pub pin_retries: PinRetries,
}

#[derive(Debug)]
pub struct TokenIdentity {
  pub identity: SigningIdentity,
  pub source: TokenSource,
}

/// Something the dialog should tell the user about an installed driver.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverNotice {
  pub driver_id: &'static str,
  pub vendor: &'static str,
  pub kind: DriverNoticeKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DriverNoticeKind {
  /// Installed, but not built for this Mac's processor.
  NeedsUpdate,
  /// A card of this vendor is in a reader, and its driver is not installed.
  Missing,
}

/// What the tokens offer, and what the dialog should say about the drivers
/// that could not be asked.
#[derive(Debug, Default)]
pub struct TokenScan {
  pub identities: Vec<TokenIdentity>,
  pub notices: Vec<DriverNotice>,
}

/// Why the helper gave no answer.
#[derive(Debug)]
pub enum HelperFailure {
  /// This build has no helper beside the app (not macOS, or a development
  /// build that did not compile it).
  Missing,
  TimedOut,
  /// It could not be started, or exited without an answer.
  Failed(String),
}

impl std::fmt::Display for HelperFailure {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Missing => write!(f, "{HELPER_NAME} is not installed beside the app"),
      Self::TimedOut => write!(f, "{HELPER_NAME} did not answer in time"),
      Self::Failed(detail) => write!(f, "{HELPER_NAME} failed: {detail}"),
    }
  }
}

/// A token that did not sign. `code` is the dialog's code; `pin_retries` is
/// the token's state after a refused PIN.
#[derive(Debug)]
pub struct TokenSignFailure {
  pub code: &'static str,
  pub detail: String,
  pub pin_retries: Option<PinRetries>,
}

/// Every signing identity on a token an installed driver can read, at `now`
/// (Unix seconds), and what the dialog should say about drivers. `chosen` is
/// the module the user picked in the settings, if any. Without a helper
/// (another platform, a development build that did not compile it) and
/// without a loadable module, nothing starts.
pub async fn scan(
  now: i64,
  chosen: Option<PathBuf>,
) -> Result<TokenScan, HelperFailure> {
  let installed =
    tokio::task::spawn_blocking(move || installed_modules(chosen.as_deref()))
      .await
      .map_err(|error| HelperFailure::Failed(error.to_string()))?;
  let installed_drivers: Vec<&'static str> = installed
    .iter()
    .filter_map(|module| match module.origin {
      ModuleOrigin::Known(driver) => Some(driver.id),
      ModuleOrigin::Chosen => None,
    })
    .collect();
  let (loadable, mut notices) = sort_installed(installed);
  if loadable.is_empty() && helper_path().is_none() {
    return Ok(TokenScan {
      identities: Vec::new(),
      notices,
    });
  }
  // Even with no module to load, the helper reads the readers, so a card
  // whose driver is missing can be named.
  let response = run(&Request::List { modules: loadable }, LISTING_TIMEOUT).await?;
  let Response::Listed { modules, readers } = response else {
    return Err(HelperFailure::Failed(
      "the helper answered a listing with something else".to_string(),
    ));
  };
  let mut identities = Vec::new();
  let mut read_slots: Vec<String> = Vec::new();
  for listing in modules {
    match listing.outcome {
      ModuleOutcome::Loaded { tokens } => {
        for token in tokens {
          if !token.certificates.is_empty() {
            read_slots.push(token.slot_description.clone());
          }
          identities.extend(token_identities(&listing.module, token, now));
        }
      }
      ModuleOutcome::Unusable { detail } => {
        tracing::warn!(module = %listing.module.display(), %detail, "PKCS #11 module could not be used");
      }
    }
  }
  match readers {
    ReaderScan::Read { cards } => {
      notices.extend(missing_drivers(&cards, &read_slots, &installed_drivers));
    }
    ReaderScan::Unavailable { detail } => {
      tracing::info!(%detail, "smart card readers could not be read");
    }
  }
  Ok(TokenScan {
    identities,
    notices,
  })
}

/// A notice for each card in a reader that no module read certificates
/// from, whose ATR names a driver that is not installed. A card no module
/// read but whose driver is installed is that driver's to explain (it may
/// hold no certificate at all); a card the table does not know is left
/// alone rather than guessed at.
fn missing_drivers(
  cards: &[ReaderCard],
  read_slots: &[String],
  installed_drivers: &[&str],
) -> Vec<DriverNotice> {
  let mut notices: Vec<DriverNotice> = Vec::new();
  for card in cards {
    if read_slots
      .iter()
      .any(|slot| same_reader(&card.reader, slot))
    {
      continue;
    }
    let Some(driver) = hex::decode(&card.atr_hex)
      .ok()
      .and_then(|atr| driver_for_atr(&atr))
      .and_then(known_driver)
    else {
      continue;
    };
    if installed_drivers.contains(&driver.id)
      || notices.iter().any(|notice| notice.driver_id == driver.id)
    {
      continue;
    }
    notices.push(DriverNotice {
      driver_id: driver.id,
      vendor: driver.vendor,
      kind: DriverNoticeKind::Missing,
    });
  }
  notices
}

/// Whether a PKCS #11 slot description names this PC/SC reader. A slot
/// description is at most 64 characters, so a long reader name arrives cut
/// short.
fn same_reader(reader: &str, slot_description: &str) -> bool {
  let (reader, slot) = (reader.trim(), slot_description.trim());
  !slot.is_empty() && (reader.starts_with(slot) || slot.starts_with(reader))
}

/// The modules to hand the helper, and a notice for each known one that
/// cannot load into it. A chosen module's problems are the settings' to show.
fn sort_installed(
  installed: Vec<InstalledModule>,
) -> (Vec<PathBuf>, Vec<DriverNotice>) {
  let mut loadable = Vec::new();
  let mut notices = Vec::new();
  for module in installed {
    match (module.check, module.origin) {
      (ModuleCheck::Loadable, _) => loadable.push(module.path),
      (ModuleCheck::MissingArchitecture { found }, ModuleOrigin::Known(driver)) => {
        tracing::info!(module = %module.path.display(), ?found, "PKCS #11 module is not built for this processor");
        notices.push(DriverNotice {
          driver_id: driver.id,
          vendor: driver.vendor,
          kind: DriverNoticeKind::NeedsUpdate,
        });
      }
      (ModuleCheck::MissingArchitecture { found }, ModuleOrigin::Chosen) => {
        tracing::info!(module = %module.path.display(), ?found, "the chosen PKCS #11 module is not built for this processor");
      }
      (ModuleCheck::NotALibrary, _) => {
        tracing::warn!(module = %module.path.display(), "PKCS #11 module path holds no Mach-O library");
      }
    }
  }
  (loadable, notices)
}

/// The identities one token offers. Every certificate on the token is a
/// candidate issuer for the chain; only one with a key can sign.
fn token_identities(
  module: &std::path::Path,
  token: TokenListing,
  now: i64,
) -> Vec<TokenIdentity> {
  let certificates: Vec<(Vec<u8>, String, bool)> = token
    .certificates
    .into_iter()
    .filter_map(|certificate| {
      let der = hex::decode(&certificate.der_hex).ok()?;
      Some((der, certificate.label, certificate.key.can_sign()))
    })
    .collect();
  let pool: Vec<Vec<u8>> = certificates.iter().map(|(der, ..)| der.clone()).collect();
  let source = TokenSource {
    module: module.to_path_buf(),
    slot: token.slot,
    token_label: token.label,
    pin_entry: token.pin_entry,
    pin_retries: token.pin_retries,
  };
  certificates
    .into_iter()
    .filter(|(.., can_sign)| *can_sign)
    .filter_map(|(der, label, _)| {
      let summary = subject_display_name(&der).unwrap_or(label);
      let chain_source = der.clone();
      signing_identity(der, &summary, || issuer_chain(&chain_source, &pool), now)
    })
    .map(|identity| TokenIdentity {
      identity,
      source: source.clone(),
    })
    .collect()
}

/// Sign a SHA-256 digest on the token that listed `identity`. `pin` is
/// `None` for a PIN pad or a token that needs no login.
pub async fn sign(
  source: &TokenSource,
  identity: &SigningIdentity,
  digest: &[u8; 32],
  pin: Option<Pin>,
) -> Result<Vec<u8>, TokenSignFailure> {
  tracing::info!(
    module = %source.module.display(),
    slot = source.slot,
    "signing on a PKCS #11 token"
  );
  let request = Request::Sign(SignRequest {
    module: source.module.clone(),
    certificate_sha256: identity.id.clone(),
    digest_hex: hex::encode(digest),
    key_type: identity.key_type.into(),
    pin,
  });
  let response =
    run(&request, SIGNING_TIMEOUT)
      .await
      .map_err(|failure| TokenSignFailure {
        code: match failure {
          HelperFailure::TimedOut => CODE_TOKEN_TIMEOUT,
          HelperFailure::Missing | HelperFailure::Failed(_) => {
            CODE_TOKEN_SIGNING_FAILED
          }
        },
        detail: failure.to_string(),
        pin_retries: None,
      })?;
  match response {
    Response::Signed { signature_hex } => {
      hex::decode(signature_hex).map_err(|error| TokenSignFailure {
        code: CODE_TOKEN_SIGNING_FAILED,
        detail: format!("unreadable signature: {error}"),
        pin_retries: None,
      })
    }
    Response::Failed {
      code,
      detail,
      pin_retries,
    } => Err(TokenSignFailure {
      code: dialog_code(&code),
      detail,
      pin_retries,
    }),
    Response::Listed { .. } => Err(TokenSignFailure {
      code: CODE_TOKEN_SIGNING_FAILED,
      detail: "the helper answered a signature with a listing".to_string(),
      pin_retries: None,
    }),
  }
}

/// The dialog's code for a helper failure: the signer's own codes where the
/// wording fits a card, a token-specific one where the signer's names the
/// keychain.
fn dialog_code(helper_code: &str) -> &'static str {
  match SigningErrorCode::from_wire(helper_code) {
    Some(
      code @ (SigningErrorCode::Cancelled
      | SigningErrorCode::PinIncorrect
      | SigningErrorCode::PinLocked
      | SigningErrorCode::TokenNotPresent
      | SigningErrorCode::KeyNotFound
      | SigningErrorCode::UnsupportedAlgorithm),
    ) => code.as_str(),
    Some(
      SigningErrorCode::KeychainLocked
      | SigningErrorCode::KeychainTimeout
      | SigningErrorCode::AuthenticationRequired
      | SigningErrorCode::UnsupportedPlatform
      | SigningErrorCode::KeychainUnavailable
      | SigningErrorCode::SigningFailed,
    )
    | None => CODE_TOKEN_SIGNING_FAILED,
  }
}

fn helper_path() -> Option<PathBuf> {
  if !cfg!(target_os = "macos") {
    return None;
  }
  let path = std::env::current_exe().ok()?.parent()?.join(HELPER_NAME);
  path.is_file().then_some(path)
}

/// One request, one helper process. Dropping the exchange (a timeout) kills
/// the helper.
async fn run(request: &Request, timeout: Duration) -> Result<Response, HelperFailure> {
  let helper = helper_path().ok_or(HelperFailure::Missing)?;
  let encoded =
    encode(request).map_err(|error| HelperFailure::Failed(error.to_string()))?;
  let mut child = tokio::process::Command::new(helper)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    // A vendor module may write anything to stderr; none of it is ours to
    // keep.
    .stderr(Stdio::null())
    .kill_on_drop(true)
    .spawn()
    .map_err(|error| HelperFailure::Failed(error.to_string()))?;
  let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take())
  else {
    return Err(HelperFailure::Failed("no pipes to the helper".to_string()));
  };
  let exchange = async move {
    stdin
      .write_all(&encoded)
      .await
      .map_err(|error| HelperFailure::Failed(error.to_string()))?;
    drop(stdin);
    drop(encoded);
    let mut output = Vec::new();
    let limit = u64::try_from(MAX_RESPONSE_BYTES + 1).unwrap_or(u64::MAX);
    stdout
      .take(limit)
      .read_to_end(&mut output)
      .await
      .map_err(|error| HelperFailure::Failed(error.to_string()))?;
    let status = child
      .wait()
      .await
      .map_err(|error| HelperFailure::Failed(error.to_string()))?;
    if output.is_empty() {
      return Err(HelperFailure::Failed(format!(
        "exited without an answer ({status})"
      )));
    }
    decode_response(&output).map_err(|error| HelperFailure::Failed(error.to_string()))
  };
  tokio::time::timeout(timeout, exchange)
    .await
    .map_err(|_elapsed| HelperFailure::TimedOut)?
}

#[cfg(test)]
mod tests {
  use stella_desktop_pkcs11::drivers::KNOWN_DRIVERS;
  use stella_desktop_pkcs11::macho::Architecture;
  use stella_desktop_pkcs11::protocol::{CertificateKey, TokenCertificate};

  use super::*;

  const SIGNING: &[u8] =
    include_bytes!("../crates/signing-core/fixtures/signing-certificate.der");
  const CODE_SIGNING: &[u8] =
    include_bytes!("../crates/signing-core/fixtures/code-signing-certificate.der");
  /// 2026-06-01T00:00:00Z.
  const NOW: i64 = 1_780_272_000;

  fn certificate(der: &[u8], key: CertificateKey) -> TokenCertificate {
    TokenCertificate {
      der_hex: hex::encode(der),
      label: "Card label".to_string(),
      key,
    }
  }

  fn token(certificates: Vec<TokenCertificate>) -> TokenListing {
    TokenListing {
      slot: 2,
      slot_description: "Reader 0".to_string(),
      label: "Signing card".to_string(),
      pin_entry: PinEntry::Keyboard,
      pin_retries: PinRetries::Low,
      certificates,
    }
  }

  #[test]
  fn offers_a_token_certificate_through_the_shared_filter() {
    let identities = token_identities(
      std::path::Path::new("/m.dylib"),
      token(vec![
        certificate(SIGNING, CertificateKey::BehindLogin),
        // Made for code: the filter leaves it out, key or not.
        certificate(CODE_SIGNING, CertificateKey::Paired),
        // No key: a chain candidate only.
        certificate(SIGNING, CertificateKey::Absent),
        certificate(b"not der", CertificateKey::Paired),
      ]),
      NOW,
    );

    assert_eq!(identities.len(), 1);
    let offered = &identities[0];
    // Named after the certificate's subject, not the card's label.
    assert_eq!(offered.identity.label, "Jane Counsel");
    assert_eq!(offered.source.module, PathBuf::from("/m.dylib"));
    assert_eq!(offered.source.slot, 2);
    assert_eq!(offered.source.token_label, "Signing card");
    assert_eq!(offered.source.pin_retries, PinRetries::Low);
  }

  #[test]
  fn a_driver_built_for_another_processor_becomes_a_notice() {
    let driver = &KNOWN_DRIVERS[0];
    let known = ModuleOrigin::Known(driver);
    let (loadable, notices) = sort_installed(vec![
      InstalledModule {
        origin: known,
        path: PathBuf::from("/a.dylib"),
        check: ModuleCheck::Loadable,
      },
      InstalledModule {
        origin: known,
        path: PathBuf::from("/b.dylib"),
        check: ModuleCheck::MissingArchitecture {
          found: vec![Architecture::X86_64],
        },
      },
      InstalledModule {
        origin: known,
        path: PathBuf::from("/c.dylib"),
        check: ModuleCheck::NotALibrary,
      },
      // The settings explain a chosen module; the dialog does not.
      InstalledModule {
        origin: ModuleOrigin::Chosen,
        path: PathBuf::from("/d.dylib"),
        check: ModuleCheck::MissingArchitecture {
          found: vec![Architecture::X86_64],
        },
      },
      InstalledModule {
        origin: ModuleOrigin::Chosen,
        path: PathBuf::from("/e.dylib"),
        check: ModuleCheck::Loadable,
      },
    ]);

    assert_eq!(
      loadable,
      vec![PathBuf::from("/a.dylib"), PathBuf::from("/e.dylib")]
    );
    assert_eq!(
      notices,
      vec![DriverNotice {
        driver_id: driver.id,
        vendor: driver.vendor,
        kind: DriverNoticeKind::NeedsUpdate,
      }]
    );
  }

  const ICA_ATR: &str = "3bda96ff81b1fe451f0780584943412056322e30e9";
  const EOP_ATR: &str = "3b7e9400008025d20310010056000000020200";

  fn card(reader: &str, atr_hex: &str) -> ReaderCard {
    ReaderCard {
      reader: reader.to_string(),
      atr_hex: atr_hex.to_string(),
    }
  }

  #[test]
  fn names_the_missing_driver_of_a_card_no_module_read() {
    let notices = missing_drivers(
      &[
        card("Alcor Micro AU9540 00 00", ICA_ATR),
        // Read by a module already: nothing to say.
        card("Identiv uTrust 2700 R Smart Card Reader", EOP_ATR),
        // Unknown card: not guessed at.
        card("Generic Reader", "3b00"),
        // Same vendor twice: one notice.
        card("Second Reader", ICA_ATR),
      ],
      &["Identiv uTrust 2700 R Smart Card Reader".to_string()],
      &[],
    );

    let ica = known_driver("ica-securestore").unwrap();
    assert_eq!(
      notices,
      vec![DriverNotice {
        driver_id: ica.id,
        vendor: ica.vendor,
        kind: DriverNoticeKind::Missing,
      }]
    );
  }

  #[test]
  fn an_installed_driver_is_never_reported_missing() {
    assert!(
      missing_drivers(&[card("Reader", ICA_ATR)], &[], &["ica-securestore"]).is_empty()
    );
  }

  #[test]
  fn matches_a_reader_to_a_slot_description_cut_short() {
    let reader = "Identiv uTrust 4701 F Dual Interface Reader(1) with a very long name";
    let slot = &reader[..64];
    assert!(same_reader(reader, slot));
    assert!(same_reader("Reader 0", "  Reader 0  "));
    assert!(!same_reader("Reader 0", ""));
    assert!(!same_reader("Reader 0", "Reader 1"));
  }

  #[test]
  fn a_token_failure_never_names_the_keychain() {
    assert_eq!(dialog_code("pin_incorrect"), "pin_incorrect");
    assert_eq!(dialog_code("token_not_present"), "token_not_present");
    assert_eq!(dialog_code("signing_failed"), CODE_TOKEN_SIGNING_FAILED);
    assert_eq!(dialog_code("keychain_timeout"), CODE_TOKEN_SIGNING_FAILED);
    assert_eq!(dialog_code("unheard_of"), CODE_TOKEN_SIGNING_FAILED);
  }

  #[test]
  fn serializes_a_notice_as_the_dialog_reads_it() {
    assert_eq!(
      serde_json::to_string(&DriverNotice {
        driver_id: "opensc",
        vendor: "OpenSC",
        kind: DriverNoticeKind::NeedsUpdate,
      })
      .unwrap(),
      r#"{"driverId":"opensc","vendor":"OpenSC","kind":"needsUpdate"}"#
    );
    assert_eq!(
      serde_json::to_value(DriverNoticeKind::Missing).unwrap(),
      "missing"
    );
  }
}
