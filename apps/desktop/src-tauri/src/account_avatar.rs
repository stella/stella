//! The linked account's profile picture, for the Settings window.
//!
//! The account verification (the registry `config` request) names the
//! member's picture as `accountImage`: an `https` URL or a `data:` URL. The
//! desktop reads it here, never the webview: a remote picture is fetched
//! without any account credential, with a size cap and an image type that
//! must match the bytes, and only then cached on this computer for the
//! account it belongs to. The webview receives it as a `data:` URL inside the
//! account snapshot, so its `img-src 'self' data:` policy stays as it is.
//!
//! Every account change and every start reads the picture again; a
//! disconnect, a rejected credential or another account clears it.

use std::{
  fs,
  io::Write as _,
  path::{Path, PathBuf},
  sync::{Arc, OnceLock},
  time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tauri::{Emitter as _, Manager as _};

use crate::{
  config::APP_DATA_DIR_NAME,
  http_client::{DesktopHttpClient, HttpClientOptions},
};

/// The largest picture kept, decoded.
pub(crate) const MAX_AVATAR_BYTES: usize = 256 * 1024;
const MAX_REFERENCE_LENGTH: usize = 4 * MAX_AVATAR_BYTES.div_ceil(3) + 64;
const MAX_CACHE_FILE_BYTES: u64 = 2 * MAX_AVATAR_BYTES as u64;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 3;
const CACHE_FILE_NAME: &str = "account-avatar.json";

/// Raster types a picture may have. SVG is never accepted.
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AvatarError {
  Unavailable,
  TooLarge,
  WrongType,
}

impl AvatarError {
  const fn message(&self) -> &'static str {
    match self {
      Self::Unavailable => "account picture is unavailable",
      Self::TooLarge => "account picture is too large",
      Self::WrongType => "account picture is not a supported image",
    }
  }
}

/// A picture whose bytes are one of [`IMAGE_TYPES`] and within the cap.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AvatarImage {
  mime: &'static str,
  bytes: Vec<u8>,
}

impl AvatarImage {
  pub(crate) fn data_url(&self) -> String {
    format!("data:{};base64,{}", self.mime, STANDARD.encode(&self.bytes))
  }
}

/// The image type the bytes themselves have, if it is one we accept.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    Some("image/png")
  } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
    Some("image/jpeg")
  } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
    Some("image/gif")
  } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
    Some("image/webp")
  } else {
    None
  }
}

/// Accepts `bytes` only when they are within the cap, the declared type is
/// a raster type we accept, and the bytes really are that type.
pub(crate) fn validated(
  declared: &str,
  bytes: Vec<u8>,
) -> Result<AvatarImage, AvatarError> {
  if bytes.len() > MAX_AVATAR_BYTES {
    return Err(AvatarError::TooLarge);
  }
  let declared = declared.trim().to_ascii_lowercase();
  let Some(mime) = IMAGE_TYPES.iter().copied().find(|mime| *mime == declared) else {
    return Err(AvatarError::WrongType);
  };
  if sniff(&bytes) != Some(mime) {
    return Err(AvatarError::WrongType);
  }
  Ok(AvatarImage { mime, bytes })
}

/// Where the picture comes from, as the verification named it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AvatarSource {
  Inline(AvatarImage),
  Remote(reqwest::Url),
}

/// Reads the verification's `accountImage`. `Ok(None)` is no picture;
/// anything that is not an `https` URL or a base64 raster `data:` URL is
/// refused.
pub(crate) fn parse_source(reference: &str) -> Result<AvatarSource, AvatarError> {
  if reference.len() > MAX_REFERENCE_LENGTH {
    return Err(AvatarError::TooLarge);
  }
  if let Some(rest) = reference.strip_prefix("data:") {
    let (mime, payload) = rest.split_once(";base64,").ok_or(AvatarError::WrongType)?;
    let bytes = STANDARD
      .decode(payload)
      .map_err(|_error| AvatarError::WrongType)?;
    return validated(mime, bytes).map(AvatarSource::Inline);
  }
  let url = reqwest::Url::parse(reference).map_err(|_error| AvatarError::WrongType)?;
  if url.scheme() != "https" || url.host_str().is_none() {
    return Err(AvatarError::WrongType);
  }
  Ok(AvatarSource::Remote(url))
}

