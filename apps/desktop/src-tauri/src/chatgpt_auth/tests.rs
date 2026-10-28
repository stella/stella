//! The sign-in against a local fake issuer: its own discovery document,
//! JWKS, token and revocation endpoints. Nothing here reaches OpenAI.

use std::{
  collections::{HashMap, VecDeque},
  sync::{Arc, Mutex},
  time::Duration,
};

use axum::{
  Form, Json, Router,
  extract::State,
  http::StatusCode,
  response::{IntoResponse, Response},
  routing::{get, post},
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{
  id_token::fake_issuer::FakeIssuer,
  oauth::{CALLBACK_PATH, Pkce},
  store::MemoryVault,
  *,
};
use crate::http_client::{DesktopHttpClient, HttpClientOptions};

const ISSUED_CLIENT: &str = "oaiapp_IssuedFixture";
const ALL_SCOPES: &str =
  "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

struct Grant {
  subject: String,
  email: String,
  scope: String,
  /// Sign the ID token with a key the JWKS does not publish.
  impostor: bool,
}

struct FakeState {
  base: String,
  issuer: FakeIssuer,
  impostor: FakeIssuer,
  grant: Grant,
  /// The last authorization request's parameters, per `state`.
  authorizations: HashMap<String, HashMap<String, String>>,
  /// Every form posted to the token endpoint.
  token_requests: Vec<HashMap<String, String>>,
  revocations: Vec<HashMap<String, String>>,
  /// Refresh token the endpoint currently accepts.
  live_refresh: Option<String>,
  issued: u32,
  refresh_errors: VecDeque<&'static str>,
  /// The scopes a renewal grants.
  refresh_scope: String,
  revoke_status: StatusCode,
}

type Shared = Arc<Mutex<FakeState>>;

struct FakeOpenAi {
  state: Shared,
  base: String,
}

impl FakeOpenAi {
  async fn start() -> Self {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(FakeState {
      base: base.clone(),
      issuer: FakeIssuer::new("fake-key-1"),
      impostor: FakeIssuer::new("fake-key-1"),
      grant: Grant {
        subject: "subject-1".into(),
        email: "person@example.com".into(),
        scope: ALL_SCOPES.into(),
        impostor: false,
      },
      authorizations: HashMap::new(),
      token_requests: Vec::new(),
      revocations: Vec::new(),
      live_refresh: None,
      issued: 0,
      refresh_errors: VecDeque::new(),
      refresh_scope: ALL_SCOPES.into(),
      revoke_status: StatusCode::OK,
    }));
    let router = Router::new()
      .route("/.well-known/openid-configuration", get(discovery))
      .route("/.well-known/jwks.json", get(jwks))
      .route("/api/accounts/oauth/token", post(token))
      .route("/oauth/revoke", post(revoke))
      .with_state(Arc::clone(&state));
    tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    Self { state, base }
  }

  fn config(&self, sign_in_timeout: Duration) -> ChatGptAuthConfig {
    ChatGptAuthConfig {
      discovery_url: format!("{}/.well-known/openid-configuration", self.base),
      issuer: self.base.clone(),
      resource: oauth::RESOURCE.into(),
      sign_in_timeout,
      page_wait: Duration::from_secs(5),
    }
  }

  fn with<T>(&self, read: impl FnOnce(&mut FakeState) -> T) -> T {
    read(&mut self.state.lock().unwrap())
  }
}

async fn discovery(State(state): State<Shared>) -> Json<Value> {
  let base = state.lock().unwrap().base.clone();
  Json(json!({
    "issuer": base,
    "authorization_endpoint": format!("{base}/api/accounts/authorize"),
    "token_endpoint": format!("{base}/api/accounts/oauth/token"),
    "jwks_uri": format!("{base}/.well-known/jwks.json"),
    "revocation_endpoint": format!("{base}/oauth/revoke"),
  }))
}

async fn jwks(State(state): State<Shared>) -> Json<Value> {
  Json(state.lock().unwrap().issuer.jwks_json())
}

fn oauth_error(status: StatusCode, error: &str) -> Response {
  (status, Json(json!({ "error": error }))).into_response()
}

