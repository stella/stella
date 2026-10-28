//! The OAuth parts of Sign in with ChatGPT for open-source apps: PKCE, the
//! authorization request, the loopback callback listener and the checks a
//! returned callback URL must pass.
//!
//! Callback validation follows t3code's `codexCallbackUrl` (MIT): one exact
//! origin and path, no credentials or fragment, exactly one matching `state`.

use std::{
  net::Ipv4Addr,
  sync::{Arc, Mutex},
  time::Duration,
};

use axum::{
  Router,
  extract::{OriginalUri, State},
  http::{StatusCode, header},
  response::{IntoResponse, Response},
  routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

/// The first-time registration entrypoint; never saved or used to exchange.
pub(crate) const DYNAMIC_CLIENT_ID: &str = "dynamic_agent_client";
/// The app's name, sent as `agent_name_hint` and Codex's `clientInfo.name`.
pub(crate) const AGENT_NAME: &str = "Stella";
pub(crate) const SCOPES: &str =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The scope that allows requests on the user's ChatGPT plan.
pub(crate) const PLAN_USAGE_SCOPE: &str = "chatgpt.tokens.use.direct";
pub(crate) const RESOURCE: &str = "https://api.openai.com/v1";
pub(crate) const CALLBACK_PATH: &str = "/auth/callback";
const CALLBACK_HOST: &str = "127.0.0.1";
const MAX_CALLBACK_URL_BYTES: usize = 16 * 1024;

/// URL-safe random text with `bytes` of entropy.
pub(crate) fn random_token(bytes: usize) -> String {
  let mut buffer = vec![0_u8; bytes];
  SystemRandom::new()
    .fill(&mut buffer)
    .expect("the system random source is available");
  URL_SAFE_NO_PAD.encode(buffer)
}

pub(crate) struct Pkce {
  pub verifier: String,
  pub challenge: String,
}

impl Pkce {
  pub(crate) fn generate() -> Self {
    // 64 random bytes: an 86-character verifier, inside RFC 7636's 43..=128.
    let verifier = random_token(64);
    let challenge = Self::challenge_for(&verifier);
    Self {
      verifier,
      challenge,
    }
  }

  /// S256: base64url of the verifier's SHA-256, without padding.
  pub(crate) fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
  }
}

/// The only callback shape: `http`, `127.0.0.1`, `/auth/callback`; only the
/// port varies between attempts.
pub(crate) fn redirect_uri(port: u16) -> String {
  format!("http://{CALLBACK_HOST}:{port}{CALLBACK_PATH}")
}

/// Which client ID an attempt signs in with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClientSelection {
  /// First sign-in for an account: dynamic registration.
  Register,
  /// A saved registration's issued client ID.
  Returning {
    client_id: String,
    login_hint: Option<String>,
    id_token_hint: Option<String>,
    /// The previous sign-in did not grant plan usage; ask again.
    request_consent: bool,
  },
}

pub(crate) struct AuthorizationRequest<'a> {
  pub endpoint: &'a str,
  pub client: &'a ClientSelection,
  pub host_id: &'a str,
  pub redirect_uri: &'a str,
  pub resource: &'a str,
  pub state: &'a str,
  pub nonce: &'a str,
  pub code_challenge: &'a str,
}

/// The browser URL. It can carry an ID token hint, so it is never logged.
pub(crate) fn authorization_url(
  request: &AuthorizationRequest<'_>,
) -> Option<reqwest::Url> {
  let mut url = reqwest::Url::parse(request.endpoint).ok()?;
  {
    let mut query = url.query_pairs_mut();
    query.clear();
    match request.client {
      ClientSelection::Register => {
        query.append_pair("client_id", DYNAMIC_CLIENT_ID);
        query.append_pair("agent_name_hint", AGENT_NAME);
      }
      ClientSelection::Returning {
        client_id,
        login_hint,
        id_token_hint,
        request_consent,
      } => {
        query.append_pair("client_id", client_id);
        if let Some(hint) = login_hint {
          query.append_pair("login_hint", hint);
        }
        if let Some(hint) = id_token_hint {
          query.append_pair("id_token_hint", hint);
        }
        if *request_consent {
          query.append_pair("prompt", "consent");
        }
      }
    }
    query.append_pair("ext_agent_host_id", request.host_id);
    query.append_pair("response_type", "code");
    query.append_pair("redirect_uri", request.redirect_uri);
    query.append_pair("scope", SCOPES);
    query.append_pair("resource", request.resource);
    query.append_pair("state", request.state);
    query.append_pair("nonce", request.nonce);
    query.append_pair("code_challenge_method", "S256");
    query.append_pair("code_challenge", request.code_challenge);
  }
  Some(url)
}

