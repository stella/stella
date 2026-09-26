//! Signing a PDF with a certificate that never leaves the user's keychain.
//!
//! The web app hands the desktop a one-shot handoff token over a deep link.
//! Redeeming it yields a short-lived session token, and the desktop then runs
//! the signature in two round trips: the API turns the chosen certificate
//! into the bytes to sign, the keychain signs them, the API embeds the
//! signature and stores the result as a new version.
//!
//! Rust owns the flow end to end; the dialog picks a certificate and reports
//! what happened. The session token lives in this module's stack for the
//! length of one flow: it is never persisted, never logged, and never reaches
//! the webview.

use std::sync::Arc;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use stella_desktop_macos_signing::{SigningIdentity, SigningKeyType};
use tauri::AppHandle;
use tokio::sync::{Mutex, oneshot};

use crate::config;
use crate::http_client::{DesktopHttpClient, HttpClientOptions};
use crate::session_manager::SessionManager;
use crate::types::{ErrorResponse, is_safe_session_id};

const REDEEM_TIMEOUT: Duration = Duration::from_secs(20);
/// The certificate and signature phases each run a PDF signing pass on the
/// server, which is slower than a plain request.
const SIGNING_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the picker may sit unanswered. The session token outlives it, so
/// a user who steps away loses the dialog rather than a half-open session.
const DIALOG_TIMEOUT: Duration = Duration::from_secs(300);
/// Enumerating the keychain is local work; a wait past this means the
/// keychain is wedged.
const IDENTITY_LISTING_TIMEOUT: Duration = Duration::from_secs(20);
/// Signing blocks on the user's keychain consent prompt the first time this
/// binary uses a key.
const SIGNING_TIMEOUT: Duration = Duration::from_secs(180);
/// How long the confirmed version number stays on screen before the dialog is
/// taken down.
const SIGNED_DIALOG_LINGER: Duration = Duration::from_secs(2);
/// Finalizations the dialog offers before giving up. The API caps attempts
/// at the same number and closes the session after the last one.
const MAX_FINALIZE_ATTEMPTS: u32 = 3;

const DIALOG_LABEL: &str = "pdf-sign-dialog";
const DIALOG_WIDTH: f64 = 420.0;
const DIALOG_HEIGHT: f64 = 470.0;

const DIGEST_ALGORITHM: &str = "SHA-256";
const DIGEST_BYTES: usize = 32;

/// The close reasons the API accepts. The desktop only ever reports the two
/// it can observe on its own; the rest are the API's to set.
const REASON_USER_CANCELLED: &str = "user_cancelled";
const REASON_UNSUPPORTED_PLATFORM: &str = "unsupported_platform";

/// The single in-flight dialog's channels. One window label means one flow at
/// a time, so a second deep link is turned away rather than stacked.
static DIALOG_BRIDGE: std::sync::Mutex<Option<DialogBridge>> =
  std::sync::Mutex::new(None);

struct DialogBridge {
  choice: oneshot::Sender<DialogChoice>,
  outcome: oneshot::Receiver<PdfSignResult>,
}

/// What the dialog's buttons mean to the flow.
pub enum DialogChoice {
  Sign {
    identity_id: String,
  },
  /// Finalize again with the signature already made: no new PIN.
  Retry,
  Cancel,
}

/// The dialog's request, as it arrives from the webview.
#[derive(serde::Deserialize)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "action"
)]
pub enum PdfSignDialogResponse {
  Sign { identity_id: String },
  Retry,
  Cancel,
}

/// What the dialog renders once the flow is done.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(
  rename_all = "camelCase",
  rename_all_fields = "camelCase",
  tag = "status"
)]
pub enum PdfSignResult {
  Cancelled,
  Signed {
    version_number: i64,
  },
  /// `retryable`: the API kept the session and the signature, so the dialog
  /// offers to finalize again instead of only closing.
  Failed {
    message: String,
    retryable: bool,
  },
}

