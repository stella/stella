//! Which vendor's card is in a reader, read from the card's ATR (Answer To
//! Reset), so a card no installed driver reads can be named along with the
//! driver it needs.
//!
//! A card announces itself with its ATR as soon as it is powered, before any
//! driver talks to it. Cards of one family share most of it; the bytes that
//! vary (a version, a checksum, a timing parameter) are masked out. Only ATRs
//! that identify one vendor's middleware are listed: a family several
//! issuers share (the Italian CNS cards, the Gemalto IDPrime prefix) would
//! name the wrong driver.
//!
//! Sources: the published ATR lists of the card issuers where there is one
//! (the DNIe ATR specification), and the pcsc-tools `smartcard_list.txt`
//! (Ludovic Rousseau's ATR database).

/// One family of cards: an ATR is theirs when it has the pattern's length
/// and agrees with it on every bit the mask sets.
#[derive(Debug)]
pub struct AtrPattern {
  /// The [`crate::drivers::KnownDriver::id`] the cards need.
  pub driver_id: &'static str,
  pub pattern: &'static [u8],
  pub mask: &'static [u8],
}

impl AtrPattern {
  #[must_use]
  pub fn matches(&self, atr: &[u8]) -> bool {
    atr.len() == self.pattern.len()
      && atr
        .iter()
        .zip(self.pattern)
        .zip(self.mask)
        .all(|((byte, expected), mask)| byte & mask == expected & mask)
  }
}

const ALL: u8 = 0xFF;
const ANY: u8 = 0x00;

pub const KNOWN_ATRS: &[AtrPattern] = &[
  // I.CA Starcos cards ("XICA V2.0", "XICA V4.0"): the version digits and
  // the checksum vary.
  AtrPattern {
    driver_id: "ica-securestore",
    pattern: &[
      0x3B, 0xDA, 0x96, 0xFF, 0x81, 0xB1, 0xFE, 0x45, 0x1F, 0x07, 0x80, 0x58, 0x49,
      0x43, 0x41, 0x20, 0x56, 0x32, 0x2E, 0x30, 0xE9,
    ],
    mask: &[
      ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL,
      ALL, ANY, ANY, ANY, ANY,
    ],
  },
  // eObčanka, both generations.
  AtrPattern {
    driver_id: "cz-eop",
    pattern: &[
      0x3B, 0x7E, 0x94, 0x00, 0x00, 0x80, 0x25, 0xD2, 0x03, 0x10, 0x01, 0x00, 0x56,
      0x00, 0x00, 0x00, 0x02, 0x02, 0x00,
    ],
    mask: &[
      ALL, ALL, ALL, ALL, ALL, ALL, ALL, ANY, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL,
      ANY, ANY, ALL,
    ],
  },
  // Slovak eID card, contact interface: TA1 and the checksum vary.
  AtrPattern {
    driver_id: "sk-eid",
    pattern: &[
      0x3B, 0xDF, 0x96, 0xFF, 0x81, 0xB1, 0xFE, 0x45, 0x1F, 0x87, 0x00, 0x31, 0xB9,
      0x64, 0x09, 0x37, 0x72, 0x13, 0x73, 0x84, 0x01, 0xE0, 0x00, 0x00, 0x00, 0x00,
    ],
    mask: &[
      ALL, ALL, ANY, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL,
      ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ANY,
    ],
  },
  // DNIe 3.0 and later in normal use: TA1 and the six bytes after "DNIe"
  // vary; the status ends 03 90 00. OpenSC reads these cards.
  AtrPattern {
    driver_id: "opensc",
    pattern: &[
      0x3B, 0x7F, 0x00, 0x00, 0x00, 0x00, 0x6A, 0x44, 0x4E, 0x49, 0x65, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x03, 0x90, 0x00,
    ],
    mask: &[
      ALL, ALL, ANY, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ALL, ANY, ANY, ANY, ANY, ANY,
      ANY, ALL, ALL, ALL,
    ],
  },
  // SafeNet eToken 5110+ FIPS.
  AtrPattern {
    driver_id: "thales-safenet",
    pattern: &[
      0x3B, 0xFF, 0x96, 0x00, 0x00, 0x81, 0x31, 0xFE, 0x43, 0x80, 0x31, 0x80, 0x65,
      0xB0, 0x84, 0x65, 0x66, 0xFB, 0x12, 0x01, 0x78, 0x82, 0x90, 0x00, 0x85,
    ],
    mask: &[ALL; 25],
  },
  // SafeNet eToken 5110 for eSignature.
  AtrPattern {
    driver_id: "thales-safenet",
    pattern: &[
      0x3B, 0xFF, 0x96, 0x00, 0x00, 0x81, 0x31, 0xFE, 0x43, 0x80, 0x31, 0x80, 0x65,
      0xB0, 0x85, 0x59, 0x56, 0xFB, 0x12, 0x01, 0x78, 0x82, 0x90, 0x00, 0x88,
    ],
    mask: &[ALL; 25],
  },
  // Bit4id TokenMe.
  AtrPattern {
    driver_id: "bit4id",
    pattern: &[
      0x3B, 0x9F, 0x11, 0x81, 0x31, 0xFE, 0x9F, 0x00, 0x6B, 0x42, 0x49, 0x54, 0x34,
      0x49, 0x44, 0x20, 0x33, 0x2E, 0x30, 0x00, 0x90, 0x00, 0xCF,
    ],
    mask: &[ALL; 23],
  },
];

