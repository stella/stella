use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::config;
use crate::session_manager::{SessionManager, download_file_standalone};
use crate::types::{ErrorResponse, OpenFileRequest, is_safe_session_id};
use crate::updater;

const ACKNOWLEDGE_TIMEOUT: Duration = Duration::from_secs(10);
const SELF_HOST_CONNECT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const HANDOFF_TOKEN_LENGTH: usize = 64;

static SELF_HOST_CONNECT_SENDER: std::sync::Mutex<
  Option<tokio::sync::oneshot::Sender<bool>>,
> = std::sync::Mutex::new(None);
static CONNECTION_CONFIRMATION: Mutex<()> = Mutex::const_new(());

#[derive(Debug, PartialEq, Eq)]
enum DeepLinkAction {
  ConnectAccount {
    api_base_url: String,
    web_origin: String,
  },
  CompleteAccount {
    correlation_id: String,
    user_id: String,
    organization_id: String,
  },
  ConnectSelfHost {
    api_base_url: String,
    web_origin: String,
  },
  Ping,
  OpenDesktopEdit {
    api_base_url: String,
    handoff_token: String,
  },
  OpenPdfSigning {
    api_base_url: String,
    handoff_token: String,
  },
}

/// The deep links that carry a handoff token. They differ only in what the
/// token is redeemed for, so they share one set of guards.
enum HandoffTarget {
  DesktopEdit,
  PdfSigning,
}