/// Why the dialog opened at all: what it can offer the user.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum DialogState {
  /// At least one keychain identity can sign.
  Ready,
  /// macOS, but nothing in the keychain to sign with.
  NoIdentities,
  /// Not macOS: signing is not available at all.
  UnsupportedPlatform,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DialogIdentity<'a> {
  id: &'a str,
  label: &'a str,
  issuer: Option<&'a str>,
  /// `YYYY-MM-DD`; the dialog formats it in the app's language.
  expires_on: &'a str,
}

/// Everything the dialog renders. The session token is deliberately absent:
/// it stays in Rust for the length of the flow.
struct DialogContent<'a> {
  /// The API asking for the signature, shown so the user sees who asks.
  api_base_url: &'a str,
  document_name: &'a str,
  /// Where the signature will be visible, so consent covers what shows.
  stamp_page_number: Option<i64>,
  identities: &'a [SigningIdentity],
  state: DialogState,
  version_number: i64,
  workspace_name: &'a str,
}

/// Hand the dialog's choice to the waiting flow and take the channel the flow
/// reports back on. `None` when no flow is waiting: a second click, or a
/// dialog that outlived the flow that opened it.
pub fn submit_dialog_choice(
  choice: DialogChoice,
) -> Option<oneshot::Receiver<PdfSignResult>> {
  let bridge = DIALOG_BRIDGE
    .lock()
    .unwrap_or_else(|e| e.into_inner())
    .take()?;
  bridge.choice.send(choice).ok()?;
  Some(bridge.outcome)
}

/// Release a dialog that was closed with the window control rather than with
/// a button, so the flow does not wait out its timeout.
fn cancel_dialog() {
  if let Some(bridge) = DIALOG_BRIDGE
    .lock()
    .unwrap_or_else(|e| e.into_inner())
    .take()
  {
    let _ = bridge.choice.send(DialogChoice::Cancel);
  }
}

fn reserve_dialog(bridge: DialogBridge) -> Result<(), ()> {
  let mut guard = DIALOG_BRIDGE.lock().unwrap_or_else(|e| e.into_inner());
  if guard.is_some() {
    return Err(());
  }
  *guard = Some(bridge);
  Ok(())
}

