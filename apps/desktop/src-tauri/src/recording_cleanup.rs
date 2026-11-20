//! AI cleanup of a transcribed recording, one part at a time: the text this
//! computer or stella AI transcribed goes through stella to the linked
//! organization's AI model, which returns the dictation as formatted text
//! (a small Markdown subset) and, apart from it, any instructions the
//! speaker gave whoever types it up. Only text is sent, never the audio, and
//! only while the server enables dictation for the same account. The part
//! before this one, as already cleaned up, comes along so a sentence or a
//! list continues. Neither the transcript, the custom words nor the answer
//! is logged or stored here.

use std::{sync::OnceLock, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
  http_client::{DesktopHttpClient, HttpClientOptions},
  logging::request_cause_logged,
};

/// One part's round trip. The server gives its model about two minutes.
const TIMEOUT: Duration = Duration::from_secs(150);
const FAILURE: &str = "recording cleanup request failed";
const INVALID: &str = "recording cleanup answer is invalid";
/// An answer is never much longer than the part it cleans up.
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_INSTRUCTIONS: usize = 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
  /// Absent from a contract older than the recording cleanup route; the
  /// window then shows the transcript alone.
  #[serde(default)]
  recording_cleanup: Option<RecordingContract>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingContract {
  path: String,
  max_transcript_length: usize,
  max_previous_text_length: usize,
}

const CONTRACT: &str =
  include_str!("../../../../packages/api-contract/src/desktop-dictation-cleanup.json");

fn contract() -> Option<&'static RecordingContract> {
  static PARSED: OnceLock<Contract> = OnceLock::new();
  PARSED
    .get_or_init(|| {
      serde_json::from_str(CONTRACT)
        .expect("the committed dictation cleanup contract must be valid")
    })
    .recording_cleanup
    .as_ref()
}

const ACCOUNT_CHANGED: &str =
  "the dictation account changed since the recording started";
const UNSUPPORTED: &str = "recording cleanup is not in this build's contract";

/// The longest part one request may carry, in characters; none without
/// the route.
pub fn max_part_length() -> usize {
  contract().map_or(0, |contract| contract.max_transcript_length)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupRequest<'a> {
  transcript: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  previous_text: Option<&'a str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  locale: Option<&'a str>,
  #[serde(skip_serializing_if = "<[_]>::is_empty")]
  languages: &'a [&'a str],
  #[serde(skip_serializing_if = "<[_]>::is_empty")]
  vocabulary: &'a [String],
}

/// One part, cleaned up. Fields a newer API adds are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanedPart {
  pub instructions: Vec<String>,
  pub markdown: String,
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

/// The end of `text`, at most `limit` characters, starting at a word.
fn tail(text: &str, limit: usize) -> &str {
  let count = text.chars().count();
  if count <= limit {
    return text;
  }
  let start = text
    .char_indices()
    .nth(count - limit)
    .map_or(0, |(index, _)| index);
  let rest = &text[start..];
  rest
    .find(char::is_whitespace)
    .map_or(rest, |space| rest[space..].trim_start())
}

/// A part the server accepts: not empty and within the contract.
pub fn valid_part(transcript: &str) -> bool {
  !transcript.trim().is_empty() && transcript.chars().count() <= max_part_length()
}

/// Controls other than a line break, and the bidirectional controls that
/// would reorder the text around them.
fn forbidden(character: char) -> bool {
  (character.is_control() && character != '\n')
    || matches!(
      character,
      '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

pub fn parse(body: &[u8]) -> Result<CleanedPart, String> {
  let part = serde_json::from_slice::<CleanedPart>(body)
    .map_err(|_error| INVALID.to_string())?;
  let sane = part.instructions.len() <= MAX_INSTRUCTIONS
    && !part
      .markdown
      .chars()
      .chain(part.instructions.iter().flat_map(|line| line.chars()))
      .any(forbidden);
  if sane {
    Ok(part)
  } else {
    Err(INVALID.to_string())
  }
}

/// Cleans up one part of a recording's transcript, only while the
/// dictation account is still the one the recording started for.
pub async fn clean_up(
  app: &AppHandle,
  recording_account: &str,
  transcript: &str,
  previous_text: Option<&str>,
) -> Result<CleanedPart, String> {
  let route = contract().ok_or(UNSUPPORTED)?;
  if !valid_part(transcript) {
    return Err("the part is empty or too long to clean up".to_string());
  }
  let words = crate::dictation_words::stored_for(recording_account);
  let language = crate::dictation::language(app);
  let previous = previous_text
    .map(str::trim)
    .filter(|text| !text.is_empty())
    .map(|text| tail(text, route.max_previous_text_length));
  let account = crate::dictation_cleanup::dictation_account(app).await?;
  // Another account linked since the recording started never receives its
  // text.
  if account.local_data_namespace() != recording_account {
    return Err(ACCOUNT_CHANGED.to_string());
  }
  let request = CleanupRequest {
    transcript,
    previous_text: previous,
    locale: crate::dictation_cleanup::locale_hint(crate::i18n::active_locale()),
    languages: &language.speaker,
    vocabulary: &words,
  };
  let mut response = crate::dictation_cleanup::send_recording_cleanup(
    &account,
    client()?,
    &route.path,
    &request,
  )
  .await?;
  if !response.status().is_success() {
    return Err(format!(
      "recording cleanup was refused: {}",
      response.status()
    ));
  }
  let mut body = Vec::new();
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(request_cause_logged(FAILURE))?
  {
    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
      return Err(INVALID.to_string());
    }
    body.extend_from_slice(&chunk);
  }
  drop(account);
  parse(&body)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_contract_names_the_route_and_its_limits_when_it_has_one() {
    if let Some(contract) = contract() {
      assert!(contract.path.starts_with("/v1/desktop/dictation/"));
      assert!(contract.max_transcript_length >= 1000);
      assert!(contract.max_previous_text_length > 0);
    }
    let older: Contract = serde_json::from_str("{}").unwrap();
    assert!(older.recording_cleanup.is_none());
  }

  #[test]
  fn the_previous_text_is_cut_at_a_word() {
    assert_eq!(tail("krátký text", 50), "krátký text");
    assert_eq!(tail("jedna dva tři čtyři", 9), "čtyři");
    assert_eq!(tail("jedna dva tři", 3), "tři");
  }

  #[test]
  fn a_part_must_hold_text_within_the_limit() {
    assert!(!valid_part("   "));
    assert!(!valid_part(&"a".repeat(max_part_length() + 1)));
    if contract().is_some() {
      assert!(valid_part("Ahoj."));
    }
  }

  #[test]
  fn an_answer_is_read_or_refused() {
    let part =
      parse(br#"{"instructions":["Reply to Petr."],"markdown":"Hi,\n\n**ok**","extra":1}"#)
        .unwrap();
    assert_eq!(part.instructions, ["Reply to Petr."]);
    assert_eq!(part.markdown, "Hi,\n\n**ok**");
    for body in [
      &b"not json"[..],
      br#"{"markdown":"x"}"#,
      br#"{"instructions":[],"markdown":"a\u0007b"}"#,
      br#"{"instructions":["a\u202Eb"],"markdown":"x"}"#,
    ] {
      assert!(parse(body).is_err(), "{}", String::from_utf8_lossy(body));
    }
  }
}