/// A form-encoded body, without pulling in a form encoder of its own.
pub(crate) fn form_body(pairs: &[(&str, &str)]) -> String {
  let mut url =
    reqwest::Url::parse("http://form.invalid/").expect("a static URL parses");
  url.query_pairs_mut().extend_pairs(pairs);
  url.query().unwrap_or_default().to_owned()
}

/// What a callback URL carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CallbackResult {
  Code {
    code: String,
    client_id: Option<String>,
  },
  Denied,
  Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallbackRejection {
  /// Not a URL for this attempt's callback.
  NotThisSignIn,
  /// The right callback, but another attempt's `state`.
  StateMismatch,
}

/// Checks a returned URL against the attempt's exact redirect URI and state.
/// A pasted URL may lack `http://`, as browsers hide it in the address bar.
pub(crate) fn parse_callback(
  raw: &str,
  redirect_uri: &str,
  state: &str,
) -> Result<CallbackResult, CallbackRejection> {
  if raw.len() > MAX_CALLBACK_URL_BYTES {
    return Err(CallbackRejection::NotThisSignIn);
  }
  let expected = reqwest::Url::parse(redirect_uri)
    .map_err(|_invalid| CallbackRejection::NotThisSignIn)?;
  let trimmed = raw.trim();
  let candidate = if trimmed.contains("://") {
    trimmed.to_owned()
  } else {
    format!("{}://{trimmed}", expected.scheme())
  };
  let url = reqwest::Url::parse(&candidate)
    .map_err(|_invalid| CallbackRejection::NotThisSignIn)?;
  if url.origin() != expected.origin()
    || url.path() != expected.path()
    || !url.username().is_empty()
    || url.password().is_some()
    || url.fragment().is_some()
  {
    return Err(CallbackRejection::NotThisSignIn);
  }
  let values = |name: &str| -> Vec<String> {
    url
      .query_pairs()
      .filter(|(key, _)| key == name)
      .map(|(_, value)| value.into_owned())
      .collect()
  };
  let states = values("state");
  if states.len() != 1 || states[0] != state {
    return Err(CallbackRejection::StateMismatch);
  }
  let errors = values("error");
  let codes = values("code");
  let clients = values("client_id");
  if clients.len() > 1 || clients.iter().any(|client| !is_issued_client_id(client)) {
    return Err(CallbackRejection::NotThisSignIn);
  }
  match (errors.as_slice(), codes.as_slice()) {
    ([error], []) if error == "access_denied" => Ok(CallbackResult::Denied),
    ([_], []) => Ok(CallbackResult::Error),
    ([], [code]) if !code.is_empty() => Ok(CallbackResult::Code {
      code: code.clone(),
      client_id: clients.into_iter().next(),
    }),
    _ => Err(CallbackRejection::NotThisSignIn),
  }
}

pub(crate) fn is_issued_client_id(value: &str) -> bool {
  value.strip_prefix("oaiapp_").is_some_and(|rest| {
    !rest.is_empty()
      && rest
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
  })
}

/// What the browser's callback page says once the attempt settles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallbackPage {
  Connected,
  NotConnected,
}

/// One URL handed to the waiting attempt, from the listener or a paste.
pub(crate) struct DeliveredCallback {
  pub url: String,
  /// Present for the listener: the browser waits for the outcome page.
  pub page: Option<oneshot::Sender<CallbackPage>>,
}

pub(crate) type CallbackSlot = Arc<Mutex<Option<oneshot::Sender<DeliveredCallback>>>>;

/// A single-use loopback listener on `127.0.0.1`. A callback is checked
/// against the attempt's `state` before it can take the slot: one for another
/// attempt is refused and the listener keeps waiting, and once the slot is
/// taken every later request is refused. It stops when dropped.
pub(crate) struct CallbackListener {
  port: u16,
  stop: Option<oneshot::Sender<()>>,
  /// Tests wait on it; otherwise the server finishes its last response and
  /// exits on its own.
  #[cfg(test)]
  served: Option<tokio::task::JoinHandle<()>>,
}

