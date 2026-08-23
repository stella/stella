pub(crate) fn validate_named_id(validator: &str, value: &str) -> bool {
  stella_stdnum_core::validate_named_id(validator, value)
}

pub(crate) fn validate_id(
  validator: &str,
  value: &str,
  input: Option<&str>,
) -> bool {
  if let Some(validate) = phone_validator(validator) {
    return validate(value);
  }
  stella_stdnum_core::validate_id(validator, value, input)
}

pub(crate) fn supports_id(validator: &str) -> bool {
  phone_validator(validator).is_some()
    || stella_stdnum_core::supported_validator_ids().contains(&validator)
}

fn phone_validator(validator: &str) -> Option<fn(&str) -> bool> {
  match validator {
    "phone.international" => Some(validate_international_phone),
    "phone.nanp" => Some(validate_nanp_phone),
    _ => None,
  }
}

fn validate_international_phone(value: &str) -> bool {
  let trimmed = value.trim();
  let international_digits = if let Some(rest) = trimmed.strip_prefix('+') {
    rest
  } else if let Some(rest) = trimmed.strip_prefix("00") {
    rest
  } else {
    return false;
  };
  if !balanced_phone_grouping(international_digits) {
    return false;
  }
  let digits: Vec<char> = international_digits
    .chars()
    .filter(char::is_ascii_digit)
    .collect();
  if !matches!(digits.len(), 8..=15)
    || digits.first() == Some(&'0')
    || has_date_like_phone_grouping(international_digits, &digits)
  {
    return false;
  }
  if digits.first() == Some(&'1') {
    return validate_nanp_digits(&digits);
  }
  true
}

fn balanced_phone_grouping(value: &str) -> bool {
  let mut in_group = false;
  for character in value.chars() {
    match character {
      '(' if in_group => return false,
      '(' => in_group = true,
      ')' if !in_group => return false,
      ')' => in_group = false,
      _ => {}
    }
  }
  !in_group
}

fn has_date_like_phone_grouping(value: &str, digits: &[char]) -> bool {
  if let Some(compact_date) = digits.get(digits.len().saturating_sub(8)..)
    && digits.len().saturating_sub(compact_date.len()) <= 3
  {
    let compact: String = compact_date.iter().collect();
    if compact_date_parts(&compact)
      .is_some_and(|(year, month, day)| valid_calendar_date(year, month, day))
    {
      return true;
    }
  }

  let groups: Vec<&str> = value
    .split(|character: char| !character.is_ascii_digit())
    .filter(|group| !group.is_empty())
    .collect();
  let Some(groups) = groups.get(groups.len().saturating_sub(3)..) else {
    return false;
  };
  let [year, month, day] = groups else {
    return false;
  };
  year.len() == 4
    && month.len() == 2
    && day.len() == 2
    && parse_calendar_parts(year, month, day)
      .is_some_and(|(year, month, day)| valid_calendar_date(year, month, day))
}

fn compact_date_parts(value: &str) -> Option<(u32, u32, u32)> {
  parse_calendar_parts(value.get(..4)?, value.get(4..6)?, value.get(6..8)?)
}

fn parse_calendar_parts(
  year: &str,
  month: &str,
  day: &str,
) -> Option<(u32, u32, u32)> {
  Some((year.parse().ok()?, month.parse().ok()?, day.parse().ok()?))
}

fn valid_calendar_date(year: u32, month: u32, day: u32) -> bool {
  if !(1900..=2199).contains(&year) {
    return false;
  }
  let leap_year = year.is_multiple_of(4)
    && (!year.is_multiple_of(100) || year.is_multiple_of(400));
  let days_in_month = match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 if leap_year => 29,
    2 => 28,
    _ => return false,
  };
  (1..=days_in_month).contains(&day)
}

/// Applies the stable numbering-plan invariants that do not require a live
/// allocation database. This follows the validation-first approach used by
/// Scrubadub and Microsoft Presidio's libphonenumber-backed recognizers at
/// pinned commits 53772cbef417da290d25c95373031f786ab3b5c6 and
/// efc775903f55c3e50e12b5902ec2699c2e52fdf7.
fn validate_nanp_phone(value: &str) -> bool {
  if !value
    .chars()
    .any(|character| matches!(character, ' ' | '\t' | '.' | '-' | '(' | ')'))
  {
    return false;
  }
  let mut digits: Vec<char> =
    value.chars().filter(char::is_ascii_digit).collect();
  if digits.len() == 11 {
    if digits.first() != Some(&'1') {
      return false;
    }
    digits.remove(0);
  }
  validate_nanp_digits(&digits)
}

fn validate_nanp_digits(digits: &[char]) -> bool {
  let digits = if digits.len() == 11 && digits.first() == Some(&'1') {
    let Some(digits) = digits.get(1..) else {
      return false;
    };
    digits
  } else if digits.len() == 10 {
    digits
  } else {
    return false;
  };
  let Some(area) = digits.get(0..3) else {
    return false;
  };
  let Some(exchange) = digits.get(3..6) else {
    return false;
  };
  valid_nanp_code(area) && valid_nanp_code(exchange)
}

fn valid_nanp_code(code: &[char]) -> bool {
  code.first().is_some_and(|digit| matches!(digit, '2'..='9'))
    && !matches!(code, [_, '1', '1'])
}
