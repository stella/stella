//! Structured, language-neutral records whose internal checks make broad
//! keyword context unnecessary. MRZ validation follows ICAO Doc 9303; card
//! tracks require their sentinels, field layout, and a Luhn-valid PAN.

use crate::diagnostics::DiagnosticStage;
use crate::labels::{
  CREDIT_CARD_NUMBER_LABEL, IDENTITY_CARD_NUMBER_LABEL, PASSPORT_NUMBER_LABEL,
};
use crate::resolution::{DetectionSource, PipelineEntity};

use super::prelude::*;
use super::timed_entities;

const SCORE: f64 = 1.0;
const TD1_LINE_BYTES: usize = 30;
const TD3_LINE_BYTES: usize = 44;
const MIN_PAN_BYTES: usize = 13;
const MAX_PAN_BYTES: usize = 19;
const MAX_TRACK_ONE_NAME_BYTES: usize = 26;
const MAX_TRACK_ONE_BYTES: usize = 79;
const MAX_TRACK_TWO_BYTES: usize = 40;

static_detector_rules! {
  pub(in crate::prepared) const RULES;
  STRUCTURED_DOCUMENT_DATA_RULE {
    id: DetectorId::StructuredDocumentData;
    stage: DiagnosticStage::EntityStructuredDocumentData;
    inputs: &[DetectorInput::FullText];
    scales: &[DetectorInput::FullText];
    active: structured_document_data_is_active;
    detect: detect_structured_document_data;
  }
}

fn structured_document_data_is_active(
  context: &StaticDetectorContext<'_>,
) -> Result<bool> {
  context.structured_document_data_is_active()
}

fn detect_structured_document_data(
  context: &StaticDetectorContext<'_>,
  _dependencies: DetectorDependencies<'_>,
  _diagnostics: StaticDetectorDiagnostics<'_>,
) -> Result<TimedEntities> {
  let (text, allowed_labels) = context.structured_document_data_input()?;
  timed_entities(|| detect(text, allowed_labels))
}

pub(in crate::prepared) fn detect(
  text: &str,
  allowed_labels: &[String],
) -> Result<Vec<PipelineEntity>> {
  let detect_td3 = label_is_allowed(PASSPORT_NUMBER_LABEL, allowed_labels);
  let detect_td1 =
    label_is_allowed(IDENTITY_CARD_NUMBER_LABEL, allowed_labels);
  let detect_tracks =
    label_is_allowed(CREDIT_CARD_NUMBER_LABEL, allowed_labels);
  let bytes = text.as_bytes();
  let mut entities = Vec::new();

  for (start, byte) in bytes.iter().copied().enumerate() {
    if at_line_start(bytes, start) {
      if detect_td3
        && let Some(end) = td3_end(bytes, start)
      {
        entities.push(entity(text, start, end, PASSPORT_NUMBER_LABEL)?);
      } else if detect_td1
        && let Some(end) = td1_end(bytes, start)
      {
        entities.push(entity(
          text,
          start,
          end,
          IDENTITY_CARD_NUMBER_LABEL,
        )?);
      }
    }

    if !detect_tracks {
      continue;
    }
    let end = match byte {
      b'%' if bytes.get(start.saturating_add(1)) == Some(&b'B') => {
        track_one_end(bytes, start)
      }
      b';' => track_two_end(bytes, start),
      _ => None,
    };
    if let Some(end) = end {
      entities.push(entity(text, start, end, CREDIT_CARD_NUMBER_LABEL)?);
    }
  }

  Ok(entities)
}

fn label_is_allowed(label: &str, allowed_labels: &[String]) -> bool {
  allowed_labels.is_empty()
    || allowed_labels.iter().any(|allowed| allowed == label)
}

fn at_line_start(bytes: &[u8], start: usize) -> bool {
  start == 0
    || bytes.get(start.saturating_sub(1)).copied() == Some(b'\n')
}

fn td3_end(bytes: &[u8], start: usize) -> Option<usize> {
  let first_end = start.checked_add(TD3_LINE_BYTES)?;
  let second_start = next_line_start(bytes, first_end)?;
  let second_end = second_start.checked_add(TD3_LINE_BYTES)?;
  if !line_ends_at(bytes, second_end) {
    return None;
  }
  let first = bytes.get(start..first_end)?;
  let second = bytes.get(second_start..second_end)?;
  valid_td3(first, second).then_some(second_end)
}