#[allow(
  clippy::significant_drop_tightening,
  reason = "the fake answers one request at a time"
)]
async fn token(
  State(state): State<Shared>,
  Form(form): Form<HashMap<String, String>>,
) -> Response {
  let mut fake = state.lock().unwrap();
  fake.token_requests.push(form.clone());
  if form.contains_key("client_secret")
    || form.get("resource").map(String::as_str) != Some(oauth::RESOURCE)
  {
    return oauth_error(StatusCode::BAD_REQUEST, "invalid_request");
  }
  match form.get("grant_type").map(String::as_str) {
    Some("authorization_code") => {
      // The code names the attempt's state, so the fake can check the PKCE
      // verifier and redirect URI against that authorization request.
      let Some(authorization) = form
        .get("code")
        .and_then(|code| code.strip_prefix("code-"))
        .and_then(|state| fake.authorizations.remove(state))
      else {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
      };
      let verifier_matches = form.get("code_verifier").is_some_and(|verifier| {
        Pkce::challenge_for(verifier) == authorization["code_challenge"]
      });
      if !verifier_matches
        || form.get("redirect_uri") != authorization.get("redirect_uri")
        || form.get("client_id").map(String::as_str) != Some(ISSUED_CLIENT)
      {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant");
      }
      let now = chrono::Utc::now().timestamp();
      let claims = json!({
        "iss": fake.base,
        "sub": fake.grant.subject,
        "aud": [ISSUED_CLIENT],
        "nonce": authorization["nonce"],
        "email": fake.grant.email,
        "iat": now,
        "exp": now + 3600,
        "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" },
      });
      let id_token = if fake.grant.impostor {
        fake.impostor.sign(&claims)
      } else {
        fake.issuer.sign(&claims)
      };
      fake.issued += 1;
      let refresh = format!("refresh-{}", fake.issued);
      fake.live_refresh = Some(refresh.clone());
      Json(json!({
        "access_token": format!("access-{}", fake.issued),
        "refresh_token": refresh,
        "id_token": id_token,
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": fake.grant.scope,
      }))
      .into_response()
    }
    Some("refresh_token") => {
      if let Some(error) = fake.refresh_errors.pop_front() {
        return oauth_error(StatusCode::BAD_REQUEST, error);
      }
      if form.get("client_id").map(String::as_str) != Some(ISSUED_CLIENT) {
        return oauth_error(StatusCode::UNAUTHORIZED, "invalid_client");
      }
      if form.get("refresh_token") != fake.live_refresh.as_ref() {
        return oauth_error(StatusCode::BAD_REQUEST, "refresh_token_reused");
      }
      fake.issued += 1;
      let refresh = format!("refresh-{}", fake.issued);
      fake.live_refresh = Some(refresh.clone());
      Json(json!({
        "access_token": format!("access-{}", fake.issued),
        "refresh_token": refresh,
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": fake.refresh_scope,
      }))
      .into_response()
    }
    _ => oauth_error(StatusCode::BAD_REQUEST, "unsupported_grant_type"),
  }
}

async fn revoke(
  State(state): State<Shared>,
  Form(form): Form<HashMap<String, String>>,
) -> StatusCode {
  let mut fake = state.lock().unwrap();
  fake.revocations.push(form);
  fake.live_refresh = None;
  fake.revoke_status
}

/// The user's browser: receives the authorization URL the app opens.
struct Browser {
  opened: mpsc::UnboundedReceiver<String>,
}

/// Waits, without polling a clock, until the attempt in progress settles.
async fn settle(auth: &ChatGptAuth, changed: &tokio::sync::Notify) -> ChatGptState {
  loop {
    let status = auth.status().await;
    if status.state != ChatGptState::SigningIn {
      return status.state;
    }
    tokio::time::timeout(Duration::from_secs(10), changed.notified())
      .await
      .expect("the sign-in settles");
  }
}

struct Harness {
  changed: Arc<tokio::sync::Notify>,
  fake: FakeOpenAi,
  auth: ChatGptAuth,
  vault: Arc<MemoryVault>,
  browser: Browser,
  cleared_harness: Arc<Mutex<u32>>,
  http: DesktopHttpClient,
  sign_in_timeout: Duration,
}

