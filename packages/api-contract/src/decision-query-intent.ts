import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

import {
  canonicalDecisionIdentifierKey,
  DECISION_DOCKET_GRAMMARS,
  foldDecisionIdentifierInput,
} from "./decision-docket-grammar";
import type {
  DecisionDocketGrammar,
  DecisionDocketJurisdiction,
} from "./decision-docket-grammar";
import {
  DECISION_DOCKETS_STORED_WITH_SHEETS,
  formatDecisionDocketReference,
  readDecisionDocketReference,
  trimDecisionReferenceEdges,
} from "./decision-docket-reference";
import type {
  DecisionDocketReference,
  DecisionDocketSelector,
} from "./decision-docket-reference";

/**
 * Where an identifier sat in the entry. Absent when the entry was the
 * reference alone (a citation prefix and surrounding punctuation included);
 * otherwise the entry as typed, whose other words still describe a text
 * search should the reference name nothing.
 */
type EmbeddedIn = { embeddedIn?: string };

/**
 * A decision named by its identifier. A docket carries the jurisdiction whose
 * grammar read it, because only that grammar keys its spellings alike: the
 * Czech and Slovak grammars both read `II. ÚS 55/98` and key it differently,
 * and only the Slovak one reads `II.ÚS55/98`.
 *
 * A docket names a case file (`family`), which can hold several decisions,
 * and the `selector` is what the reference printed to single one of them
 * out. `value` spells both and reads back as the same intent.
 */
export type DecisionIdentifierIntent =
  | ({
      type: "identifier";
      kind: "docket";
      jurisdiction: DecisionDocketJurisdiction;
      value: string;
      family: string;
      selector: DecisionDocketSelector;
    } & EmbeddedIn)
  | ({ type: "identifier"; kind: "ecli"; value: string } & EmbeddedIn)
  | { type: "identifier"; kind: "reporter" | "neutral"; value: string };

/**
 * A jurisdiction's reporter citation grammar, supplied by the caller the way
 * a docket grammar is. Injected rather than imported: its edition table is
 * data only the jurisdictions that cite reporters need, so a reader of any
 * other corpus never loads it.
 */
export type DecisionReporterGrammar = {
  /**
   * The canonical identity a whole entry names as a reporter citation, or null
   * when it is not one or does not settle on one reporter.
   */
  readonly canonicalCitation: (text: string) => string | null;
};

/**
 * The kinds of reference that name a decision outright. A neutral citation is
 * never inferred from free text: no grammar declares one, and a catch-all
 * pattern would claim ordinary words, so it only arrives typed explicitly.
 */
export type DecisionIdentifierKind = "docket" | "ecli" | "reporter" | "neutral";

/**
 * What a case-law box entry asks for: a decision by its identifier (a docket
 * number in one of the grammars the corpus's courts use, an ECLI, or a
 * reporter citation), or words to search the text by. Anything the grammars
 * do not claim is text, verbatim.
 */
export type DecisionQueryIntent =
  | { type: "empty" }
  | DecisionIdentifierIntent
  | { type: "text"; text: string };

const ECLI_RE = /^ecli:[a-z]{2}:[a-z0-9]{1,12}:\d{4}:[a-z0-9.]{1,64}$/iu;

type ParseDecisionQueryOptions = {
  readonly grammar?: DecisionDocketGrammar | null | undefined;
  /**
   * The reporter grammar of the jurisdiction the entry is read in. Without
   * one, an entry reads as it always did: no reporter citation is claimed.
   */
  readonly reporters?: DecisionReporterGrammar | null | undefined;
};

const docketIntentOf = (
  reference: DecisionDocketReference,
): Extract<DecisionIdentifierIntent, { kind: "docket" }> => ({
  type: "identifier",
  kind: "docket",
  jurisdiction: reference.family.jurisdiction,
  value: formatDecisionDocketReference(reference),
  family: reference.family.formatted,
  selector: reference.selector,
});