/// One client for every picture fetch. It never carries an account
/// credential, and it follows a few redirects only while they stay on
/// `https`.
fn avatar_client() -> Result<&'static DesktopHttpClient, AvatarError> {
  static CLIENT: OnceLock<DesktopHttpClient> = OnceLock::new();
  if let Some(client) = CLIENT.get() {
    return Ok(client);
  }
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::custom(|attempt| {
      if attempt.previous().len() >= MAX_REDIRECTS || attempt.url().scheme() != "https"
      {
        attempt.stop()
      } else {
        attempt.follow()
      }
    }),
    timeout: Some(FETCH_TIMEOUT),
  })
  .map_err(|_error| AvatarError::Unavailable)?;
  Ok(CLIENT.get_or_init(|| client))
}

/// Fetches a remote picture without credentials. The answer must say it is
/// an accepted image type, stay within the cap while it streams, and be that
/// type.
pub(crate) async fn fetch(
  client: &DesktopHttpClient,
  url: reqwest::Url,
) -> Result<AvatarImage, AvatarError> {
  let mut response = client
    .get(url)
    .send()
    .await
    .map_err(|_error| AvatarError::Unavailable)?;
  if !response.status().is_success() {
    return Err(AvatarError::Unavailable);
  }
  let declared = response
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .map(|value| value.split(';').next().unwrap_or_default().to_string())
    .ok_or(AvatarError::WrongType)?;
  if response
    .content_length()
    .is_some_and(|length| length > MAX_AVATAR_BYTES as u64)
  {
    return Err(AvatarError::TooLarge);
  }
  let mut bytes = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|_error| AvatarError::Unavailable)?
  {
    if bytes.len() + chunk.len() > MAX_AVATAR_BYTES {
      return Err(AvatarError::TooLarge);
    }
    bytes.extend_from_slice(&chunk);
  }
  validated(&declared, bytes)
}

/// The cached picture: whose it is, which reference it came from, and the
/// picture itself as the `data:` URL the webview renders.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedAvatar {
  namespace: String,
  source: String,
  data_url: String,
}

/// The one cached picture, in the app data directory beside the other
/// per-account files.
pub(crate) struct AvatarCache {
  path: Option<PathBuf>,
}

impl AvatarCache {
  pub(crate) fn in_app_data() -> Self {
    Self {
      path: dirs::data_dir()
        .map(|dir| dir.join(APP_DATA_DIR_NAME).join(CACHE_FILE_NAME)),
    }
  }

  #[cfg(test)]
  pub(crate) fn at(path: PathBuf) -> Self {
    Self { path: Some(path) }
  }