fn http() -> DesktopHttpClient {
  DesktopHttpClient::new(HttpClientOptions {
    timeout: Some(Duration::from_secs(10)),
    redirect: reqwest::redirect::Policy::none(),
  })
  .unwrap()
}

impl Harness {
  async fn new(sign_in_timeout: Duration) -> Self {
    // The callback page renders native strings.
    crate::i18n::init_en();
    let fake = FakeOpenAi::start().await;
    let vault = Arc::new(MemoryVault::default());
    let cleared_harness = Arc::new(Mutex::new(0));
    let changed = Arc::new(tokio::sync::Notify::new());
    let (auth, browser) =
      Self::app(&fake, sign_in_timeout, &vault, &cleared_harness, &changed);
    Self {
      changed,
      fake,
      auth,
      vault,
      browser,
      cleared_harness,
      http: http(),
      sign_in_timeout,
    }
  }

  /// One app process over the shared vault and fake issuer.
  fn app(
    fake: &FakeOpenAi,
    sign_in_timeout: Duration,
    vault: &Arc<MemoryVault>,
    cleared_harness: &Arc<Mutex<u32>>,
    changed: &Arc<tokio::sync::Notify>,
  ) -> (ChatGptAuth, Browser) {
    let (open, opened) = mpsc::unbounded_channel();
    let cleared = Arc::clone(cleared_harness);
    let notify = Arc::clone(changed);
    let auth = ChatGptAuth::new(
      fake.config(sign_in_timeout),
      Arc::clone(vault) as Arc<dyn store::ChatGptVault>,
      http(),
      ChatGptAuthHooks {
        open_browser: Box::new(move |url| open.send(url.to_owned()).is_ok()),
        changed: Box::new(move || notify.notify_one()),
        clear_harness_sign_in: Box::new(move || *cleared.lock().unwrap() += 1),
      },
    );
    (auth, Browser { opened })
  }

  /// Quits and starts the app again over the same stored connection.
  fn restart(&mut self) {
    let (auth, browser) = Self::app(
      &self.fake,
      self.sign_in_timeout,
      &self.vault,
      &self.cleared_harness,
      &self.changed,
    );
    self.auth = auth;
    self.browser = browser;
  }

  /// Waits for the browser to open and records the request at the fake, as
  /// the real authorization server would remember it.
  async fn authorization(&mut self) -> HashMap<String, String> {
    let url = tokio::time::timeout(Duration::from_secs(5), self.browser.opened.recv())
      .await
      .unwrap()
      .unwrap();
    let url = reqwest::Url::parse(&url).unwrap();
    assert_eq!(url.path(), "/api/accounts/authorize");
    let params: HashMap<String, String> = url
      .query_pairs()
      .map(|(key, value)| (key.into_owned(), value.into_owned()))
      .collect();
    self.fake.with(|fake| {
      fake
        .authorizations
        .insert(params["state"].clone(), params.clone());
    });
    params
  }

  fn callback_url(
    params: &HashMap<String, String>,
    state: &str,
    issue_client: bool,
  ) -> String {
    let mut url = format!(
      "{}?code=code-{}&state={state}&scope=openid",
      params["redirect_uri"], params["state"]
    );
    if issue_client {
      url.push_str(&format!("&client_id={ISSUED_CLIENT}"));
    }
    url
  }

  async fn browser_returns(&self, url: &str) -> StatusCode {
    self.http.get(url).send().await.unwrap().status()
  }

  async fn settled(&self) -> ChatGptState {
    settle(&self.auth, &self.changed).await
  }

  /// A callback after the attempt ended is never accepted: its listener is
  /// closed, or still closing and answering that the sign-in is over.
  async fn assert_refused(&self, url: String) {
    if let Ok(response) = self.http.get(url).send().await {
      assert_eq!(response.status(), StatusCode::GONE);
    }
  }

