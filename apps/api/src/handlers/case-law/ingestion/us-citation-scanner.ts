/**
 * The reporter references, short forms and authority barriers in one run of
 * text, in source order, with their pins.
 *
 * Two recognisers run side by side. The supported grammar proposes spans of
 * the shape `volume reporter page` and lets the reporter table decide what
 * each names. The barrier recogniser is deliberately broader and never names
 * anything: a statute, an electronic database citation, or any authority the
 * table does not carry still stands between a case and a later `Id.`, so it
 * must be seen even though it cannot be identified.
 *
 * All scanning charges one work budget per candidate as it is produced, so a
 * decision made of nothing but candidates is rejected before the excess is
 * collected or sorted.
 */

import { panic, Result, TaggedError } from "better-result";

import {
  canonicalUsReporterCitation,
  parseUsReporterReference,
} from "@stll/api-contract/us-reporter-citation";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { ReporterCitationIdentifier } from "@stll/legal-ast/decision-identifier";
import {
  CITATION_PIN_MAX_PARTS,
  CITATION_PIN_RAW_MAX_LENGTH,
} from "@stll/legal-ast/inline";
import type { InlineCitationPinPart } from "@stll/legal-ast/inline";

import { plainTextOf } from "@/api/lib/case-law/document-ast";
import type { Inline } from "@/api/lib/case-law/document-ast";

// ---------------------------------------------------------------------------
// Work budget

/**
 * Units of work one decision's extraction may spend: one per candidate span
 * the scanner produces (barriers included), per earlier reference an
 * antecedent lookup inspects, and per node the annotator visits.
 */
export const US_CITATION_WORK_LIMIT = 2_000_000;

export type CitationWorkBudget = { readonly limit: number; spent: number };

export class UsCitationWorkBudgetError extends TaggedError(
  "UsCitationWorkBudgetError",
)<{
  message: string;
  limit: number;
}> {}

/** Spends `units`; false once the budget is exhausted. */
export const chargeWork = (
  budget: CitationWorkBudget,
  units: number,
): boolean => {
  budget.spent += units;
  return budget.spent <= budget.limit;
};

export const workBudgetExhausted = (
  budget: CitationWorkBudget,
): UsCitationWorkBudgetError =>
  new UsCitationWorkBudgetError({
    message: `Citation extraction exceeded its work limit of ${String(budget.limit)}`,
    limit: budget.limit,
  });

// ---------------------------------------------------------------------------
// The reporter table

/** A reporter edition's place in one decision, in canonical spelling. */
export type ReporterBase = {
  volume: string;
  edition: string;
  identifier: ReporterCitationIdentifier;
  /** The identifier's stored key: what makes two references one decision. */
  key: string;
  /** The reporter across its series: `F.`, `F.2d` and `F.3d` are one. */
  family: string;
};

/** The stored key of a reporter identifier in the decision's jurisdiction. */
export type ReporterIdentityKey = (
  identifier: ReporterCitationIdentifier,
) => string;

/**
 * A full citation's base, or null where the table does not settle the
 * spelling on one reporter. Undefined when the table does not read the span
 * as a citation at all.
 */
const readFullCitation = (
  text: string,
  identityKey: ReporterIdentityKey,
): ReporterBase | null | undefined => {
  const reference = parseUsReporterReference(text);
  if (reference?.type !== "full") {
    return undefined;
  }
  const canonical = canonicalUsReporterCitation(text);
  const [first] = reference.candidates;
  if (canonical === null || first.reporter === null) {
    return null;
  }
  const identifier = {
    type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    value: canonical,
  };
  return {
    volume: first.volume,
    edition: first.edition,
    identifier,
    key: identityKey(identifier),
    family: first.reporter,
  };
};

/**
 * The editions a `volume reporter` spelling may name. The table reads a
 * spelling only inside a whole citation, so it is asked about the shortest
 * short form carrying it; the printed pin is parsed here, not there.
 */
const readShortEditions = (
  volumeAndReporter: string,
): readonly string[] | null => {
  const reference = parseUsReporterReference(`${volumeAndReporter}, at 1`);
  return reference?.type === "short" ? reference.editions : null;
};

// ---------------------------------------------------------------------------
// Pins

export type ScannedPin =
  | {
      type: "pin";
      raw: string;
      parts: readonly [InlineCitationPinPart, ...InlineCitationPinPart[]];
    }
  /** A pin list running past what an annotation can hold. */
  | { type: "overlong" };