// --- Wire types ---

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RedeemRequest<'a> {
  handoff_token: &'a str,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedeemResponse {
  session_id: String,
  session_token: String,
  api_base_url: String,
  document_name: String,
  version_number: i64,
  workspace_name: String,
  /// 1-based page of the visible stamp; absent or null signs invisibly.
  #[serde(default)]
  stamp_page_number: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CertificateRequest<'a> {
  session_token: &'a str,
  certificate: String,
  certificate_chain: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CertificateResponse {
  digest_hex: String,
  digest_algorithm: String,
  signature_algorithm: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SignatureRequest<'a> {
  session_token: &'a str,
  signature: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureResponse {
  version_number: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequest<'a> {
  session_token: &'a str,
  reason: &'a str,
}

/// A failed step, and what is left of the session it failed in.
#[derive(Debug)]
struct StepError {
  message: String,
  /// Still open, so the desktop must cancel it if it gives up.
  session_left_open: bool,
  /// Still open with the signature kept: finalizing again may succeed.
  retryable: bool,
}

impl StepError {
  /// A local failure: nothing reached the API, so the session is still open.
  fn local(message: String) -> Self {
    Self {
      message,
      session_left_open: true,
      retryable: false,
    }
  }

  /// The API may or may not have the signature; either way posting it again
  /// is safe, since the API only ever accepts the one it verified first.
  fn retryable(message: String) -> Self {
    Self {
      message,
      session_left_open: true,
      retryable: true,
    }
  }
}

/// The statuses the API answers with only after closing the session itself:
/// gone, diverged from the base version, or a certificate it will not accept.
/// Anything else (a timeout, a gateway error) leaves the session open for the
/// desktop to cancel.
fn api_closed_session(status: reqwest::StatusCode) -> bool {
  matches!(status.as_u16(), 404 | 409 | 410 | 413 | 422)
}

/// The status the API finalizes with when it kept the session open and the
/// signature with it, for a retry.
fn api_kept_signature(status: reqwest::StatusCode) -> bool {
  status == reqwest::StatusCode::SERVICE_UNAVAILABLE
}

/// Whether `api_base_url` names a loopback host (`localhost`, 127.0.0.0/8,
/// `::1`).
fn is_loopback_api(api_base_url: &str) -> bool {
  let Ok(parsed) = reqwest::Url::parse(api_base_url) else {
    return false;
  };
  let Some(host) = parsed.host_str() else {
    return false;
  };
  let host = host.trim_start_matches('[').trim_end_matches(']');
  host.eq_ignore_ascii_case("localhost")
    || host
      .parse::<std::net::IpAddr>()
      .is_ok_and(|address| address.is_loopback())
}

/// Whether an API origin may ask this desktop for a signature.
///
/// Stricter than opening a document: a signature is produced from whatever
/// digest the API hands over, so a local process that merely listens on the
/// development port must not be able to ask for one. Loopback APIs count
/// only in development builds or once the user approved them explicitly as
/// a self-hosted stella; everything else must be a built-in API or such an
/// approved one.
fn trusted_for_signing(
  api_base_url: &str,
  built_in: &std::collections::HashSet<String>,
  approved_by_user: bool,
  development_build: bool,
) -> bool {
  if approved_by_user {
    return true;
  }
  if is_loopback_api(api_base_url) {
    return development_build;
  }
  built_in.contains(api_base_url)
}

pub async fn api_trusted_for_signing(
  manager: &Mutex<SessionManager>,
  api_base_url: &str,
) -> bool {
  let approved_by_user = manager
    .lock()
    .await
    .is_trusted_self_host_api_base_url(api_base_url);
  trusted_for_signing(
    api_base_url,
    &config::resolve_trusted_api_base_urls(),
    approved_by_user,
    cfg!(debug_assertions),
  )
}

/// Entry point from the deep-link handler.
pub async fn redeem_and_sign(
  manager: Arc<Mutex<SessionManager>>,
  app_handle: AppHandle,
  api_base_url: String,
  handoff_token: String,
) -> Result<(), String> {
  // The handoff token travels in the request body; a redirect would replay it
  // to another origin, so handoff requests never follow one.
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: None,
  })
  .map_err(|e| format!("stella desktop could not start the signing client: {e}"))?;

  let redeemed = redeem(&client, &api_base_url, &handoff_token).await?;
  if !is_safe_session_id(&redeemed.session_id) {
    return Err("Invalid PDF signing session payload.".to_string());
  }
  // The API names the origin the session lives on; it only counts if the user
  // already trusts it, exactly as the deep link's own origin had to.
  let session_api_base_url =
    config::normalize_self_host_api_base_url(&redeemed.api_base_url)
      .map_err(|_| "Invalid PDF signing API URL.".to_string())?;
  if !api_trusted_for_signing(&manager, &session_api_base_url).await {
    return Err("PDF signing session names an untrusted API URL.".to_string());
  }

  let session = SigningSession {
    api_base_url: session_api_base_url,
    client,
    id: redeemed.session_id,
    token: redeemed.session_token,
  };

  let identities = list_identities().await;
  let state = match &identities {
    Ok(identities) if identities.is_empty() => DialogState::NoIdentities,
    Ok(_) => DialogState::Ready,
    Err(_) => DialogState::UnsupportedPlatform,
  };
  let identities = identities.unwrap_or_default();

  let (choice_sender, choice_receiver) = oneshot::channel();
  let (outcome_sender, outcome_receiver) = oneshot::channel();
  if reserve_dialog(DialogBridge {
    choice: choice_sender,
    outcome: outcome_receiver,
  })
  .is_err()
  {
    session.cancel(REASON_USER_CANCELLED).await;
    return Err("A PDF signing dialog is already open.".to_string());
  }

  let content = DialogContent {
    api_base_url: &session.api_base_url,
    document_name: &redeemed.document_name,
    identities: &identities,
    stamp_page_number: redeemed.stamp_page_number,
    state,
    version_number: redeemed.version_number,
    workspace_name: &redeemed.workspace_name,
  };
  let window = match open_dialog(&app_handle, content) {
    Ok(window) => window,
    Err(error) => {
      cancel_dialog();
      session.cancel(REASON_USER_CANCELLED).await;
      return Err(error);
    }
  };

  let choice = match tokio::time::timeout(DIALOG_TIMEOUT, choice_receiver).await {
    Ok(Ok(choice)) => choice,
    // A dropped sender or an expired dialog both mean nobody chose.
    _ => {
      cancel_dialog();
      DialogChoice::Cancel
    }
  };

  let identity_id = match choice {
    DialogChoice::Sign { identity_id } => identity_id,
    // Nothing has been signed yet, so there is nothing to retry: a stray
    // retry reads as the user walking away.
    DialogChoice::Retry | DialogChoice::Cancel => {
      let reason = match state {
        DialogState::UnsupportedPlatform => REASON_UNSUPPORTED_PLATFORM,
        DialogState::NoIdentities | DialogState::Ready => REASON_USER_CANCELLED,
      };
      session.cancel(reason).await;
      let _ = outcome_sender.send(PdfSignResult::Cancelled);
      let _ = window.close();
      return Ok(());
    }
  };

  let Some(identity) = identities
    .into_iter()
    .find(|identity| identity.id == identity_id)
  else {
    let message = "stella desktop no longer has the chosen certificate.".to_string();
    session.cancel(REASON_USER_CANCELLED).await;
    let _ = outcome_sender.send(PdfSignResult::Failed {
      message: message.clone(),
      retryable: false,
    });
    return Err(message);
  };

  let signature = match prepare_signature(&session, &identity).await {
    Ok(signature) => signature,
    Err(error) => {
      report_failure(&session, error, outcome_sender).await;
      return Ok(());
    }
  };

  let mut outcome_sender = outcome_sender;
  let mut attempt = 1;
  loop {
    let error = match finalize(&session, &signature).await {
      Ok(version_number) => {
        let _ = outcome_sender.send(PdfSignResult::Signed { version_number });
        // The dialog is the receipt: it stays up long enough to be read,
        // then Rust takes it down. A webview cannot close a window it did
        // not open.
        tokio::time::sleep(SIGNED_DIALOG_LINGER).await;
        let _ = window.close();
        return Ok(());
      }
      Err(error) => error,
    };
    if !error.retryable || attempt >= MAX_FINALIZE_ATTEMPTS {
      report_failure(&session, error, outcome_sender).await;
      return Ok(());
    }

    // The next choice needs a bridge before the dialog learns it may retry,
    // or a quick click would find nothing waiting for it.
    let (choice_sender, choice_receiver) = oneshot::channel();
    let (next_outcome_sender, next_outcome_receiver) = oneshot::channel();
    if reserve_dialog(DialogBridge {
      choice: choice_sender,
      outcome: next_outcome_receiver,
    })
    .is_err()
    {
      report_failure(&session, error, outcome_sender).await;
      return Ok(());
    }
    tracing::warn!(error = %error.message, attempt, "PDF signing will be retried");
    let _ = outcome_sender.send(PdfSignResult::Failed {
      message: error.message,
      retryable: true,
    });
    outcome_sender = next_outcome_sender;

    match tokio::time::timeout(DIALOG_TIMEOUT, choice_receiver).await {
      Ok(Ok(DialogChoice::Retry)) => attempt += 1,
      _ => {
        cancel_dialog();
        session.cancel(REASON_USER_CANCELLED).await;
        let _ = outcome_sender.send(PdfSignResult::Cancelled);
        let _ = window.close();
        return Ok(());
      }
    }
  }
}