  async fn sign_in(&mut self, intent: SignInIntent) -> HashMap<String, String> {
    self.auth.start(intent);
    let params = self.authorization().await;
    let register = params["client_id"] == oauth::DYNAMIC_CLIENT_ID;
    let url = Self::callback_url(&params, &params["state"], register);
    // The callback page reports the outcome; tests read it from the status.
    self.browser_returns(&url).await;
    params
  }

  fn record(&self) -> store::ChatGptRecord {
    self.vault.record.lock().unwrap().clone()
  }
}

#[tokio::test]
async fn first_sign_in_registers_verifies_and_stores_the_connection() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  assert_eq!(harness.auth.status().await.state, ChatGptState::SignedOut);
  let params = harness.sign_in(SignInIntent::SameAccount).await;
  assert_eq!(
    harness.settled().await,
    ChatGptState::Connected {
      email: Some("person@example.com".into()),
      plan: Some("plus".into()),
    }
  );

  assert_eq!(params["client_id"], "dynamic_agent_client");
  assert_eq!(params["agent_name_hint"], "Stella");
  assert_eq!(params["response_type"], "code");
  assert_eq!(params["code_challenge_method"], "S256");
  assert_eq!(params["resource"], "https://api.openai.com/v1");
  assert_eq!(
    params["scope"],
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
  );
  let redirect = reqwest::Url::parse(&params["redirect_uri"]).unwrap();
  assert_eq!(redirect.scheme(), "http");
  assert_eq!(redirect.host_str(), Some("127.0.0.1"));
  assert_eq!(redirect.path(), CALLBACK_PATH);
  let host_id = params["ext_agent_host_id"].clone();
  assert!(host_id.starts_with("urn:uuid:"));

  let exchange = harness.fake.with(|fake| fake.token_requests[0].clone());
  assert_eq!(exchange["client_id"], ISSUED_CLIENT);
  assert_eq!(exchange["redirect_uri"], params["redirect_uri"]);
  assert!(!exchange.contains_key("client_secret"));

  let record = harness.record();
  let registration = record.registration.unwrap();
  assert_eq!(registration.client_id, ISSUED_CLIENT);
  assert_eq!(registration.subject.as_deref(), Some("subject-1"));
  let session = record.session.unwrap();
  assert_eq!(session.access_token, "access-1");
  assert_eq!(session.refresh_token.as_deref(), Some("refresh-1"));
  assert!(session.grants(oauth::PLAN_USAGE_SCOPE));

  // The listener served its one callback.
  harness
    .assert_refused(Harness::callback_url(&params, &params["state"], true))
    .await;

  // A returning sign-in reuses the issued client and this host's ID.
  let again = harness.sign_in(SignInIntent::SameAccount).await;
  assert_eq!(again["client_id"], ISSUED_CLIENT);
  assert!(!again.contains_key("agent_name_hint"));
  assert_eq!(again["ext_agent_host_id"], host_id);
  assert_eq!(again["login_hint"], "person@example.com");
  assert_eq!(again["id_token_hint"], session.id_token);
  assert_ne!(again["state"], params["state"]);
  assert_ne!(again["nonce"], params["nonce"]);
  assert_ne!(again["code_challenge"], params["code_challenge"]);
  assert!(matches!(
    harness.settled().await,
    ChatGptState::Connected { .. }
  ));
}

#[tokio::test]
async fn a_sign_in_without_plan_usage_is_a_typed_failure() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.fake.with(|fake| {
    fake.grant.scope = "email offline_access openid profile resource.invoke".into();
  });
  let callback = {
    harness.auth.start(SignInIntent::SameAccount);
    let params = harness.authorization().await;
    Harness::callback_url(&params, &params["state"], true)
  };
  assert_eq!(
    harness.browser_returns(&callback).await,
    StatusCode::BAD_REQUEST
  );
  assert_eq!(
    harness.settled().await,
    ChatGptState::Failed {
      reason: ChatGptFailure::PlanUsageNotGranted
    }
  );
  let record = harness.record();
  assert!(record.session.is_none());
  assert!(!record.registration.as_ref().unwrap().plan_usage_granted);
  assert_eq!(
    harness.auth.access(None).await,
    Err(AccessError::NotConnected)
  );

  // Trying again asks for consent with the saved client.
  harness
    .fake
    .with(|fake| fake.grant.scope = ALL_SCOPES.into());
  let params = harness.sign_in(SignInIntent::SameAccount).await;
  assert_eq!(params["client_id"], ISSUED_CLIENT);
  assert_eq!(params["prompt"], "consent");
  assert!(matches!(
    harness.settled().await,
    ChatGptState::Connected { .. }
  ));
}