fn is_safe_handoff_token(value: &str) -> bool {
  value.len() == HANDOFF_TOKEN_LENGTH && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn normalize_and_validate_api_base_url(value: &str) -> Result<String, String> {
  config::normalize_self_host_api_base_url(value).map_err(
    crate::logging::with_cause_logged("Invalid desktop edit API URL."),
  )
}

/// Reserves the approval channel for a single in-flight prompt. Returns the
/// sender back to the caller when a prompt is already pending so concurrent
/// `self-host/connect` deep links cannot cancel each other's approval.
fn try_reserve_self_host_connect_sender(
  sender: tokio::sync::oneshot::Sender<bool>,
) -> Result<(), tokio::sync::oneshot::Sender<bool>> {
  let mut guard = SELF_HOST_CONNECT_SENDER
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  if guard.is_some() {
    return Err(sender);
  }
  *guard = Some(sender);
  drop(guard);
  Ok(())
}

pub fn set_self_host_connect_response(approved: bool) {
  let mut guard = SELF_HOST_CONNECT_SENDER
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  if let Some(sender) = guard.take() {
    let _ = sender.send(approved);
  }
}

fn parse_deep_link(raw_url: &str) -> Option<DeepLinkAction> {
  let url = reqwest::Url::parse(raw_url).ok()?;
  if url.scheme() != "stella" {
    return None;
  }

  if url.host_str() == Some("account") {
    let params: std::collections::HashMap<_, _> =
      url.query_pairs().into_owned().collect();
    match url.path() {
      "/connect" => {
        return Some(DeepLinkAction::ConnectAccount {
          api_base_url: config::normalize_self_host_api_base_url(
            params.get("apiBaseUrl")?,
          )
          .ok()?,
          web_origin: config::normalize_self_host_web_origin(params.get("webOrigin")?)
            .ok()?,
        });
      }
      "/complete" => {
        let correlation_id = params.get("correlationId")?;
        let user_id = params.get("userId")?;
        let organization_id = params.get("organizationId")?;
        uuid::Uuid::parse_str(correlation_id).ok()?;
        for value in [user_id, organization_id] {
          if value.is_empty()
            || value.len() > 128
            || !value
              .bytes()
              .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
          {
            return None;
          }
        }
        return Some(DeepLinkAction::CompleteAccount {
          correlation_id: correlation_id.clone(),
          user_id: user_id.clone(),
          organization_id: organization_id.clone(),
        });
      }
      _ => return None,
    }
  }

  if url.host_str() == Some("ping") {
    return Some(DeepLinkAction::Ping);
  }

  if url.host_str() == Some("self-host") && url.path() == "/connect" {
    let mut web_origin = None;
    let mut api_base_url = None;

    for (key, value) in url.query_pairs() {
      match key.as_ref() {
        "webOrigin" => web_origin = Some(value.into_owned()),
        "apiBaseUrl" => api_base_url = Some(value.into_owned()),
        _ => {}
      }
    }

    let web_origin = config::normalize_self_host_web_origin(&web_origin?).ok()?;
    let api_base_url = config::normalize_self_host_api_base_url(&api_base_url?).ok()?;

    return Some(DeepLinkAction::ConnectSelfHost {
      api_base_url,
      web_origin,
    });
  }

  let target = match (url.host_str(), url.path()) {
    (Some("desktop-edit"), "/open") => HandoffTarget::DesktopEdit,
    (Some("pdf-sign"), "/open") => HandoffTarget::PdfSigning,
    _ => return None,
  };

  let mut handoff_token = None;
  let mut api_base_url = None;

  for (key, value) in url.query_pairs() {
    match key.as_ref() {
      "handoff" => handoff_token = Some(value.into_owned()),
      "apiBaseUrl" => api_base_url = Some(value.into_owned()),
      _ => {}
    }
  }

  let handoff_token = handoff_token?;
  if !is_safe_handoff_token(&handoff_token) {
    return None;
  }

  let api_base_url = normalize_and_validate_api_base_url(&api_base_url?).ok()?;

  Some(match target {
    HandoffTarget::DesktopEdit => DeepLinkAction::OpenDesktopEdit {
      api_base_url,
      handoff_token,
    },
    HandoffTarget::PdfSigning => DeepLinkAction::OpenPdfSigning {
      api_base_url,
      handoff_token,
    },
  })
}

/// The deep link's origin only counts if the user already trusts it: the
/// production API, a local development API, or a self-host connection they
/// approved.
async fn is_trusted_api_base_url(
  manager: &Mutex<SessionManager>,
  api_base_url: &str,
) -> bool {
  if config::resolve_trusted_api_base_urls().contains(api_base_url) {
    return true;
  }
  manager
    .lock()
    .await
    .is_trusted_self_host_api_base_url(api_base_url)
}

pub fn handle_url(
  raw_url: &str,
  manager: Arc<Mutex<SessionManager>>,
  app_handle: AppHandle,
) {
  let handoff_expires = std::time::Instant::now() + crate::handoff::HANDOFF_LIFETIME;
  match parse_deep_link(raw_url) {
    Some(DeepLinkAction::ConnectAccount {
      api_base_url,
      web_origin,
    }) => {
      tauri::async_runtime::spawn(async move {
        let static_pair = config::resolve_trusted_api_base_urls()
          .contains(&api_base_url)
          && config::resolve_allowed_origins().contains(&web_origin);
        if !static_pair
          && let Err(error) = confirm_and_trust_self_host(
            manager,
            app_handle.clone(),
            web_origin.clone(),
            api_base_url.clone(),
          )
          .await
        {
          tracing::warn!(error = %error, "desktop account connection was not accepted");
          return;
        }
        if let Err(error) = crate::account::open_browser_connection(
          &app_handle,
          &api_base_url,
          &web_origin,
        )
        .await
        {
          tracing::warn!(error = %error, "desktop account connection could not start");
        }
      });
    }
    Some(DeepLinkAction::CompleteAccount {
      correlation_id,
      user_id,
      organization_id,
    }) => {
      tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::account::complete_browser_connection(
          &app_handle,
          &correlation_id,
          crate::types::DesktopAccountIdentity {
            user_id,
            organization_id,
          },
        )
        .await
        {
          tracing::warn!(error = %error, "desktop account connection could not complete");
          tracing::warn!(target: crate::logging::TRAIL_TARGET, event = "account.link_failed");
          return;
        }
        tracing::info!(target: crate::logging::TRAIL_TARGET, event = "account.linked");
        resume_parked_handoff(manager, app_handle).await;
      });
    }
    Some(DeepLinkAction::ConnectSelfHost {
      api_base_url,
      web_origin,
    }) => {
      tracing::info!("self-host desktop connection deep link received");
      tauri::async_runtime::spawn(async move {
        if let Err(error) =
          confirm_and_trust_self_host(manager, app_handle, web_origin, api_base_url)
            .await
        {
          tracing::warn!(error = %error, "self-host desktop connection failed");
        }
      });
    }
    Some(DeepLinkAction::Ping) => {
      tracing::info!("deep link ping received");
      tauri::async_runtime::spawn(async move {
        if cfg!(debug_assertions) {
          tracing::debug!("deep link updater check skipped in debug build");
          return;
        }

        let active_edit_sessions = {
          let mgr = manager.lock().await;
          mgr.has_active_edit_sessions()
        };

        match updater::run_check(&app_handle, active_edit_sessions).await {
          updater::CheckOutcome::Deferred { version } => {
            tracing::debug!(
                version = %version,
                "deep link updater check deferred while desktop edits are active"
            );
          }
          updater::CheckOutcome::UpToDate => {
            tracing::debug!("deep link updater check: up to date");
          }
          updater::CheckOutcome::Installed { version } => {
            tracing::info!(version = %version, "deep link update installed, relaunching");
          }
          updater::CheckOutcome::Failed(error) => {
            tracing::warn!(error = %error, "deep link updater check failed");
          }
          updater::CheckOutcome::Disabled => {
            tracing::debug!("deep link updater check skipped: updates are managed");
          }
        }
      });
    }
    Some(DeepLinkAction::OpenDesktopEdit {
      api_base_url,
      handoff_token,
    }) => {
      tracing::info!(target: crate::logging::TRAIL_TARGET, event = "handoff.received", target_kind = "DesktopEdit");
      start_handoff(
        HandoffRun {
          target: crate::handoff::Target::DesktopEdit,
          api_base_url,
          token: handoff_token,
          expires: handoff_expires,
        },
        manager,
        app_handle,
      );
    }
    Some(DeepLinkAction::OpenPdfSigning {
      api_base_url,
      handoff_token,
    }) => {
      tracing::info!(target: crate::logging::TRAIL_TARGET, event = "handoff.received", target_kind = "PdfSigning");
      start_handoff(
        HandoffRun {
          target: crate::handoff::Target::PdfSigning,
          api_base_url,
          token: handoff_token,
          expires: handoff_expires,
        },
        manager,
        app_handle,
      );
    }
    None => {
      tracing::warn!("unsupported deep link received");
    }
  }
}

