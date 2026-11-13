//! Optional AI cleanup of a dictation. Only the text this computer
//! transcribed goes through stella to the linked organization's AI provider,
//! never the audio, and only while the server enables dictation for that same
//! account. With it goes the kind of app the text is for and, when the
//! speaker shares them, the window title and the text before the cursor
//! (`dictation_context`), which set the register and are never typed. The answer is a list of typed segments; any failure, timeout, or
//! malformed or implausible answer leaves the raw transcript, so cleanup never
//! blocks or loses a dictation. Neither the transcript nor the answer is
//! logged or stored.

#![cfg_attr(
  not(dictation),
  allow(dead_code, reason = "only builds with the speech engine clean up text")
)]

use std::{collections::BTreeMap, future::Future, sync::OnceLock, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
  account::{self, AccountRequest, AccountState},
  dictation_context::CleanupContext,
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
  max_window_title_length: usize,
  max_text_before_cursor_length: usize,
  /// `dictation_context::AppKind` names the same kinds; a test binds them.
  #[cfg(test)]
  app_kinds: Vec<String>,
  min_answer_text_percent: usize,
  min_break_allowance: usize,
  transcript_characters_per_break: usize,
  sentence_end_marks: String,
  /// Phrases by the mark, break or bold they become; every kind counts.
  formatting_commands: BTreeMap<String, Vec<String>>,
  correction_markers: Vec<String>,
}

/// The contract's phrases as the words a transcript is matched on.
struct Phrases {
  formatting_commands: Vec<Vec<String>>,
  correction_markers: Vec<Vec<String>>,
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

fn phrases() -> &'static Phrases {
  static PARSED: OnceLock<Phrases> = OnceLock::new();
  PARSED.get_or_init(|| {
    let contract = contract();
    Phrases {
      formatting_commands: contract
        .formatting_commands
        .values()
        .flatten()
        .map(String::as_str)
        .map(phrase_words)
        .collect(),
      correction_markers: contract
        .correction_markers
        .iter()
        .map(String::as_str)
        .map(phrase_words)
        .collect(),
    }
  })
}

/// How much of the window title and of the text before the cursor cleanup
/// may get, in characters.
pub struct ContextLimits {
  pub window_title: usize,
  pub text_before_cursor: usize,
}

pub fn context_limits() -> ContextLimits {
  let contract = contract();
  ContextLimits {
    window_title: contract.max_window_title_length,
    text_before_cursor: contract.max_text_before_cursor_length,
  }
}

#[cfg(test)]
pub fn contract_app_kinds() -> &'static [String] {
  &contract().app_kinds
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
  /// Where the text goes: the kind of app, and the window title and the
  /// text before the cursor when the speaker shares them.
  context: &'a CleanupContext,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupResponse {
  segments: Vec<WireSegment>,
}

/// One segment exactly as the contract shapes it. The breaks are empty
/// struct variants because serde checks unknown fields only on those: a
/// unit variant would accept a break that carries text the contract
/// refuses.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum WireSegment {
  Text { text: String, bold: bool },
  LineBreak {},
  ParagraphBreak {},
}

impl From<WireSegment> for Segment {
  fn from(segment: WireSegment) -> Self {
    match segment {
      WireSegment::Text { text, bold } => Self::Text { text, bold },
      WireSegment::LineBreak {} => Self::LineBreak,
      WireSegment::ParagraphBreak {} => Self::ParagraphBreak,
    }
  }
}

/// The answer's segments, held to the contract's bounds. A serde error is
/// never logged: its message can quote the text.
pub fn parse_segments(body: &[u8]) -> Result<Vec<Segment>, String> {
  let response = serde_json::from_slice::<CleanupResponse>(body)
    .map_err(|_error| INVALID.to_string())?;
  let contract = contract();
  let valid = response.segments.len() <= contract.max_segments
    && response.segments.iter().all(|segment| match segment {
      WireSegment::Text { text, .. } => {
        !text.is_empty()
          && text.chars().count() <= contract.max_transcript_length
          && !text.chars().any(dictation_format::is_untyped)
      }
      WireSegment::LineBreak {} | WireSegment::ParagraphBreak {} => true,
    });
  if valid {
    Ok(response.segments.into_iter().map(Segment::from).collect())
  } else {
    Err(INVALID.to_string())
  }
}

/// Letters and digits, the part of a text cleanup must keep.
fn content_length(text: &str) -> usize {
  text
    .chars()
    .filter(|character| character.is_alphanumeric())
    .count()
}

/// A word lowercased and reduced to its letters and digits.
fn word_content(word: &str) -> String {
  word
    .chars()
    .filter(|character| character.is_alphanumeric())
    .collect()
}