#[tokio::test]
async fn a_callback_with_another_state_is_refused_without_an_exchange() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.auth.start(SignInIntent::SameAccount);
  let params = harness.authorization().await;
  for forged in [
    Harness::callback_url(&params, "forged-state", true),
    format!("{}?code=code-{}", params["redirect_uri"], params["state"]),
  ] {
    assert_eq!(
      harness.browser_returns(&forged).await,
      StatusCode::BAD_REQUEST
    );
  }
  // The attempt is still waiting and nothing was exchanged.
  assert_eq!(harness.auth.status().await.state, ChatGptState::SigningIn);
  assert!(harness.fake.with(|fake| fake.token_requests.is_empty()));
  // The genuine callback still completes it, once.
  let genuine = Harness::callback_url(&params, &params["state"], true);
  assert_eq!(harness.browser_returns(&genuine).await, StatusCode::OK);
  assert!(matches!(
    harness.settled().await,
    ChatGptState::Connected { .. }
  ));
  assert_eq!(harness.fake.with(|fake| fake.token_requests.len()), 1);
  harness.assert_refused(genuine).await;
}

#[tokio::test]
async fn an_unanswered_sign_in_times_out_and_closes_its_listener() {
  let mut harness = Harness::new(Duration::from_millis(200)).await;
  harness.auth.start(SignInIntent::SameAccount);
  let params = harness.authorization().await;
  assert_eq!(
    harness.settled().await,
    ChatGptState::Failed {
      reason: ChatGptFailure::TimedOut
    }
  );
  let late = Harness::callback_url(&params, &params["state"], true);
  harness.assert_refused(late).await;
  assert_eq!(
    harness.auth.complete_from_url(&params["redirect_uri"]),
    Err(CallbackUrlError::NoSignIn)
  );
}

#[tokio::test]
async fn a_pasted_final_url_completes_the_sign_in() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.auth.start(SignInIntent::SameAccount);
  let params = harness.authorization().await;
  let pasted = Harness::callback_url(&params, &params["state"], true);
  // Another attempt's URL is refused and the attempt keeps waiting.
  assert_eq!(
    harness
      .auth
      .complete_from_url(&Harness::callback_url(&params, "other", true)),
    Err(CallbackUrlError::NotThisSignIn)
  );
  assert_eq!(
    harness
      .auth
      .complete_from_url(&pasted.replace("127.0.0.1", "localhost")),
    Err(CallbackUrlError::NotThisSignIn)
  );
  assert_eq!(harness.auth.status().await.state, ChatGptState::SigningIn);
  // Without the scheme, as an address bar shows it.
  harness
    .auth
    .complete_from_url(pasted.trim_start_matches("http://"))
    .unwrap();
  assert!(matches!(
    harness.settled().await,
    ChatGptState::Connected { .. }
  ));
  // Used once: neither a second paste nor the browser can complete it again.
  assert_eq!(
    harness.auth.complete_from_url(&pasted),
    Err(CallbackUrlError::NoSignIn)
  );
}

#[tokio::test]
async fn an_id_token_from_another_key_is_refused() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.fake.with(|fake| fake.grant.impostor = true);
  harness.auth.start(SignInIntent::SameAccount);
  let params = harness.authorization().await;
  harness
    .browser_returns(&Harness::callback_url(&params, &params["state"], true))
    .await;
  assert_eq!(
    harness.settled().await,
    ChatGptState::Failed {
      reason: ChatGptFailure::Verification
    }
  );
  assert!(harness.record().session.is_none());
}