struct HandoffRun {
  target: crate::handoff::Target,
  api_base_url: String,
  token: String,
  expires: std::time::Instant,
}

/// Every handoff ends in front of the user: in its own window, in a notice,
/// or in an offer to link the account it is waiting for.
fn start_handoff(run: HandoffRun, manager: Arc<Mutex<SessionManager>>, app: AppHandle) {
  tauri::async_runtime::spawn(async move {
    match redeem_handoff(&run, &manager, &app).await {
      Ok(()) => {
        tracing::info!(target: crate::logging::TRAIL_TARGET, event = "handoff.completed", target_kind = ?run.target);
      }
      Err(crate::handoff::Stop::Presented(message)) => {
        tracing::warn!(error = %message, "document handoff ended");
        tracing::warn!(target: crate::logging::TRAIL_TARGET, event = "handoff.ended", target_kind = ?run.target);
      }
      Err(crate::handoff::Stop::AccountRequired)
      | Err(crate::handoff::Stop::AccountMismatch(_)) => {
        crate::account::notify(&app);
        offer_account_link(run, manager, app).await;
      }
      Err(crate::handoff::Stop::Failed(failure)) => {
        tracing::warn!(
          target: crate::logging::TRAIL_TARGET, event = "handoff.failed",
          target_kind = ?run.target,
          code = failure.message_key()
        );
        present_handoff_failure(&app, &failure).await;
      }
    }
  });
}

async fn redeem_handoff(
  run: &HandoffRun,
  manager: &Arc<Mutex<SessionManager>>,
  app: &AppHandle,
) -> Result<(), crate::handoff::Stop> {
  if std::time::Instant::now() >= run.expires {
    return Err(crate::handoff::Failure::Expired.into());
  }
  let trusted = match run.target {
    crate::handoff::Target::DesktopEdit => {
      is_trusted_api_base_url(manager, &run.api_base_url).await
    }
    crate::handoff::Target::PdfSigning => {
      crate::pdf_signing::api_trusted_for_signing(manager, &run.api_base_url).await
    }
  };
  if !trusted {
    return Err(crate::handoff::Failure::UntrustedServer.into());
  }
  match run.target {
    crate::handoff::Target::DesktopEdit => {
      redeem_and_open_desktop_edit(
        manager.clone(),
        app.clone(),
        run.api_base_url.clone(),
        run.token.clone(),
      )
      .await
    }
    crate::handoff::Target::PdfSigning => {
      crate::pdf_signing::redeem_and_sign(
        manager.clone(),
        app.clone(),
        run.api_base_url.clone(),
        run.token.clone(),
      )
      .await
    }
  }
}

async fn present_handoff_failure(app: &AppHandle, failure: &crate::handoff::Failure) {
  if let Err(error) =
    show_connection_confirmation(app, ConnectionConfirmation::HandoffError(failure))
      .await
  {
    tracing::warn!(error = %error, "document handoff notice was not shown");
  }
}

/// Retries a link completed since admission, or parks and offers to link;
/// a later completion resumes it through `resume_parked_handoff`.
async fn offer_account_link(
  run: HandoffRun,
  manager: Arc<Mutex<SessionManager>>,
  app: AppHandle,
) {
  match crate::handoff::park_if_unlinked(
    &app.state::<crate::account::AccountState>(),
    run.target,
    &run.api_base_url,
    &run.token,
    run.expires,
  )
  .await
  {
    Ok(crate::handoff::AccountWait::AccountAvailable) => {
      start_handoff(run, manager, app);
      return;
    }
    Ok(crate::handoff::AccountWait::Parked) => {}
    Ok(crate::handoff::AccountWait::Expired) => {
      present_handoff_failure(&app, &crate::handoff::Failure::Expired).await;
      return;
    }
    Err(error) => {
      present_handoff_failure(&app, &crate::handoff::Failure::Terminal(error)).await;
      return;
    }
  }
  tracing::info!(target: crate::logging::TRAIL_TARGET, event = "handoff.parked", target_kind = ?run.target);
  let expiry_token = zeroize::Zeroizing::new(run.token.clone());
  let expiry_app = app.clone();
  let expiry_api = run.api_base_url.clone();
  tauri::async_runtime::spawn(async move {
    if matches!(
      crate::handoff::expire_parked(&expiry_token, &expiry_api).await,
      crate::handoff::Resumable::Expired
    ) {
      present_handoff_failure(&expiry_app, &crate::handoff::Failure::Expired).await;
    }
  });
  offer_parked_handoff(run, manager, app).await;
}