const ecliIntentOf = (
  text: string,
): Extract<DecisionIdentifierIntent, { kind: "ecli" }> | null => {
  // A sentence's full stop is not part of an ECLI, which never ends on one.
  const folded = trimDecisionReferenceEdges(
    foldDecisionIdentifierInput(text),
    ".",
  );
  return ECLI_RE.test(folded)
    ? { type: "identifier", kind: "ecli", value: folded }
    : null;
};

/**
 * Words an entry may carry around one reference and still be read for it.
 * Past that the entry is prose, whatever docket it quotes.
 */
const EMBEDDED_ENTRY_MAX_TOKENS = 32;

/**
 * The longest reference a window of words is read as: a two-word prefix, a
 * docket spaced into five words, and a spaced tail.
 */
const EMBEDDED_WINDOW_MAX_TOKENS = 12;

type WindowIntent = Extract<
  DecisionIdentifierIntent,
  { kind: "docket" | "ecli" }
>;

type WindowReading = {
  readonly start: number;
  readonly end: number;
  /** What two readings share when they name the same case file or ECLI. */
  readonly familyKey: string;
  readonly selector: DecisionDocketSelector;
  readonly intent: WindowIntent;
};

/**
 * Whether a part numeral a window ends on is the reference's own, given the
 * word after the window. A window stops at a word boundary, so the word that
 * follows never reaches the tail grammar: `30 Cdo 1/2020 – v němž` reads as
 * part V and `… - i když` as part I. Inside running text a part is therefore
 * read only when the numeral closes on its dot and no lower-case word runs
 * on from it, or when it is the entry's last word.
 */
const partStandsAlone = (
  lastWord: string | undefined,
  nextWord: string | undefined,
): boolean =>
  nextWord === undefined ||
  (lastWord?.endsWith(".") === true && !/^\p{Ll}/u.test(nextWord));

type WindowOptions = {
  /** The entry's words; the window is `tokens[start, end)`. */
  readonly tokens: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly grammar: DecisionDocketGrammar | null | undefined;
};

const readingOfWindow = ({
  end,
  grammar,
  start,
  tokens,
}: WindowOptions): WindowReading | null => {
  const window = tokens.slice(start, end).join(" ");
  const ecli = end - start === 1 ? ecliIntentOf(window) : null;
  if (ecli !== null) {
    return {
      start,
      end,
      familyKey: JSON.stringify(["ecli", ecli.value.toUpperCase()]),
      selector: { kind: "none" },
      intent: ecli,
    };
  }
  const read = readDecisionDocketReference(window, { grammar });
  if (read === null) {
    return null;
  }
  const docket =
    read.selector.kind === "part" &&
    !partStandsAlone(tokens[end - 1], tokens[end])
      ? { ...read, selector: { kind: "none" } as const }
      : read;
  return {
    start,
    end,
    familyKey: JSON.stringify([
      "docket",
      docket.family.jurisdiction,
      docket.family.canonical,
    ]),
    selector: docket.selector,
    intent: docketIntentOf(docket),
  };
};

/**
 * What a run of overlapping readings says: they are one stretch of the entry
 * read several ways, so they must name one file, and at most one selector
 * (`sp. zn. 6 Tdo 1/2021 - II` is read with and without its part, depending
 * on where a window stops). Null when they disagree.
 */
const readingOfRun = (run: readonly WindowReading[]): WindowReading | null => {
  const [first] = run;
  if (
    first === undefined ||
    run.some((reading) => reading.familyKey !== first.familyKey)
  ) {
    return null;
  }
  const selected = run.filter((reading) => reading.selector.kind !== "none");
  const selectors = new Set(
    selected.map((reading) => JSON.stringify(reading.selector)),
  );
  if (selectors.size > 1) {
    return null;
  }
  return selected.at(0) ?? first;
};

