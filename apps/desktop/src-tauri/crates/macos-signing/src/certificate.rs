//! What the picker needs to know about a certificate, read from its DER.
//!
//! Like the key type (see `spki`), none of this comes from the keychain's
//! attribute API: `SecKeyCopyAttributes` and friends can block on a consent
//! prompt, and the certificate already carries the validity window, the
//! permitted key usages and the issuer's name.

use crate::spki::{
  TAG_BIT_STRING, TAG_CONTEXT_0, TAG_INTEGER, TAG_OID, TAG_SEQUENCE, read_element,
  read_tagged, skip,
};

const TAG_BOOLEAN: u8 = 0x01;
const TAG_OCTET_STRING: u8 = 0x04;
const TAG_UTF8_STRING: u8 = 0x0C;
const TAG_PRINTABLE_STRING: u8 = 0x13;
const TAG_T61_STRING: u8 = 0x14;
const TAG_IA5_STRING: u8 = 0x16;
const TAG_UTC_TIME: u8 = 0x17;
const TAG_GENERALIZED_TIME: u8 = 0x18;
const TAG_BMP_STRING: u8 = 0x1E;
const TAG_SET: u8 = 0x31;
/// `[3] EXPLICIT`: the extensions at the tail of a v3 TBSCertificate.
const TAG_CONTEXT_3: u8 = 0xA3;

/// id-ce-keyUsage (2.5.29.15).
const OID_KEY_USAGE: &[u8] = &[0x55, 0x1D, 0x0F];
/// id-ce-extKeyUsage (2.5.29.37).
const OID_EXTENDED_KEY_USAGE: &[u8] = &[0x55, 0x1D, 0x25];
/// id-at-commonName (2.5.4.3).
const OID_COMMON_NAME: &[u8] = &[0x55, 0x04, 0x03];
/// id-at-organizationName (2.5.4.10).
const OID_ORGANIZATION: &[u8] = &[0x55, 0x04, 0x0A];

/// KeyUsage bits 0 and 1 (RFC 5280 4.2.1.3), in the first content byte.
const DIGITAL_SIGNATURE: u8 = 0x80;
const NON_REPUDIATION: u8 = 0x40;

/// Extended key usages that mark a certificate as made for something other
/// than signing documents: servers, code, VPN and IPsec endpoints, time
/// stamping, OCSP responders. A certificate whose every usage is one of
/// these is left out of the picker; one that also allows anything else
/// (e-mail protection, document signing, client authentication, any usage)
/// stays.
const NON_DOCUMENT_USAGES: &[&[u8]] = &[
  // id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01],
  // id-kp-codeSigning (1.3.6.1.5.5.7.3.3)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x03],
  // id-kp-ipsecEndSystem (1.3.6.1.5.5.7.3.5)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x05],
  // id-kp-ipsecTunnel (1.3.6.1.5.5.7.3.6)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x06],
  // id-kp-ipsecUser (1.3.6.1.5.5.7.3.7)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x07],
  // id-kp-timeStamping (1.3.6.1.5.5.7.3.8)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08],
  // id-kp-OCSPSigning (1.3.6.1.5.5.7.3.9)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x09],
  // id-kp-ipsecIKE (1.3.6.1.5.5.7.3.17)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x11],
  // iKEIntermediate (1.3.6.1.5.5.8.2.2)
  &[0x2B, 0x06, 0x01, 0x05, 0x05, 0x08, 0x02, 0x02],
];

const SECONDS_PER_DAY: i64 = 86_400;

/// The fields of a certificate the picker decides and displays with.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct CertificateFacts {
  /// Unix seconds.
  pub(crate) not_before: i64,
  /// Unix seconds.
  pub(crate) not_after: i64,
  /// The KeyUsage bits' first byte; `None` when the extension is absent,
  /// which leaves the key unconstrained.
  key_usage: Option<u8>,
  /// The extended key usages' OID contents; `None` when absent.
  extended_key_usages: Option<Vec<Vec<u8>>>,
  /// The issuer's common name, or its organization when it has none.
  pub(crate) issuer_name: Option<String>,
}