fn phrase_words(phrase: &str) -> Vec<String> {
  phrase
    .to_lowercase()
    .split_whitespace()
    .map(word_content)
    .filter(|word| !word.is_empty())
    .collect()
}

/// The transcript's words, lowercased and reduced to letters and digits,
/// with a sentence end (`None`) after each word that a sentence end mark
/// follows ("weeks." ends a sentence, "3.5" does not).
fn transcript_tokens(transcript: &str) -> Vec<Option<String>> {
  let marks = &contract().sentence_end_marks;
  let mut tokens = Vec::new();
  for chunk in transcript.to_lowercase().split_whitespace() {
    let word = word_content(chunk);
    let mut ends = false;
    for character in chunk.chars() {
      if character.is_alphanumeric() {
        ends = false;
      } else if marks.contains(character) {
        ends = true;
      }
    }
    if !word.is_empty() {
      tokens.push(Some(word));
    }
    if ends {
      tokens.push(None);
    }
  }
  tokens
}

/// The longest of `phrases` that the tokens from `start` spell, if any.
fn longest_match<'a>(
  phrases: &'a [Vec<String>],
  tokens: &[Option<String>],
  start: usize,
) -> &'a [String] {
  phrases.iter().fold(&[][..], |longest, words| {
    let spelled = words.iter().enumerate().all(|(offset, word)| {
      tokens.get(start + offset).and_then(Option::as_deref) == Some(word.as_str())
    });
    if words.len() > longest.len() && spelled {
      words.as_slice()
    } else {
      longest
    }
  })
}

/// Dictated content or a correction marker, by its letters and digits;
/// `Stop` for a formatting command or a sentence end.
#[derive(Clone, Copy)]
enum Spoken {
  Content(usize),
  Marker(usize),
  Stop,
}

/// What the transcript dictated outside complete formatting commands, and
/// how much of it a correct answer may drop: a correction marker with
/// dictated words on both sides within its sentence drops itself and at most
/// as much of the words before it as the correction after it holds. A
/// formatting command, another marker or a sentence end closes the words a
/// marker reaches. `cleanup-model.ts` measures the same way.
fn dictated_content(transcript: &str) -> (usize, usize) {
  let phrases = phrases();
  let tokens = transcript_tokens(transcript);
  let mut spoken = Vec::new();
  let mut index = 0;
  while index < tokens.len() {
    let command = longest_match(&phrases.formatting_commands, &tokens, index);
    let marker = longest_match(&phrases.correction_markers, &tokens, index);
    match &tokens[index] {
      None => {
        spoken.push(Spoken::Stop);
        index += 1;
      }
      Some(_) if !command.is_empty() && command.len() >= marker.len() => {
        spoken.push(Spoken::Stop);
        index += command.len();
      }
      Some(_) if !marker.is_empty() => {
        spoken.push(Spoken::Marker(
          marker.iter().map(|word| word.chars().count()).sum(),
        ));
        index += marker.len();
      }
      Some(word) => {
        spoken.push(Spoken::Content(word.chars().count()));
        index += 1;
      }
    }
  }
  let content = |item: &Spoken| match item {
    Spoken::Content(length) => Some(*length),
    Spoken::Marker(_) | Spoken::Stop => None,
  };
  let mut dictated = 0;
  let mut discardable = 0;
  for (at, item) in spoken.iter().enumerate() {
    match *item {
      Spoken::Content(length) => dictated += length,
      Spoken::Marker(length) => {
        dictated += length;
        let before: usize = spoken[..at].iter().rev().map_while(content).sum();
        let after: usize = spoken[at + 1..].iter().map_while(content).sum();
        if before > 0 && after > 0 {
          discardable += length + before.min(after);
        }
      }
      Spoken::Stop => {}
    }
  }
  (dictated, discardable)
}