/// End a flow that cannot go on: the session is cancelled if the API left it
/// open, and the dialog keeps the message up with only a way to close it.
async fn report_failure(
  session: &SigningSession,
  error: StepError,
  outcome_sender: oneshot::Sender<PdfSignResult>,
) {
  if error.session_left_open {
    session.cancel(REASON_USER_CANCELLED).await;
  }
  tracing::warn!(error = %error.message, "PDF signing failed");
  let _ = outcome_sender.send(PdfSignResult::Failed {
    message: error.message,
    retryable: false,
  });
}

struct SigningSession {
  api_base_url: String,
  client: DesktopHttpClient,
  id: String,
  token: String,
}

impl SigningSession {
  fn url(&self, suffix: &str) -> String {
    format!(
      "{}/v1/pdf-signing-sessions/{}/{suffix}",
      self.api_base_url, self.id
    )
  }

  /// Best effort: the session is the API's to close, and a cancel that does
  /// not land leaves a row that expires on its own.
  async fn cancel(&self, reason: &str) {
    let result = self
      .client
      .post(self.url("cancel"))
      .json(&CancelRequest {
        session_token: &self.token,
        reason,
      })
      .timeout(CANCEL_TIMEOUT)
      .send()
      .await;
    if let Err(error) = result {
      tracing::warn!(error = %error, "PDF signing session cancellation failed");
    }
  }
}