/// Read the facts, or `None` for anything that is not a well-formed
/// certificate as far as these fields go.
pub(crate) fn certificate_facts(certificate_der: &[u8]) -> Option<CertificateFacts> {
  let certificate = read_tagged(certificate_der, TAG_SEQUENCE)?;
  let tbs = read_tagged(certificate.contents, TAG_SEQUENCE)?;
  let after_version = match read_element(tbs.contents) {
    Some(element) if element.tag == TAG_CONTEXT_0 => element.rest,
    _ => tbs.contents,
  };
  let after_serial = read_tagged(after_version, TAG_INTEGER)?.rest;
  let after_signature = skip(after_serial)?;
  let issuer = read_tagged(after_signature, TAG_SEQUENCE)?;
  let validity = read_tagged(issuer.rest, TAG_SEQUENCE)?;
  let not_before = read_element(validity.contents)?;
  let not_after = read_element(not_before.rest)?;
  let after_subject = skip(validity.rest)?;
  let after_spki = skip(after_subject)?;

  let mut facts = CertificateFacts {
    not_before: parse_time(not_before.tag, not_before.contents)?,
    not_after: parse_time(not_after.tag, not_after.contents)?,
    key_usage: None,
    extended_key_usages: None,
    issuer_name: issuer_name(issuer.contents),
  };

  // issuerUniqueID [1] and subjectUniqueID [2] may precede the extensions.
  let mut cursor = after_spki;
  while let Some(element) = read_element(cursor) {
    if element.tag == TAG_CONTEXT_3 {
      read_extensions(element.contents, &mut facts)?;
      break;
    }
    cursor = element.rest;
  }
  Some(facts)
}

fn read_extensions(explicit: &[u8], facts: &mut CertificateFacts) -> Option<()> {
  let mut cursor = read_tagged(explicit, TAG_SEQUENCE)?.contents;
  while !cursor.is_empty() {
    let extension = read_tagged(cursor, TAG_SEQUENCE)?;
    cursor = extension.rest;
    let oid = read_tagged(extension.contents, TAG_OID)?;
    let after_critical = match read_element(oid.rest) {
      Some(element) if element.tag == TAG_BOOLEAN => element.rest,
      _ => oid.rest,
    };
    let value = read_tagged(after_critical, TAG_OCTET_STRING)?.contents;
    if oid.contents == OID_KEY_USAGE {
      let bits = read_tagged(value, TAG_BIT_STRING)?;
      // An all-clear KeyUsage encodes as the unused-bits byte alone.
      facts.key_usage = Some(bits.contents.get(1).copied().unwrap_or(0));
    } else if oid.contents == OID_EXTENDED_KEY_USAGE {
      let mut usages = Vec::new();
      let mut entries = read_tagged(value, TAG_SEQUENCE)?.contents;
      while !entries.is_empty() {
        let usage = read_tagged(entries, TAG_OID)?;
        usages.push(usage.contents.to_vec());
        entries = usage.rest;
      }
      facts.extended_key_usages = Some(usages);
    }
  }
  Some(())
}

/// Whether the picker should offer this certificate for signing documents
/// at `now` (Unix seconds).
pub(crate) fn can_sign_documents(facts: &CertificateFacts, now: i64) -> bool {
  if now < facts.not_before || now > facts.not_after {
    return false;
  }
  if facts
    .key_usage
    .is_some_and(|bits| bits & (DIGITAL_SIGNATURE | NON_REPUDIATION) == 0)
  {
    return false;
  }
  match &facts.extended_key_usages {
    Some(usages) if !usages.is_empty() => usages
      .iter()
      .any(|usage| !NON_DOCUMENT_USAGES.contains(&usage.as_slice())),
    _ => true,
  }
}