fn td1_end(bytes: &[u8], start: usize) -> Option<usize> {
  let first_end = start.checked_add(TD1_LINE_BYTES)?;
  let second_start = next_line_start(bytes, first_end)?;
  let second_end = second_start.checked_add(TD1_LINE_BYTES)?;
  let third_start = next_line_start(bytes, second_end)?;
  let third_end = third_start.checked_add(TD1_LINE_BYTES)?;
  if !line_ends_at(bytes, third_end) {
    return None;
  }
  let first = bytes.get(start..first_end)?;
  let second = bytes.get(second_start..second_end)?;
  let third = bytes.get(third_start..third_end)?;
  valid_td1(first, second, third).then_some(third_end)
}

fn next_line_start(bytes: &[u8], line_end: usize) -> Option<usize> {
  match bytes.get(line_end).copied() {
    Some(b'\n') => line_end.checked_add(1),
    Some(b'\r')
      if bytes.get(line_end.checked_add(1)?).copied() == Some(b'\n') =>
    {
      line_end.checked_add(2)
    }
    _ => None,
  }
}

fn line_ends_at(bytes: &[u8], line_end: usize) -> bool {
  line_end == bytes.len()
    || matches!(bytes.get(line_end).copied(), Some(b'\n'))
    || (matches!(bytes.get(line_end).copied(), Some(b'\r'))
      && bytes.get(line_end.saturating_add(1)).copied() == Some(b'\n'))
}

fn valid_td3(first: &[u8], second: &[u8]) -> bool {
  first.len() == TD3_LINE_BYTES
    && second.len() == TD3_LINE_BYTES
    && first.first().copied() == Some(b'P')
    && first
      .get(1)
      .is_some_and(|byte| byte.is_ascii_uppercase() || *byte == b'<')
    && is_mrz_alpha(first)
    && is_mrz_alphanumeric(second)
    && second.get(10..13).is_some_and(is_mrz_alpha)
    && second.get(13..19).is_some_and(is_mrz_numeric)
    && second
      .get(20)
      .is_some_and(|byte| matches!(byte, b'M' | b'F' | b'<'))
    && second.get(21..28).is_some_and(all_digits)
    && digit_matches(second.get(0..9), second.get(9))
    && digit_matches(second.get(13..19), second.get(19))
    && digit_matches(second.get(21..27), second.get(27))
    && optional_digit_matches(second.get(28..42), second.get(42))
    && composite_digit_matches(
      &[
        second.get(0..10),
        second.get(13..20),
        second.get(21..43),
      ],
      second.get(43),
    )
}

fn valid_td1(first: &[u8], second: &[u8], third: &[u8]) -> bool {
  first.len() == TD1_LINE_BYTES
    && second.len() == TD1_LINE_BYTES
    && third.len() == TD1_LINE_BYTES
    && first
      .first()
      .is_some_and(|byte| matches!(byte, b'A' | b'C' | b'I'))
    && first
      .get(1)
      .is_some_and(|byte| byte.is_ascii_uppercase() || *byte == b'<')
    && is_mrz_alphanumeric(first)
    && is_mrz_alphanumeric(second)
    && is_mrz_alpha(third)
    && first.get(2..5).is_some_and(is_mrz_alpha)
    && first.get(5..14).is_some_and(is_mrz_alphanumeric)
    && second.get(0..6).is_some_and(is_mrz_numeric)
    && second
      .get(7)
      .is_some_and(|byte| matches!(byte, b'M' | b'F' | b'<'))
    && second.get(8..15).is_some_and(all_digits)
    && second.get(15..18).is_some_and(is_mrz_alpha)
    && document_number_digit_matches(
      first.get(5..14),
      first.get(14),
      first.get(15..30),
    )
    && digit_matches(second.get(0..6), second.get(6))
    && digit_matches(second.get(8..14), second.get(14))
    && composite_digit_matches(
      &[
        first.get(5..30),
        second.get(0..7),
        second.get(8..15),
        second.get(18..29),
      ],
      second.get(29),
    )
}

fn all_digits(bytes: &[u8]) -> bool {
  bytes.iter().all(u8::is_ascii_digit)
}

fn is_mrz_alpha(bytes: &[u8]) -> bool {
  bytes
    .iter()
    .all(|byte| byte.is_ascii_uppercase() || *byte == b'<')
}

