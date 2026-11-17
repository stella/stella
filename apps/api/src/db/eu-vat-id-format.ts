/**
 * The syntax of EU VAT identification numbers, with no dependency beyond the
 * language: the schema's check, the online repair behind it and invoicing all
 * read the one format map here.
 */

/** A United Kingdom VAT number, also behind the Northern Ireland XI prefix. */
export const UK_VAT_NUMBER = /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/u;

/**
 * The number part of each member state's VAT ID, as the VIES service checks
 * its syntax. Only a well-formed VAT ID removes VAT by reverse charge; a
 * prefix with arbitrary characters behind it ("DEAB") does not.
 */
export const EU_VAT_ID_FORMATS: ReadonlyMap<string, RegExp> = new Map([
  ["AT", /^U\d{8}$/u],
  ["BE", /^[01]\d{9}$/u],
  ["BG", /^\d{9,10}$/u],
  ["CY", /^\d{8}[A-Z]$/u],
  ["CZ", /^\d{8,10}$/u],
  ["DE", /^\d{9}$/u],
  ["DK", /^\d{8}$/u],
  ["EE", /^\d{9}$/u],
  ["EL", /^\d{9}$/u],
  ["ES", /^[0-9A-Z]\d{7}[0-9A-Z]$/u],
  ["FI", /^\d{8}$/u],
  ["FR", /^[0-9A-HJ-NP-Z]{2}\d{9}$/u],
  ["HR", /^\d{11}$/u],
  ["HU", /^\d{8}$/u],
  ["IE", /^(?:\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/u],
  ["IT", /^\d{11}$/u],
  ["LT", /^(?:\d{9}|\d{12})$/u],
  ["LU", /^\d{8}$/u],
  ["LV", /^\d{11}$/u],
  ["MT", /^\d{8}$/u],
  ["NL", /^\d{9}B\d{2}$/u],
  ["PL", /^\d{10}$/u],
  ["PT", /^\d{9}$/u],
  ["RO", /^\d{2,10}$/u],
  ["SE", /^\d{12}$/u],
  ["SI", /^\d{8}$/u],
  ["SK", /^\d{10}$/u],
  ["XI", UK_VAT_NUMBER],
]);

/**
 * `isWellFormedEuVatId` (invoice-prefill.logic.ts) as a PostgreSQL regular expression over the same
 * compacted value (`EU_VAT_ID_SQL_COMPACT`), derived from the one format map
 * so the repair that moves stored rows cannot drift from the rule.
 */
export const EU_VAT_ID_SQL_PATTERN = `^(?:${[...EU_VAT_ID_FORMATS]
  .map(
    ([prefix, format]) =>
      `${prefix}(?:${format.source.replace(/^\^/u, "").replace(/\$$/u, "")})`,
  )
  .join("|")})$`;

/** `compactVatId` in SQL, for a column named by `column`. */
export const EU_VAT_ID_SQL_COMPACT = (column: string) =>
  `upper(regexp_replace(${column}, '[[:space:].-]', '', 'g'))`;