/**
 * The one reference an entry carries among other words, or null when it
 * carries none or several. Every window of consecutive words is read as a
 * whole entry. A reading inside a longer one is the longer one's own part (a
 * registry mark and number inside a senate's docket); readings that overlap
 * are one stretch of the entry, which names one reference only if they agree;
 * and the entry names a decision only when every stretch names the same one.
 * Choosing among two would search one of them silently.
 */
const identifierWithin = (
  text: string,
  grammar: DecisionDocketGrammar | null | undefined,
): WindowIntent | null => {
  const tokens = foldDecisionIdentifierInput(text).split(" ");
  if (tokens.length < 2 || tokens.length > EMBEDDED_ENTRY_MAX_TOKENS) {
    return null;
  }
  const readings: WindowReading[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const longest = Math.min(tokens.length, start + EMBEDDED_WINDOW_MAX_TOKENS);
    for (let end = start + 1; end <= longest; end += 1) {
      const window = tokens.slice(start, end).join(" ");
      // Every docket grammar the entry can reach writes a slash; an ECLI is a
      // single word. Anything else is not worth a grammar's time.
      if (!window.includes("/") && !/ecli:/iu.test(window)) {
        continue;
      }
      const reading = readingOfWindow({ end, grammar, start, tokens });
      if (reading !== null) {
        readings.push(reading);
      }
    }
  }
  const outermost = readings
    .filter(
      (reading) =>
        !readings.some(
          (other) =>
            other !== reading &&
            other.start <= reading.start &&
            other.end >= reading.end &&
            other.end - other.start > reading.end - reading.start,
        ),
    )
    .toSorted((a, b) => a.start - b.start || a.end - b.end);
  const runs: WindowReading[][] = [];
  let runEnd = 0;
  for (const reading of outermost) {
    const run = runs.at(-1);
    if (run !== undefined && reading.start < runEnd) {
      run.push(reading);
    } else {
      runs.push([reading]);
    }
    runEnd = Math.max(runEnd, reading.end);
  }
  const stretches: WindowReading[] = [];
  for (const run of runs) {
    const stretch = readingOfRun(run);
    if (stretch === null) {
      return null;
    }
    stretches.push(stretch);
  }
  const distinct = new Set(
    stretches.map(({ familyKey, selector }) =>
      JSON.stringify([familyKey, selector]),
    ),
  );
  const [only] = stretches;
  return distinct.size === 1 && only !== undefined ? only.intent : null;
};

export const parseDecisionQuery = (
  raw: string,
  { grammar, reporters }: ParseDecisionQueryOptions = {},
): DecisionQueryIntent => {
  const text = raw.trim();
  if (text.length === 0) {
    return { type: "empty" };
  }
  const ecli = ecliIntentOf(text);
  if (ecli !== null) {
    return ecli;
  }
  // Before the docket fallback: only a whole entry the reporter grammar
  // settles on one reporter is claimed.
  const reporter =
    reporters?.canonicalCitation(foldDecisionIdentifierInput(text)) ?? null;
  if (reporter !== null) {
    return { type: "identifier", kind: "reporter", value: reporter };
  }
  const docket = readDecisionDocketReference(text, { grammar });
  if (docket !== null) {
    return docketIntentOf(docket);
  }
  const embedded = identifierWithin(text, grammar);
  if (embedded !== null) {
    return { ...embedded, embeddedIn: text };
  }
  return { type: "text", text };
};

/**
 * Whether the entry was a reference and nothing else, so it is matched as
 * written. An identifier found among other words leaves those words a text
 * search, read like any other.
 */
export const isWholeEntryIdentifier = (
  intent: DecisionQueryIntent,
): boolean => {
  if (intent.type !== "identifier") {
    return false;
  }
  switch (intent.kind) {
    case "docket":
    case "ecli":
      return intent.embeddedIn === undefined;
    case "neutral":
    case "reporter":
      return true;
    default: {
      intent satisfies never;
      return panic(`Unhandled decision identifier: ${String(intent)}`);
    }
  }
};