/// Phase 1 and the keychain: the certificate goes up, the digest comes back
/// and the keychain signs it. The one step that may ask for a PIN.
async fn prepare_signature(
  session: &SigningSession,
  identity: &SigningIdentity,
) -> Result<Vec<u8>, StepError> {
  let prepared: CertificateResponse = post(
    &session.client,
    session.url("certificate"),
    &CertificateRequest {
      session_token: &session.token,
      certificate: STANDARD.encode(&identity.certificate_der),
      certificate_chain: identity
        .chain_der
        .iter()
        .map(|der| STANDARD.encode(der))
        .collect(),
    },
  )
  .await?;

  if prepared.digest_algorithm != DIGEST_ALGORITHM {
    return Err(StepError::local(format!(
      "stella desktop cannot sign a {} digest.",
      prepared.digest_algorithm
    )));
  }
  // The API derives the algorithm from the certificate that was just sent, so
  // a disagreement means the two sides read different keys out of it. Signing
  // anyway would produce a PDF that no verifier accepts.
  if prepared.signature_algorithm != identity.key_type.signature_algorithm() {
    return Err(StepError::local(format!(
      "stella desktop signs with {}, but the document expects {}.",
      identity.key_type.signature_algorithm(),
      prepared.signature_algorithm
    )));
  }
  let digest = decode_digest(&prepared.digest_hex)?;

  sign_digest(identity.id.clone(), digest, identity.key_type).await
}

/// Phase 2: the API embeds the signature. Safe to repeat with the same
/// signature: a transient failure keeps the session and the signature on the
/// API's side, and a repeat of a call that already landed answers with the
/// version it made.
async fn finalize(
  session: &SigningSession,
  signature: &[u8],
) -> Result<i64, StepError> {
  let response = session
    .client
    .post(session.url("signature"))
    .json(&SignatureRequest {
      session_token: &session.token,
      signature: STANDARD.encode(signature),
    })
    .timeout(SIGNING_REQUEST_TIMEOUT)
    .send()
    .await
    .map_err(|e| {
      StepError::retryable(format!("stella desktop could not reach stella: {e}"))
    })?;

  let status = response.status();
  if api_kept_signature(status) {
    return Err(StepError::retryable(error_message(response, status).await));
  }
  if !status.is_success() {
    return Err(StepError {
      message: error_message(response, status).await,
      session_left_open: !api_closed_session(status),
      retryable: false,
    });
  }

  response
    .json::<SignatureResponse>()
    .await
    .map(|signed| signed.version_number)
    .map_err(|e| StepError {
      message: format!("stella desktop could not read the signing response: {e}"),
      // The API answered successfully; whatever it did, it did.
      session_left_open: false,
      retryable: false,
    })
}

fn decode_digest(digest_hex: &str) -> Result<[u8; DIGEST_BYTES], StepError> {
  hex::decode(digest_hex)
    .ok()
    .and_then(|bytes| <[u8; DIGEST_BYTES]>::try_from(bytes).ok())
    .ok_or_else(|| {
      StepError::local("stella desktop could not read the document digest.".to_string())
    })
}

async fn redeem(
  client: &DesktopHttpClient,
  api_base_url: &str,
  handoff_token: &str,
) -> Result<RedeemResponse, String> {
  let response = client
    .post(format!("{api_base_url}/v1/pdf-signing-handoffs/redeem"))
    .json(&RedeemRequest { handoff_token })
    .timeout(REDEEM_TIMEOUT)
    .send()
    .await
    .map_err(|e| format!("stella desktop could not redeem the signing handoff: {e}"))?;

  if !response.status().is_success() {
    let status = response.status();
    return Err(error_message(response, status).await);
  }

  response
    .json::<RedeemResponse>()
    .await
    .map_err(|e| format!("stella desktop could not read the signing handoff: {e}"))
}