fn is_mrz_alphanumeric(bytes: &[u8]) -> bool {
  bytes.iter().all(|byte| {
    byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'<'
  })
}

fn is_mrz_numeric(bytes: &[u8]) -> bool {
  bytes
    .iter()
    .all(|byte| byte.is_ascii_digit() || *byte == b'<')
}

fn digit_matches(field: Option<&[u8]>, digit: Option<&u8>) -> bool {
  field
    .and_then(check_digit)
    .is_some_and(|expected| Some(&expected) == digit)
}

fn document_number_digit_matches(
  primary: Option<&[u8]>,
  primary_digit: Option<&u8>,
  optional_data: Option<&[u8]>,
) -> bool {
  if primary_digit != Some(&b'<') {
    return digit_matches(primary, primary_digit);
  }
  let (Some(primary), Some(optional_data)) = (primary, optional_data) else {
    return false;
  };
  let Some(check_position) = optional_data.iter().rposition(|byte| *byte != b'<')
  else {
    return false;
  };
  let Some(continuation) = optional_data.get(..check_position) else {
    return false;
  };
  let Some(check_digit) = optional_data.get(check_position) else {
    return false;
  };
  let Some(fillers) = optional_data.get(check_position.saturating_add(1)..)
  else {
    return false;
  };
  !continuation.is_empty()
    && continuation
      .iter()
      .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    && check_digit.is_ascii_digit()
    && fillers.iter().all(|byte| *byte == b'<')
    && composite_digit_matches(
      &[Some(primary), Some(continuation)],
      Some(check_digit),
    )
}

fn optional_digit_matches(field: Option<&[u8]>, digit: Option<&u8>) -> bool {
  if field.is_some_and(|value| value.iter().all(|byte| *byte == b'<'))
    && digit.is_some_and(|value| matches!(value, b'0' | b'<'))
  {
    return true;
  }
  digit_matches(field, digit)
}

fn composite_digit_matches(
  fields: &[Option<&[u8]>],
  digit: Option<&u8>,
) -> bool {
  let mut sum = 0u32;
  let mut position = 0usize;
  for field in fields {
    let Some(field) = field else {
      return false;
    };
    for byte in *field {
      let Some(value) = mrz_character_value(*byte) else {
        return false;
      };
      sum = sum.saturating_add(value.saturating_mul(mrz_weight(position)));
      position = position.saturating_add(1);
    }
  }
  check_digit_byte(sum).is_some_and(|expected| Some(&expected) == digit)
}

fn check_digit(bytes: &[u8]) -> Option<u8> {
  let mut sum = 0u32;
  for (position, byte) in bytes.iter().copied().enumerate() {
    let value = mrz_character_value(byte)?;
    sum = sum.saturating_add(value.saturating_mul(mrz_weight(position)));
  }
  check_digit_byte(sum)
}

fn mrz_character_value(byte: u8) -> Option<u32> {
  match byte {
    b'0'..=b'9' => Some(u32::from(byte.checked_sub(b'0')?)),
    b'A'..=b'Z' => Some(u32::from(byte.checked_sub(b'A')?.checked_add(10)?)),
    b'<' => Some(0),
    _ => None,
  }
}

const fn mrz_weight(position: usize) -> u32 {
  match position % 3 {
    0 => 7,
    1 => 3,
    _ => 1,
  }
}

fn check_digit_byte(sum: u32) -> Option<u8> {
  b'0'.checked_add(u8::try_from(sum % 10).ok()?)
}

fn track_one_end(bytes: &[u8], start: usize) -> Option<usize> {
  let pan_start = start.checked_add(2)?;
  let pan_end = digits_until(bytes, pan_start, b'^')?;
  let pan = bytes.get(pan_start..pan_end)?;
  if !valid_pan(pan) {
    return None;
  }

  let name_start = pan_end.checked_add(1)?;
  let name_search_end = name_start
    .checked_add(MAX_TRACK_ONE_NAME_BYTES.checked_add(1)?)?
    .min(bytes.len());
  let name_search = bytes.get(name_start..name_search_end)?;
  let name_length = name_search.iter().position(|byte| *byte == b'^')?;
  let name = name_search.get(..name_length)?;
  if !valid_track_one_name(name) {
    return None;
  }
  let suffix_start = name_start.checked_add(name_length)?.checked_add(1)?;
  let record_end = start.checked_add(MAX_TRACK_ONE_BYTES)?.min(bytes.len());
  let (end, suffix) =
    track_suffix(bytes.get(suffix_start..record_end)?, suffix_start)?;
  suffix
    .iter()
    .all(|byte| (b' '..=b'_').contains(byte))
    .then_some(end)
}