  fn read(&self) -> Option<CachedAvatar> {
    let path = self.path.as_deref()?;
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > MAX_CACHE_FILE_BYTES {
      return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
  }

  /// The picture of the account with `namespace`, never another account's.
  pub(crate) fn data_url(&self, namespace: &str) -> Option<String> {
    self
      .read()
      .filter(|cached| cached.namespace == namespace)
      .map(|cached| cached.data_url)
  }

  fn holds(&self, namespace: &str, source: &str) -> bool {
    self
      .read()
      .is_some_and(|cached| cached.namespace == namespace && cached.source == source)
  }

  fn write(
    &self,
    namespace: &str,
    source: &str,
    image: &AvatarImage,
  ) -> Result<(), String> {
    let path = self
      .path
      .as_deref()
      .ok_or_else(|| "app data directory is unavailable".to_string())?;
    let parent = path
      .parent()
      .ok_or_else(|| "app data directory is unavailable".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let body = serde_json::to_vec(&CachedAvatar {
      namespace: namespace.into(),
      source: source.into(),
      data_url: image.data_url(),
    })
    .map_err(|error| error.to_string())?;
    let staged = path.with_extension("json.partial");
    write_private(&staged, &body)?;
    fs::rename(&staged, path).map_err(|error| error.to_string())
  }

  /// Removes the picture; nothing cached is not an error.
  pub(crate) fn clear(&self) -> Result<bool, String> {
    let Some(path) = self.path.as_deref() else {
      return Ok(false);
    };
    match fs::remove_file(path) {
      Ok(()) => Ok(true),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
      Err(error) => Err(error.to_string()),
    }
  }
}

fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
  let mut options = fs::OpenOptions::new();
  options.write(true).create(true).truncate(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt as _;
    options.mode(0o600);
  }
  let mut file = options.open(path).map_err(|error| error.to_string())?;
  file.write_all(body).map_err(|error| error.to_string())?;
  file.sync_all().map_err(|error| error.to_string())
}

/// A digest of the reference, so a changed picture is fetched again while the
/// cache never stores the URL itself.
fn source_digest(reference: &str) -> String {
  hex::encode(Sha256::digest(reference.as_bytes()))
}

/// The picture for the account with `namespace`, as the snapshot carries it.
pub(crate) fn data_url_for(namespace: &str) -> Option<String> {
  AvatarCache::in_app_data().data_url(namespace)
}

fn forget(cache: &AvatarCache) {
  if let Err(error) = cache.clear() {
    tracing::warn!(error = %error, "account picture was not removed");
  }
}

/// Forgets the picture, at once, when the account is disconnected.
pub(crate) fn clear() {
  forget(&AvatarCache::in_app_data());
}

/// What the verification of `namespace` says the picture is now.
pub(crate) enum Verified {
  NoPicture,
  Picture { reference: String },
}

impl Verified {
  pub(crate) fn from_config(config: &serde_json::Value) -> Self {
    match config
      .get("accountImage")
      .and_then(serde_json::Value::as_str)
    {
      Some(reference) if !reference.is_empty() => Self::Picture {
        reference: reference.to_string(),
      },
      _ => Self::NoPicture,
    }
  }
}

/// Brings the cache in line with a verification of the account with
/// `namespace`. Answers whether the cached picture changed.
pub(crate) async fn apply(
  cache: &AvatarCache,
  client: impl FnOnce() -> Result<&'static DesktopHttpClient, AvatarError>,
  namespace: &str,
  verified: Verified,
) -> Result<bool, AvatarError> {
  let Verified::Picture { reference } = verified else {
    return cache.clear().map_err(|_error| AvatarError::Unavailable);
  };
  let source = source_digest(&reference);
  if cache.holds(namespace, &source) {
    return Ok(false);
  }
  let image = match parse_source(&reference) {
    Ok(AvatarSource::Inline(image)) => Ok(image),
    Ok(AvatarSource::Remote(url)) => match client() {
      Ok(client) => fetch(client, url).await,
      Err(error) => Err(error),
    },
    Err(error) => Err(error),
  };
  match image {
    Ok(image) => {
      cache
        .write(namespace, &source, &image)
        .map_err(|_error| AvatarError::Unavailable)?;
      Ok(true)
    }
    // The old picture no longer belongs to the account; show the initials.
    Err(error) => {
      forget(cache);
      Err(error)
    }
  }
}

/// Reads the account's picture again: on every start and account change.
/// Without a linked account the picture is cleared. A change reaches open
/// windows through the account change event.
pub fn refresh(app: &tauri::AppHandle) {
  let Some(state) = app.try_state::<crate::account::AccountState>() else {
    return;
  };
  let state = Arc::clone(&state);
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    // One refresh at a time, so two account changes never race their writes.
    static RUNNING: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _running = RUNNING
      .get_or_init(|| tokio::sync::Mutex::new(()))
      .lock()
      .await;
    let cache = AvatarCache::in_app_data();
    let request = match crate::account::request_account(&state).await {
      Ok(Some(request)) => request,
      Ok(None) => {
        if cache.clear().unwrap_or(false) {
          announce(&app);
        }
        return;
      }
      // Offline or unreadable: keep what is cached until the next refresh.
      Err(_error) => return,
    };
    let namespace = request.local_data_namespace();
    let config = crate::registry::request(
      request.request_auth(),
      serde_json::json!({"type":"config"}),
    )
    .await;
    // The picture is fetched without the account's lease or credential.
    drop(request);
    let Ok(config) = config else {
      return;
    };
    let outcome = apply(
      &cache,
      avatar_client,
      &namespace,
      Verified::from_config(&config),
    )
    .await;
    // Another account may have been linked while the picture loaded.
    let still_current = matches!(
      crate::account::current(&state).await,
      Ok(Some(account)) if account.local_data_namespace() == namespace
    );
    if !still_current {
      forget(&cache);
      return;
    }
    match outcome {
      Ok(true) => announce(&app),
      Ok(false) => {}
      Err(error) => {
        tracing::warn!(error = error.message(), "account picture was not refreshed");
        announce(&app);
      }
    }
  });
}