async fn post<Request: serde::Serialize, Response: serde::de::DeserializeOwned>(
  client: &DesktopHttpClient,
  url: String,
  body: &Request,
) -> Result<Response, StepError> {
  let response = client
    .post(url)
    .json(body)
    .timeout(SIGNING_REQUEST_TIMEOUT)
    .send()
    .await
    .map_err(|e| {
      StepError::local(format!("stella desktop could not reach stella: {e}"))
    })?;

  let status = response.status();
  if !status.is_success() {
    return Err(StepError {
      message: error_message(response, status).await,
      session_left_open: !api_closed_session(status),
      retryable: false,
    });
  }

  response.json::<Response>().await.map_err(|e| StepError {
    message: format!("stella desktop could not read the signing response: {e}"),
    // The API answered successfully; whatever it did, it did.
    session_left_open: false,
    retryable: false,
  })
}

async fn error_message(
  response: reqwest::Response,
  status: reqwest::StatusCode,
) -> String {
  response
    .json::<ErrorResponse>()
    .await
    .ok()
    .and_then(|body| body.message)
    .unwrap_or_else(|| format!("stella rejected the signing request ({status})."))
}

/// The keychain blocks, so both native calls run off the async runtime. A
/// wedged keychain times out instead of holding the flow open.
async fn list_identities() -> Result<Vec<SigningIdentity>, ()> {
  let listing =
    tokio::task::spawn_blocking(stella_desktop_macos_signing::list_identities);
  match tokio::time::timeout(IDENTITY_LISTING_TIMEOUT, listing).await {
    Ok(Ok(Ok(identities))) => Ok(identities),
    Ok(Ok(Err(error))) => {
      tracing::warn!(error = %error, "signing identities could not be listed");
      Err(())
    }
    Ok(Err(_)) | Err(_) => {
      tracing::warn!("signing identity listing did not finish");
      Err(())
    }
  }
}

async fn sign_digest(
  identity_id: String,
  digest: [u8; DIGEST_BYTES],
  key_type: SigningKeyType,
) -> Result<Vec<u8>, StepError> {
  let signing = tokio::task::spawn_blocking(move || {
    stella_desktop_macos_signing::sign_digest(&identity_id, &digest, key_type)
  });
  match tokio::time::timeout(SIGNING_TIMEOUT, signing).await {
    Ok(Ok(Ok(signature))) => Ok(signature),
    Ok(Ok(Err(error))) => Err(StepError::local(error.to_string())),
    Ok(Err(_)) | Err(_) => Err(StepError::local(
      "stella desktop did not get a signature from the keychain.".to_string(),
    )),
  }
}

// --- Dialog ---

