//! Optional AI cleanup of a dictation. Only the text this computer
//! transcribed goes through stella to the linked organization's AI provider,
//! never the audio, and only while the server enables dictation for that same
//! account. The answer is a list of typed segments; any failure, timeout, or
//! malformed or implausible answer leaves the raw transcript, so cleanup never
//! blocks or loses a dictation. Neither the transcript nor the answer is
//! logged or stored.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine clean up text")
)]

use std::{future::Future, sync::OnceLock, time::Duration};

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
const IMPLAUSIBLE: &str = "dictation cleanup answer lost part of the dictation";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
  path: String,
  max_transcript_length: usize,
  max_locale_length: usize,
  max_languages: usize,
  max_segments: usize,
  min_answer_text_percent: usize,
  min_break_allowance: usize,
  transcript_characters_per_break: usize,
  command_words: Vec<String>,
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
          && !text.chars().any(dictation_format::is_untyped)
      }
      Segment::LineBreak | Segment::ParagraphBreak => true,
    });
  if valid {
    Ok(response.segments)
  } else {
    Err(INVALID.to_string())
  }
}

/// Letters and digits, the part of a text cleanup must keep.
fn content_length(text: &str) -> usize {
  text.chars().filter(|character| character.is_alphanumeric()).count()
}

/// The transcript's letters and digits outside spoken command words, which a
/// correct answer replaces by punctuation, breaks or bold.
fn dictated_content_length(transcript: &str, command_words: &[String]) -> usize {
  transcript
    .to_lowercase()
    .split_whitespace()
    .map(|word| {
      word
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect::<String>()
    })
    .filter(|word| !word.is_empty() && !command_words.iter().any(|command| command == word))
    .map(|word| word.chars().count())
    .sum()
}

/// Whether the answer kept the dictation: it has text unless only commands
/// were dictated, that text keeps at least the contract's share of the
/// dictated letters and digits outside command words, and it breaks lines no
/// more often than the dictation could have asked for. The server applies
/// the same bounds; this side holds them too, so an answer that lost content
/// is never typed.
pub fn plausible(transcript: &str, segments: &[Segment]) -> bool {
  let contract = contract();
  let dictated = dictated_content_length(transcript, &contract.command_words);
  let mut kept = 0;
  let mut texts = 0;
  let mut breaks = 0;
  for segment in segments {
    match segment {
      Segment::Text { text, .. } => {
        texts += 1;
        kept += content_length(text);
      }
      Segment::LineBreak | Segment::ParagraphBreak => breaks += 1,
    }
  }
  let allowed_breaks = contract
    .min_break_allowance
    .max(transcript.chars().count() / contract.transcript_characters_per_break);
  // Only a dictation of commands alone ("nový řádek") may become breaks alone.
  let has_text = texts > 0 || (dictated == 0 && breaks > 0);
  has_text
    && kept * 100 >= dictated * contract.min_answer_text_percent
    && breaks <= allowed_breaks
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
  let segments = segments?;
  if plausible(transcript, &segments) {
    Ok(segments)
  } else {
    Err(IMPLAUSIBLE.to_string())
  }
}

/// Runs `future` on the shared runtime from a plain thread, for at most
/// `limit`. The timer is built inside the runtime: created on the calling
/// thread, which has no runtime of its own, it would panic.
fn bounded<T>(limit: Duration, future: impl Future<Output = T>) -> Option<T> {
  tauri::async_runtime::block_on(
    async move { tokio::time::timeout(limit, future).await },
  )
  .ok()
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
  match bounded(TIMEOUT, request(app, transcript, languages)) {
    Some(Ok(segments)) => Some(segments),
    Some(Err(error)) => {
      tracing::info!(%error, "dictation cleanup skipped; typing the transcript");
      None
    }
    None => {
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
      r#"{"segments":[{"type":"text","text":"a\u2028b","bold":false}]}"#.to_string(),
      r#"{"segments":[{"type":"text","text":"a\u2029b","bold":false}]}"#.to_string(),
      r#"{"segments":[{"type":"text","text":"a\u202Eb","bold":false}]}"#.to_string(),
      r#"{"segments":[{"type":"text","text":"a\u2066b","bold":false}]}"#.to_string(),
      r#"{"segments":[],"extra":true}"#.to_string(),
      format!(r#"{{"segments":[{{"type":"text","text":"{long}","bold":false}}]}}"#),
      too_many,
    ] {
      assert!(parse_segments(body.as_bytes()).is_err(), "{body:.80}");
    }
  }

  fn plain(value: &str) -> Segment {
    Segment::Text {
      text: value.to_string(),
      bold: false,
    }
  }

  #[test]
  fn an_answer_that_keeps_too_little_of_the_dictation_is_not_typed() {
    let transcript = "the parties agree to extend the deadline by two weeks";
    assert!(plausible(
      transcript,
      &[plain("The parties agree to extend the deadline.")]
    ));
    assert!(!plausible(transcript, &[plain("The parties agree.")]));
  }

  #[test]
  fn spoken_commands_do_not_count_as_content_that_must_be_kept() {
    let transcript = "nový řádek a tedy nový řádek se rozhodl odejít tečka";
    assert!(plausible(
      transcript,
      &[
        Segment::LineBreak,
        plain("a tedy"),
        Segment::LineBreak,
        plain("se rozhodl odejít."),
      ]
    ));
    assert!(plausible(
      "tučně 42, ne, 24 dní tečka",
      &[
        Segment::Text {
          text: "24".to_string(),
          bold: true,
        },
        plain(" dní."),
      ]
    ));
  }

  #[test]
  fn only_a_dictation_of_commands_may_become_breaks_alone() {
    assert!(plausible("nový řádek", &[Segment::LineBreak]));
    assert!(plausible("Nový odstavec.", &[Segment::ParagraphBreak]));
    assert!(!plausible("nový řádek", &[]));
    assert!(!plausible("smlouva nový řádek", &[Segment::LineBreak]));
  }

  /// The transcript's words, with a line break before each of the first
  /// `breaks` words after the first.
  fn broken(transcript: &str, breaks: usize) -> Vec<Segment> {
    transcript
      .split_whitespace()
      .enumerate()
      .flat_map(|(index, word)| {
        let mut pieces = Vec::new();
        if index > 0 && index <= breaks {
          pieces.push(Segment::LineBreak);
        }
        pieces.push(plain(word));
        pieces
      })
      .collect()
  }

  #[test]
  fn an_answer_that_breaks_far_more_often_than_dictated_is_not_typed() {
    // Four breaks are always allowed; 27 characters allow no more.
    let short = "ano ne ano ne ano ne ano ne";
    assert!(plausible(short, &broken(short, 4)));
    assert!(!plausible(short, &broken(short, 5)));
    // 240 characters allow one break per 20 of them.
    let long = "slovo ".repeat(40);
    assert!(plausible(&long, &broken(&long, 12)));
    assert!(!plausible(&long, &broken(&long, 13)));
  }

  #[test]
  fn the_bounded_wait_runs_from_a_thread_without_a_runtime() {
    let outcome = std::thread::spawn(|| {
      let started = std::time::Instant::now();
      let pending = bounded(
        Duration::from_millis(50),
        std::future::pending::<Result<Vec<Segment>, String>>(),
      );
      let ready = bounded(Duration::from_secs(1), async { 7 });
      (pending, ready, started.elapsed())
    })
    .join()
    .expect("a plain dictation thread must not panic");
    assert_eq!(outcome.0, None);
    assert_eq!(outcome.1, Some(7));
    assert!(outcome.2 < Duration::from_secs(1));
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