#[tokio::test]
async fn a_returning_sign_in_with_another_account_keeps_the_saved_one() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  let saved = harness.record();

  harness
    .fake
    .with(|fake| fake.grant.subject = "subject-2".into());
  harness.sign_in(SignInIntent::SameAccount).await;
  assert_eq!(
    harness.settled().await,
    ChatGptState::Failed {
      reason: ChatGptFailure::DifferentAccount
    }
  );
  assert_eq!(harness.record(), saved);
}

#[tokio::test]
async fn cancelling_returns_to_the_saved_state_and_closes_the_listener() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.auth.start(SignInIntent::SameAccount);
  let params = harness.authorization().await;
  harness.auth.cancel();
  assert_eq!(harness.settled().await, ChatGptState::SignedOut);
  let late = Harness::callback_url(&params, &params["state"], true);
  harness.assert_refused(late).await;
}

fn expire(harness: &Harness) {
  let mut record = harness.vault.record.lock().unwrap();
  record.session.as_mut().unwrap().expires_at = now_ms() - 1;
}

#[tokio::test]
async fn renewal_rotates_and_persists_the_refresh_token_once() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  // Still fresh: no renewal.
  assert_eq!(harness.auth.access(None).await.as_deref(), Ok("access-1"));

  expire(&harness);
  let (first, second) =
    tokio::join!(harness.auth.access(None), harness.auth.access(None));
  assert_eq!(first.as_deref(), Ok("access-2"));
  assert_eq!(second.as_deref(), Ok("access-2"));
  let refreshes = harness.fake.with(|fake| {
    fake
      .token_requests
      .iter()
      .filter(|request| request["grant_type"] == "refresh_token")
      .cloned()
      .collect::<Vec<_>>()
  });
  assert_eq!(refreshes.len(), 1, "concurrent renewals are serialized");
  assert_eq!(refreshes[0]["client_id"], ISSUED_CLIENT);
  assert_eq!(refreshes[0]["refresh_token"], "refresh-1");
  assert_eq!(refreshes[0]["resource"], oauth::RESOURCE);
  assert!(!refreshes[0].contains_key("scope"));

  let session = harness.record().session.unwrap();
  assert_eq!(session.access_token, "access-2");
  assert_eq!(session.refresh_token.as_deref(), Some("refresh-2"));
  assert!(session.expires_at > now_ms() + 3_000_000);
}

#[tokio::test]
async fn a_temporary_renewal_failure_keeps_the_tokens() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  expire(&harness);
  harness
    .fake
    .with(|fake| fake.refresh_errors.push_back("temporarily_unavailable"));
  assert_eq!(
    harness.auth.access(None).await,
    Err(AccessError::Unavailable)
  );
  assert_eq!(
    harness.record().session.unwrap().refresh_token.as_deref(),
    Some("refresh-1")
  );
  assert_eq!(harness.auth.access(None).await.as_deref(), Ok("access-2"));
}

#[tokio::test]
async fn an_unusable_refresh_token_requires_a_new_sign_in() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  expire(&harness);
  harness
    .fake
    .with(|fake| fake.refresh_errors.push_back("refresh_token_reused"));
  assert_eq!(
    harness.auth.access(None).await,
    Err(AccessError::NeedsReconnect)
  );
  let record = harness.record();
  assert!(record.session.is_none());
  assert!(record.registration.unwrap().reconnect_required);
  assert_eq!(
    harness.auth.status().await.state,
    ChatGptState::NeedsReconnect {
      email: Some("person@example.com".into())
    }
  );
}

#[tokio::test]
async fn a_profile_key_binds_tokens_to_one_sign_in() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  let key = harness.auth.profile_key().await.unwrap();
  assert_eq!(key.len(), 64);
  assert!(harness.auth.access(Some(&key)).await.is_ok());
  assert_eq!(
    harness.auth.access(Some(&"0".repeat(64))).await,
    Err(AccessError::ProfileChanged)
  );
  // A new sign-in issues a new ID token, so the old key stops working.
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  assert_eq!(
    harness.auth.access(Some(&key)).await,
    Err(AccessError::ProfileChanged)
  );
}

