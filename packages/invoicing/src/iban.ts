import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "./errors";

// Lengths follow Swift IBAN Registry release 103 (September 2026):
// https://www.swift.com/swift-resource/9606/download
// Unknown country prefixes are rejected because a generic 15–34 character
// check accepts malformed IBANs.
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BI: 27,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DJ: 27,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FK: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HN: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MN: 20,
  MR: 27,
  MT: 31,
  MU: 30,
  NI: 32,
  NL: 18,
  NO: 15,
  OM: 23,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SD: 18,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  SO: 23,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
  YE: 30,
} as const;

const IBAN_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]+$/u;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Removes whitespace, uppercases, and validates country length and MOD 97. */
export const parseIban = (value: string): InvoicingResult<string> => {
  const normalized = value.replaceAll(/\s/gu, "").toUpperCase();
  if (!IBAN_PATTERN.test(normalized)) {
    return invalidInput(
      "IBAN must use the standard country and check digit format",
    );
  }

  const country = normalized.slice(0, 2);
  if (
    !(country in IBAN_LENGTHS) ||
    normalized.length !== IBAN_LENGTHS[country]
  ) {
    return invalidInput("IBAN length does not match its country");
  }

  const rearranged = `${normalized.slice(4)}${normalized.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/u.test(character)
      ? character
      : String(ALPHABET.indexOf(character) + 10);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  if (remainder !== 1) {
    return invalidInput("IBAN checksum is invalid");
  }

  return Result.ok(normalized);
};

/** Returns the canonical IBAN, or null when format, country length, or checksum is invalid. */
export const normalizeIban = (value: string): string | null => {
  const parsed = parseIban(value);
  return parsed.isOk() ? parsed.value : null;
};
