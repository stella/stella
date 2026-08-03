const ID_SEPARATORS: [char; 3] = ['-', '/', '.'];

use crate::types::{Error, Result};

pub(crate) struct NormalizedSearchText {
  text: String,
  byte_to_original: Option<Vec<u32>>,
}

impl NormalizedSearchText {
  pub(crate) fn as_str(&self) -> &str {
    &self.text
  }

  pub(crate) fn map_span(&self, start: u32, end: u32) -> Result<(u32, u32)> {
    if start > end {
      return Err(Error::InvalidSpan { start, end });
    }

    let Some(byte_to_original) = &self.byte_to_original else {
      return Ok((start, end));
    };

    Ok((
      map_normalized_offset(byte_to_original, start)?,
      map_normalized_offset(byte_to_original, end)?,
    ))
  }
}

#[must_use]
pub fn normalize_for_search(text: &str) -> String {
  let mut has_replacement = false;
  for ch in text.chars() {
    if replacement_char(ch) != ch {
      has_replacement = true;
      break;
    }
  }
  if !has_replacement {
    return text.to_owned();
  }

  let mut output = String::with_capacity(text.len());
  for ch in text.chars() {
    output.push(replacement_char(ch));
  }
  output
}

pub(crate) fn normalize_for_search_with_byte_map(
  text: &str,
) -> Result<NormalizedSearchText> {
  let mut has_replacement = false;
  for ch in text.chars() {
    if replacement_char(ch) != ch {
      has_replacement = true;
      break;
    }
  }
  if !has_replacement {
    return Ok(NormalizedSearchText {
      text: text.to_owned(),
      byte_to_original: None,
    });
  }

  let mut output = String::with_capacity(text.len());
  let mut byte_to_original = vec![0_u32];
  for (original_start, ch) in text.char_indices() {
    set_boundary(
      &mut byte_to_original,
      output.len(),
      checked_u32(original_start)?,
    );
    output.push(replacement_char(ch));
    set_boundary(
      &mut byte_to_original,
      output.len(),
      checked_u32(original_start.saturating_add(ch.len_utf8()))?,
    );
  }

  Ok(NormalizedSearchText {
    text: output,
    byte_to_original: Some(byte_to_original),
  })
}

fn set_boundary(
  byte_to_original: &mut Vec<u32>,
  normalized_offset: usize,
  original_offset: u32,
) {
  if byte_to_original.len() <= normalized_offset {
    byte_to_original.resize(normalized_offset.saturating_add(1), u32::MAX);
  }
  if let Some(slot) = byte_to_original.get_mut(normalized_offset) {
    *slot = original_offset;
  }
}

fn map_normalized_offset(byte_to_original: &[u32], offset: u32) -> Result<u32> {
  let index = usize::try_from(offset)
    .map_err(|_| Error::ByteOffsetOutOfBounds { offset })?;
  let mapped = byte_to_original
    .get(index)
    .copied()
    .ok_or(Error::ByteOffsetOutOfBounds { offset })?;
  if mapped == u32::MAX {
    return Err(Error::ByteOffsetInsideCodepoint { offset });
  }
  Ok(mapped)
}

fn checked_u32(offset: usize) -> Result<u32> {
  u32::try_from(offset)
    .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })
}

// Normalization decides placeholder identity.
pub(crate) fn label_key(label: &str) -> String {
  let uppercase = uppercase(label);
  collapse_whitespace(&uppercase, "_", false)
}

pub(crate) fn placeholder_fallback(label: &str) -> String {
  format!("[{}]", label_key(label))
}

pub(crate) fn normalize_entity_text(label: &str, text: &str) -> String {
  let upper = label_key(label);

  if upper == "EMAIL_ADDRESS" || upper == "EMAIL" {
    return text.to_lowercase().trim().to_owned();
  }
  if upper == "PHONE_NUMBER" || upper == "PHONE" {
    let digits: String = text.chars().filter(char::is_ascii_digit).collect();
    return digits.strip_prefix("00").unwrap_or(&digits).to_owned();
  }
  if upper == "CRYPTO" {
    return normalize_crypto_text(text);
  }
  if upper == "NATIONAL_IDENTIFICATION_NUMBER" && contains_nhs_cue(text) {
    return text.chars().filter(char::is_ascii_digit).collect();
  }
  if upper == "CREDIT_CARD_NUMBER" {
    return normalize_credit_card_text(text);
  }
  if is_identifier_label(&upper) {
    return normalize_identifier_text(text);
  }
  if upper == "PASSPORT_NUMBER" {
    return normalize_passport_text(text);
  }
  if is_collapsible_text_label(&upper) {
    return collapse_whitespace(text, " ", false)
      .to_lowercase()
      .trim()
      .to_owned();
  }

  text.trim().to_owned()
}