/// `YYYY-MM-DD` for a Unix time, in UTC.
pub(crate) fn iso_date(unix_seconds: i64) -> String {
  let (year, month, day) = civil_from_days(unix_seconds.div_euclid(SECONDS_PER_DAY));
  format!("{year:04}-{month:02}-{day:02}")
}

fn issuer_name(name: &[u8]) -> Option<String> {
  let mut common_name = None;
  let mut organization = None;
  let mut sets = name;
  while !sets.is_empty() {
    let set = read_tagged(sets, TAG_SET)?;
    sets = set.rest;
    let mut attributes = set.contents;
    while !attributes.is_empty() {
      let attribute = read_tagged(attributes, TAG_SEQUENCE)?;
      attributes = attribute.rest;
      let oid = read_tagged(attribute.contents, TAG_OID)?;
      let value = read_element(oid.rest)?;
      if oid.contents == OID_COMMON_NAME {
        common_name = common_name.or_else(|| decode_string(value.tag, value.contents));
      } else if oid.contents == OID_ORGANIZATION {
        organization =
          organization.or_else(|| decode_string(value.tag, value.contents));
      }
    }
  }
  common_name
    .or(organization)
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn decode_string(tag: u8, contents: &[u8]) -> Option<String> {
  match tag {
    TAG_UTF8_STRING | TAG_PRINTABLE_STRING | TAG_IA5_STRING => {
      String::from_utf8(contents.to_vec()).ok()
    }
    // T61 is in practice Latin-1 when it appears at all.
    TAG_T61_STRING => Some(contents.iter().map(|byte| char::from(*byte)).collect()),
    TAG_BMP_STRING => {
      if !contents.len().is_multiple_of(2) {
        return None;
      }
      let units: Vec<u16> = contents
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
      String::from_utf16(&units).ok()
    }
    _ => None,
  }
}

/// UTCTime (`YYMMDDHHMMSSZ`, RFC 5280 years 1950-2049) or GeneralizedTime
/// (`YYYYMMDDHHMMSSZ`), as Unix seconds.
fn parse_time(tag: u8, contents: &[u8]) -> Option<i64> {
  let text = std::str::from_utf8(contents).ok()?;
  let digits = text.strip_suffix('Z')?;
  if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
    return None;
  }
  let (year, rest) = match (tag, digits.len()) {
    (TAG_UTC_TIME, 12) => {
      let short: i64 = digits.get(..2)?.parse().ok()?;
      (
        if short < 50 {
          2000 + short
        } else {
          1900 + short
        },
        digits.get(2..)?,
      )
    }
    (TAG_GENERALIZED_TIME, 14) => (digits.get(..4)?.parse().ok()?, digits.get(4..)?),
    _ => return None,
  };
  let field =
    |range: std::ops::Range<usize>| -> Option<i64> { rest.get(range)?.parse().ok() };
  let (month, day) = (field(0..2)?, field(2..4)?);
  let (hour, minute, second) = (field(4..6)?, field(6..8)?, field(8..10)?);
  if !(1..=12).contains(&month)
    || !(1..=31).contains(&day)
    || hour > 23
    || minute > 59
    || second > 60
  {
    return None;
  }
  Some(
    days_from_civil(year, month, day) * SECONDS_PER_DAY
      + hour * 3600
      + minute * 60
      + second,
  )
}

/// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let year = if month <= 2 { year - 1 } else { year };
  let era = year.div_euclid(400);
  let year_of_era = year - era * 400;
  let shifted_month = (month + 9) % 12;
  let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
  let day_of_era =
    year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  era * 146_097 + day_of_era - 719_468
}