const DASH = "[-‐‑‒–—―−]";
const NOTE_ITEM = String.raw`nn?\.\s?\d{1,4}(?:\s?${DASH}\s?\d{1,4})?`;
const PIN_ITEM = String.raw`(?:¶¶?\s?\d{1,5}(?:\s?${DASH}\s?\d{1,5})?|${NOTE_ITEM}|\*?\d{1,5}(?:\s?${DASH}\s?\*?\d{1,5})?(?:\s?,?\s?(?:&\s?|and\s)?${NOTE_ITEM})?)`;
// A pin never ends where a reporter abbreviation begins: in
// `495, 74 S. Ct. 686` the 74 opens the next reference.
const PIN_ITEM_END = String.raw`(?![\p{L}\p{N}])(?!\s{1,2}\p{L}[\p{L}'&]*\.)`;
const FIRST_PIN_RE = new RegExp(`${PIN_ITEM}${PIN_ITEM_END}`, "yu");
const NEXT_PIN_RE = new RegExp(
  String.raw`(?:\s?[,&]\s?|\sand\s)${PIN_ITEM}${PIN_ITEM_END}`,
  "yu",
);
const PIN_PART_RE = new RegExp(
  String.raw`nn?\.\s*(?<note>\d+)(?:\s*${DASH}\s*(?<noteEnd>\d+))?|¶¶?\s*(?<paragraph>\d+)(?:\s*${DASH}\s*(?<paragraphEnd>\d+))?|(?<page>\*?\d+)(?:\s*${DASH}\s*(?<pageEnd>\*?\d+))?`,
  "gu",
);

const pinPartOf = (
  groups: Record<string, string | undefined> | undefined,
): InlineCitationPinPart | null => {
  const part = (
    kind: InlineCitationPinPart["kind"],
    start: string | undefined,
    end: string | undefined,
  ): InlineCitationPinPart | null =>
    start === undefined
      ? null
      : { kind, start, ...(end === undefined ? {} : { end }) };
  if (groups?.["note"] !== undefined) {
    return part("footnote", groups["note"], groups["noteEnd"]);
  }
  if (groups?.["paragraph"] !== undefined) {
    return part("paragraph", groups["paragraph"], groups["paragraphEnd"]);
  }
  return part("page", groups?.["page"], groups?.["pageEnd"]);
};

const pinPartsOf = (raw: string): InlineCitationPinPart[] => {
  const parts: InlineCitationPinPart[] = [];
  for (const { groups } of raw.matchAll(PIN_PART_RE)) {
    const part = pinPartOf(groups);
    if (part !== null) {
      parts.push(part);
    }
  }
  return parts;
};

type PinRead = { end: number; pin: ScannedPin };

/**
 * The whole pin list starting at `from`, item by item. A list the annotation
 * bounds cannot hold is read to its end and reported as overlong, never
 * truncated to the prefix that fits.
 */
const readPinList = (
  text: string,
  from: number,
  budget: CitationWorkBudget,
): PinRead | null => {
  FIRST_PIN_RE.lastIndex = from;
  const first = FIRST_PIN_RE.exec(text);
  if (first === null) {
    return null;
  }
  let end = from + first[0].length;
  for (;;) {
    NEXT_PIN_RE.lastIndex = end;
    const next = NEXT_PIN_RE.exec(text);
    if (next === null || !chargeWork(budget, 1)) {
      break;
    }
    end += next[0].length;
  }
  const raw = text.slice(from, end);
  const [part, ...parts] = pinPartsOf(raw);
  if (part === undefined) {
    return panic(`Pin grammar matched without a part: ${raw}`);
  }
  return raw.length > CITATION_PIN_RAW_MAX_LENGTH ||
    parts.length + 1 > CITATION_PIN_MAX_PARTS
    ? { end, pin: { type: "overlong" } }
    : { end, pin: { type: "pin", raw, parts: [part, ...parts] } };
};

/** A pin introduced at `from` by one of `leads`, or none. */
const readLedPin = (
  text: string,
  from: number,
  lead: RegExp,
  budget: CitationWorkBudget,
): PinRead | null => {
  lead.lastIndex = from;
  const led = lead.exec(text);
  return led === null ? null : readPinList(text, from + led[0].length, budget);
};

/** After a first page: `, 495`, `, at 495`, ` at 495`. */
const FULL_PIN_LEAD_RE = /\s{0,2},\s{0,2}(?:at\s{1,2})?|\s{1,2}at\s{1,2}/uy;
/** After `Id.` or `supra`: `, at 495`, ` at 495`, `, 495`. */
const SHORT_PIN_LEAD_RE = /\s{0,2},?\s{1,2}at\s{1,2}|\s{0,2},\s{0,2}/uy;

// ---------------------------------------------------------------------------
// Tokens