fn uppercase(text: &str) -> String {
  let mut output = String::new();
  for ch in text.chars() {
    output.extend(ch.to_uppercase());
  }
  output
}

fn collapse_whitespace(text: &str, replacement: &str, trim: bool) -> String {
  let mut output = String::new();
  let mut in_whitespace = false;

  for ch in text.chars() {
    if ch.is_whitespace() {
      if !in_whitespace {
        output.push_str(replacement);
        in_whitespace = true;
      }
      continue;
    }

    output.push(ch);
    in_whitespace = false;
  }

  if trim {
    return output.trim().to_owned();
  }
  output
}

fn strip_id_separators(text: &str) -> String {
  text
    .chars()
    .filter(|ch| !ch.is_whitespace() && !ID_SEPARATORS.contains(ch))
    .collect()
}

fn normalize_identifier_text(text: &str) -> String {
  strip_id_separators(text).to_uppercase()
}

fn normalize_credit_card_text(text: &str) -> String {
  let trimmed = text.trim();
  let track = trimmed
    .strip_prefix("%B")
    .or_else(|| trimmed.strip_prefix(';'))
    .unwrap_or(trimmed);
  let track_pan = track
    .split_once('^')
    .or_else(|| track.split_once('='))
    .map(|(pan, _)| pan);
  if let Some(pan) = track_pan
    && (13..=19).contains(&pan.len())
    && pan.chars().all(|character| character.is_ascii_digit())
  {
    return pan.to_owned();
  }

  normalize_identifier_text(text)
}

fn is_identifier_label(upper: &str) -> bool {
  matches!(
    upper,
    "IBAN"
      | "BANK_ACCOUNT_NUMBER"
      | "TAX_IDENTIFICATION_NUMBER"
      | "REGISTRATION_NUMBER"
      | "NATIONAL_IDENTIFICATION_NUMBER"
      | "SOCIAL_SECURITY_NUMBER"
      | "BIRTH_NUMBER"
      | "IDENTITY_CARD_NUMBER"
      | "CREDIT_CARD_NUMBER"
  )
}

fn is_collapsible_text_label(upper: &str) -> bool {
  matches!(
    upper,
    "PERSON" | "ORGANIZATION" | "ADDRESS" | "LAND_PARCEL" | "MISC"
  )
}

fn contains_nhs_cue(text: &str) -> bool {
  let lower = text.to_lowercase();
  contains_word(&lower, "nhs")
    || collapse_whitespace(&lower, " ", true)
      .contains("national health service")
}

fn normalize_crypto_text(text: &str) -> String {
  let trimmed = text.trim();

  if let Some(address) = find_ethereum_address(trimmed) {
    return address.to_lowercase();
  }
  if let Some(address) = find_bech32_address(trimmed) {
    return address.to_lowercase();
  }
  if let Some(address) = find_base58_address(trimmed) {
    return address.to_owned();
  }

  trimmed.to_owned()
}

fn find_ethereum_address(text: &str) -> Option<&str> {
  for (start, _) in text.match_indices("0x") {
    let end = start.saturating_add(42);
    let Some(candidate) = text.get(start..end) else {
      continue;
    };
    if candidate.chars().skip(2).all(|ch| ch.is_ascii_hexdigit()) {
      return Some(candidate);
    }
  }

  None
}

fn find_bech32_address(text: &str) -> Option<&str> {
  find_ascii_token(text, |token| {
    let lower = token.to_lowercase();
    lower.len() >= 14
      && lower.len() <= 74
      && lower.starts_with("bc1")
      && lower
        .chars()
        .skip(3)
        .all(|ch| matches!(ch, 'a'..='h' | 'j'..='n' | 'p'..='z' | '0'..='9'))
  })
}

fn find_base58_address(text: &str) -> Option<&str> {
  find_ascii_token(text, |token| {
    let len = token.len();
    (26..=35).contains(&len)
      && (token.starts_with('1') || token.starts_with('3'))
      && token.chars().all(is_base58_char)
  })
}

fn find_ascii_token(
  text: &str,
  predicate: impl Fn(&str) -> bool,
) -> Option<&str> {
  let mut token_start = None;

  for (index, ch) in text.char_indices() {
    if ch.is_ascii_alphanumeric() {
      if token_start.is_none() {
        token_start = Some(index);
      }
      continue;
    }

    if let Some(start) = token_start {
      let token = text.get(start..index)?;
      if predicate(token) {
        return Some(token);
      }
      token_start = None;
    }
  }

  let start = token_start?;
  let token = text.get(start..)?;
  predicate(token).then_some(token)
}

fn find_compact_ascii_identifier(
  text: &str,
  allow_whitespace: bool,
  predicate: impl Fn(&str) -> bool,
) -> Option<String> {
  for (start, ch) in text.char_indices() {
    if !is_identifier_start(text, start, ch) {
      continue;
    }
    let Some(candidate) =
      compact_ascii_identifier_from(text, start, allow_whitespace, &predicate)
    else {
      continue;
    };
    return Some(candidate);
  }

  None
}