/// Whether the answer kept the dictation: it has text unless only formatting
/// commands were dictated, that text keeps at least the contract's share of
/// the dictated letters and digits a correct answer keeps, and it breaks
/// lines no more often than the dictation could have asked for. The server
/// applies the same bounds; this side holds them too, so an answer that lost
/// content is never typed.
pub fn plausible(transcript: &str, segments: &[Segment]) -> bool {
  let contract = contract();
  let (dictated, discardable) = dictated_content(transcript);
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
  // Only a dictation of formatting commands alone ("nový řádek") may become
  // breaks alone; "No, sorry." is dictated text.
  let has_text = texts > 0 || (dictated == 0 && breaks > 0);
  has_text
    && kept * 100
      >= dictated.saturating_sub(discardable) * contract.min_answer_text_percent
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

/// The dictation as text, for clipboard history: what `strokes` types, with
/// breaks as newlines and bold as plain text.
pub fn typed_text(transcript: &str, cleaned: Option<&[Segment]>) -> String {
  match cleaned {
    Some(segments) if !segments.is_empty() => dictation_format::plain_text(segments),
    _ => transcript.trim().to_string(),
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
  context: &CleanupContext,
) -> Result<Vec<Segment>, String> {
  let languages = &languages[..languages.len().min(contract().max_languages)];
  let request = crate::http_client::device_proof_request(
    client()?
      .post(format!("{}{}", account.api_base_url, contract().path))
      .json(&CleanupRequest {
        transcript,
        locale,
        languages,
        context,
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

/// The linked account the server enabled dictation for, and no other: what
/// dictation sends goes only there.
pub(crate) async fn dictation_account(
  app: &AppHandle,
) -> Result<AccountRequest, String> {
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
  Ok(account)
}

async fn request(
  app: &AppHandle,
  transcript: &str,
  languages: &[&str],
  context: &CleanupContext,
) -> Result<Vec<Segment>, String> {
  let account = dictation_account(app).await?;
  let segments = send(
    &account,
    transcript,
    locale_hint(crate::i18n::active_locale()),
    languages,
    context,
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
pub(crate) fn bounded<T>(
  limit: Duration,
  future: impl Future<Output = T>,
) -> Option<T> {
  tauri::async_runtime::block_on(
    async move { tokio::time::timeout(limit, future).await },
  )
  .ok()
}

/// The cleaned segments, or `None` whenever the raw transcript should be
/// typed instead. Blocks the dictation thread for at most [`TIMEOUT`]. The
/// plausibility check measures the answer against the transcript alone, so
/// nothing from `context` can be typed.
pub fn clean_up(
  app: &AppHandle,
  transcript: &str,
  languages: &[&str],
  context: &CleanupContext,
) -> Option<Vec<Segment>> {
  if transcript.chars().count() > contract().max_transcript_length {
    return None;
  }
  match bounded(TIMEOUT, request(app, transcript, languages, context)) {
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

  const PLAUSIBILITY_CASES: &str = include_str!(
    "../../../../packages/api-contract/src/desktop-dictation-cleanup.plausibility.json"
  );

  #[derive(Deserialize)]
  struct PlausibilityCase {
    name: String,
    transcript: String,
    segments: Vec<WireSegment>,
    plausible: bool,
  }

  /// The server runs the same cases (cleanup-model.test.ts), so both sides
  /// refuse the same answers.
  #[test]
  fn the_shared_plausibility_cases_hold() {
    let cases: Vec<PlausibilityCase> =
      serde_json::from_str(PLAUSIBILITY_CASES).unwrap();
    assert!(!cases.is_empty());
    for case in cases {
      let segments: Vec<Segment> =
        case.segments.into_iter().map(Segment::from).collect();
      assert_eq!(
        plausible(&case.transcript, &segments),
        case.plausible,
        "{}",
        case.name
      );
    }
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
      // A future that never finishes can only end by the limit firing.
      let pending = bounded(
        Duration::from_millis(50),
        std::future::pending::<Result<Vec<Segment>, String>>(),
      );
      let ready = bounded(Duration::from_secs(1), async { 7 });
      (pending, ready)
    })
    .join()
    .expect("a plain dictation thread must not panic");
    assert_eq!(outcome, (None, Some(7)));
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
  fn clipboard_history_keeps_what_was_dictated_cleaned_or_raw() {
    let segments = vec![
      plain("Lhůta je "),
      Segment::Text {
        text: "24".to_string(),
        bold: true,
      },
      plain(" dní."),
      Segment::LineBreak,
      plain("Konec."),
    ];
    assert_eq!(
      typed_text("lhůta je tučně 24 dní", Some(&segments)),
      "Lhůta je 24 dní.\nKonec."
    );
    // Without a cleaned answer the raw transcript is kept, as it is typed.
    for cleaned in [None, Some(&[][..])] {
      assert_eq!(
        typed_text(" nový řádek a tedy ", cleaned),
        "nový řádek a tedy"
      );
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
              "context": {
                "appKind": "document",
                "windowTitle": "Kupní smlouva.docx",
              },
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

    let context = CleanupContext {
      app_kind: crate::dictation_context::AppKind::Document,
      window_title: Some("Kupní smlouva.docx".to_string()),
      text_before_cursor: None,
    };
    let good = AccountRequest::fixture(linked(base.clone(), "stella_dr_good")).await;
    assert_eq!(
      send(&good, "tučně 42", Some("cs"), &["cs", "en"], &context)
        .await
        .unwrap(),
      parse_segments(FIXTURE.as_bytes()).unwrap()
    );
    drop(good);
    let bad = AccountRequest::fixture(linked(base, "stella_dr_bad")).await;
    assert!(
      send(&bad, "tučně 42", Some("cs"), &["cs", "en"], &context)
        .await
        .is_err()
    );
    drop(bad);
    server.abort();
  }
}