export type BarrierKind =
  | "statute"
  | "electronic"
  | "unsupported-authority"
  | "treatise";

type Span = { start: number; end: number };

export type FullToken = Span & {
  kind: "full";
  /** Null where the reporter spelling names more than one reporter. */
  base: ReporterBase | null;
  pin: ScannedPin | null;
};

export type VolumeShortToken = Span & {
  kind: "volume-reporter";
  volume: string;
  editions: readonly string[];
  pin: ScannedPin;
};

export type ShortToken = Span & {
  kind: "id" | "supra";
  pin: ScannedPin | null;
};

export type BarrierToken = Span & { kind: "barrier"; barrier: BarrierKind };

export type Token = FullToken | VolumeShortToken | ShortToken | BarrierToken;

// Supported grammar. Every quantifier is bounded, and a reporter word without
// a closing period must be followed by whitespace, so a word never splits
// into tokens more than one way.
const VOLUME_START = String.raw`(?<![\p{L}\p{N}§])`;
const REPORTER_WORD = String.raw`(?!at\s)\p{L}[\p{L}'&]*\.?`;
const REPORTER_PART = String.raw`(?:${REPORTER_WORD}|\d{1,2}(?:d|nd|rd|th|st)\.?|\(\d{1,3}\s{1,2}[^()\d]{1,24}\))`;
const REPORTER_RUN = String.raw`${REPORTER_WORD}(?:(?:(?<=\.)\s{0,2}|\s{1,2})${REPORTER_PART}){0,5}`;
const CANDIDATE_RE = new RegExp(
  String.raw`${VOLUME_START}(?<head>(?<volume>\d{1,4})\s{1,2}(?<run>${REPORTER_RUN}))(?:\s{1,2}(?<page>\d{1,5})(?![\p{L}\p{N}])|(?<short>\s{0,2},?\s{1,2}at\s{1,2}))`,
  "gu",
);
const ID_RE = /(?<![\p{L}\p{N}])[Ii]d\./gu;
const SUPRA_RE = /(?<!\p{L})supra(?!\p{L})/gu;

// Barrier grammar: broader than any table, never naming a decision.
const STATUTE_RE = new RegExp(
  String.raw`${VOLUME_START}\d{1,4}\s{1,2}U\.\s?S\.\s?C\.(?:\s?A\.)?(?:\s{0,2}§§?\s{0,2}\d[\p{L}\p{N}.-]{0,16})?|§§?\s{0,2}\d[\p{L}\p{N}.:-]{0,16}`,
  "gu",
);
const ELECTRONIC_RE = new RegExp(
  String.raw`${VOLUME_START}\d{4}\s{1,2}(?:\p{Lu}[\p{L}.]{0,12}\s{1,2}){0,3}(?:WL|LEXIS|Lexis)\s{1,2}\d{1,9}(?!\p{N})`,
  "gu",
);
/**
 * `volume Abbrev page` in any capitalised spelling, dotted or not, with a
 * page of any length: the shape of an authority whether or not any table
 * carries its reporter.
 */
const AUTHORITY_SHAPE_RE = new RegExp(
  String.raw`${VOLUME_START}\d{1,4}\s{1,2}\p{Lu}[\p{L}.&']{0,15}(?:\s{1,2}\p{Lu}[\p{L}.&']{0,15}|\s{0,2}\d{1,2}(?:d|nd|rd|th)\.?){0,5}\s{1,2}\d{1,9}(?![\p{L}\p{N}])`,
  "gu",
);
const YEAR_PARENTHETICAL = String.raw`\([^()]{0,120}\b(?:1[5-9]|20)\d{2}\b[^()]{0,16}\)`;
const TRAILING_PARENTHETICAL_RE = new RegExp(
  String.raw`\s{0,2}${YEAR_PARENTHETICAL}`,
  "yu",
);
const TREATISE_RE = new RegExp(YEAR_PARENTHETICAL, "gu");

type Produce = (match: RegExpExecArray) => Token | null;

/** One run's scan: its text, the budget it charges and what it has found. */
type ScanContext = {
  readonly text: string;
  readonly budget: CitationWorkBudget;
  readonly identityKey: ReporterIdentityKey;
  readonly candidates: Token[];
};

/**
 * Collects every token `re` produces, charging the budget per match; false
 * as soon as the budget is exhausted, before anything more is collected.
 * With `rescan`, a match that yields no supported form is searched again
 * from inside it: `12 See 347 U.S. 483` hides a citation behind its volume.
 */