fn open_dialog(
  app_handle: &AppHandle,
  content: DialogContent<'_>,
) -> Result<tauri::WebviewWindow, String> {
  use tauri::Manager;

  // Defensive: a stale window without a reserved bridge should never happen
  // (every exit path closes it), but bail rather than stack a second one.
  if app_handle.get_webview_window(DIALOG_LABEL).is_some() {
    return Err("A PDF signing dialog is already open.".to_string());
  }

  let listed: Vec<DialogIdentity<'_>> = content
    .identities
    .iter()
    .map(|identity| DialogIdentity {
      id: &identity.id,
      label: &identity.label,
      issuer: identity.issuer.as_deref(),
      expires_on: &identity.expires_on,
    })
    .collect();
  // Everything the dialog renders travels in the hash, the session token
  // included in what does not: the webview never sees it. The dialog holds no
  // strings of its own, so its wording rides along and it renders in the
  // language the rest of the app runs in.
  let hash = format!(
    "state={}&apiOrigin={}&stampPage={}&documentName={}&versionNumber={}&workspaceName={}&identities={}&strings={}&lang={}&dir={}",
    encode_json(&content.state)?,
    percent_encode(content.api_base_url),
    content
      .stamp_page_number
      .map(|page| page.to_string())
      .unwrap_or_default(),
    percent_encode(content.document_name),
    content.version_number,
    percent_encode(content.workspace_name),
    encode_json(&listed)?,
    percent_encode(&crate::i18n::namespace_json("dialog")),
    percent_encode(crate::i18n::active_locale()),
    percent_encode(crate::i18n::text_direction()),
  );

  let builder = tauri::WebviewWindowBuilder::new(
    app_handle,
    DIALOG_LABEL,
    tauri::WebviewUrl::App(format!("pdf-sign-dialog.html#{hash}").into()),
  )
  .title(crate::i18n::t("dialog.pdfSignWindowTitle"))
  .inner_size(DIALOG_WIDTH, DIALOG_HEIGHT)
  .resizable(false);
  let builder = crate::window_placement::centered_on_target_screen(
    app_handle,
    builder,
    tauri::LogicalSize::new(DIALOG_WIDTH, DIALOG_HEIGHT),
  );

  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);

  let window = builder
    .build()
    .map_err(|error| format!("failed to open the PDF signing dialog: {error}"))?;

  // Closing the dialog with the OS window control bypasses the buttons, so
  // release the reserved bridge on destroy. Otherwise the slot stays taken
  // until the timeout and every retry fails as "already open".
  window.on_window_event(|event| {
    if matches!(event, tauri::WindowEvent::Destroyed) {
      cancel_dialog();
    }
  });
  let _ = window.set_focus();
  Ok(window)
}

fn encode_json<T: serde::Serialize>(value: &T) -> Result<String, String> {
  serde_json::to_string(value)
    .map(|json| percent_encode(&json))
    .map_err(|error| format!("failed to describe the PDF signing dialog: {error}"))
}