async fn offer_parked_handoff(
  run: HandoffRun,
  manager: Arc<Mutex<SessionManager>>,
  app: AppHandle,
) {
  let offer = crate::handoff::account_offer(&run.token, &run.api_base_url).await;
  match offer.pending() {
    crate::handoff::Resumable::Nothing => return,
    crate::handoff::Resumable::Expired => {
      present_handoff_failure(&app, &crate::handoff::Failure::Expired).await;
      return;
    }
    crate::handoff::Resumable::Ready(_) => {}
  }
  let state = app.state::<crate::account::AccountState>();
  match crate::handoff::account_mismatch(&state, &run.api_base_url).await {
    Ok(Some(mismatch)) => {
      present_account_mismatch(&app, &mismatch).await;
      return;
    }
    Ok(None) => {}
    Err(error) => {
      present_handoff_failure(&app, &crate::handoff::Failure::Terminal(error)).await;
      return;
    }
  }
  let approved = match show_connection_confirmation(
    &app,
    ConnectionConfirmation::HandoffConnect(run.target),
  )
  .await
  {
    Ok(approved) => approved,
    Err(error) => {
      // The expiry task still owns an outcome if the native window fails.
      tracing::warn!(error = %error, "account link offer was not shown");
      return;
    }
  };
  // A replacement has its own queued offer. Consent for the old token must
  // neither cancel it nor start a connection for its potentially different API.
  match offer.pending() {
    crate::handoff::Resumable::Nothing => return,
    crate::handoff::Resumable::Expired => {
      present_handoff_failure(&app, &crate::handoff::Failure::Expired).await;
      return;
    }
    crate::handoff::Resumable::Ready(_) => {}
  }
  if !approved {
    if crate::handoff::unpark(&run.token, &run.api_base_url) {
      tracing::info!(target: crate::logging::TRAIL_TARGET, event = "handoff.dropped", target_kind = ?run.target);
      crate::handoff::decline(run.target, &run.api_base_url, &run.token).await;
    }
    return;
  }
  match offer
    .connect(
      &DesktopConnectionHost {
        manager: &manager,
        app: &app,
      },
      &state,
    )
    .await
  {
    Ok(crate::handoff::OfferConnection::AccountMismatch(mismatch)) => {
      present_account_mismatch(&app, &mismatch).await;
    }
    Ok(crate::handoff::OfferConnection::NotCurrent) => {}
    Ok(crate::handoff::OfferConnection::Expired) => {
      present_handoff_failure(&app, &crate::handoff::Failure::Expired).await;
    }
    Ok(crate::handoff::OfferConnection::Started(outcome)) => match outcome {
      crate::account::ConnectionStart::Started => {
        tracing::info!(target: crate::logging::TRAIL_TARGET, event = "account.link_started");
      }
      crate::account::ConnectionStart::Resumed => {
        tracing::info!(target: crate::logging::TRAIL_TARGET, event = "account.link_resumed");
      }
      crate::account::ConnectionStart::SameOriginPending => {}
      crate::account::ConnectionStart::DifferentOriginPending => {
        // Keep this token for its own offer after the other connection completes.
        present_handoff_failure(&app, &crate::handoff::Failure::AccountMismatch).await;
      }
    },
    Err(failure) => {
      crate::handoff::unpark(&run.token, &run.api_base_url);
      present_handoff_failure(&app, &failure).await;
    }
  }
}

async fn present_account_mismatch(
  app: &AppHandle,
  mismatch: &crate::handoff::AccountMismatch,
) {
  if let Err(error) =
    show_connection_confirmation(app, ConnectionConfirmation::AccountMismatch(mismatch))
      .await
  {
    tracing::warn!(error = %error, "account mismatch notice was not shown");
  }
}

struct DesktopConnectionHost<'a> {
  manager: &'a Mutex<SessionManager>,
  app: &'a AppHandle,
}

impl crate::handoff::ConnectionHost for DesktopConnectionHost<'_> {
  type Prepared = crate::account::PreparedBrowserConnection;

  async fn web_origin(&self, api_base_url: &str) -> Option<String> {
    web_origin_for_api(self.manager, api_base_url).await
  }

  async fn prepare(
    &self,
    api_base_url: &str,
    web_origin: &str,
  ) -> Result<Self::Prepared, String> {
    crate::account::prepare_browser_connection(api_base_url, web_origin).await
  }

  fn open(
    &self,
    prepared: Self::Prepared,
  ) -> Result<crate::account::ConnectionStart, String> {
    prepared.open(self.app)
  }
}