const produce = (
  re: RegExp,
  { budget, candidates, text }: ScanContext,
  make: Produce,
  rescan = false,
): boolean => {
  re.lastIndex = 0;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    if (!chargeWork(budget, 1)) {
      return false;
    }
    const token = make(match);
    if (token !== null) {
      candidates.push(token);
    }
    if (rescan && (token === null || token.kind === "barrier")) {
      re.lastIndex = match.index + (match.groups?.["volume"]?.length ?? 1);
    }
  }
  return true;
};

const barrierAt = (
  match: RegExpExecArray,
  barrier: BarrierKind,
): BarrierToken => ({
  kind: "barrier",
  barrier,
  start: match.index,
  end: match.index + match[0].length,
});

const reporterToken = (
  { budget, identityKey, text }: ScanContext,
  match: RegExpExecArray,
): Token | null => {
  const start = match.index;
  const matchEnd = start + match[0].length;
  const head = match.groups?.["head"] ?? "";
  const page = match.groups?.["page"];
  if (page !== undefined) {
    const base = readFullCitation(match[0], identityKey);
    if (base !== undefined) {
      const pin = readLedPin(text, matchEnd, FULL_PIN_LEAD_RE, budget);
      return {
        kind: "full",
        start,
        end: pin?.end ?? matchEnd,
        base,
        pin: pin?.pin ?? null,
      };
    }
  } else {
    // Without a pin, `1954 Congress, at` is prose, not a short form.
    const pin = readPinList(text, matchEnd, budget);
    if (pin === null) {
      return null;
    }
    const editions = readShortEditions(head);
    if (editions !== null) {
      return {
        kind: "volume-reporter",
        start,
        end: pin.end,
        volume: match.groups?.["volume"] ?? "",
        editions,
        pin: pin.pin,
      };
    }
    return {
      kind: "barrier",
      barrier: "unsupported-authority",
      start,
      end: pin.end,
    };
  }
  // A rejected `volume reporter page` is the barrier grammar's to see.
  return null;
};

const shortToken =
  ({ budget, text }: ScanContext, kind: ShortToken["kind"]): Produce =>
  (match) => {
    const end = match.index + match[0].length;
    const pin = readLedPin(text, end, SHORT_PIN_LEAD_RE, budget);
    return {
      kind,
      start: match.index,
      end: pin?.end ?? end,
      pin: pin?.pin ?? null,
    };
  };

/**
 * Non-overlapping tokens in source order: at one start a recognised form
 * wins over a barrier and the longer over the shorter; an overlap drops the
 * later token unless a recognised form displaces a barrier.
 */
const selectTokens = (candidates: readonly Token[]): Token[] => {
  const ordered = candidates.toSorted(
    (left, right) =>
      left.start - right.start ||
      Number(left.kind === "barrier") - Number(right.kind === "barrier") ||
      right.end - left.end,
  );
  const kept: Token[] = [];
  for (const token of ordered) {
    const previous = kept.at(-1);
    if (previous === undefined || token.start >= previous.end) {
      kept.push(token);
    } else if (previous.kind === "barrier" && token.kind !== "barrier") {
      kept[kept.length - 1] = token;
    }
  }
  return kept;
};

// ---------------------------------------------------------------------------
// Sentences

/** Words closed by a period that do not end a sentence. */
const ABBREVIATIONS = new Set([
  "v",
  "vs",
  "cf",
  "no",
  "nos",
  "mr",
  "mrs",
  "ms",
  "dr",
  "jr",
  "sr",
  "st",
  "co",
  "corp",
  "inc",
  "ltd",
  "bros",
  "art",
  "arts",
  "pt",
  "pts",
  "cc",
  "ch",
  "ed",
  "eds",
  "p",
  "pp",
  "n",
  "nn",
  "cl",
  "const",
  "stat",
  "gen",
  "rev",
  "ann",
  "supp",
  "dept",
  "dist",
  "educ",
  "bd",
  "ry",
  "ibid",
]);

