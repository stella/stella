/**
 * What a case-law box entry asks for: a decision by its identifier (a docket
 * number in one of the grammars the corpus's courts use, or an ECLI), or words
 * to search the text by. Anything the grammars do not claim is text, verbatim.
 */
export type DecisionQueryIntent =
  | { type: "empty" }
  | { type: "identifier"; kind: "docket" | "ecli"; value: string }
  | { type: "text"; text: string };

/**
 * The comparison form of an entry: compatibility-normalised (full-width
 * digits, no-break spaces), every dash the publishers use folded to a hyphen
 * (`C‑131/12` is typed with U+2011 on the Curia site), whitespace runs
 * collapsed to one space.
 */
export const foldDecisionQuery = (raw: string): string =>
  raw
    .normalize("NFKC")
    .replace(/[‐-―−]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();

const ECLI_RE = /^ecli:[a-z]{2}:[a-z0-9]{1,12}:\d{4}:[a-z0-9.]{1,64}$/iu;

// The docket grammars run on folded text, where every whitespace run is one
// space, so they spell spaces literally instead of with `\s*` runs: adjacent
// unbounded quantifiers are what makes a regex backtrack super-linearly.
//
// Czech: senate, registry, ordinal/year (`22 Cdo 2653/2012`, `29 NSČR
// 55/2013`, `1 As 12/2020`, `65 A 3/2025`); the Constitutional Court leads
// with a plenary or senate numeral (`Pl. ÚS 1/20`, `IV. ÚS 23/05`); a
// trailing `-28` is the sheet number of the paper file.
const CZ_DOCKET_RE =
  /^(?:(?:pl|i|ii|iii|iv)\.? ?)?(?:\d{1,3} ?)?\p{L}{1,7}\.? \d{1,6}\/\d{2}(?:\d{2})?(?:-\d{1,4})?$/iu;
// Slovak: senate and registry glued, then ordinal/year, with or without the
// slash the publisher prints after the registry (`1Cdo/12/2020`, `4Sžf 12/2019`).
const SK_DOCKET_RE = /^\d{1,3} ?\p{L}{1,7}(?: ?\/ ?| )\d{1,6}\/\d{4}$/iu;
// Polish: chamber numeral, registry, ordinal/year (`II CSK 123/19`, `III AKa 198/23`).
const PL_DOCKET_RE = /^[ivx]{1,5} \p{L}{1,5} \d{1,6}\/\d{2}(?:\d{2})?$/iu;
// CJEU: court letter, ordinal/year, optional appeal marker, optionally led by
// the word for "case" in the languages the corpus holds.
const EU_DOCKET_RE =
  /^(?:(?:case|vec|věc|sprawa|affaire|rechtssache|causa|asunto) )?[ctf]-\d{1,4}\/\d{2}(?: p)?$/iu;
// Austria: the Supreme Court's senate, registry, ordinal/year and check letter
// (`5Ob200/20x`, `6 Ob 123/21k`); the administrative court's registry and
// year/serial (`Ra 2020/01/0001`); the constitutional court's registry and
// ordinal/year (`G 1/2020`, `E 123/2019-12`); the tax court's registry path
// (`RV/7500368/2026`).
const AT_OGH_DOCKET_RE = /^\d{1,3} ?[a-z]{1,4} ?\d{1,5}\/\d{2}[a-z]$/iu;
const AT_VWGH_DOCKET_RE = /^r[aow] ?\d{4}\/\d{2}\/\d{4}$/iu;
const AT_VFGH_DOCKET_RE = /^[a-z]{1,2} ?\d{1,4}\/\d{4}(?:-\d{1,3})?$/iu;
const AT_FINDOK_DOCKET_RE = /^[a-z]{1,3}\/\d{1,8}\/\d{4}$/iu;

const DOCKET_GRAMMARS = [
  CZ_DOCKET_RE,
  SK_DOCKET_RE,
  PL_DOCKET_RE,
  EU_DOCKET_RE,
  AT_OGH_DOCKET_RE,
  AT_VWGH_DOCKET_RE,
  AT_VFGH_DOCKET_RE,
  AT_FINDOK_DOCKET_RE,
] as const;

export const parseDecisionQuery = (raw: string): DecisionQueryIntent => {
  const text = raw.trim();
  if (text.length === 0) {
    return { type: "empty" };
  }
  const folded = foldDecisionQuery(text);
  if (ECLI_RE.test(folded)) {
    return { type: "identifier", kind: "ecli", value: folded };
  }
  if (DOCKET_GRAMMARS.some((grammar) => grammar.test(folded))) {
    return { type: "identifier", kind: "docket", value: folded };
  }
  return { type: "text", text };
};

/**
 * The identity of a docket or ECLI as publishers vary it: case, spacing and
 * dash style are theirs, not the docket's, and the sheet number names a page
 * of the file rather than the decision.
 */
const compactIdentifier = (value: string): string =>
  foldDecisionQuery(value)
    .toLowerCase()
    .replace(/-\d{1,4}$/u, "")
    .replaceAll(" ", "");

type DecisionHitIdentity = {
  caseNumber: string;
  ecli: string | null;
  /** Every identifier the publisher supplied, parallel case numbers included. */
  identifiers?: readonly { value: string }[] | undefined;
};

/**
 * The hits that are the decision the entry named, not merely ones that
 * mention it: by case number, ECLI, or any other identifier the publisher
 * supplied (a second docket, a reporter citation). Several are the same
 * docket at several courts, which the reader must choose between; the caller
 * never picks one for them.
 */
export const exactDecisionMatches = <THit extends DecisionHitIdentity>(
  identifier: string,
  hits: readonly THit[],
): THit[] => {
  const wanted = compactIdentifier(identifier);
  return hits.filter(
    (hit) =>
      compactIdentifier(hit.caseNumber) === wanted ||
      (hit.ecli !== null && compactIdentifier(hit.ecli) === wanted) ||
      hit.identifiers?.some(
        ({ value }) => compactIdentifier(value) === wanted,
      ) === true,
  );
};