fn valid_track_one_name(bytes: &[u8]) -> bool {
  !bytes.is_empty()
    && bytes.len() <= MAX_TRACK_ONE_NAME_BYTES
    && bytes
      .iter()
      .all(|byte| (b' '..=b'_').contains(byte) && *byte != b'^')
}

fn track_two_end(bytes: &[u8], start: usize) -> Option<usize> {
  let pan_start = start.checked_add(1)?;
  let pan_end = digits_until(bytes, pan_start, b'=')?;
  let pan = bytes.get(pan_start..pan_end)?;
  if !valid_pan(pan) {
    return None;
  }
  let suffix_start = pan_end.checked_add(1)?;
  let record_end = start.checked_add(MAX_TRACK_TWO_BYTES)?.min(bytes.len());
  let (end, suffix) =
    track_suffix(bytes.get(suffix_start..record_end)?, suffix_start)?;
  all_digits(suffix).then_some(end)
}

fn digits_until(bytes: &[u8], start: usize, delimiter: u8) -> Option<usize> {
  let search_end = start
    .checked_add(MAX_PAN_BYTES.checked_add(1)?)?
    .min(bytes.len());
  let search = bytes.get(start..search_end)?;
  let length = search.iter().position(|byte| *byte == delimiter)?;
  let end = start.checked_add(length)?;
  let value = bytes.get(start..end)?;
  ((MIN_PAN_BYTES..=MAX_PAN_BYTES).contains(&value.len())
    && all_digits(value))
    .then_some(end)
}

fn track_suffix(search: &[u8], start: usize) -> Option<(usize, &[u8])> {
  let prefix = search.get(..7)?;
  if !all_digits(prefix) {
    return None;
  }
  let month_tens = prefix.get(2)?.checked_sub(b'0')?;
  let month_units = prefix.get(3)?.checked_sub(b'0')?;
  let month = month_tens.saturating_mul(10).saturating_add(month_units);
  if !(1..=12).contains(&month) {
    return None;
  }
  let terminator = search.iter().position(|byte| *byte == b'?')?;
  let data = search.get(..terminator)?;
  let end = start.checked_add(terminator)?.checked_add(1)?;
  Some((end, data))
}

fn valid_pan(pan: &[u8]) -> bool {
  if !(MIN_PAN_BYTES..=MAX_PAN_BYTES).contains(&pan.len())
    || !all_digits(pan)
  {
    return false;
  }
  let mut sum = 0u32;
  for (position, byte) in pan.iter().copied().rev().enumerate() {
    let Some(mut digit) = byte.checked_sub(b'0').map(u32::from) else {
      return false;
    };
    if position % 2 == 1 {
      digit = digit.saturating_mul(2);
      if digit > 9 {
        digit = digit.saturating_sub(9);
      }
    }
    sum = sum.saturating_add(digit);
  }
  sum.is_multiple_of(10)
}

fn entity(
  text: &str,
  start: usize,
  end: usize,
  label: &str,
) -> Result<PipelineEntity> {
  let entity_text = text
    .get(start..end)
    .ok_or_else(|| crate::types::Error::InvalidStaticData {
      field: "structured document span",
      reason: String::from("must be UTF-8 boundaries within the input"),
    })?
    .to_owned();
  let start = u32::try_from(start).map_err(|_| {
    crate::types::Error::InvalidStaticData {
      field: "structured document offset",
      reason: String::from("start exceeds u32"),
    }
  })?;
  let end = u32::try_from(end).map_err(|_| {
    crate::types::Error::InvalidStaticData {
      field: "structured document offset",
      reason: String::from("end exceeds u32"),
    }
  })?;
  Ok(PipelineEntity::detected(
    start,
    end,
    label,
    entity_text,
    SCORE,
    DetectionSource::Regex,
  ))
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::unwrap_used)]
mod tests {
  use proptest::prelude::*;

  use super::{check_digit, detect, optional_digit_matches};

