// EU VAT identification numbers.
//
// Each member state defines its own VAT format. This module covers the
// FORMAT check (length + character class) for every current EU member
// state plus the special cases below. Per-country checksum algorithms
// (MOD-11, MOD-97, Luhn variants, etc.) are NOT implemented here — VIES
// itself performs the authoritative check upstream, and adding per-country
// checksums is queued as a separate follow-up (see README note).
//
// Special prefixes:
//   - EL: Greece (ISO 3166 says GR; the EU VAT register uses EL).
//   - XI: Northern Ireland — post-Brexit, NI VATs are validated by
//     VIES under the XI prefix.
//   - GB: removed from VIES on 2021-01-01 after Brexit. Retained here
//     with `removed: true` so the dispatch layer can produce a useful
//     error rather than a generic "unknown country" reject.
//
// Reference:
//   https://taxation-customs.ec.europa.eu/online-services/online-services-and-databases-taxation/vies-vat-information-exchange-system_en

export type VatFormatRule = {
  /** Regex against the national digits (NO country prefix). */
  pattern: RegExp;
  /** True iff the country no longer participates in VIES. */
  removed?: boolean;
};

// Patterns drawn from the EU's published format list. The match runs
// against the national portion only — the dispatch layer splits off
// the leading 2-letter prefix before looking the country up.
export const VAT_FORMAT_RULES: Readonly<Record<string, VatFormatRule>> = {
  AT: { pattern: /^U\d{8}$/u },
  BE: { pattern: /^[01]\d{9}$/u },
  BG: { pattern: /^\d{9,10}$/u },
  CY: { pattern: /^\d{8}[A-Z]$/u },
  CZ: { pattern: /^\d{8,10}$/u },
  DE: { pattern: /^\d{9}$/u },
  DK: { pattern: /^\d{8}$/u },
  EE: { pattern: /^\d{9}$/u },
  EL: { pattern: /^\d{9}$/u },
  ES: { pattern: /^[A-Z0-9]\d{7}[A-Z0-9]$/u },
  FI: { pattern: /^\d{8}$/u },
  FR: { pattern: /^[A-HJ-NP-Z0-9]{2}\d{9}$/u },
  HR: { pattern: /^\d{11}$/u },
  HU: { pattern: /^\d{8}$/u },
  // Ireland: legacy 8-char `\d[A-Z0-9*+]\d{5}[A-W]` plus the
  // 7-digit-then-letter format that Revenue issues at either 8 or 9
  // chars (the trailing letter is optional). Without the `?`, the
  // second alternative rejects every 8-char number that doesn't
  // happen to overlap with the first.
  IE: { pattern: /^(?:\d[A-Z0-9*+]\d{5}[A-W]|\d{7}[A-W][A-I]?)$/u },
  IT: { pattern: /^\d{11}$/u },
  LT: { pattern: /^(?:\d{9}|\d{12})$/u },
  LU: { pattern: /^\d{8}$/u },
  LV: { pattern: /^\d{11}$/u },
  MT: { pattern: /^\d{8}$/u },
  // Netherlands: 9 digits, the literal `B`, then 2 digits
  // (e.g. `123456789B01`). The Belastingdienst's published format is
  // strict — the `B` separator is mandatory and not an arbitrary
  // alphanumeric, so the catch-all `{10}` pattern would have leaked
  // malformed inputs to VIES.
  NL: { pattern: /^\d{9}B\d{2}$/u },
  PL: { pattern: /^\d{10}$/u },
  PT: { pattern: /^\d{9}$/u },
  RO: { pattern: /^\d{2,10}$/u },
  SE: { pattern: /^\d{12}$/u },
  SI: { pattern: /^\d{8}$/u },
  SK: { pattern: /^\d{10}$/u },
  XI: { pattern: /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/u },
  // Removed from VIES on 2021-01-01 (Brexit). Pattern retained for
  // diagnostic messages; the dispatch layer rejects with a dedicated
  // "GB no longer in VIES" error before reaching the upstream call.
  GB: { pattern: /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/u, removed: true },
} as const;

const COUNTRY_PREFIXES = Object.freeze(Object.keys(VAT_FORMAT_RULES));

/**
 * Strip spaces, dots, dashes, then uppercase. VAT numbers are
 * frequently quoted with thousand-separator dots or hyphens, e.g.
 * "DE 143.593.636" or "FR 12-345678901".
 */
export const normalizeVatNumber = (input: string): string =>
  input.replaceAll(/[\s.\-/]/gu, "").toUpperCase();

export type ParsedVatNumber = {
  country: string;
  vat: string;
};

/**
 * Split a VAT string into `{country, vat}`. Returns `null` if the input
 * does not start with two letters followed by at least one VAT character.
 */
export const parseVatNumber = (input: string): ParsedVatNumber | null => {
  const compact = normalizeVatNumber(input);
  const match = /^([A-Z]{2})([A-Z0-9+*]+)$/u.exec(compact);
  if (!match) {
    return null;
  }
  const [, country, vat] = match;
  if (country === undefined || vat === undefined) {
    return null;
  }
  return { country, vat };
};

/**
 * Whether `prefix` is a 2-letter code we have a VAT format rule for.
 */
export const isKnownVatCountry = (prefix: string): boolean =>
  Object.hasOwn(VAT_FORMAT_RULES, prefix);

/**
 * Whether the country still participates in VIES (GB does not).
 */
export const isViesParticipant = (prefix: string): boolean => {
  const rule = VAT_FORMAT_RULES[prefix];
  return rule !== undefined && rule.removed !== true;
};

/**
 * Format-only validity check for a VAT number string.
 *
 * Returns `false` for unknown country prefixes, removed-from-VIES
 * prefixes (GB), and inputs that fail the per-country format rule.
 * Does NOT perform per-country checksum validation — VIES does that
 * upstream and is the source of truth for whether a number is
 * actually registered.
 */
export const validateVatFormat = (input: string): boolean => {
  const parsed = parseVatNumber(input);
  if (!parsed) {
    return false;
  }
  if (!isViesParticipant(parsed.country)) {
    return false;
  }
  const rule = VAT_FORMAT_RULES[parsed.country];
  if (!rule) {
    return false;
  }
  return rule.pattern.test(parsed.vat);
};

/**
 * All country prefixes the validator knows about (including GB,
 * which is marked `removed`). Exposed so callers can build picklists
 * or surface "supported countries" UI.
 */
export const knownVatCountries = (): readonly string[] => COUNTRY_PREFIXES;
