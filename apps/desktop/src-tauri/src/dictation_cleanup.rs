//! Optional AI cleanup of a dictation. Only the text this computer
//! transcribed goes to the linked account's stella AI, never the audio, and
//! only while the server enables dictation for that same account. The answer
//! is a list of typed segments; any failure, timeout or malformed answer
//! leaves the raw transcript, so cleanup never blocks or loses a dictation.
//! Neither the transcript nor the answer is logged or stored.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine clean up text")
)]

use std::{sync::OnceLock, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
  account::{self, AccountRequest, AccountState},
  dictation_format::{self, AppClass, Segment, Stroke},
  feature_gate::{DesktopFeature, FeatureGates},
  http_client::{DesktopHttpClient, HttpClientOptions},
  logging::request_cause_logged,
};

/// The whole round trip, account read included. Past it the raw transcript
/// is typed instead.
pub const TIMEOUT: Duration = Duration::from_secs(5);
const FAILURE: &str = "dictation cleanup request failed";
const UNAVAILABLE: &str = "dictation cleanup has no linked account";
const INVALID: &str = "dictation cleanup answer is invalid";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
  path: String,
  max_transcript_length: usize,
  max_locale_length: usize,
  max_languages: usize,
  max_segments: usize,
}

const CONTRACT: &str =
  include_str!("../../../../packages/api-contract/src/desktop-dictation-cleanup.json");

fn contract() -> &'static Contract {
  static PARSED: OnceLock<Contract> = OnceLock::new();
  PARSED.get_or_init(|| {
    serde_json::from_str(CONTRACT)
      .expect("the committed dictation cleanup contract must be valid")
  })
}

/// Every segment's text is at most a transcript long, and JSON spends at
/// most six bytes on a character; the field names fit in the rest.
fn max_response_bytes() -> usize {
  let contract = contract();
  contract.max_transcript_length * 6 * 2 + contract.max_segments * 64
}

#[derive(Serialize)]
struct CleanupRequest<'a> {
  transcript: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  locale: Option<&'a str>,
  /// The languages the speaker uses, so cleanup keeps the text in them.
  #[serde(skip_serializing_if = "<[_]>::is_empty")]
  languages: &'a [&'a str],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupResponse {
  segments: Vec<Segment>,
}

/// The answer's segments, held to the contract's bounds. A serde error is
/// never logged: its message can quote the text.
pub fn parse_segments(body: &[u8]) -> Result<Vec<Segment>, String> {
  let response = serde_json::from_slice::<CleanupResponse>(body)
    .map_err(|_error| INVALID.to_string())?;
  let contract = contract();
  let valid = response.segments.len() <= contract.max_segments
    && response.segments.iter().all(|segment| match segment {
      Segment::Text { text, .. } => {
        !text.is_empty()
          && text.chars().count() <= contract.max_transcript_length
          && !text.chars().any(char::is_control)
      }
      Segment::LineBreak | Segment::ParagraphBreak => true,
    });
  if valid {
    Ok(response.segments)
  } else {
    Err(INVALID.to_string())
  }
}

/// What to type: the cleaned segments when there are any, otherwise the
/// transcript exactly as dictation types it without cleanup.
pub fn strokes(
  transcript: &str,
  cleaned: Option<&[Segment]>,
  class: AppClass,
) -> Vec<Stroke> {
  match cleaned {
    Some(segments) if !segments.is_empty() => dictation_format::plan(segments, class),
    _ => dictation_format::raw(transcript),
  }
}

/// A language tag the contract admits, or none.
fn locale_hint(locale: &str) -> Option<&str> {
  let mut parts = locale.split('-');
  let language = parts.next()?;
  let tagged = (2..=3).contains(&language.len())
    && language
      .chars()
      .all(|character| character.is_ascii_alphabetic())
    && parts.all(|part| {
      (2..=8).contains(&part.len())
        && part
          .chars()
          .all(|character| character.is_ascii_alphanumeric())
    });
  (tagged && locale.len() <= contract().max_locale_length).then_some(locale)
}

