import { stripCitationPrefix } from "@stll/legal-ast/citation-prefix";

import {
  DECISION_DOCKET_GRAMMARS,
  foldDecisionIdentifierInput,
  parseDecisionDocket,
  storedDecisionDocketOf,
} from "./decision-docket-grammar";
import type {
  DecisionDocketGrammar,
  DecisionDocketJurisdiction,
  ParsedDecisionDocket,
} from "./decision-docket-grammar";

/**
 * Reading a docket reference as a reader or a citing court writes it, apart
 * from the grammars themselves.
 *
 * Read-side only: search, the lookup tool and the web box read references
 * through it, and nothing ingestion runs imports it. What it needs of the
 * grammars it reads through their exported surface (`parseDecisionDocket`,
 * `storedDecisionDocketOf`), so a reference and a stored docket are cut and
 * keyed by the same code.
 */

type ParseDecisionDocketOptions = {
  readonly grammar?: DecisionDocketGrammar | null | undefined;
};

/**
 * Whether a jurisdiction's stored dockets can still carry the sheet they were
 * published with (`4 As 50/2012 - 33`), keyed apart from their file's other
 * members. Where they can, a read of a file by its docket can miss those
 * members, so a lone decision it finds is not proof that the file holds no
 * other: a bare docket there never names one decision outright. A
 * jurisdiction whose stored dockets are all keyed by their file declares
 * `false`. Total over the grammars, so a new one has to say which it is.
 */
export const DECISION_DOCKETS_STORED_WITH_SHEETS = {
  AUT: false,
  CZE: true,
  EU: false,
  HUN: false,
  POL: false,
  SVK: true,
  USA: false,
} as const satisfies Record<DecisionDocketJurisdiction, boolean>;

/**
 * Which decision of a case file a reference names, beside the docket.
 *
 * A docket names a file, not a decision: one file holds every decision a
 * court issues in it, and several can share a date. A reference singles one
 * out only by what it prints after the docket.
 *
 * - `sheet`: a trailing number, the sheet the document sits on (`8 As
 *   287/2020-33`). It is the last segment of that decision's ECLI. Only a
 *   number the accepting grammar itself keys away (its canonical form is the
 *   docket's) is read as one, so a grammar whose trailing digits are part of
 *   the docket (`21-123`) never loses them.
 * - `part`: a Roman part numeral a publisher appends (`6 Tdo 1/2021 - II.`).
 * - `none`: the bare docket, which names the whole file.
 *
 * Numbers carry no leading zeros and numerals are upper case, so two
 * spellings of one selector compare equal.
 */
export type DecisionDocketSelector =
  | { readonly kind: "none" }
  | { readonly kind: "sheet"; readonly value: string }
  | { readonly kind: "part"; readonly value: string };

/**
 * A docket reference split into its two identities: the case file (`family`,
 * every decision under the docket, siblings included) and the selector that
 * may single one decision of it out. Matching by `family` alone is never
 * matching a decision.
 */
export type DecisionDocketReference = {
  readonly family: ParsedDecisionDocket<DecisionDocketJurisdiction>;
  readonly selector: DecisionDocketSelector;
};

const NO_SELECTOR: DecisionDocketSelector = { kind: "none" };

/**
 * Quotes, brackets and list punctuation around a reference in running text.
 * A dot is not among them, since a part numeral ends on one.
 */
const REFERENCE_EDGE_CHARACTERS = new Set(Array.from(`"'„“”‚‘’«»()[]{}<>,;:`));

/**
 * `text` without the whitespace, quotes, brackets and list punctuation around
 * it, nor any of `extra`. A character walk rather than an anchored pattern,
 * which would rescan every run of them.
 */
export const trimDecisionReferenceEdges = (
  text: string,
  extra = "",
): string => {
  const characters = Array.from(text);
  const isEdge = (character: string | undefined): boolean =>
    character !== undefined &&
    (REFERENCE_EDGE_CHARACTERS.has(character) ||
      extra.includes(character) ||
      /^\s$/u.test(character));
  let start = 0;
  let end = characters.length;
  while (start < end && isEdge(characters[start])) {
    start += 1;
  }
  while (end > start && isEdge(characters[end - 1])) {
    end -= 1;
  }
  return characters.slice(start, end).join("");
};

/** `text` with the gaps on either side of each `separator` closed. */
const closeGapsAround = (text: string, separator: string): string =>
  text
    .split(separator)
    .map((piece) => piece.trim())
    .join(separator);

/**
 * The longest entry read as a docket reference, prefix and tail included, and
 * the longest tail cut off one. Consolidated dockets run long; a part tail
 * (`, - XXXIX.`) does not, and a bound on both keeps the reading linear in
 * what a reader can type.
 */