  const TD3: &str = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10";
  const TD1: &str = "I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<";
  const TRACK1: &str =
    "%B4111111111111111^DOE/JOHN Q^25121010000000000000?";
  const TRACK2: &str = ";4111111111111111=25121010000000000000?";

  #[test]
  fn detects_valid_icao_and_payment_records_with_lf_and_crlf() {
    let inputs = [
      format!("{TD3}\n{TD1}\n{TRACK1} {TRACK2}"),
      format!(
        "{}\r\n{}\r\n{TRACK1} {TRACK2}",
        TD3.replace('\n', "\r\n"),
        TD1.replace('\n', "\r\n"),
      ),
    ];
    for text in inputs {
      let entities = detect(&text, &[]).unwrap();
      assert_eq!(entities.len(), 4);
      assert_eq!(entities[0].label, "passport number");
      assert_eq!(entities[1].label, "identity card number");
      assert!(
        entities[2..]
          .iter()
          .all(|entity| entity.label == "credit card number")
      );
    }
  }

  #[test]
  fn rejects_single_digit_checksum_corruption() {
    let text = format!(
      "{}\n{}\n{}\n{}",
      TD3.replacen('6', "7", 1),
      TD1.replacen('7', "8", 1),
      TRACK1.replacen("4111111111111111", "4111111111111112", 1),
      TRACK2.replacen("4111111111111111", "4111111111111112", 1),
    );
    assert!(detect(&text, &[]).unwrap().is_empty());
  }

  #[test]
  fn accepts_maximum_length_payment_tracks_and_rejects_one_byte_over() {
    let track_one_prefix =
      "%B4111111111111111^DOE/JOHN Q^2512101";
    let track_one_padding = super::MAX_TRACK_ONE_BYTES
      .checked_sub(track_one_prefix.len())
      .and_then(|remaining| remaining.checked_sub(1))
      .unwrap();
    let track_one =
      format!("{track_one_prefix}{}?", "A".repeat(track_one_padding));
    let track_two_prefix = ";4111111111111111=2512101";
    let track_two_padding = super::MAX_TRACK_TWO_BYTES
      .checked_sub(track_two_prefix.len())
      .and_then(|remaining| remaining.checked_sub(1))
      .unwrap();
    let track_two =
      format!("{track_two_prefix}{}?", "1".repeat(track_two_padding));

    assert_eq!(
      detect(&format!("{track_one}\n{track_two}"), &[])
        .unwrap()
        .len(),
      2
    );
    let overlong_track_one =
      format!("{}A?", track_one.strip_suffix('?').unwrap());
    let overlong_track_two =
      format!("{}1?", track_two.strip_suffix('?').unwrap());
    assert!(
      detect(&format!("{overlong_track_one}\n{overlong_track_two}"), &[])
        .unwrap()
        .is_empty()
    );
  }

  #[test]
  fn accepts_icao_filler_for_an_unused_td3_personal_number() {
    assert!(optional_digit_matches(Some(b"<<<<<<<<<<<<<<"), Some(&b'<')));
  }