fn client() -> Result<&'static DesktopHttpClient, String> {
  static CLIENT: OnceLock<DesktopHttpClient> = OnceLock::new();
  if let Some(client) = CLIENT.get() {
    return Ok(client);
  }
  let client = DesktopHttpClient::new(HttpClientOptions {
    redirect: reqwest::redirect::Policy::none(),
    timeout: Some(TIMEOUT),
  })
  .map_err(request_cause_logged(FAILURE))?;
  Ok(CLIENT.get_or_init(|| client))
}

async fn send(
  account: &AccountRequest,
  transcript: &str,
  locale: Option<&str>,
  languages: &[&str],
) -> Result<Vec<Segment>, String> {
  let languages = &languages[..languages.len().min(contract().max_languages)];
  let request = crate::http_client::device_proof_request(
    client()?
      .post(format!("{}{}", account.api_base_url, contract().path))
      .json(&CleanupRequest {
        transcript,
        locale,
        languages,
      }),
    &account.device_key,
    Some(&account.credential.key),
    None,
  )?;
  let mut response = request
    .send()
    .await
    .map_err(request_cause_logged(FAILURE))?;
  if !response.status().is_success() {
    return Err(format!(
      "dictation cleanup was refused: {}",
      response.status()
    ));
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(request_cause_logged(FAILURE))?
  {
    if body.len() + chunk.len() > max_response_bytes() {
      return Err(INVALID.to_string());
    }
    body.extend_from_slice(&chunk);
  }
  parse_segments(&body)
}

async fn request(
  app: &AppHandle,
  transcript: &str,
  languages: &[&str],
) -> Result<Vec<Segment>, String> {
  // The account that enabled dictation, and no other, receives the text.
  let (_, namespace) = app
    .try_state::<FeatureGates>()
    .and_then(|gates| gates.account_binding(DesktopFeature::Dictation))
    .ok_or(UNAVAILABLE)?;
  let accounts = app.try_state::<AccountState>().ok_or(UNAVAILABLE)?;
  let account = account::request_account(&accounts)
    .await?
    .ok_or(UNAVAILABLE)?;
  if account.local_data_namespace() != namespace {
    return Err(UNAVAILABLE.to_string());
  }
  let segments = send(
    &account,
    transcript,
    locale_hint(crate::i18n::active_locale()),
    languages,
  )
  .await;
  drop(account);
  segments
}

/// The cleaned segments, or `None` whenever the raw transcript should be
/// typed instead. Blocks the dictation thread for at most [`TIMEOUT`].
pub fn clean_up(
  app: &AppHandle,
  transcript: &str,
  languages: &[&str],
) -> Option<Vec<Segment>> {
  if transcript.chars().count() > contract().max_transcript_length {
    return None;
  }
  let outcome = tauri::async_runtime::block_on(tokio::time::timeout(
    TIMEOUT,
    request(app, transcript, languages),
  ));
  match outcome {
    Ok(Ok(segments)) => Some(segments),
    Ok(Err(error)) => {
      tracing::info!(%error, "dictation cleanup skipped; typing the transcript");
      None
    }
    Err(_elapsed) => {
      tracing::info!("dictation cleanup timed out; typing the transcript");
      None
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::account::LinkedAccount;

  const FIXTURE: &str = include_str!(
    "../../../../packages/api-contract/src/desktop-dictation-cleanup.fixture.json"
  );

  #[test]
  fn the_shared_fixture_parses_into_segments() {
    let segments = parse_segments(FIXTURE.as_bytes()).unwrap();
    assert_eq!(segments.len(), 8);
    assert_eq!(segments[0], Segment::LineBreak);
    assert_eq!(
      segments[4],
      Segment::Text {
        text: "24".to_string(),
        bold: true
      }
    );
    assert_eq!(segments[6], Segment::ParagraphBreak);
  }

  #[test]
  fn a_malformed_or_unbounded_answer_is_refused() {
    let long = "x".repeat(contract().max_transcript_length + 1);
    let too_many = format!(
      r#"{{"segments":[{}]}}"#,
      vec![r#"{"type":"lineBreak"}"#; contract().max_segments + 1].join(",")
    );
    for body in [
      "not json".to_string(),
      "{}".to_string(),
      r#"{"segments":[{"type":"keystroke","key":"Return"}]}"#.to_string(),
      r#"{"segments":[{"type":"lineBreak","text":"x"}]}"#.to_string(),
      r#"{"segments":[{"type":"text","text":"a"}]}"#.to_string(),
      r#"{"segments":[{"type":"text","text":"","bold":false}]}"#.to_string(),
      r#"{"segments":[{"type":"text","text":"run\n","bold":false}]}"#.to_string(),
      r#"{"segments":[],"extra":true}"#.to_string(),
      format!(r#"{{"segments":[{{"type":"text","text":"{long}","bold":false}}]}}"#),
      too_many,
    ] {
      assert!(parse_segments(body.as_bytes()).is_err(), "{body:.80}");
    }
  }

  #[test]
  fn without_a_cleaned_answer_the_raw_transcript_is_typed_exactly() {
    let raw = vec![Stroke::Text("nový řádek a tedy ".to_string())];
    for class in [AppClass::Rich, AppClass::Chat, AppClass::Terminal] {
      assert_eq!(strokes("nový řádek a tedy", None, class), raw);
      assert_eq!(strokes("nový řádek a tedy", Some(&[]), class), raw);
    }
  }

  #[test]
  fn a_cleaned_answer_is_typed_through_the_format_plan() {
    let segments = parse_segments(FIXTURE.as_bytes()).unwrap();
    assert_eq!(
      strokes("ignored", Some(&segments), AppClass::Rich),
      dictation_format::plan(&segments, AppClass::Rich)
    );
  }

  #[test]
  fn only_a_language_tag_is_sent_as_the_locale() {
    assert_eq!(locale_hint("cs"), Some("cs"));
    assert_eq!(locale_hint("pt-BR"), Some("pt-BR"));
    for invalid in ["", "c", "cs_CZ", "cs-", "česky", "cs-CZ-x-very-long-part"] {
      assert_eq!(locale_hint(invalid), None, "{invalid}");
    }
  }

  #[test]
  fn the_contract_path_is_a_versioned_desktop_route() {
    assert!(contract().path.starts_with("/v1/desktop/"));
  }

  fn linked(api_base_url: String, key: &str) -> LinkedAccount {
    LinkedAccount {
      api_base_url,
      web_origin: "https://my.example.test".into(),
      identity: crate::types::DesktopAccountIdentity {
        user_id: "user_fixture".into(),
        organization_id: "org_fixture".into(),
      },
      account: crate::types::LinkedAccountSnapshot {
        email: "desktop@example.test".into(),
        name: None,
        verified_at: chrono::Utc::now().to_rfc3339(),
      },
      credential: crate::types::DesktopAccountCredential {
        key: key.into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
      },
      device_key: crate::device_proof::DeviceKey::default(),
    }
  }

  #[tokio::test]
  async fn the_request_sends_only_text_with_a_signed_account_key() {
    use axum::{
      Json, Router,
      http::{HeaderMap, StatusCode},
      routing::post,
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().route(
      &contract().path,
      post(
        |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
          let signed = headers
            .get("dpop")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|proof| proof.split('.').count() == 3);
          let authorized = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            == Some("Bearer stella_dr_good");
          let only_text = body
            == serde_json::json!({
              "transcript": "tučně 42",
              "locale": "cs",
              "languages": ["cs", "en"],
            });
          if signed && authorized && only_text {
            (StatusCode::OK, FIXTURE.to_string())
          } else {
            (StatusCode::FORBIDDEN, "{}".to_string())
          }
        },
      ),
    );
    let server = tokio::spawn(async move {
      axum::serve(listener, router).await.unwrap();
    });

    let good = AccountRequest::fixture(linked(base.clone(), "stella_dr_good")).await;
    assert_eq!(
      send(&good, "tučně 42", Some("cs"), &["cs", "en"])
        .await
        .unwrap(),
      parse_segments(FIXTURE.as_bytes()).unwrap()
    );
    drop(good);
    let bad = AccountRequest::fixture(linked(base, "stella_dr_bad")).await;
    assert!(
      send(&bad, "tučně 42", Some("cs"), &["cs", "en"])
        .await
        .is_err()
    );
    drop(bad);
    server.abort();
  }
}