async fn resume_parked_handoff(manager: Arc<Mutex<SessionManager>>, app: AppHandle) {
  let account =
    match crate::account::current(&app.state::<crate::account::AccountState>()).await {
      Ok(Some(account)) => account,
      Ok(None) => return,
      Err(error) => {
        present_handoff_failure(&app, &crate::handoff::Failure::Terminal(error)).await;
        return;
      }
    };
  match crate::handoff::take_parked_for_account(&account.api_base_url).await {
    crate::handoff::ResumeAfterLink::Nothing => {}
    crate::handoff::ResumeAfterLink::Expired => {
      tracing::info!(target: crate::logging::TRAIL_TARGET, event = "handoff.expired");
      present_handoff_failure(&app, &crate::handoff::Failure::Expired).await;
    }
    crate::handoff::ResumeAfterLink::Ready(parked) => {
      tracing::info!(target: crate::logging::TRAIL_TARGET, event = "handoff.resumed", target_kind = ?parked.target);
      start_handoff(
        HandoffRun {
          target: parked.target,
          api_base_url: parked.api_base_url.clone(),
          token: parked.token.to_string(),
          expires: parked.expires,
        },
        manager,
        app,
      );
    }
    crate::handoff::ResumeAfterLink::NeedsOffer(parked) => {
      offer_parked_handoff(
        HandoffRun {
          target: parked.target,
          api_base_url: parked.api_base_url.clone(),
          token: parked.token.to_string(),
          expires: parked.expires,
        },
        manager,
        app,
      )
      .await;
    }
  }
}

async fn web_origin_for_api(
  manager: &Mutex<SessionManager>,
  api_base_url: &str,
) -> Option<String> {
  if let Some(origin) = config::web_origin_for_trusted_api(api_base_url) {
    return Some(origin);
  }
  manager
    .lock()
    .await
    .trusted_self_host_web_origin(api_base_url)
}

async fn confirm_and_trust_self_host(
  manager: Arc<Mutex<SessionManager>>,
  app_handle: AppHandle,
  web_origin: String,
  api_base_url: String,
) -> Result<(), String> {
  let trusted = {
    let mgr = manager.lock().await;
    mgr.is_trusted_self_host_connection(&web_origin, &api_base_url)
  };
  if !trusted {
    let approved = show_connection_confirmation(
      &app_handle,
      ConnectionConfirmation::SelfHost {
        web_origin: &web_origin,
        api_base_url: &api_base_url,
      },
    )
    .await?;
    if !approved {
      return Err("Self-host desktop connection was not approved.".to_string());
    }
  }

  manager
    .lock()
    .await
    .trust_self_host_connection(web_origin, api_base_url)
    .await;
  Ok(())
}