fn compact_ascii_identifier_from(
  text: &str,
  start: usize,
  allow_whitespace: bool,
  predicate: &impl Fn(&str) -> bool,
) -> Option<String> {
  let mut compact = String::new();
  let mut token = String::new();
  let mut last_valid = None;
  let tail = text.get(start..)?;

  for ch in tail.chars() {
    if ch.is_ascii_alphanumeric() {
      compact.push(ch.to_ascii_uppercase());
      token.push(ch.to_ascii_uppercase());
      continue;
    }

    if is_identifier_separator(ch, allow_whitespace) {
      if predicate(&compact) {
        last_valid = Some(compact.clone());
      }
      token.clear();
      continue;
    }

    break;
  }

  if allow_whitespace && token_is_trailing_prose(&token) && last_valid.is_some()
  {
    return last_valid;
  }
  if predicate(&compact) {
    return Some(compact);
  }
  last_valid
}

fn token_is_trailing_prose(token: &str) -> bool {
  token.len() >= 3 && token.chars().all(|ch| ch.is_ascii_alphabetic())
}

fn is_identifier_start(text: &str, index: usize, ch: char) -> bool {
  ch.is_ascii_alphanumeric()
    && text
      .get(..index)
      .and_then(|prefix| prefix.chars().next_back())
      .is_none_or(|previous| !previous.is_ascii_alphanumeric())
}

fn is_identifier_separator(ch: char, allow_whitespace: bool) -> bool {
  ID_SEPARATORS.contains(&ch) || (allow_whitespace && ch.is_whitespace())
}

const fn is_base58_char(ch: char) -> bool {
  matches!(
    ch,
    'a'..='k'
      | 'm'..='z'
      | 'A'..='H'
      | 'J'..='N'
      | 'P'..='Z'
      | '1'..='9'
  )
}

fn normalize_passport_text(text: &str) -> String {
  find_compact_ascii_identifier(text, true, is_passport_identifier)
    .unwrap_or_else(|| strip_id_separators(text).to_uppercase())
}

fn is_passport_identifier(token: &str) -> bool {
  let chars: Vec<char> = token.chars().collect();
  matches_letters_digits(&chars, 1, 2, 6, 8)
    || matches_digits_letters_digits(&chars, 2, 2, 5)
    || (token.len() >= 7
      && token.len() <= 9
      && token.chars().all(|ch| ch.is_ascii_digit()))
}

fn matches_letters_digits(
  chars: &[char],
  min_letters: usize,
  max_letters: usize,
  min_digits: usize,
  max_digits: usize,
) -> bool {
  for letter_count in min_letters..=max_letters {
    let digit_count = chars.len().saturating_sub(letter_count);
    if digit_count < min_digits || digit_count > max_digits {
      continue;
    }
    let Some((letters, digits)) = chars.split_at_checked(letter_count) else {
      continue;
    };
    if letters.iter().all(char::is_ascii_alphabetic)
      && digits.iter().all(char::is_ascii_digit)
    {
      return true;
    }
  }

  false
}

fn matches_digits_letters_digits(
  chars: &[char],
  first_digits: usize,
  letters_count: usize,
  last_digits: usize,
) -> bool {
  let expected_len = first_digits
    .saturating_add(letters_count)
    .saturating_add(last_digits);
  if chars.len() != expected_len {
    return false;
  }

  let Some((first, tail)) = chars.split_at_checked(first_digits) else {
    return false;
  };
  let Some((letters, last)) = tail.split_at_checked(letters_count) else {
    return false;
  };

  first.iter().all(char::is_ascii_digit)
    && letters.iter().all(char::is_ascii_alphabetic)
    && last.iter().all(char::is_ascii_digit)
}

fn contains_word(text: &str, word: &str) -> bool {
  let mut start = 0;
  while let Some(relative) = text.get(start..).and_then(|tail| tail.find(word))
  {
    let word_start = start.saturating_add(relative);
    let word_end = word_start.saturating_add(word.len());
    let before_ok = text
      .get(..word_start)
      .and_then(|prefix| prefix.chars().next_back())
      .is_none_or(|ch| !ch.is_alphanumeric());
    let after_ok = text
      .get(word_end..)
      .and_then(|suffix| suffix.chars().next())
      .is_none_or(|ch| !ch.is_alphanumeric());
    if before_ok && after_ok {
      return true;
    }
    start = word_end;
  }

  false
}

const fn replacement_char(ch: char) -> char {
  match ch {
    '\u{00a0}' | '\u{2007}' | '\u{202f}' => ' ',
    '\u{2013}' | '\u{2014}' => '-',
    '\u{201c}' | '\u{201d}' => '"',
    _ => ch,
  }
}