const SENTENCE_MARK_RE = /[.?!]/gu;
const AFTER_SENTENCE_RE = /^["”’)\]]*(?:\s+["“‘(\p{Lu}\p{N}]|\s*$)/u;
const WORD_BEFORE_RE = /([\p{L}\p{N}'.]*)$/u;

/** Offsets in `text[from, to)` where a sentence ends. */
const sentenceEnds = (text: string, from: number, to: number): number[] => {
  const ends: number[] = [];
  SENTENCE_MARK_RE.lastIndex = from;
  for (
    let match = SENTENCE_MARK_RE.exec(text);
    match !== null && match.index < to;
    match = SENTENCE_MARK_RE.exec(text)
  ) {
    const at = match.index;
    if (!AFTER_SENTENCE_RE.test(text.slice(at + 1, at + 64))) {
      continue;
    }
    if (match[0] === ".") {
      const word = WORD_BEFORE_RE.exec(text.slice(Math.max(0, at - 32), at));
      const bare = (word?.[1] ?? "").toLocaleLowerCase("und");
      if (
        ABBREVIATIONS.has(bare) ||
        bare.includes(".") ||
        /^\p{L}$/u.test(bare)
      ) {
        continue;
      }
    }
    ends.push(at + 1);
  }
  return ends;
};

// ---------------------------------------------------------------------------
// One run

/** Characters a note mark occupies, which no reference may read through. */
const MARK_CHARACTER = "￼";
const NOTE_MARK_RE = /^\s*[\d*†‡]{1,4}\s*$/u;

const isNoteMark = (inline: Inline): boolean =>
  (inline.type === "superscript" ||
    (inline.type === "link" && inline.href.startsWith("#"))) &&
  NOTE_MARK_RE.test(plainTextOf(inline.children));

/** `plainTextOf(inlines)` with every note mark blanked, offsets unchanged. */
const scanTextOf = (inlines: readonly Inline[]): string => {
  let out = "";
  for (const inline of inlines) {
    if (isNoteMark(inline)) {
      out += MARK_CHARACTER.repeat(plainTextOf([inline]).length);
    } else if (inline.type === "text") {
      out += inline.text;
    } else if (inline.type === "line-break") {
      out += "\n";
    } else if (inline.type !== "page-anchor") {
      out += scanTextOf(inline.children);
    }
  }
  return out;
};

export type RunEvent =
  | { kind: "token"; at: number; token: Token }
  | { kind: "sentence-end"; at: number };

export type ScannedRun = { text: string; events: RunEvent[] };

export type ScanRunOptions = {
  identityKey: ReporterIdentityKey;
  budget: CitationWorkBudget;
};

/**
 * The run's tokens and sentence ends in source order. A year parenthetical
 * after a reference belongs to it; one anywhere else is a treatise barrier.
 */
export const scanRun = (
  inlines: readonly Inline[],
  { budget, identityKey }: ScanRunOptions,
): Result<ScannedRun, UsCitationWorkBudgetError> => {
  const text = scanTextOf(inlines);
  const candidates: Token[] = [];
  const context: ScanContext = { text, budget, identityKey, candidates };
  const complete =
    produce(
      CANDIDATE_RE,
      context,
      (match) => reporterToken(context, match),
      true,
    ) &&
    produce(ID_RE, context, shortToken(context, "id")) &&
    produce(SUPRA_RE, context, shortToken(context, "supra")) &&
    produce(STATUTE_RE, context, (match) => barrierAt(match, "statute")) &&
    produce(ELECTRONIC_RE, context, (match) =>
      barrierAt(match, "electronic"),
    ) &&
    produce(AUTHORITY_SHAPE_RE, context, (match) =>
      barrierAt(match, "unsupported-authority"),
    );
  // Pin lists charge as they are read, inside a production step.
  if (!complete || budget.spent > budget.limit) {
    return Result.err(workBudgetExhausted(budget));
  }
  const tokens = selectTokens(candidates);

  const events: RunEvent[] = [];
  let gapStart = 0;
  for (const [index, token] of [...tokens, null].entries()) {
    const gapEnd = token?.start ?? text.length;
    let treatiseFrom = gapStart;
    if (index > 0) {
      TRAILING_PARENTHETICAL_RE.lastIndex = gapStart;
      const trailing = TRAILING_PARENTHETICAL_RE.exec(text);
      if (trailing !== null && gapStart + trailing[0].length <= gapEnd) {
        treatiseFrom += trailing[0].length;
      }
    }
    for (const match of text
      .slice(treatiseFrom, gapEnd)
      .matchAll(TREATISE_RE)) {
      if (!chargeWork(budget, 1)) {
        return Result.err(workBudgetExhausted(budget));
      }
      const start = treatiseFrom + match.index;
      events.push({
        kind: "token",
        at: start,
        token: {
          kind: "barrier",
          barrier: "treatise",
          start,
          end: start + match[0].length,
        },
      });
    }
    // A reference closed by its own period (`Id.`) may also end the sentence.
    const sentenceFrom =
      index > 0 && text[gapStart - 1] === "." ? gapStart - 1 : gapStart;
    for (const at of sentenceEnds(text, sentenceFrom, gapEnd)) {
      events.push({ kind: "sentence-end", at });
    }
    if (token === null) {
      break;
    }
    events.push({ kind: "token", at: token.start, token });
    gapStart = token.end;
  }
  return Result.ok({
    text,
    events: events.toSorted((left, right) => left.at - right.at),
  });
};