impl CallbackListener {
  pub(crate) async fn bind(
    slot: CallbackSlot,
    expected_state: String,
    page_wait: Duration,
  ) -> std::io::Result<Self> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let state = Arc::new(ListenerState {
      slot,
      port,
      expected_state,
      page_wait,
    });
    let router = Router::new()
      .route(CALLBACK_PATH, get(callback))
      .fallback(|| async { StatusCode::NOT_FOUND })
      .with_state(state);
    let (stop, stopped) = oneshot::channel::<()>();
    #[cfg_attr(
      not(test),
      allow(unused_variables, reason = "only tests await the server")
    )]
    let served = tokio::spawn(async move {
      let served = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
          let _ = stopped.await;
        })
        .await;
      if let Err(error) = served {
        tracing::warn!(kind = ?error.kind(), "ChatGPT sign-in callback listener stopped");
      }
    });
    Ok(Self {
      port,
      stop: Some(stop),
      #[cfg(test)]
      served: Some(served),
    })
  }

  pub(crate) fn port(&self) -> u16 {
    self.port
  }

  /// Stops listening and waits until the socket is closed.
  #[cfg(test)]
  pub(crate) async fn close(mut self) {
    if let Some(stop) = self.stop.take() {
      let _ = stop.send(());
    }
    if let Some(served) = self.served.take() {
      served.await.unwrap();
    }
  }
}

impl Drop for CallbackListener {
  fn drop(&mut self) {
    if let Some(stop) = self.stop.take() {
      let _ = stop.send(());
    }
  }
}

struct ListenerState {
  slot: CallbackSlot,
  port: u16,
  expected_state: String,
  page_wait: Duration,
}

async fn callback(
  State(state): State<Arc<ListenerState>>,
  OriginalUri(uri): OriginalUri,
) -> Response {
  let url = format!("http://{CALLBACK_HOST}:{}{uri}", state.port);
  // Checked before the slot is touched, as a pasted URL is: a request for
  // another attempt cannot use up this one.
  if parse_callback(&url, &redirect_uri(state.port), &state.expected_state).is_err() {
    return (
      StatusCode::BAD_REQUEST,
      page_html(CallbackPage::NotConnected),
    )
      .into_response();
  }
  let taken = state.slot.lock().ok().and_then(|mut slot| slot.take());
  let Some(waiting) = taken else {
    return (StatusCode::GONE, page_html(CallbackPage::NotConnected)).into_response();
  };
  let (page, outcome) = oneshot::channel();
  if waiting
    .send(DeliveredCallback {
      url,
      page: Some(page),
    })
    .is_err()
  {
    return (StatusCode::GONE, page_html(CallbackPage::NotConnected)).into_response();
  }
  let shown = tokio::time::timeout(state.page_wait, outcome)
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or(CallbackPage::NotConnected);
  let status = match shown {
    CallbackPage::Connected => StatusCode::OK,
    CallbackPage::NotConnected => StatusCode::BAD_REQUEST,
  };
  (status, page_html(shown)).into_response()
}