pub(crate) enum ConnectionConfirmation<'a> {
  HandoffError(&'a crate::handoff::Failure),
  AccountMismatch(&'a crate::handoff::AccountMismatch),
  /// A document handoff waits for the account link.
  HandoffConnect(crate::handoff::Target),
  SelfHost {
    web_origin: &'a str,
    api_base_url: &'a str,
  },
  Account {
    email: &'a str,
    organization_name: &'a str,
  },
}

pub(crate) async fn show_connection_confirmation(
  app_handle: &AppHandle,
  confirmation: ConnectionConfirmation<'_>,
) -> Result<bool, String> {
  use tauri::Manager;

  // Notices and approvals share a native window. Queue them through its
  // destruction so a busy dialog cannot swallow a handoff's final notice.
  let _dialog = CONNECTION_CONFIRMATION.lock().await;
  let (sender, receiver) = tokio::sync::oneshot::channel();
  if try_reserve_self_host_connect_sender(sender).is_err() {
    return Err("A self-host connection dialog is already open.".to_string());
  }

  // Defensive: a stale dialog window without a reserved sender should never
  // happen (we close it on every exit path), but bail rather than stack a
  // second window over it.
  if app_handle
    .get_webview_window("selfhost-connect-dialog")
    .is_some()
  {
    set_self_host_connect_response(false);
    return Err("A self-host connection dialog is already open.".to_string());
  }

  // The dialog holds no strings of its own; its wording travels in the hash
  // with the origins, so it renders in the language the rest of the app runs
  // in.
  let (details, title_key) = match confirmation {
    ConnectionConfirmation::HandoffError(failure) => {
      let detail = match failure {
        crate::handoff::Failure::Retryable(message)
        | crate::handoff::Failure::Terminal(message) => message.as_str(),
        _ => "",
      };
      (
        format!(
          "mode=handoff&message={}&action={}&detail={}",
          percent_encode(crate::i18n::t(failure.message_key())),
          percent_encode(failure.action_key().map(crate::i18n::t).unwrap_or("")),
          percent_encode(detail)
        ),
        "dialog.handoffWindowTitle",
      )
    }
    ConnectionConfirmation::AccountMismatch(mismatch) => (
      format!(
        "mode=handoff&message={}&action=&detail=",
        percent_encode(&mismatch.message()),
      ),
      "dialog.handoffWindowTitle",
    ),
    ConnectionConfirmation::HandoffConnect(target) => (
      format!(
        "mode=handoff&message={}&action={}&dismiss={}&detail={}",
        percent_encode(crate::i18n::t(match target {
          crate::handoff::Target::PdfSigning => "dialog.handoffConnectToSign",
          crate::handoff::Target::DesktopEdit => "dialog.handoffConnectToOpen",
        })),
        percent_encode(crate::i18n::t("dialog.connect")),
        percent_encode(crate::i18n::t("dialog.cancel")),
        percent_encode(crate::i18n::t("dialog.handoffConnectDetail")),
      ),
      "dialog.handoffWindowTitle",
    ),
    ConnectionConfirmation::SelfHost {
      web_origin,
      api_base_url,
    } => (
      format!(
        "webOrigin={}&apiBaseUrl={}",
        percent_encode(web_origin),
        percent_encode(api_base_url)
      ),
      "dialog.selfHostWindowTitle",
    ),
    ConnectionConfirmation::Account {
      email,
      organization_name,
    } => (
      format!(
        "mode=account&accountEmail={}&organizationName={}",
        percent_encode(email),
        percent_encode(organization_name)
      ),
      "dialog.accountWindowTitle",
    ),
  };
  let hash = format!(
    "{details}&strings={}&lang={}&dir={}",
    percent_encode(&crate::i18n::namespace_json("dialog")),
    percent_encode(crate::i18n::active_locale()),
    percent_encode(crate::i18n::text_direction()),
  );

  let builder = crate::app_window::builder(
    app_handle,
    "selfhost-connect-dialog",
    format!("selfhost-connect-dialog.html#{hash}"),
  )
  .title(crate::i18n::t(title_key))
  .inner_size(420.0, 320.0)
  .resizable(false);
  let builder = crate::window_placement::centered_on_target_screen(
    app_handle,
    builder,
    tauri::LogicalSize::new(420.0, 320.0),
  );

  #[cfg(target_os = "macos")]
  let builder = builder
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true);

  match builder.build() {
    Ok(window) => {
      // Closing the dialog with the OS window control bypasses the
      // Cancel/Connect commands, so release the reserved approval sender on
      // destroy. Otherwise the slot stays reserved until the timeout and every
      // retry fails as "already open".
      let (closed_sender, closed_receiver) = tokio::sync::oneshot::channel();
      let closed_sender = std::sync::Mutex::new(Some(closed_sender));
      window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
          set_self_host_connect_response(false);
          let sender = closed_sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
          if let Some(sender) = sender {
            let _ = sender.send(());
          }
        }
      });
      let _ = window.set_focus();
      let outcome = match tokio::time::timeout(
        SELF_HOST_CONNECT_APPROVAL_TIMEOUT,
        receiver,
      )
      .await
      {
        Ok(Ok(approved)) => approved,
        Ok(Err(_)) => false,
        Err(_) => {
          set_self_host_connect_response(false);
          false
        }
      };
      // The dialog closes itself once the user responds; close it explicitly so
      // a timeout or dropped sender does not leave a ghost window behind.
      let _ = window.close();
      tokio::time::timeout(ACKNOWLEDGE_TIMEOUT, closed_receiver)
        .await
        .map_err(crate::logging::with_cause_logged(
          "A self-host connection dialog is already open.",
        ))?
        .map_err(crate::logging::with_cause_logged(
          "A self-host connection dialog is already open.",
        ))?;
      Ok(outcome)
    }
    Err(error) => {
      set_self_host_connect_response(false);
      Err(format!(
        "failed to open self-host connection dialog: {error}"
      ))
    }
  }
}

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

#[derive(serde::Deserialize)]
struct RedeemedDesktopEditHandoff {
  identity: crate::types::DesktopAccountIdentity,
  #[serde(flatten)]
  request: OpenFileRequest,
}

pub(crate) fn ensure_handoff_identity(
  identity: &crate::types::DesktopAccountIdentity,
  expected: &crate::types::DesktopAccountIdentity,
) -> Result<(), crate::handoff::Failure> {
  if identity.user_id != expected.user_id
    || identity.organization_id != expected.organization_id
  {
    return Err(crate::handoff::Failure::AccountMismatch);
  }
  Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeDesktopEditHandoffOpenedRequest<'a> {
  handoff_token: &'a str,
  session_id: &'a str,
}