/// Percent-encode a string for use in a URL hash parameter.
fn percent_encode(value: &str) -> String {
  use std::fmt::Write;

  let mut encoded = String::with_capacity(value.len());
  for byte in value.bytes() {
    match byte {
      b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
        encoded.push(byte as char);
      }
      _ => {
        let _ = write!(encoded, "%{byte:02X}");
      }
    }
  }
  encoded
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_release_build_does_not_let_a_local_api_ask_for_a_signature() {
    let built_in: std::collections::HashSet<String> = [
      "https://api.stll.app".to_string(),
      "http://127.0.0.1:3001".to_string(),
      "http://localhost:3001".to_string(),
    ]
    .into_iter()
    .collect();

    for local in [
      "http://127.0.0.1:3001",
      "http://localhost:3001",
      "http://[::1]:3001",
      "http://127.8.9.10:3001",
    ] {
      // Built in or not, a loopback API needs a development build...
      assert!(
        !trusted_for_signing(local, &built_in, false, false),
        "{local}"
      );
      assert!(
        trusted_for_signing(local, &built_in, false, true),
        "{local}"
      );
      // ...or the user's explicit approval.
      assert!(
        trusted_for_signing(local, &built_in, true, false),
        "{local}"
      );
    }

    assert!(trusted_for_signing(
      "https://api.stll.app",
      &built_in,
      false,
      false
    ));
    assert!(!trusted_for_signing(
      "https://evil.example",
      &built_in,
      false,
      true
    ));
  }

  #[test]
  fn reads_the_stamp_page_from_the_redeemed_session() {
    let base = r#"{"sessionId":"s","sessionToken":"t","apiBaseUrl":"https://api.stll.app","documentName":"d","versionNumber":1,"workspaceName":"w""#;
    let visible: RedeemResponse =
      serde_json::from_str(&format!(r#"{base},"stampPageNumber":3}}"#)).unwrap();
    assert_eq!(visible.stamp_page_number, Some(3));
    let invisible: RedeemResponse =
      serde_json::from_str(&format!(r#"{base},"stampPageNumber":null}}"#)).unwrap();
    assert_eq!(invisible.stamp_page_number, None);
    let older: RedeemResponse = serde_json::from_str(&format!("{base}}}")).unwrap();
    assert_eq!(older.stamp_page_number, None);
  }

  #[test]
  fn decodes_a_sha256_digest() {
    let digest = decode_digest(&"ab".repeat(32)).unwrap();

    assert_eq!(digest, [0xAB; DIGEST_BYTES]);
  }

  #[test]
  fn refuses_a_digest_that_is_not_32_bytes_of_hex() {
    for digest_hex in [
      "",
      "ab",
      &"ab".repeat(31),
      &"ab".repeat(33),
      &"zz".repeat(32),
    ] {
      assert!(decode_digest(digest_hex).is_err());
    }
  }

  #[test]
  fn leaves_the_session_open_only_when_the_api_did_not_close_it() {
    for status in [404, 409, 410, 413, 422] {
      assert!(api_closed_session(
        reqwest::StatusCode::from_u16(status).unwrap()
      ));
    }
    for status in [400, 401, 403, 429, 500, 502, 503, 504] {
      assert!(!api_closed_session(
        reqwest::StatusCode::from_u16(status).unwrap()
      ));
    }
  }

  #[test]
  fn only_a_503_means_the_api_kept_the_signature_for_a_retry() {
    assert!(api_kept_signature(reqwest::StatusCode::SERVICE_UNAVAILABLE));
    for status in [200, 400, 404, 409, 422, 500, 502, 504] {
      assert!(!api_kept_signature(
        reqwest::StatusCode::from_u16(status).unwrap()
      ));
    }
  }

  #[test]
  fn a_certificate_label_cannot_break_out_of_the_url_hash() {
    // Subject summaries are whatever the issuer wrote: a label carrying a
    // separator, a fragment marker or a non-ASCII script must not end the
    // parameter it travels in.
    let encoded = encode_json(&[DialogIdentity {
      id: "abc",
      label: "Kancelář & Co #2 \"Praha\"",
      issuer: Some("CA #1 & Co"),
      expires_on: "2030-01-31",
    }])
    .unwrap();

    assert!(
      encoded
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "-._~%".contains(ch))
    );
  }

  #[test]
  fn an_identity_reaches_the_dialog_with_its_issuer_and_expiry() {
    assert_eq!(
      serde_json::to_string(&DialogIdentity {
        id: "abc",
        label: "Jane Counsel",
        issuer: Some("Test Issuing CA"),
        expires_on: "2030-01-31",
      })
      .unwrap(),
      r#"{"id":"abc","label":"Jane Counsel","issuer":"Test Issuing CA","expiresOn":"2030-01-31"}"#
    );
  }

  #[test]
  fn the_dialog_states_serialize_as_the_dialog_reads_them() {
    assert_eq!(
      serde_json::to_string(&DialogState::UnsupportedPlatform).unwrap(),
      "\"unsupportedPlatform\""
    );
    assert_eq!(
      serde_json::to_string(&DialogState::NoIdentities).unwrap(),
      "\"noIdentities\""
    );
    assert_eq!(
      serde_json::to_string(&DialogState::Ready).unwrap(),
      "\"ready\""
    );
  }

  #[test]
  fn the_dialog_response_and_result_match_the_dialog_script() {
    let signed: PdfSignDialogResponse =
      serde_json::from_str(r#"{"action":"sign","identityId":"abc"}"#).unwrap();
    assert!(matches!(
      signed,
      PdfSignDialogResponse::Sign { identity_id } if identity_id == "abc"
    ));
    let cancelled: PdfSignDialogResponse =
      serde_json::from_str(r#"{"action":"cancel"}"#).unwrap();
    assert!(matches!(cancelled, PdfSignDialogResponse::Cancel));
    let retried: PdfSignDialogResponse =
      serde_json::from_str(r#"{"action":"retry"}"#).unwrap();
    assert!(matches!(retried, PdfSignDialogResponse::Retry));

    assert_eq!(
      serde_json::to_string(&PdfSignResult::Signed { version_number: 4 }).unwrap(),
      r#"{"status":"signed","versionNumber":4}"#
    );
    assert_eq!(
      serde_json::to_string(&PdfSignResult::Cancelled).unwrap(),
      r#"{"status":"cancelled"}"#
    );
    assert_eq!(
      serde_json::to_string(&PdfSignResult::Failed {
        message: "later".to_string(),
        retryable: true,
      })
      .unwrap(),
      r#"{"status":"failed","message":"later","retryable":true}"#
    );
  }
}