#[tokio::test]
async fn disconnect_revokes_and_wipes_the_tokens_but_keeps_the_registration() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  let params = harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  assert_eq!(harness.auth.disconnect().await, Ok(true));

  let revocation = harness.fake.with(|fake| fake.revocations[0].clone());
  assert_eq!(revocation["token"], "refresh-1");
  assert_eq!(revocation["token_type_hint"], "refresh_token");
  assert_eq!(revocation["client_id"], ISSUED_CLIENT);
  assert_eq!(*harness.cleared_harness.lock().unwrap(), 1);

  let record = harness.record();
  assert!(record.session.is_none());
  assert_eq!(record.registration.unwrap().client_id, ISSUED_CLIENT);
  assert_eq!(harness.auth.status().await.state, ChatGptState::SignedOut);
  assert_eq!(
    harness.auth.access(None).await,
    Err(AccessError::NotConnected)
  );

  // The next sign-in reuses the client and host, without an ID token hint.
  harness.auth.start(SignInIntent::SameAccount);
  let again = harness.authorization().await;
  assert_eq!(again["client_id"], ISSUED_CLIENT);
  assert_eq!(again["ext_agent_host_id"], params["ext_agent_host_id"]);
  assert!(!again.contains_key("id_token_hint"));
  harness.auth.cancel();
}

#[tokio::test]
async fn an_unconfirmed_revocation_still_signs_out_locally() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  harness
    .fake
    .with(|fake| fake.revoke_status = StatusCode::SERVICE_UNAVAILABLE);
  assert_eq!(harness.auth.disconnect().await, Ok(false));
  assert_eq!(harness.fake.with(|fake| fake.revocations.len()), 3);
  assert!(harness.record().session.is_none());
}

#[tokio::test]
async fn a_new_account_registers_a_new_client() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  harness
    .fake
    .with(|fake| fake.grant.subject = "subject-2".into());
  let params = harness.sign_in(SignInIntent::NewAccount).await;
  assert_eq!(params["client_id"], oauth::DYNAMIC_CLIENT_ID);
  assert!(!params.contains_key("id_token_hint"));
  assert!(matches!(
    harness.settled().await,
    ChatGptState::Connected { .. }
  ));
  assert_eq!(
    harness.record().registration.unwrap().subject.as_deref(),
    Some("subject-2")
  );
}

#[tokio::test]
async fn discovery_naming_another_origin_is_not_trusted() {
  let fake = FakeOpenAi::start().await;
  let changed = Arc::new(tokio::sync::Notify::new());
  let notify = Arc::clone(&changed);
  let auth = ChatGptAuth::new(
    ChatGptAuthConfig {
      issuer: "https://auth.openai.com".into(),
      ..fake.config(Duration::from_secs(1))
    },
    Arc::new(MemoryVault::default()),
    http(),
    ChatGptAuthHooks {
      open_browser: Box::new(|_| panic!("no browser for an untrusted issuer")),
      changed: Box::new(move || notify.notify_one()),
      clear_harness_sign_in: Box::new(|| {}),
    },
  );
  auth.start(SignInIntent::SameAccount);
  assert_eq!(
    settle(&auth, &changed).await,
    ChatGptState::Failed {
      reason: ChatGptFailure::Verification
    }
  );
}

fn revoked(harness: &Harness) -> Vec<String> {
  harness.fake.with(|fake| {
    fake
      .revocations
      .iter()
      .map(|revocation| revocation["token"].clone())
      .collect()
  })
}

#[tokio::test]
async fn a_renewal_without_plan_usage_revokes_and_deletes_the_tokens() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  expire(&harness);
  harness.fake.with(|fake| {
    fake.refresh_scope = "email offline_access openid profile resource.invoke".into();
  });
  assert_eq!(
    harness.auth.access(None).await,
    Err(AccessError::PlanUsageNotGranted)
  );
  // The renewed refresh token was revoked, not kept.
  assert_eq!(revoked(&harness), ["refresh-2"]);
  assert!(harness.record().session.is_none());
  let after_restart = |status: ChatGptStatus| {
    assert_eq!(
      status,
      ChatGptStatus {
        state: ChatGptState::NeedsReconnect {
          email: Some("person@example.com".into())
        },
        session_stored: false,
      }
    );
  };
  after_restart(harness.auth.status().await);
  harness.restart();
  after_restart(harness.auth.status().await);
  // The next sign-in asks for consent again.
  harness
    .fake
    .with(|fake| fake.refresh_scope = ALL_SCOPES.into());
  let params = harness.sign_in(SignInIntent::SameAccount).await;
  assert_eq!(params["prompt"], "consent");
}