fn announce(app: &tauri::AppHandle) {
  if let Err(error) = app.emit(crate::account::CHANGED_EVENT, ()) {
    tracing::warn!(error = %error, "account picture change was not delivered");
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
  const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F'];

  fn temp_cache() -> (AvatarCache, PathBuf) {
    let dir =
      std::env::temp_dir().join(format!("stella-avatar-{}", uuid::Uuid::new_v4()));
    (AvatarCache::at(dir.join(CACHE_FILE_NAME)), dir)
  }

  #[allow(
    clippy::unnecessary_wraps,
    reason = "stands in for the client factory an inline picture never calls"
  )]
  fn no_client() -> Result<&'static DesktopHttpClient, AvatarError> {
    panic!("an inline picture is never fetched")
  }

  #[test]
  fn only_a_raster_image_of_its_declared_type_within_the_cap_is_kept() {
    assert_eq!(
      validated("image/png", PNG.to_vec()).unwrap().mime,
      "image/png"
    );
    assert_eq!(
      validated("IMAGE/JPEG ", JPEG.to_vec()).unwrap().mime,
      "image/jpeg"
    );
    // The bytes decide, not the label.
    assert_eq!(
      validated("image/jpeg", PNG.to_vec()),
      Err(AvatarError::WrongType)
    );
    assert_eq!(
      validated(
        "image/svg+xml",
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec()
      ),
      Err(AvatarError::WrongType)
    );
    assert_eq!(
      validated("text/html", PNG.to_vec()),
      Err(AvatarError::WrongType)
    );
    let mut oversized = PNG.to_vec();
    oversized.resize(MAX_AVATAR_BYTES + 1, 0);
    assert_eq!(
      validated("image/png", oversized),
      Err(AvatarError::TooLarge)
    );
  }

  #[test]
  fn a_reference_is_an_https_url_or_a_raster_data_url() {
    let inline = format!("data:image/png;base64,{}", STANDARD.encode(PNG));
    assert!(matches!(parse_source(&inline), Ok(AvatarSource::Inline(_))));
    assert!(matches!(
      parse_source("https://images.example.test/member.png"),
      Ok(AvatarSource::Remote(_))
    ));
    for refused in [
      "http://images.example.test/member.png",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zy8+",
      "data:image/png,not-base64",
      "not a url",
    ] {
      assert!(parse_source(refused).is_err(), "{refused}");
    }
    let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_REFERENCE_LENGTH));
    assert_eq!(parse_source(&huge), Err(AvatarError::TooLarge));
  }

  #[tokio::test]
  async fn an_inline_picture_is_cached_for_its_account_only_and_cleared() {
    let (cache, dir) = temp_cache();
    let reference = format!("data:image/png;base64,{}", STANDARD.encode(PNG));
    let verified = || Verified::Picture {
      reference: reference.clone(),
    };

    assert_eq!(
      apply(&cache, no_client, "account-a", verified()).await,
      Ok(true)
    );
    assert_eq!(
      cache.data_url("account-a").as_deref(),
      Some(reference.as_str())
    );
    assert_eq!(cache.data_url("account-b"), None);
    // The same picture again changes nothing.
    assert_eq!(
      apply(&cache, no_client, "account-a", verified()).await,
      Ok(false)
    );
    // Another account's verification replaces it.
    assert_eq!(
      apply(&cache, no_client, "account-b", verified()).await,
      Ok(true)
    );
    assert_eq!(cache.data_url("account-a"), None);

    assert_eq!(
      apply(&cache, no_client, "account-b", Verified::NoPicture).await,
      Ok(true)
    );
    assert_eq!(cache.data_url("account-b"), None);
    assert_eq!(cache.clear(), Ok(false));
    fs::remove_dir_all(dir).unwrap();
  }

  #[tokio::test]
  async fn a_refused_picture_clears_the_one_it_replaces() {
    let (cache, dir) = temp_cache();
    let reference = format!("data:image/png;base64,{}", STANDARD.encode(PNG));
    apply(
      &cache,
      no_client,
      "account-a",
      Verified::Picture { reference },
    )
    .await
    .unwrap();
    assert!(cache.data_url("account-a").is_some());
    let mislabelled = format!("data:image/png;base64,{}", STANDARD.encode(JPEG));
    assert_eq!(
      apply(
        &cache,
        no_client,
        "account-a",
        Verified::Picture {
          reference: mislabelled
        }
      )
      .await,
      Err(AvatarError::WrongType)
    );
    assert_eq!(cache.data_url("account-a"), None);
    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn the_verification_names_the_picture_or_none() {
    assert!(matches!(
      Verified::from_config(
        &serde_json::json!({"accountImage": "https://a.test/p.png"})
      ),
      Verified::Picture { .. }
    ));
    for config in [
      serde_json::json!({"accountImage": null}),
      serde_json::json!({"accountImage": ""}),
      serde_json::json!({}),
    ] {
      assert!(matches!(
        Verified::from_config(&config),
        Verified::NoPicture
      ));
    }
  }

  async fn serve(
    content_type: &'static str,
    body: Vec<u8>,
  ) -> (reqwest::Url, tokio::task::JoinHandle<()>) {
    use axum::{Router, routing::get};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new().route(
      "/picture",
      get(move |headers: axum::http::HeaderMap| {
        let body = body.clone();
        async move {
          // A picture host never receives an account credential.
          assert!(headers.get("authorization").is_none());
          ([(axum::http::header::CONTENT_TYPE, content_type)], body)
        }
      }),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });
    (
      reqwest::Url::parse(&format!("http://{address}/picture")).unwrap(),
      server,
    )
  }

  fn test_client() -> DesktopHttpClient {
    DesktopHttpClient::new(HttpClientOptions {
      redirect: reqwest::redirect::Policy::none(),
      timeout: Some(FETCH_TIMEOUT),
    })
    .unwrap()
  }

  #[tokio::test]
  async fn a_remote_picture_is_fetched_within_the_cap_and_by_its_type() {
    let client = test_client();

    let (url, server) = serve("image/png", PNG.to_vec()).await;
    assert_eq!(fetch(&client, url).await.unwrap().mime, "image/png");
    server.abort();

    let mut oversized = PNG.to_vec();
    oversized.resize(MAX_AVATAR_BYTES + 1, 0);
    let (url, server) = serve("image/png", oversized).await;
    assert_eq!(fetch(&client, url).await, Err(AvatarError::TooLarge));
    server.abort();

    let (url, server) = serve("text/html; charset=utf-8", PNG.to_vec()).await;
    assert_eq!(fetch(&client, url).await, Err(AvatarError::WrongType));
    server.abort();

    let (url, server) = serve("image/png", b"<html></html>".to_vec()).await;
    assert_eq!(fetch(&client, url).await, Err(AvatarError::WrongType));
    server.abort();
  }
}