/**
 * The text a search sends for an entry: the reference in its canonical
 * spelling when the entry was one, otherwise the entry as typed, so words
 * around an embedded reference still reach the text search.
 */
export const searchTextOfDecisionQuery = (
  intent: DecisionQueryIntent,
): string | undefined => {
  switch (intent.type) {
    case "empty":
      return undefined;
    case "text":
      return intent.text;
    case "identifier":
      return (
        ("embeddedIn" in intent ? intent.embeddedIn : undefined) ?? intent.value
      );
    default: {
      intent satisfies never;
      return panic(`Unhandled decision query intent: ${String(intent)}`);
    }
  }
};

/**
 * The case file a docket or ECLI spelling names, as publishers vary it: case,
 * spacing and dash style are theirs, not the docket's, and neither a sheet
 * number nor a part numeral changes the file. A docket is read by the grammar
 * that read the entry, so the entry and every stored spelling of it key
 * alike.
 */
const decisionIdentifierComparisonKey = (
  value: string,
  grammar: DecisionDocketGrammar | undefined,
): string =>
  readDecisionDocketReference(value, { grammar })?.family.canonical ??
  canonicalDecisionIdentifierKey(value);

/**
 * The identity of a structured citation: case, spacing and punctuation are
 * typography. The same folding the identifier column is written with.
 */