/// The inverse of [`days_from_civil`].
fn civil_from_days(days: i64) -> (i64, i64, i64) {
  let shifted = days + 719_468;
  let era = shifted.div_euclid(146_097);
  let day_of_era = shifted - era * 146_097;
  let year_of_era =
    (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
  let day_of_year =
    day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let shifted_month = (5 * day_of_year + 2) / 153;
  let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
  let month = if shifted_month < 10 {
    shifted_month + 3
  } else {
    shifted_month - 9
  };
  let year = year_of_era + era * 400 + i64::from(month <= 2);
  (year, month, day)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Issued by "Test Issuing CA", valid 2025-01-01 to 2055-06-30 12:00 UTC
  /// (a GeneralizedTime, since it is past 2049), keyUsage
  /// digitalSignature + nonRepudiation, extKeyUsage emailProtection.
  const SIGNING: &[u8] = include_bytes!("../fixtures/signing-certificate.der");
  const CODE_SIGNING: &[u8] =
    include_bytes!("../fixtures/code-signing-certificate.der");
  const ENCIPHERMENT: &[u8] =
    include_bytes!("../fixtures/encipherment-certificate.der");
  const VPN: &[u8] = include_bytes!("../fixtures/vpn-certificate.der");
  const CLIENT_AUTH: &[u8] = include_bytes!("../fixtures/client-auth-certificate.der");
  /// Self-signed, no extensions, valid for one day from 2026-09-21 18:19:52.
  const NO_EXTENSIONS: &[u8] = include_bytes!("../fixtures/rsa-certificate.der");

  /// 2026-06-01T00:00:00Z.
  const NOW: i64 = 1_780_272_000;

  #[test]
  fn reads_the_validity_window_across_both_time_encodings() {
    let facts = certificate_facts(SIGNING).unwrap();

    assert_eq!(iso_date(facts.not_before), "2025-01-01");
    assert_eq!(facts.not_before, 1_735_689_600);
    assert_eq!(iso_date(facts.not_after), "2055-06-30");
    assert_eq!(facts.not_after, 2_697_969_600);
  }

  #[test]
  fn names_the_issuer_by_its_common_name() {
    assert_eq!(
      certificate_facts(SIGNING).unwrap().issuer_name.as_deref(),
      Some("Test Issuing CA")
    );
  }

  #[test]
  fn offers_a_document_signing_certificate_only_inside_its_validity() {
    let facts = certificate_facts(SIGNING).unwrap();

    assert!(can_sign_documents(&facts, NOW));
    assert!(!can_sign_documents(&facts, facts.not_before - 1));
    assert!(!can_sign_documents(&facts, facts.not_after + 1));
  }

  #[test]
  fn leaves_out_certificates_made_for_something_else() {
    for certificate in [CODE_SIGNING, ENCIPHERMENT, VPN] {
      let facts = certificate_facts(certificate).unwrap();
      assert!(!can_sign_documents(&facts, NOW), "{facts:?}");
    }
  }

  #[test]
  fn keeps_certificates_whose_usages_do_not_rule_out_documents() {
    // Client authentication often rides along on personal certificates.
    assert!(can_sign_documents(
      &certificate_facts(CLIENT_AUTH).unwrap(),
      NOW
    ));
    // No KeyUsage and no extKeyUsage: unconstrained.
    let unconstrained = certificate_facts(NO_EXTENSIONS).unwrap();
    assert!(can_sign_documents(&unconstrained, unconstrained.not_before));
  }

  #[test]
  fn refuses_input_that_is_not_a_certificate() {
    for input in [b"".as_slice(), b"not der", &[TAG_SEQUENCE, 0x00]] {
      assert_eq!(certificate_facts(input), None);
    }
    for end in 0..SIGNING.len() {
      // Truncation may still yield facts only if every field was read;
      // either way nothing panics or reads past the buffer.
      let _ = certificate_facts(&SIGNING[..end]);
    }
  }

  #[test]
  fn round_trips_civil_dates() {
    for days in [-719_468, -1, 0, 1, 10_957, 20_000, 31_000, 2_932_896] {
      let (year, month, day) = civil_from_days(days);
      assert_eq!(days_from_civil(year, month, day), days);
    }
    assert_eq!(iso_date(0), "1970-01-01");
    assert_eq!(iso_date(951_782_400), "2000-02-29");
  }
}