/// The driver a card with this ATR needs, if the table knows the card.
#[must_use]
pub fn driver_for_atr(atr: &[u8]) -> Option<&'static str> {
  KNOWN_ATRS
    .iter()
    .find(|pattern| pattern.matches(atr))
    .map(|pattern| pattern.driver_id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::drivers::known_driver;

  fn atr(hex: &str) -> Vec<u8> {
    hex::decode(hex).unwrap()
  }

  #[test]
  fn names_the_driver_for_known_cards() {
    for (card, driver) in [
      // I.CA, both published versions.
      (
        "3BDA96FF81B1FE451F0780584943412056322E30E9",
        "ica-securestore",
      ),
      (
        "3BDA96FF81B1FE451F0780584943412056342E30EF",
        "ica-securestore",
      ),
      // eObčanka, issued since 7/2018 and before.
      ("3B7E9400008025D20310010056000000020200", "cz-eop"),
      ("3B7E9400008025D20310010056000000010100", "cz-eop"),
      // Slovak eID, contact and dual interface.
      (
        "3BDF96FF81B1FE451F870031B96409377213738401E000000000",
        "sk-eid",
      ),
      (
        "3BDF18FF81B1FE451F870031B96409377213738401E00000008E",
        "sk-eid",
      ),
      // DNIe 3.0, two published ATRs.
      ("3B7F960000006A444E496520010155041003 9000", "opensc"),
      ("3B7F380000006A444E496510024C340113039000", "opensc"),
      (
        "3BFF9600008131FE4380318065B0846566FB12017882900085",
        "thales-safenet",
      ),
      ("3B9F118131FE9F006B42495434494420332E30009000CF", "bit4id"),
    ] {
      let bytes = atr(&card.replace(' ', ""));
      assert_eq!(driver_for_atr(&bytes), Some(driver), "{card}");
    }
  }

  #[test]
  fn leaves_unknown_and_shared_families_alone() {
    for card in [
      // Gemalto IDPrime prefix, shared by several national eIDs.
      "3B7F96000080318065B0855956FB120FFE829000",
      // A terminated DNIe ends 0F 65 81, not 03 90 00.
      "3B7F960000006A444E49652001015504100F6581",
      // Truncated I.CA ATR.
      "3BDA96FF81B1FE451F07805849434120",
      "",
    ] {
      assert_eq!(driver_for_atr(&atr(card)), None, "{card}");
    }
  }

  #[test]
  fn every_pattern_names_a_known_driver_and_fits_its_mask() {
    for pattern in KNOWN_ATRS {
      assert!(
        known_driver(pattern.driver_id).is_some(),
        "{}",
        pattern.driver_id
      );
      assert_eq!(
        pattern.pattern.len(),
        pattern.mask.len(),
        "{}",
        pattern.driver_id
      );
      assert!(pattern.matches(pattern.pattern));
    }
  }
}