const DOCKET_REFERENCE_MAX_LENGTH = 200;
const DOCKET_REFERENCE_TAIL_MAX_LENGTH = 16;

/** A trailing number after a dash, once spacing around the dash is gone. */
const SHEET_TAIL_RE = /^(?<docket>.*\d)-(?<sheet>\d{1,4})$/u;

/** Roman part numerals one to thirty-nine, the range the tail grammar reads. */
const ROMAN_PART_NUMERALS: readonly string[] = Array.from(
  { length: 39 },
  (_, index) => {
    const value = index + 1;
    const tens = "X".repeat(Math.floor(value / 10));
    const units = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"][
      value % 10
    ];
    return `${tens}${units ?? ""}`;
  },
);

const ROMAN_PART_NUMERAL_SET: ReadonlySet<string> = new Set(
  ROMAN_PART_NUMERALS,
);

/**
 * The marks that introduce a part numeral after a docket (`- II.`, `/I`,
 * `, III.`), spaced or not. The one source for both sides: the reader takes a
 * numeral as a part only after one of them, and the stored spellings a file's
 * members are read under are generated from them
 * (`decisionDocketTailSpellings`). A numeral after a bare space is not a
 * part: in running text it is as often a word (`6 Tdo 1/2021 v trestní
 * věci`), and reading it would invent a selector the reference never printed.
 * The dash leads, so a character class built from them reads it literally.
 */
const DOCKET_PART_SEPARATORS = ["-", "/", ","] as const;

const PART_NUMERAL_RE = new RegExp(
  String.raw`[${DOCKET_PART_SEPARATORS.join("")}][\s\p{P}\p{S}]*(?<![\p{L}\p{N}])(?<numeral>[ivx]+)(?![\p{L}\p{N}])`,
  "giu",
);

const withoutLeadingZeros = (digits: string): string =>
  digits.replace(/^0+(?=\d)/u, "");

/**
 * The spellings a reader's entry is tried in, most literal first: as typed
 * (prefix and surrounding punctuation removed), with the gaps a typist puts
 * around a slash or a dash closed (`4410 / 2019`, `41/2008 - 98`), and with
 * a glued registry mark set apart from its numbers (`12Cdo3456/2021`). A
 * later spelling is tried only when an earlier one is not a docket, so a
 * grammar that reads a compact form itself (`5Ob200/20x`) keeps it.
 */
const referenceSpellingsOf = (raw: string): string[] => {
  const folded = trimDecisionReferenceEdges(foldDecisionIdentifierInput(raw));
  const bare = trimDecisionReferenceEdges(stripCitationPrefix(folded));
  const tight = closeGapsAround(closeGapsAround(bare, "/"), "-");
  const spaced = tight
    .replace(/(\p{Nd})(?=\p{L})/gu, "$1 ")
    .replace(/(\p{L})(?=\p{Nd})/gu, "$1 ");
  return [...new Set([bare, tight, spaced])].filter(
    (spelling) => spelling.length > 0,
  );
};

const partOf = (removed: string): DecisionDocketSelector => {
  const numerals = [...removed.matchAll(PART_NUMERAL_RE)]
    .map((match) => match.groups?.["numeral"]?.toUpperCase() ?? "")
    .filter((numeral) => ROMAN_PART_NUMERAL_SET.has(numeral));
  const [only, ...rest] = numerals;
  return only === undefined || rest.length > 0
    ? NO_SELECTOR
    : { kind: "part", value: only.toUpperCase() };
};

/**
 * The reference an accepted spelling makes, its trailing number read as a
 * sheet where the grammar keys it away.
 */
const withSheetOf = (
  spelling: string,
  whole: ParsedDecisionDocket<DecisionDocketJurisdiction>,
  parse: (
    text: string,
  ) => ParsedDecisionDocket<DecisionDocketJurisdiction> | null,
): DecisionDocketReference => {
  const groups = SHEET_TAIL_RE.exec(spelling)?.groups;
  const docket = groups?.["docket"];
  const sheet = groups?.["sheet"];
  if (docket !== undefined && sheet !== undefined) {
    const family = parse(docket);
    // The grammar decides whether trailing digits are a sheet: only when it
    // keys the reference exactly as it keys the docket without them.
    if (
      family !== null &&
      family.jurisdiction === whole.jurisdiction &&
      family.canonical === whole.canonical
    ) {
      return {
        family,
        selector: { kind: "sheet", value: withoutLeadingZeros(sheet) },
      };
    }
  }
  return { family: whole, selector: NO_SELECTOR };
};