fn page_html(page: CallbackPage) -> impl IntoResponse {
  let (title, body) = match page {
    CallbackPage::Connected => (
      crate::i18n::t("agentSubscriptions.callbackConnectedTitle"),
      crate::i18n::t("agentSubscriptions.callbackConnectedBody"),
    ),
    CallbackPage::NotConnected => (
      crate::i18n::t("agentSubscriptions.callbackNotConnectedTitle"),
      crate::i18n::t("agentSubscriptions.callbackNotConnectedBody"),
    ),
  };
  let html = format!(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
     <style>body{{font:15px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1rem;color:#111}}\
     @media (prefers-color-scheme:dark){{body{{background:#111;color:#eee}}}}</style></head>\
     <body><h1>{title}</h1><p>{body}</p></body></html>",
    title = ammonia::clean_text(title),
    body = ammonia::clean_text(body),
  );
  (
    [
      (header::CONTENT_TYPE, "text/html; charset=utf-8"),
      (header::CACHE_CONTROL, "no-store"),
      (header::REFERRER_POLICY, "no-referrer"),
      (
        header::CONTENT_SECURITY_POLICY,
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      ),
      (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
    ],
    html,
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  const REDIRECT: &str = "http://127.0.0.1:43123/auth/callback";

  #[test]
  fn pkce_uses_s256_over_a_fresh_verifier() {
    // RFC 7636 appendix B.
    assert_eq!(
      Pkce::challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let first = Pkce::generate();
    let second = Pkce::generate();
    assert_ne!(first.verifier, second.verifier);
    assert!((43..=128).contains(&first.verifier.len()));
    assert_eq!(first.challenge, Pkce::challenge_for(&first.verifier));
    assert!(!first.challenge.contains('='));
  }

  #[test]
  fn states_and_nonces_are_unpredictable() {
    let tokens: std::collections::HashSet<_> =
      (0..64).map(|_| random_token(32)).collect();
    assert_eq!(tokens.len(), 64);
    assert!(tokens.iter().all(|token| token.len() == 43));
  }

  #[test]
  fn the_redirect_uri_is_exactly_the_loopback_ip_and_path() {
    assert_eq!(redirect_uri(1455), "http://127.0.0.1:1455/auth/callback");
    let uri = reqwest::Url::parse(&redirect_uri(54321)).unwrap();
    assert_eq!(uri.host_str(), Some("127.0.0.1"));
    assert_eq!(uri.path(), "/auth/callback");
  }

  fn query(url: &reqwest::Url) -> Vec<(String, String)> {
    url
      .query_pairs()
      .map(|(key, value)| (key.into_owned(), value.into_owned()))
      .collect()
  }

  #[test]
  fn first_sign_in_registers_with_the_dynamic_client_and_host() {
    let url = authorization_url(&AuthorizationRequest {
      endpoint: "https://auth.example.test/api/accounts/authorize",
      client: &ClientSelection::Register,
      host_id: "urn:uuid:00000000-0000-4000-8000-000000000000",
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      state: "state-1",
      nonce: "nonce-1",
      code_challenge: "challenge-1",
    })
    .unwrap();
    assert_eq!(
      query(&url),
      [
        ("client_id", DYNAMIC_CLIENT_ID),
        ("agent_name_hint", "Stella"),
        (
          "ext_agent_host_id",
          "urn:uuid:00000000-0000-4000-8000-000000000000"
        ),
        ("response_type", "code"),
        ("redirect_uri", REDIRECT),
        (
          "scope",
          "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
        ),
        ("resource", "https://api.openai.com/v1"),
        ("state", "state-1"),
        ("nonce", "nonce-1"),
        ("code_challenge_method", "S256"),
        ("code_challenge", "challenge-1"),
      ]
      .map(|(key, value)| (key.to_owned(), value.to_owned()))
    );
    assert!(!url.as_str().contains("localhost"));
  }

  #[test]
  fn returning_sign_in_reuses_the_issued_client_without_a_name_hint() {
    let url = authorization_url(&AuthorizationRequest {
      endpoint: "https://auth.example.test/api/accounts/authorize",
      client: &ClientSelection::Returning {
        client_id: "oaiapp_issued".into(),
        login_hint: Some("person@example.com".into()),
        id_token_hint: Some("hint".into()),
        request_consent: true,
      },
      host_id: "urn:uuid:host",
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      state: "s",
      nonce: "n",
      code_challenge: "c",
    })
    .unwrap();
    let pairs = query(&url);
    let get = |name: &str| {
      pairs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
    };
    assert_eq!(get("client_id"), Some("oaiapp_issued"));
    assert_eq!(get("agent_name_hint"), None);
    assert_eq!(get("login_hint"), Some("person@example.com"));
    assert_eq!(get("id_token_hint"), Some("hint"));
    assert_eq!(get("prompt"), Some("consent"));
    assert_eq!(get("ext_agent_host_id"), Some("urn:uuid:host"));
  }

  #[test]
  fn form_bodies_are_url_encoded() {
    assert_eq!(
      form_body(&[
        ("grant_type", "authorization_code"),
        ("redirect_uri", REDIRECT)
      ]),
      "grant_type=authorization_code&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2Fauth%2Fcallback"
    );
  }

  #[test]
  fn a_matching_callback_yields_its_code_and_issued_client() {
    assert_eq!(
      parse_callback(
        &format!("{REDIRECT}?code=abc&state=s1&client_id=oaiapp_X-1&scope=openid"),
        REDIRECT,
        "s1"
      ),
      Ok(CallbackResult::Code {
        code: "abc".into(),
        client_id: Some("oaiapp_X-1".into())
      })
    );
    // The address bar hides the scheme.
    assert!(matches!(
      parse_callback(
        "127.0.0.1:43123/auth/callback?code=abc&state=s1",
        REDIRECT,
        "s1"
      ),
      Ok(CallbackResult::Code {
        client_id: None,
        ..
      })
    ));
    assert_eq!(
      parse_callback(
        &format!("{REDIRECT}?error=access_denied&state=s1"),
        REDIRECT,
        "s1"
      ),
      Ok(CallbackResult::Denied)
    );
  }

  #[test]
  fn callbacks_for_another_attempt_or_address_are_refused() {
    let state = "s1";
    for url in [
      format!("{REDIRECT}?code=abc&state=other"),
      format!("{REDIRECT}?code=abc"),
      format!("{REDIRECT}?code=abc&state=s1&state=s1"),
    ] {
      assert_eq!(
        parse_callback(&url, REDIRECT, state),
        Err(CallbackRejection::StateMismatch),
        "{url}"
      );
    }
    for url in [
      "http://localhost:43123/auth/callback?code=abc&state=s1",
      "http://127.0.0.1:43124/auth/callback?code=abc&state=s1",
      "https://127.0.0.1:43123/auth/callback?code=abc&state=s1",
      "http://127.0.0.1:43123/callback?code=abc&state=s1",
      "http://user@127.0.0.1:43123/auth/callback?code=abc&state=s1",
      "http://127.0.0.1:43123/auth/callback?code=abc&state=s1#x",
      "http://127.0.0.1:43123/auth/callback?code=abc&state=s1&client_id=dynamic_agent_client",
      "http://127.0.0.1:43123/auth/callback?code=a&code=b&state=s1",
      "http://127.0.0.1:43123/auth/callback?state=s1",
    ] {
      assert_eq!(
        parse_callback(url, REDIRECT, state),
        Err(CallbackRejection::NotThisSignIn),
        "{url}"
      );
    }
    let long = format!(
      "{REDIRECT}?code={}&state=s1",
      "a".repeat(MAX_CALLBACK_URL_BYTES)
    );
    assert_eq!(
      parse_callback(&long, REDIRECT, state),
      Err(CallbackRejection::NotThisSignIn)
    );
  }

  #[test]
  fn issued_client_ids_have_the_oaiapp_prefix() {
    assert!(is_issued_client_id("oaiapp_EHBV7pzdMtehZ7j6Ypgyje-F"));
    for value in [
      "dynamic_agent_client",
      "oaiapp_",
      "oaiapp_a b",
      "x_oaiapp_a",
    ] {
      assert!(!is_issued_client_id(value), "{value}");
    }
  }

  #[tokio::test]
  async fn the_listener_serves_one_callback_and_refuses_replays() {
    crate::i18n::init_en();
    let slot: CallbackSlot = Arc::new(Mutex::new(None));
    let (deliver, delivered) = oneshot::channel();
    *slot.lock().unwrap() = Some(deliver);
    let listener =
      CallbackListener::bind(Arc::clone(&slot), "s".into(), Duration::from_secs(5))
        .await
        .unwrap();
    let port = listener.port();
    let base = format!("http://127.0.0.1:{port}");
    let client = crate::http_client::DesktopHttpClient::new(
      crate::http_client::HttpClientOptions {
        timeout: Some(Duration::from_secs(5)),
        redirect: reqwest::redirect::Policy::none(),
      },
    )
    .unwrap();

    assert_eq!(
      client
        .get(format!("{base}/favicon.ico"))
        .send()
        .await
        .unwrap()
        .status(),
      StatusCode::NOT_FOUND
    );
    // Another attempt's callback is refused and does not use up this one.
    for forged in ["state=other&code=c", "code=c"] {
      let refused = client
        .get(format!("{base}{CALLBACK_PATH}?{forged}"))
        .send()
        .await
        .unwrap();
      assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
      assert!(slot.lock().unwrap().is_some());
    }
    let first = tokio::spawn({
      let client = client.clone();
      let url = format!("{base}{CALLBACK_PATH}?code=c&state=s");
      async move { client.get(url).send().await.unwrap() }
    });
    let received = delivered.await.unwrap();
    assert_eq!(
      received.url,
      format!("{base}{CALLBACK_PATH}?code=c&state=s")
    );
    received
      .page
      .unwrap()
      .send(CallbackPage::Connected)
      .unwrap();
    let response = first.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
      response.headers().get(header::CACHE_CONTROL).unwrap(),
      "no-store"
    );

    let replay = client
      .get(format!("{base}{CALLBACK_PATH}?code=c&state=s"))
      .send()
      .await
      .unwrap();
    assert_eq!(replay.status(), StatusCode::GONE);

    listener.close().await;
    assert!(
      tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err(),
      "the listener closes once its attempt ends"
    );
  }
}