async fn acknowledge_desktop_edit_handoff_opened(
  client: &crate::http_client::DesktopHttpClient,
  api_base_url: &str,
  handoff_id: &str,
  handoff_token: &str,
  session_id: &str,
  app: &AppHandle,
  expected_account: &crate::account::LinkedAccount,
) -> Result<(), crate::handoff::Stop> {
  if !is_safe_session_id(handoff_id) {
    return Err(String::from("Invalid desktop edit handoff payload.").into());
  }

  let state = app.state::<crate::account::AccountState>();
  let account = crate::account::request_account(&state)
    .await?
    .ok_or(crate::handoff::Failure::AccountChanged)?;
  ensure_handoff_identity(&account.identity, &expected_account.identity)?;
  if account.api_base_url != api_base_url {
    return Err(crate::handoff::Failure::AccountChanged.into());
  }
  let url = format!("{api_base_url}/v1/desktop-edit-handoffs/{handoff_id}/opened");
  let builder = client
    .post(url)
    .json(&AcknowledgeDesktopEditHandoffOpenedRequest {
      handoff_token,
      session_id,
    })
    .timeout(ACKNOWLEDGE_TIMEOUT);
  let response = crate::http_client::device_proof_request(
    builder,
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?
  .send()
  .await
  .map_err(|e| format!("stella desktop could not acknowledge the edit handoff: {e}"))?;
  drop(account);

  if response.status().is_success() {
    return Ok(());
  }

  let status = response.status();
  let message = response
    .json::<ErrorResponse>()
    .await
    .ok()
    .and_then(|body| body.message)
    .unwrap_or_else(|| {
      format!("Desktop edit handoff acknowledgement was rejected ({status}).")
    });

  Err(message.into())
}

/// The account a redeemed handoff was opened for must still be the linked one.
pub(crate) async fn recheck_handoff_account(
  app_handle: &AppHandle,
  expected: &crate::account::LinkedAccount,
) -> Result<(), crate::handoff::Stop> {
  let state = app_handle.state::<crate::account::AccountState>();
  let unchanged = crate::account::current(&state)
    .await?
    .is_some_and(|current| {
      current.api_base_url == expected.api_base_url
        && current.identity.user_id == expected.identity.user_id
        && current.identity.organization_id == expected.identity.organization_id
    });
  if !unchanged {
    return Err(crate::handoff::Failure::AccountChanged.into());
  }
  Ok(())
}

async fn redeem_and_open_desktop_edit(
  manager: Arc<Mutex<SessionManager>>,
  app_handle: AppHandle,
  api_base_url: String,
  handoff_token: String,
) -> Result<(), crate::handoff::Stop> {
  let http_client = {
    let mgr = manager.lock().await;
    mgr.http_client().clone()
  };
  // Acknowledgements also carry the token and must never follow redirects.
  let handoff_client =
    crate::http_client::DesktopHttpClient::new(crate::http_client::HttpClientOptions {
      redirect: reqwest::redirect::Policy::none(),
      timeout: None,
    })
    .map_err(|error| error.to_string())?;
  let (redeemed, account) = crate::handoff::redeem::<RedeemedDesktopEditHandoff>(
    crate::handoff::RedeemOptions {
      manager: &manager,
      app: &app_handle,
      target: crate::handoff::Target::DesktopEdit,
      api_base_url: &api_base_url,
      token: &handoff_token,
    },
  )
  .await?;
  ensure_handoff_identity(&redeemed.identity, &account.identity)?;
  let request = redeemed.request;
  if request.api_base_url != api_base_url {
    return Err(crate::handoff::Failure::AccountMismatch.into());
  }
  let handoff_id = request.handoff_id.clone();

  if !is_safe_session_id(&request.remote_session.session_id) {
    return Err(String::from("Invalid desktop edit session payload.").into());
  }

  recheck_handoff_account(&app_handle, &account).await?;
  let download_url = request.remote_session.download_url.clone();
  let prefetched_buffer = download_file_standalone(
    request.remote_session.file_type,
    &http_client,
    &download_url,
  )
  .await?;

  let result = {
    let mut mgr = manager.lock().await;
    recheck_handoff_account(&app_handle, &account).await?;
    mgr.open_file(request, prefetched_buffer).await
  }?;

  SessionManager::attach_watcher(&manager, &result.session_id).await;

  if let Some(handoff_id) = handoff_id
    && let Err(error) = acknowledge_desktop_edit_handoff_opened(
      &handoff_client,
      &api_base_url,
      &handoff_id,
      &handoff_token,
      &result.session_id,
      &app_handle,
      &account,
    )
    .await
  {
    tracing::warn!(
      error = ?error,
      session_id = %result.session_id,
      "desktop edit handoff acknowledgement failed",
    );
  }

  {
    let mut mgr = manager.lock().await;
    mgr.ensure_sse_listener(&manager, &result.session_id);
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  const TOKEN: &str =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  #[test]
  fn account_links_accept_provider_ids_and_require_a_uuid_correlation() {
    let correlation = "11111111-1111-4111-8111-111111111111";
    for identity in [
      "a",
      "provider_user-1",
      "0123456789abcdefghijklmnopqrstuvwxyz",
      correlation,
    ] {
      let action = parse_deep_link(&format!(
        "stella://account/complete?correlationId={correlation}&userId={identity}&organizationId={identity}"
      ));
      assert_eq!(
        action,
        Some(DeepLinkAction::CompleteAccount {
          correlation_id: correlation.into(),
          user_id: identity.into(),
          organization_id: identity.into(),
        })
      );
    }
    for identity in [
      "".to_string(),
      "a".repeat(129),
      "invalid%2Fid".into(),
      "invalid%20id".into(),
      "ž".into(),
    ] {
      assert_eq!(
        parse_deep_link(&format!(
          "stella://account/complete?correlationId={correlation}&userId={identity}&organizationId={correlation}"
        )),
        None
      );
    }
    assert_eq!(
      parse_deep_link(&format!(
        "stella://account/complete?correlationId=provider_id&userId={correlation}&organizationId={correlation}"
      )),
      None
    );
  }

  #[test]
  fn a_document_handoff_requires_the_connected_account_identity() {
    let expected = crate::types::DesktopAccountIdentity {
      user_id: "user".into(),
      organization_id: "organization".into(),
    };
    assert!(ensure_handoff_identity(&expected, &expected).is_ok());
    for (user_id, organization_id) in [
      ("other-user", "organization"),
      ("user", "other-organization"),
      ("other-user", "other-organization"),
    ] {
      let identity = crate::types::DesktopAccountIdentity {
        user_id: user_id.into(),
        organization_id: organization_id.into(),
      };
      assert_eq!(
        ensure_handoff_identity(&identity, &expected),
        Err(crate::handoff::Failure::AccountMismatch)
      );
    }
  }

  #[test]
  fn parses_desktop_edit_handoff_link() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=https%3A%2F%2Fapi.stll.app",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::OpenDesktopEdit {
        api_base_url: "https://api.stll.app".to_string(),
        handoff_token: TOKEN.to_string(),
      })
    );
  }

  #[test]
  fn maps_app_origin_to_api_origin() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=https%3A%2F%2Fmy.stll.app",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::OpenDesktopEdit {
        api_base_url: "https://api.stll.app".to_string(),
        handoff_token: TOKEN.to_string(),
      })
    );
  }

  #[test]
  fn rejects_plain_http_non_loopback_api_url() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=http%3A%2F%2Fexample.com",
    );

    assert_eq!(action, None);
  }

  #[test]
  fn parses_https_api_url_before_runtime_trust_check() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=https%3A%2F%2Fexample.com",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::OpenDesktopEdit {
        api_base_url: "https://example.com".to_string(),
        handoff_token: TOKEN.to_string(),
      })
    );
  }

  #[test]
  fn rejects_malformed_handoff_token() {
    let action = parse_deep_link(
      "stella://desktop-edit/open?handoff=../bad&apiBaseUrl=https%3A%2F%2Fapi.stll.app",
    );

    assert_eq!(action, None);
  }

  #[test]
  fn parses_pdf_signing_handoff_link() {
    let action = parse_deep_link(
      "stella://pdf-sign/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=https%3A%2F%2Fmy.stll.app",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::OpenPdfSigning {
        api_base_url: "https://api.stll.app".to_string(),
        handoff_token: TOKEN.to_string(),
      })
    );
  }

  #[test]
  fn rejects_a_pdf_signing_link_with_a_malformed_token() {
    let action = parse_deep_link(
      "stella://pdf-sign/open?handoff=../bad&apiBaseUrl=https%3A%2F%2Fapi.stll.app",
    );

    assert_eq!(action, None);
  }

  #[test]
  fn rejects_a_pdf_signing_link_with_a_plain_http_api_url() {
    let action = parse_deep_link(
      "stella://pdf-sign/open?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=http%3A%2F%2Fexample.com",
    );

    assert_eq!(action, None);
  }

  #[test]
  fn rejects_a_pdf_signing_host_on_another_path() {
    // The host is matched with its path, so a neighbouring route cannot
    // inherit the handoff guards.
    let action = parse_deep_link(
      "stella://pdf-sign/redeem?handoff=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&apiBaseUrl=https%3A%2F%2Fapi.stll.app",
    );

    assert_eq!(action, None);
  }

  #[test]
  fn parses_self_host_connect_link() {
    let action = parse_deep_link(
      "stella://self-host/connect?webOrigin=https%3A%2F%2Fweb-production.example&apiBaseUrl=https%3A%2F%2Fapi-production.example",
    );

    assert_eq!(
      action,
      Some(DeepLinkAction::ConnectSelfHost {
        api_base_url: "https://api-production.example".to_string(),
        web_origin: "https://web-production.example".to_string(),
      })
    );
  }

  #[test]
  fn rejects_self_host_connect_origin_with_path() {
    let action = parse_deep_link(
      "stella://self-host/connect?webOrigin=https%3A%2F%2Fweb-production.example%2Fapp&apiBaseUrl=https%3A%2F%2Fapi-production.example",
    );

    assert_eq!(action, None);
  }
}
