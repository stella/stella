export const BRREG_IDENTIFIER_SPACED_TOKEN = "registry number spaced" as const;

const NINE_DIGITS_RE = /^\d{9}$/u;

/** Norwegian practice groups the nine-digit organisasjonsnummer as
 *  "ddd ddd ddd" — the grouping Brønnøysundregistrene prints itself.
 *  Anything else (already grouped, foreign, malformed) is returned untouched,
 *  which also makes the grouping idempotent.
 *
 *  https://www.brreg.no/om-oss/oppgavene-vare/alle-registrene-vare/om-enhetsregisteret/organisasjonsnummeret/ */
export const formatBrregIdentifierSpaced = (identifier: string): string =>
  NINE_DIGITS_RE.test(identifier)
    ? `${identifier.slice(0, 3)} ${identifier.slice(3, 6)} ${identifier.slice(6)}`
    : identifier;
