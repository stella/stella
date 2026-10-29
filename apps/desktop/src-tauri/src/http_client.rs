//! Desktop HTTP identity has one owner. Clippy rejects raw clients outside
//! this module, including constructors reached through imports or aliases.

#![allow(
  clippy::disallowed_types,
  reason = "the desktop HTTP owner constructs identified clients; callers use DesktopHttpClient"
)]

use std::time::Duration;

const DESKTOP_HTTP_USER_AGENT: &str = "stella-desktop";
const LOCAL_CLIENT_IDENTITY_HEADER: &str = "x-stella-local-client";

#[derive(Default)]
pub struct HttpClientOptions {
  pub timeout: Option<Duration>,
  pub redirect: reqwest::redirect::Policy,
}

// No Default, Deref, or raw-client conversion: a client can only be created
// with the desktop identity, including in test and fallback paths.
#[derive(Clone)]
pub struct DesktopHttpClient(reqwest::Client);

impl DesktopHttpClient {
  pub fn new(options: HttpClientOptions) -> reqwest::Result<Self> {
    #[allow(
      clippy::disallowed_methods,
      reason = "construct the identified desktop client"
    )]
    let mut builder = reqwest::Client::builder()
      .user_agent(DESKTOP_HTTP_USER_AGENT)
      .default_headers(reqwest::header::HeaderMap::from_iter([(
        reqwest::header::HeaderName::from_static(LOCAL_CLIENT_IDENTITY_HEADER),
        reqwest::header::HeaderValue::from_static(concat!(
          "desktop/",
          env!("CARGO_PKG_VERSION")
        )),
      )]))
      .redirect(options.redirect)
      // Application retry owners rebuild possession proofs for each attempt.
      .retry(reqwest::retry::never());
    if let Some(timeout) = options.timeout {
      builder = builder.timeout(timeout);
    }
    builder.build().map(Self)
  }

  pub fn get(&self, url: impl reqwest::IntoUrl) -> reqwest::RequestBuilder {
    self.0.get(url)
  }

  pub fn put(&self, url: impl reqwest::IntoUrl) -> reqwest::RequestBuilder {
    self.0.put(url)
  }

  pub fn post(&self, url: impl reqwest::IntoUrl) -> reqwest::RequestBuilder {
    self.0.post(url)
  }

  #[cfg(test)]
  pub fn request(
    &self,
    method: reqwest::Method,
    url: impl reqwest::IntoUrl,
  ) -> reqwest::RequestBuilder {
    self.0.request(method, url)
  }
}

// Building consumes the unsigned builder; callers cannot change method or URL
// after signing, and every send/retry constructs a fresh proof.
pub(crate) struct DeviceProofRequest {
  client: reqwest::Client,
  request: reqwest::Request,
}
impl DeviceProofRequest {
  pub(crate) async fn send(self) -> reqwest::Result<reqwest::Response> {
    self.client.execute(self.request).await
  }
  #[cfg(test)]
  pub(crate) fn build(self) -> reqwest::Request {
    self.request
  }
}

pub(crate) fn device_proof_request(
  builder: reqwest::RequestBuilder,
  key: &crate::device_proof::DeviceKey,
  bearer: Option<&str>,
  nonce: Option<&str>,
) -> Result<DeviceProofRequest, String> {
  let builder = match bearer {
    Some(bearer) => builder.bearer_auth(bearer),
    None => builder,
  };
  let (client, request) = builder.build_split();
  let mut request = request.map_err(crate::logging::request_cause_logged(
    "Could not build desktop account request",
  ))?;
  let proof = key.proof(&request, bearer, nonce)?;
  request.headers_mut().insert(
    "DPoP",
    proof.parse().map_err(crate::logging::with_cause_logged(
      "Could not encode desktop device proof",
    ))?,
  );
  Ok(DeviceProofRequest { client, request })
}

pub(crate) fn unsigned_request(
  builder: reqwest::RequestBuilder,
) -> Result<DeviceProofRequest, String> {
  let (client, request) = builder.build_split();
  Ok(DeviceProofRequest {
    client,
    request: request.map_err(crate::logging::request_cause_logged(
      "Could not build desktop request",
    ))?,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use axum::{Router, http::HeaderMap, routing::any};

  #[tokio::test]
  async fn every_client_configuration_sends_the_desktop_identity() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let router = Router::new().route(
      "/",
      any(|headers: HeaderMap| async move {
        headers
          .get("user-agent")
          .and_then(|value| value.to_str().ok())
          .unwrap_or_default()
          .to_owned()
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    for timeout in [
      None,
      Some(Duration::from_secs(3)),
      Some(Duration::from_secs(30)),
    ] {
      for redirect in [
        reqwest::redirect::Policy::none(),
        reqwest::redirect::Policy::default(),
      ] {
        let client =
          DesktopHttpClient::new(HttpClientOptions { timeout, redirect }).unwrap();
        for request in [client.get(&url), client.post(&url)] {
          let response = request.send().await.unwrap();
          assert_eq!(response.text().await.unwrap(), DESKTOP_HTTP_USER_AGENT);
        }
      }
    }
    server.abort();
  }
}