const structuredCitationKey = (value: string): string =>
  normalizeUnicode(value, "NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{Z}\s]+/gu, "");

type TypedReferenceKind = Extract<
  DecisionIdentifierKind,
  "neutral" | "reporter"
>;

type TypedReferenceComparison = {
  identifierType: string;
  key: (value: string) => string;
};

/**
 * How a typed reference is compared: only against identifiers stored under its
 * own type, each read by that type's canonicaliser. A reporter citation is
 * read through the jurisdiction's reporter grammar first, so a variant
 * abbreviation or a pin does not change it.
 */
const typedReferenceComparison = (
  kind: TypedReferenceKind,
  reporters: DecisionReporterGrammar | null | undefined,
): TypedReferenceComparison => {
  switch (kind) {
    case "neutral":
      return { identifierType: "neutral-citation", key: structuredCitationKey };
    case "reporter":
      return {
        identifierType: "reporter-citation",
        key: (value) =>
          structuredCitationKey(reporters?.canonicalCitation(value) ?? value),
      };
    default: {
      kind satisfies never;
      return panic(`Unhandled typed reference kind: ${String(kind)}`);
    }
  }
};

type ExactDecisionMatchesOptions = {
  /** The reporter grammar the entry was read under, as `parseDecisionQuery` took it. */
  readonly reporters?: DecisionReporterGrammar | null | undefined;
};

type DecisionHitIdentity = {
  caseNumber: string;
  ecli: string | null;
  /** Every identifier the publisher supplied, parallel case numbers included. */
  identifiers?: readonly { type: string; value: string }[] | undefined;
  /** The reference as the court published it, sheet included, if recorded. */
  publishedCaseNumber?: string | null | undefined;
  /** The sheet the court published the decision on, if recorded. */
  sheetNumber?: string | null | undefined;
};

/**
 * The hits that answer to the reference: for a docket, every decision of its
 * case file (siblings, sheets and parts alike); for an ECLI, the decision
 * carrying it. A docket or an ECLI matches by case number, ECLI, or any other
 * identifier the publisher supplied (a second docket, a reporter citation). A
 * reporter or neutral citation matches only an identifier of its own type.
 *
 * Membership, not identity: several hits are a file's siblings or the same
 * reference at several courts, which `resolveDecisionIdentity` tells apart
 * from one decision. The caller never picks one of them.
 */
export const exactDecisionMatches = <THit extends DecisionHitIdentity>(
  identifier: DecisionIdentifierIntent,
  hits: readonly THit[],
  { reporters }: ExactDecisionMatchesOptions = {},
): THit[] => {
  switch (identifier.kind) {
    case "docket":
    case "ecli": {
      // A docket is keyed by the grammar that read it; an ECLI belongs to no
      // docket grammar, so it is compared unscoped.
      const grammar =
        identifier.kind === "docket"
          ? DECISION_DOCKET_GRAMMARS[identifier.jurisdiction]
          : undefined;
      const keyOf = (value: string): string =>
        decisionIdentifierComparisonKey(value, grammar);
      const wanted = keyOf(identifier.value);
      return hits.filter(
        (hit) =>
          keyOf(hit.caseNumber) === wanted ||
          (hit.ecli !== null && keyOf(hit.ecli) === wanted) ||
          hit.identifiers?.some(({ value }) => keyOf(value) === wanted) ===
            true,
      );
    }
    case "neutral":
    case "reporter": {
      const { identifierType, key } = typedReferenceComparison(
        identifier.kind,
        reporters,
      );
      const wanted = key(identifier.value);
      return hits.filter(
        (hit) =>
          hit.identifiers?.some(
            ({ type, value }) =>
              type === identifierType && key(value) === wanted,
          ) === true,
      );
    }
    default: {
      identifier satisfies never;
      return panic(
        `Unhandled decision identifier: ${JSON.stringify(identifier)}`,
      );
    }
  }
};

/**
 * What a reference resolves to among the hits that answer to it.
 *
 * - `unique`: one decision is the one named. `basis` says by what: an
 *   identifier that names a decision outright (an ECLI, a reporter
 *   citation), the sheet or part the reference printed and exactly one
 *   candidate is known to carry, or a bare docket whose file the read holds
 *   whole and finds one decision in.
 * - `ambiguous`: the reference cannot tell its candidates apart. `several`
 *   is siblings in one file, or one number at several courts;
 *   `selector_unmatched` is a sheet or part that no candidate is known to
 *   carry, so the file's decisions come back rather than one of them, even
 *   when the file shows one; for a sheet, only those whose sheet is unknown,
 *   since one known under another sheet is not the decision named.
 * - `incomplete_identifier`: a bare docket finding one
 *   decision where stored dockets can still carry their sheet
 *   (`DECISION_DOCKETS_STORED_WITH_SHEETS`), so the file may hold members the
 *   read did not reach.
 * - `none`: nothing answers to it, which includes a sheet where every
 *   candidate is known under another sheet.
 *
 * A docket, a court and a date together are still not a decision: two
 * decisions of one file can be issued on one day, so nothing here ever
 * prefers a candidate by its date or its court.
 */
export type DecisionIdentityResolution<THit> =
  | { readonly status: "none" }
  | {
      readonly status: "unique";
      readonly decision: THit;
      readonly basis: "identifier" | "selector" | "docket";
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly THit[];
      readonly reason: "several" | "selector_unmatched";
    }
  | {
      readonly status: "incomplete_identifier";
      readonly candidates: readonly THit[];
      readonly missing: readonly ["sheet"];
    };

/** A digit run as a number would read it, so `05` and `5` compare equal. */
const numeral = (digits: string): string => digits.replace(/^0+(?=\d)/u, "");

/**
 * What the segment after a file's numbers means in a court's ECLI scheme, for
 * the schemes where it is the sheet the document sits on in its file
 * (`ECLI:CZ:NSS:2010:3.AFS.41.2008.98` is sheet 98 of `3 Afs 41/2008`). Keyed
 * by the ECLI's own country and court codes. A scheme absent here appends
 * something else there (a decision's sequence number in its file, as the
 * general and constitutional courts do), which no printed sheet answers to.
 */
export const DECISION_ECLI_SHEET_SCHEMES: Readonly<Record<string, "sheet">> = {
  "CZ:NSS": "sheet",
};

/**
 * The sheet an ECLI names after the file's own numbers, or null. Read only
 * in a scheme declared to carry it (`DECISION_ECLI_SHEET_SCHEMES`), and only
 * where the ordinal's numbers end in the file's numbers followed by exactly
 * one more: an ECLI whose last number is the docket's own year carries no
 * sheet, and one of another file carries none of this one.
 */
export const ecliSheetOf = (
  ecli: string,
  familyCanonical: string,
): string | null => {
  const [, country, court] = ecli.toUpperCase().split(":");
  if (
    country === undefined ||
    court === undefined ||
    !Object.hasOwn(DECISION_ECLI_SHEET_SCHEMES, `${country}:${court}`)
  ) {
    return null;
  }
  const ordinal = ecli.split(":").slice(4).join(":");
  const segments = ordinal.split(".");
  const last = segments.at(-1);
  if (last === undefined || !/^\d+$/u.test(last)) {
    return null;
  }
  const familyNumbers = (familyCanonical.match(/\d+/gu) ?? []).map(numeral);
  const leadingNumbers = segments
    .slice(0, -1)
    .filter((segment) => /^\d+$/u.test(segment))
    .map(numeral);
  if (
    familyNumbers.length === 0 ||
    leadingNumbers.length < familyNumbers.length
  ) {
    return null;
  }
  const offset = leadingNumbers.length - familyNumbers.length;
  return familyNumbers.every(
    (number, index) => leadingNumbers[offset + index] === number,
  )
    ? numeral(last)
    : null;
};

const CASE_NUMBER_IDENTIFIER = "case-number";
const ECLI_IDENTIFIER = "ecli";

/**
 * How a sheet source's values are read: as a docket spelling of the file
 * (whose tail may be a sheet or a part), as an ECLI (whose scheme may end on
 * the sheet), or as a sheet the source stated beside a docket.
 */
export type DecisionSheetReading = "docket" | "ecli" | "stated";

/**
 * Every place a decision's sheet can be known from, and how each is read.
 * Which of these carries the sheet never changes which decision a lookup
 * (`resolveDecisionIdentity`) says a reference names. The citation
 * resolver's SQL maps this one list with a total map of its own, declaring
 * per source whether it reads it, so a source added here without a decision
 * on either side fails typecheck.
 *
 * - `case-number`: the stored docket, which keeps a sheet the row was
 *   written with (`DECISION_DOCKETS_STORED_WITH_SHEETS`).
 * - `published-case-number`: the reference as the court published it.
 * - `case-number-identifier`: a full file number a publisher supplied.
 * - `recorded-sheet`: the sheet the source's adapter split off and recorded
 *   in the decision's metadata, a sheet of the file it was split from only.
 * - `ecli`, `ecli-identifier`: an ECLI whose scheme ends on the sheet
 *   (`DECISION_ECLI_SHEET_SCHEMES`).
 */
export const DECISION_SHEET_SOURCES = [
  { source: "case-number", reading: "docket" },
  { source: "published-case-number", reading: "docket" },
  { source: "case-number-identifier", reading: "docket" },
  { source: "recorded-sheet", reading: "stated" },
  { source: "ecli", reading: "ecli" },
  { source: "ecli-identifier", reading: "ecli" },
] as const satisfies readonly {
  source: string;
  reading: DecisionSheetReading;
}[];

export type DecisionSheetSource =
  (typeof DECISION_SHEET_SOURCES)[number]["source"];

/** The longest sheet a source states on its own that is read as one. */
export const DECISION_STATED_SHEET_MAX_DIGITS = 8;

const identifierValuesOf = (hit: DecisionHitIdentity, type: string): string[] =>
  (hit.identifiers ?? [])
    .filter((identifier) => identifier.type === type)
    .map(({ value }) => value);

const HIT_SHEET_SOURCE_VALUES = {
  "case-number": (hit) => [hit.caseNumber],
  "published-case-number": (hit) =>
    hit.publishedCaseNumber ? [hit.publishedCaseNumber] : [],
  "case-number-identifier": (hit) =>
    identifierValuesOf(hit, CASE_NUMBER_IDENTIFIER),
  "recorded-sheet": (hit) => (hit.sheetNumber ? [hit.sheetNumber] : []),
  ecli: (hit) => (hit.ecli === null ? [] : [hit.ecli]),
  "ecli-identifier": (hit) => identifierValuesOf(hit, ECLI_IDENTIFIER),
} as const satisfies Record<
  DecisionSheetSource,
  (hit: DecisionHitIdentity) => readonly string[]
>;

const STATED_SHEET_RE = new RegExp(
  String.raw`^\d{1,${String(DECISION_STATED_SHEET_MAX_DIGITS)}}$`,
  "u",
);

type SheetReadingContext = {
  familyCanonical: string;
  grammar: DecisionDocketGrammar;
};

/** A docket spelling as a reference within the file, or null for another. */
const fileReferenceOf = (
  docket: string,
  { familyCanonical, grammar }: SheetReadingContext,
): DecisionDocketReference | null => {
  const reference = readDecisionDocketReference(docket, { grammar });
  return reference?.family.canonical === familyCanonical ? reference : null;
};

const SHEET_READINGS = {
  docket: (value, context) =>
    fileReferenceOf(value, context)?.selector ?? { kind: "none" },
  ecli: (value, { familyCanonical }) => {
    const sheet = ecliSheetOf(value, familyCanonical);
    return sheet === null ? { kind: "none" } : { kind: "sheet", value: sheet };
  },
  // Ingestion splits the recorded sheet off the reference as the court
  // published it and stores the docket that remains (`splitCaseReference`),
  // so it is a sheet of the stored docket's file only: a hit reached through
  // a parallel file number does not carry it here. The remainder is read
  // rather than the published reference, whose sheet the grammar may not
  // take (more than four digits) though the split did.
  stated: (value, context, { caseNumber }) => {
    const stated = value.trim();
    return STATED_SHEET_RE.test(stated) &&
      fileReferenceOf(caseNumber, context) !== null
      ? { kind: "sheet", value: numeral(stated) }
      : { kind: "none" };
  },
} as const satisfies Record<
  DecisionSheetReading,
  (
    value: string,
    context: SheetReadingContext,
    hit: DecisionHitIdentity,
  ) => DecisionDocketSelector
>;

type CarriedSelectors = { sheets: Set<string>; parts: Set<string> };

/**
 * Every selector a hit is known to carry within the file, read from each of
 * `DECISION_SHEET_SOURCES` in `sources` (all of them when absent). A docket
 * spelling of another file carries none of this one's.
 */
const selectorsOfHit = (
  hit: DecisionHitIdentity,
  context: SheetReadingContext,
  sources: ReadonlySet<DecisionSheetSource> | undefined,
): CarriedSelectors => {
  const sheets = new Set<string>();
  const parts = new Set<string>();
  for (const { source, reading } of DECISION_SHEET_SOURCES) {
    if (sources !== undefined && !sources.has(source)) {
      continue;
    }
    for (const value of HIT_SHEET_SOURCE_VALUES[source](hit)) {
      const selector = SHEET_READINGS[reading](value, context, hit);
      switch (selector.kind) {
        case "none":
          break;
        case "sheet":
          sheets.add(selector.value);
          break;
        case "part":
          parts.add(selector.value);
          break;
        default: {
          selector satisfies never;
          return panic(`Unhandled docket selector: ${String(selector)}`);
        }
      }
    }
  }
  return { sheets, parts };
};

const resolvedAmong = <THit>(
  matches: readonly THit[],
  basis: "identifier" | "selector" | "docket",
): DecisionIdentityResolution<THit> => {
  const [only, ...rest] = matches;
  if (only === undefined) {
    return { status: "none" };
  }
  return rest.length === 0
    ? { status: "unique", decision: only, basis }
    : { status: "ambiguous", candidates: matches, reason: "several" };
};

/**
 * Resolve a reference to the decision it names among the hits, or to the
 * candidates the reader has to choose between. A bare docket names its whole
 * file; a sheet or part narrows it to the decision known to carry that
 * selector, and to nothing arbitrary when none is.
 */
type ResolveDecisionIdentityOptions = ExactDecisionMatchesOptions & {
  /**
   * The sheet sources a selector is read from; every one when absent. A
   * reader that adjudicates sheets from only some of them (the citation
   * resolver's SQL) is held to the answer a lookup gives over the same ones.
   */
  readonly sheetSources?: ReadonlySet<DecisionSheetSource> | undefined;
};

export const resolveDecisionIdentity = <THit extends DecisionHitIdentity>(
  identifier: DecisionIdentifierIntent,
  hits: readonly THit[],
  options: ResolveDecisionIdentityOptions = {},
): DecisionIdentityResolution<THit> => {
  const family = exactDecisionMatches(identifier, hits, options);
  if (identifier.kind !== "docket") {
    return resolvedAmong(family, "identifier");
  }
  const { selector } = identifier;
  if (family.length === 0) {
    return { status: "none" };
  }
  if (selector.kind === "none") {
    const [only, ...rest] = family;
    // Where a sibling can be stored under its sheet, the read may not have
    // reached it: one decision found is not one decision in the file.
    if (
      only !== undefined &&
      rest.length === 0 &&
      DECISION_DOCKETS_STORED_WITH_SHEETS[identifier.jurisdiction]
    ) {
      return {
        status: "incomplete_identifier",
        candidates: family,
        missing: ["sheet"],
      };
    }
    return resolvedAmong(family, "docket");
  }
  const grammar = DECISION_DOCKET_GRAMMARS[identifier.jurisdiction];
  const familyCanonical = decisionIdentifierComparisonKey(
    identifier.family,
    grammar,
  );
  const known = family.map((hit) => {
    const { parts, sheets } = selectorsOfHit(
      hit,
      { familyCanonical, grammar },
      options.sheetSources,
    );
    return { hit, carried: selector.kind === "sheet" ? sheets : parts };
  });
  const selected = known
    .filter(({ carried }) => carried.has(selector.value))
    .map(({ hit }) => hit);
  if (selected.length > 0) {
    return resolvedAmong(selected, "selector");
  }
  // Nothing known to carry what the reference printed: the file comes back,
  // even when it shows one decision, which may be a sibling of the one named.
  // A sibling known under another sheet is not it, whichever source states
  // that sheet; the read never reaches a row stored under another sheet, so
  // counting the others in would let storage decide the answer. Where every
  // candidate is known under another sheet nothing answers (`none`), as when
  // the read reaches no row at all. A part selector keeps the whole file.
  const open =
    selector.kind === "sheet"
      ? known.filter(({ carried }) => carried.size === 0).map(({ hit }) => hit)
      : family;
  if (open.length === 0) {
    return { status: "none" };
  }
  return {
    status: "ambiguous",
    candidates: open,
    reason: "selector_unmatched",
  };
};

/**
 * The hits an entry names, for a list that shows them first: the decision it
 * resolves to, or every candidate it leaves open. Nothing for an entry that
 * is not an identifier.
 */
export const namedDecisionsOf = <THit extends DecisionHitIdentity>(
  intent: DecisionQueryIntent,
  hits: readonly THit[],
  options: ExactDecisionMatchesOptions = {},
): readonly THit[] => {
  if (intent.type !== "identifier") {
    return [];
  }
  const resolution = resolveDecisionIdentity(intent, hits, options);
  switch (resolution.status) {
    case "none":
      return [];
    case "unique":
      return [resolution.decision];
    case "ambiguous":
    case "incomplete_identifier":
      return resolution.candidates;
    default: {
      resolution satisfies never;
      return panic(`Unhandled identity resolution: ${String(resolution)}`);
    }
  }
};