#[tokio::test]
async fn a_rejected_client_loses_its_tokens_and_registers_anew() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  expire(&harness);
  harness
    .fake
    .with(|fake| fake.refresh_errors.push_back("invalid_client"));
  assert_eq!(
    harness.auth.access(None).await,
    Err(AccessError::ClientRejected)
  );
  assert_eq!(revoked(&harness), ["refresh-1"]);
  assert!(harness.record().session.is_none());
  harness.restart();
  let status = harness.auth.status().await;
  assert!(!status.session_stored);
  assert!(matches!(status.state, ChatGptState::NeedsReconnect { .. }));
  let params = harness.sign_in(SignInIntent::SameAccount).await;
  assert_eq!(params["client_id"], oauth::DYNAMIC_CLIENT_ID);
}

#[tokio::test]
async fn stored_tokens_always_offer_disconnect() {
  let mut harness = Harness::new(Duration::from_secs(30)).await;
  harness.sign_in(SignInIntent::SameAccount).await;
  harness.settled().await;
  // A failed later attempt shows its failure; the tokens are still there.
  harness.auth.start(SignInIntent::SameAccount);
  let params = harness.authorization().await;
  let declined = format!(
    "{}?error=access_denied&state={}",
    params["redirect_uri"], params["state"]
  );
  harness.browser_returns(&declined).await;
  assert_eq!(
    harness.settled().await,
    ChatGptState::Failed {
      reason: ChatGptFailure::Declined
    }
  );
  assert!(harness.auth.status().await.session_stored);

  // A stored session that cannot use the plan still counts after a restart.
  harness
    .vault
    .record
    .lock()
    .unwrap()
    .session
    .as_mut()
    .unwrap()
    .scopes
    .retain(|scope| scope != oauth::PLAN_USAGE_SCOPE);
  harness.restart();
  assert_eq!(
    harness.auth.status().await,
    ChatGptStatus {
      state: ChatGptState::SignedOut,
      session_stored: true,
    }
  );
  assert_eq!(harness.auth.disconnect().await, Ok(true));
  assert_eq!(revoked(&harness), ["refresh-1"]);
  assert!(!harness.auth.status().await.session_stored);
}

#[test]
fn statuses_serialize_without_tokens() {
  assert_eq!(
    serde_json::to_value(ChatGptStatus {
      state: ChatGptState::Connected {
        email: Some("person@example.com".into()),
        plan: None
      },
      session_stored: true,
    })
    .unwrap(),
    json!({
      "state": "connected",
      "email": "person@example.com",
      "plan": null,
      "sessionStored": true,
    })
  );
  assert_eq!(
    serde_json::to_value(ChatGptStatus {
      state: ChatGptState::Failed {
        reason: ChatGptFailure::PlanUsageNotGranted
      },
      session_stored: false,
    })
    .unwrap(),
    json!({
      "state": "failed",
      "reason": "plan_usage_not_granted",
      "sessionStored": false,
    })
  );
  let record = store::ChatGptRecord {
    registration: None,
    session: Some(store::ChatGptSession {
      client_id: ISSUED_CLIENT.into(),
      issuer: "https://issuer.test".into(),
      subject: "subject-1".into(),
      email: None,
      plan: None,
      id_token: "id-token-secret".into(),
      access_token: "access-secret".into(),
      refresh_token: Some("refresh-secret".into()),
      expires_at: 0,
      earliest_refresh_at: None,
      scopes: vec![oauth::PLAN_USAGE_SCOPE.into()],
      saved_at: 0,
    }),
  };
  let shown = serde_json::to_string(&stored_status(&record)).unwrap();
  for secret in ["secret", ISSUED_CLIENT, "subject-1"] {
    assert!(!shown.contains(secret), "{shown}");
  }
}