  #[test]
  fn detects_td1_with_an_extended_document_number() {
    let mut lines = TD1
      .split('\n')
      .map(|line| line.as_bytes().to_vec())
      .collect::<Vec<_>>();
    let first = &mut lines[0];
    first[14] = b'<';
    first[15..17].copy_from_slice(b"AB");
    first[17] = check_digit(b"D23145890AB").unwrap();

    let mut composite = first[5..30].to_vec();
    composite.extend_from_slice(&lines[1][0..7]);
    composite.extend_from_slice(&lines[1][8..15]);
    composite.extend_from_slice(&lines[1][18..29]);
    lines[1][29] = check_digit(&composite).unwrap();

    let extended = lines
      .into_iter()
      .map(|line| String::from_utf8(line).unwrap())
      .collect::<Vec<_>>()
      .join("\n");
    let entities = detect(&extended, &[]).unwrap();
    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].label, "identity card number");
  }

  #[test]
  fn detects_td1_when_the_extended_document_number_fills_optional_data() {
    let mut lines = TD1
      .split('\n')
      .map(|line| line.as_bytes().to_vec())
      .collect::<Vec<_>>();
    let first = &mut lines[0];
    first[14] = b'<';
    first[15..29].copy_from_slice(b"ABCDEFGHIJKLMN");
    let mut document_number = first[5..14].to_vec();
    document_number.extend_from_slice(&first[15..29]);
    first[29] = check_digit(&document_number).unwrap();

    let mut composite = first[5..30].to_vec();
    composite.extend_from_slice(&lines[1][0..7]);
    composite.extend_from_slice(&lines[1][8..15]);
    composite.extend_from_slice(&lines[1][18..29]);
    lines[1][29] = check_digit(&composite).unwrap();

    let extended = lines
      .into_iter()
      .map(|line| String::from_utf8(line).unwrap())
      .collect::<Vec<_>>()
      .join("\n");
    assert_eq!(detect(&extended, &[]).unwrap().len(), 1);
  }

  #[test]
  fn detects_icao_records_with_unknown_birth_date_components() {
    let mut td3_lines = TD3
      .split('\n')
      .map(|line| line.as_bytes().to_vec())
      .collect::<Vec<_>>();
    td3_lines[1][13..19].copy_from_slice(b"74<<<<");
    td3_lines[1][19] = check_digit(&td3_lines[1][13..19]).unwrap();
    let mut td3_composite = td3_lines[1][0..10].to_vec();
    td3_composite.extend_from_slice(&td3_lines[1][13..20]);
    td3_composite.extend_from_slice(&td3_lines[1][21..43]);
    td3_lines[1][43] = check_digit(&td3_composite).unwrap();
    let td3 = td3_lines
      .into_iter()
      .map(|line| String::from_utf8(line).unwrap())
      .collect::<Vec<_>>()
      .join("\n");

    let mut td1_lines = TD1
      .split('\n')
      .map(|line| line.as_bytes().to_vec())
      .collect::<Vec<_>>();
    td1_lines[1][0..6].copy_from_slice(b"74<<<<");
    td1_lines[1][6] = check_digit(&td1_lines[1][0..6]).unwrap();
    let mut td1_composite = td1_lines[0][5..30].to_vec();
    td1_composite.extend_from_slice(&td1_lines[1][0..7]);
    td1_composite.extend_from_slice(&td1_lines[1][8..15]);
    td1_composite.extend_from_slice(&td1_lines[1][18..29]);
    td1_lines[1][29] = check_digit(&td1_composite).unwrap();
    let td1 = td1_lines
      .into_iter()
      .map(|line| String::from_utf8(line).unwrap())
      .collect::<Vec<_>>()
      .join("\n");

    assert_eq!(detect(&format!("{td3}\n{td1}"), &[]).unwrap().len(), 2);
  }

  #[test]
  fn preserves_utf8_byte_offsets_and_honors_label_filtering() {
    let text = format!("ž {TD3}\n{TRACK1}");
    let allowed = vec![String::from("credit card number")];
    let entities = detect(&text, &allowed).unwrap();
    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities[0].start,
      u32::try_from(text.find(TRACK1).unwrap()).unwrap()
    );
    assert_eq!(entities[0].text, TRACK1);
  }

  #[test]
  fn rejects_malformed_tracks_with_bounded_lookahead() {
    let malformed_suffix =
      "%B4111111111111111^DOE/JOHN^25X21010000000000000?";
    let late_terminator = format!(
      ";4111111111111111=2512101{}?",
      "0".repeat(super::MAX_TRACK_TWO_BYTES)
    );
    let repeated_sentinels = "%B".repeat(8_192);
    let track_one_lowercase =
      "%B4111111111111111^DOE/JOHN^2512101password?";
    let track_two_non_numeric = ";4111111111111111=2512101PASSWORD?";
    let text = format!(
      "{malformed_suffix}{late_terminator}{repeated_sentinels}{track_one_lowercase}{track_two_non_numeric}"
    );
    assert!(detect(&text, &[]).unwrap().is_empty());
  }

  proptest! {
    #[test]
    fn arbitrary_unicode_never_produces_invalid_spans(
      chars in proptest::collection::vec(any::<char>(), 0..256),
    ) {
      let text = chars.into_iter().collect::<String>();
      for entity in detect(&text, &[]).unwrap() {
        let start = usize::try_from(entity.start).unwrap();
        let end = usize::try_from(entity.end).unwrap();
        prop_assert!(start <= end);
        prop_assert_eq!(text.get(start..end), Some(entity.text.as_str()));
      }
    }
  }
}