/**
 * The docket a spelling is once a tail of separators and part numerals is cut
 * off, read by the grammar's own stored-docket reading
 * (`storedDecisionDocketOf`), so the reader trims exactly what ingestion
 * trims. Unscoped, every grammar an unscoped entry may reach is tried, in the
 * order an unscoped parse tries them. A tail can only follow the last digit,
 * and one longer than a part numeral's is not one, which bounds the work.
 */
const trimmedDocketOf = (
  spelling: string,
  grammar: DecisionDocketGrammar | null | undefined,
): {
  caseNumber: string;
  parsed: ParsedDecisionDocket<DecisionDocketJurisdiction>;
  removed: string;
} | null => {
  const lastDigit = Math.max(
    ...Array.from("0123456789", (digit) => spelling.lastIndexOf(digit)),
  );
  if (
    grammar === null ||
    lastDigit < 0 ||
    spelling.length - lastDigit - 1 > DOCKET_REFERENCE_TAIL_MAX_LENGTH
  ) {
    return null;
  }
  const grammars =
    grammar === undefined ? Object.values(DECISION_DOCKET_GRAMMARS) : [grammar];
  for (const candidate of grammars) {
    const stored = storedDecisionDocketOf(spelling, candidate.jurisdiction);
    if (stored.type !== "trimmed") {
      continue;
    }
    // Unscoped, only a grammar an unscoped entry reaches may claim it.
    const parsed = parseDecisionDocket(stored.caseNumber, {
      grammar: grammar === undefined ? undefined : candidate,
    });
    if (parsed !== null) {
      return { caseNumber: stored.caseNumber, parsed, removed: stored.removed };
    }
  }
  return null;
};

const referenceOfSpelling = (
  spelling: string,
  grammar: DecisionDocketGrammar | null | undefined,
): DecisionDocketReference | null => {
  const parse = (text: string) => parseDecisionDocket(text, { grammar });
  const whole = parse(spelling);
  if (whole !== null) {
    return withSheetOf(spelling, whole, parse);
  }
  const trimmed = trimmedDocketOf(spelling, grammar);
  if (trimmed === null) {
    return null;
  }
  // What the cut leaves can still end on a sheet (`8 As 1/2020-33 …`).
  const kept = withSheetOf(trimmed.caseNumber, trimmed.parsed, parse);
  return kept.selector.kind === "none"
    ? { family: kept.family, selector: partOf(trimmed.removed) }
    : kept;
};

/**
 * Read a docket reference as a reader or a citing court writes it: behind a
 * citation prefix (`sp. zn.`, `č. j.`, `č. k.`, `sygn. akt`), in any dash
 * style, spaced or compact, with a sheet number or a part numeral after it.
 * The family is the docket the jurisdiction's grammar accepts, formatted as
 * the grammar formats it, which is the spelling the stored docket is keyed
 * from; the selector is kept apart and never invented.
 */
export const readDecisionDocketReference = (
  raw: string,
  { grammar }: ParseDecisionDocketOptions = {},
): DecisionDocketReference | null => {
  if (raw.length > DOCKET_REFERENCE_MAX_LENGTH) {
    return null;
  }
  for (const spelling of referenceSpellingsOf(raw)) {
    const reference = referenceOfSpelling(spelling, grammar);
    if (reference !== null) {
      return reference;
    }
  }
  return null;
};

/**
 * One spelling of a reference that reads back as the same reference: the
 * family as its grammar formats it, then the selector after a dash.
 */
export const formatDecisionDocketReference = ({
  family,
  selector,
}: DecisionDocketReference): string =>
  selector.kind === "none"
    ? family.formatted
    : `${family.formatted}-${selector.value}`;

/** A tail of separators alone, which names no part. */
const BARE_JUNK_TAILS = [".", " -", ","] as const;

/** The gaps a publisher leaves on either side of a part separator. */
const PART_SEPARATOR_GAPS = [
  ["", ""],
  ["", " "],
  [" ", ""],
  [" ", " "],
] as const;

/**
 * The spellings under which a stored docket can carry a part numeral or a
 * stray separator after `family`, each one a docket the tail grammar trims
 * back to `family` and the reader reads back as that part. A stored docket
 * keeps such a tail when the publisher's document carries no key of its own,
 * so the file's members are stored under more than one spelling, and an
 * index keyed by the stored spelling is read under every one of them.
 * Bounded: thirty-nine numerals after each separator in each spacing.
 */
export const decisionDocketTailSpellings = (family: string): string[] => [
  ...BARE_JUNK_TAILS.map((tail) => `${family}${tail}`),
  ...DOCKET_PART_SEPARATORS.flatMap((separator) =>
    PART_SEPARATOR_GAPS.flatMap(([before, after]) =>
      ROMAN_PART_NUMERALS.map(
        (numeral) => `${family}${before}${separator}${after}${numeral}.`,
      ),
    ),
  ),
];
