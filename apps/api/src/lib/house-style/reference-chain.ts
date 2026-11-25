// Reads the chains of head words and designators out of a paragraph's text:
// `čl. XI. odst. 1 a odst. 2 písm. d)`, `Section 2.3(b)`, `§ 5 Abs. 2`. This
// is the walk over the patterns in `reference-grammar.ts`; what a chain
// points at is decided in `reference-detector.ts`.

import { panic } from "better-result";

import { parseRomanNumeral } from "@stll/api-contract/magyar-kozlony-designation";

import {
  ABBREVIATION_AT,
  ADJACENT_AT,
  ATTACHED_AT,
  BEFORE_DESIGNATOR,
  CONNECTOR_AT,
  createHeadScanner,
  CZECH_STATUTE_AT,
  DEMONSTRATIVE_AT,
  DESIGNATOR_AT,
  FILLER_AT,
  HEAD_AT,
  HEAD_LEVELS,
  LEGISLATION_NOUN,
  NAMED_DOCUMENT_AT,
  NAMED_STATUTE_AT,
  OF_AT,
  OWN_DOCUMENT_NOUN,
  OWN_NOUN_AT,
  QUANTITY_AT,
  RELATIVE_DEICTIC_AT,
  SELF_ADVERB_AT,
  TAIL_START_AT,
} from "@/api/lib/house-style/reference-grammar";
import type { HeadLevel } from "@/api/lib/house-style/reference-grammar";

type TokenFamily = "decimal" | "upperRoman" | "bracketed" | "number" | "letter";

export type Token = {
  start: number;
  end: number;
  family: TokenFamily;
  /** The designator without brackets. */
  core: string;
  join: "list" | "range" | null;
  /** Set directly against the token before it: the `(b)` of `2.3(b)`. */
  attached: boolean;
};

export type Segment = {
  level: HeadLevel;
  start: number;
  join: "first" | "adjacent" | "list" | "range" | "of";
  tokens: Token[];
  end: number;
};

const matchAt = (
  pattern: RegExp,
  text: string,
  position: number,
): RegExpExecArray | null => {
  pattern.lastIndex = position;
  return pattern.exec(text);
};

const headLevelOf = (match: RegExpExecArray): HeadLevel | null => {
  for (const [index, level] of HEAD_LEVELS.entries()) {
    if (match[index + 1] !== undefined) {
      return level;
    }
  }
  return null;
};

/** Which designators a head can take: an article is never `a)`, an annex is
 *  `1`, `II` or `A` but not a lower-case letter, which is a conjunction. */
const acceptsToken = (
  level: HeadLevel,
  token: Token,
  text: string,
): boolean => {
  const written = text.slice(token.start, token.end);
  switch (level) {
    case "section":
      return token.family === "decimal";
    case "article":
      return token.family === "decimal" || token.family === "upperRoman";
    case "clause":
      return token.family !== "letter";
    case "point":
      return token.family !== "upperRoman" && token.family !== "letter";
    case "letter":
      return (
        token.family === "bracketed" ||
        (token.family === "letter" && written === written.toLowerCase())
      );
    case "annex":
      return (
        token.family === "decimal" ||
        token.family === "upperRoman" ||
        (token.family === "letter" && written === written.toUpperCase())
      );
    case "recital":
      return (
        token.family === "bracketed" ||
        token.family === "number" ||
        (token.family === "letter" && written === written.toUpperCase())
      );
    default: {
      level satisfies never;
      return panic("Unhandled level");
    }
  }
};

const readToken = (text: string, position: number): Token | null => {
  const match = matchAt(DESIGNATOR_AT, text, position);
  if (!match) {
    return null;
  }
  const [whole, decimal, roman, open, bracketed, number, letter] = match;
  const end = position + whole.length;
  const shared = { start: position, end, join: null, attached: false } as const;
  if (decimal !== undefined) {
    return { ...shared, family: "decimal", core: decimal };
  }
  if (roman !== undefined) {
    return parseRomanNumeral(roman) === null
      ? null
      : { ...shared, family: "upperRoman", core: roman };
  }
  if (bracketed !== undefined) {
    // `(?)` leaves group 3 empty rather than undefined.
    return open === undefined
      ? null
      : { ...shared, family: "bracketed", core: bracketed };
  }
  if (number !== undefined) {
    return { ...shared, family: "number", core: number };
  }
  if (letter !== undefined) {
    return { ...shared, family: "letter", core: letter };
  }
  return null;
};

const readAttached = (text: string, position: number): Token[] => {
  const tokens: Token[] = [];
  let cursor = position;
  for (;;) {
    const match = matchAt(ATTACHED_AT, text, cursor);
    if (!match) {
      return tokens;
    }
    const [whole, number, letters] = match;
    const end = cursor + whole.length;
    tokens.push({
      start: cursor,
      end,
      family: number === undefined ? "bracketed" : "number",
      core: number ?? letters ?? "",
      join: null,
      attached: true,
    });
    cursor = end;
  }
};

const readSegment = (
  text: string,
  level: HeadLevel,
  headStart: number,
  headEnd: number,
): Omit<Segment, "join"> | null => {
  const before = matchAt(BEFORE_DESIGNATOR, text, headEnd);
  const first = readToken(text, headEnd + (before?.[0].length ?? 0));
  if (first === null || !acceptsToken(level, first, text)) {
    return null;
  }
  const tokens = [first];
  let cursor = first.end;
  const attachFrom = (token: Token) => {
    if (token.family !== "decimal" && token.family !== "number") {
      return;
    }
    const attached = readAttached(text, cursor);
    tokens.push(...attached);
    cursor = attached.at(-1)?.end ?? cursor;
  };
  attachFrom(first);
  for (;;) {
    const connector = matchAt(CONNECTOR_AT, text, cursor);
    if (!connector) {
      break;
    }
    const after = cursor + connector[0].length;
    // A head after the connector opens the next segment.
    if (matchAt(HEAD_AT, text, after) !== null) {
      break;
    }
    const next = readToken(text, after);
    if (
      next === null ||
      next.family !== first.family ||
      !acceptsToken(level, next, text) ||
      (next.family === "decimal" &&
        matchAt(QUANTITY_AT, text, next.end) !== null)
    ) {
      break;
    }
    tokens.push({
      ...next,
      join: connector[2] === undefined ? "list" : "range",
    });
    cursor = next.end;
    attachFrom(next);
  }
  return { level, start: headStart, tokens, end: cursor };
};

const readSegmentAt = (
  text: string,
  position: number,
): Omit<Segment, "join"> | null => {
  const head = matchAt(HEAD_AT, text, position);
  if (!head) {
    return null;
  }
  const level = headLevelOf(head);
  return level === null
    ? null
    : readSegment(text, level, position, position + head[0].length);
};

const skipFillers = (text: string, position: number): number => {
  let cursor = position;
  for (;;) {
    const filler = matchAt(FILLER_AT, text, cursor);
    if (!filler || filler[0].length === 0) {
      return cursor;
    }
    cursor += filler[0].length;
  }
};

const readNextSegment = (text: string, position: number): Segment | null => {
  const cursor = skipFillers(text, position);
  const adjacent = matchAt(ADJACENT_AT, text, cursor);
  const adjacentSegment = readSegmentAt(
    text,
    cursor + (adjacent?.[0].length ?? 0),
  );
  if (adjacentSegment !== null) {
    return { ...adjacentSegment, join: "adjacent" };
  }
  const connector = matchAt(CONNECTOR_AT, text, cursor);
  if (connector) {
    const segment = readSegmentAt(text, cursor + connector[0].length);
    if (segment !== null) {
      return {
        ...segment,
        join: connector[2] === undefined ? "list" : "range",
      };
    }
  }
  const of = matchAt(OF_AT, text, cursor);
  if (of) {
    const segment = readSegmentAt(text, cursor + of[0].length);
    if (segment !== null) {
      return { ...segment, join: "of" };
    }
  }
  return null;
};

/** What the words after a chain say about whose provision it is. */
export type TailEvidence =
  /** Legislation is named after the chain (`zákona`, `Act`, `Gesetz`). */
  | "statuteName"
  /** An abbreviation follows the chain (`ZDPH`, `BGB`, `VOP`). */
  | "abbreviation"
  /** Another document is named after the chain. */
  | "namedDocument"
  /** `této smlouvy`, `hereof`, `dieses Vertrages`. */
  | "selfDeictic"
  /** `Smlouvy`, `of the Agreement`, without a demonstrative. */
  | "ownNoun"
  /** `tohoto článku`, `of this Clause`. */
  | "relativeDeictic";

type Tail = {
  evidence: TailEvidence[];
  /** The chain is read from the citing block's own article or clause. */
  relative: "article" | "clause" | null;
};

const hasTwoCapitals = (token: string): boolean =>
  (token.match(/\p{Lu}/gu)?.length ?? 0) >= 2;

/** Reads what follows the chain: whose provision it is. */
const readTail = (text: string, chainEnd: number): Tail => {
  const tail: Tail = { evidence: [], relative: null };
  let cursor = skipFillers(text, chainEnd);
  const start = matchAt(TAIL_START_AT, text, cursor);
  const gap = start?.[0] ?? "";
  cursor += gap.length;
  // A period and a capital: the sentence ended, and what follows belongs to
  // the next one.
  if (gap.startsWith(".") && /^\p{Lu}/u.test(text.slice(cursor))) {
    return tail;
  }
  const relative = matchAt(RELATIVE_DEICTIC_AT, text, cursor);
  if (relative) {
    const articleLevel = [1, 3, 5].some(
      (group) => relative[group] !== undefined,
    );
    tail.relative = articleLevel ? "article" : "clause";
    tail.evidence.push("relativeDeictic");
    cursor += relative[0].length;
    cursor += matchAt(TAIL_START_AT, text, cursor)?.[0].length ?? 0;
  }
  const demonstrative = matchAt(DEMONSTRATIVE_AT, text, cursor);
  if (demonstrative) {
    const noun = demonstrative[1] ?? demonstrative[2] ?? demonstrative[3] ?? "";
    tail.evidence.push(
      LEGISLATION_NOUN.test(noun) ? "statuteName" : "selfDeictic",
    );
    return tail;
  }
  if (matchAt(SELF_ADVERB_AT, text, cursor) !== null) {
    tail.evidence.push("selfDeictic");
    return tail;
  }
  if (
    matchAt(CZECH_STATUTE_AT, text, cursor) !== null ||
    matchAt(NAMED_STATUTE_AT, text, cursor) !== null
  ) {
    tail.evidence.push("statuteName");
    return tail;
  }
  if (matchAt(OWN_NOUN_AT, text, cursor) !== null) {
    tail.evidence.push("ownNoun");
    return tail;
  }
  const abbreviation = matchAt(ABBREVIATION_AT, text, cursor);
  const abbreviated = abbreviation?.[1];
  if (
    abbreviated !== undefined &&
    hasTwoCapitals(abbreviated) &&
    parseRomanNumeral(abbreviated) === null
  ) {
    tail.evidence.push("abbreviation");
    return tail;
  }
  const named = matchAt(NAMED_DOCUMENT_AT, text, cursor);
  if (named) {
    const noun = named[1] ?? named[2];
    tail.evidence.push(
      noun !== undefined && OWN_DOCUMENT_NOUN.test(noun)
        ? "ownNoun"
        : "namedDocument",
    );
  }
  return tail;
};

export type Chain = {
  segments: Segment[];
  start: number;
  /** End of the last designator. */
  end: number;
  tail: Tail;
  /** Opened by `č.` instead of a head word. */
  loose: boolean;
};

type ChainSpan = Pick<Chain, "segments" | "start" | "end">;

const readChain = (
  text: string,
  level: HeadLevel,
  headStart: number,
  headEnd: number,
): ChainSpan | null => {
  const first = readSegment(text, level, headStart, headEnd);
  if (first === null) {
    return null;
  }
  const segments: Segment[] = [{ ...first, join: "first" }];
  let end = first.end;
  for (;;) {
    const next = readNextSegment(text, end);
    if (next === null) {
      break;
    }
    segments.push(next);
    end = next.end;
  }
  return { segments, start: headStart, end };
};

/** A chain opened by `č.` is worth a question only when everything else says
 *  it is a reference: one roman numeral, then `této smlouvy`. */
const isLooseReference = ({ segments }: ChainSpan, tail: Tail): boolean => {
  const tokens = segments.flatMap((segment) => segment.tokens);
  return (
    tokens.length === 1 &&
    tokens.at(0)?.family === "upperRoman" &&
    tail.evidence.includes("selfDeictic")
  );
};

/** Reads every chain of `text` from `from` on, in order. */
export const readChains = (text: string, from: number): Chain[] => {
  const chains: Chain[] = [];
  const scanner = createHeadScanner();
  scanner.lastIndex = from;
  for (;;) {
    const head = scanner.exec(text);
    if (!head) {
      return chains;
    }
    const level = headLevelOf(head);
    const span = readChain(
      text,
      level ?? "article",
      head.index,
      head.index + head[0].length,
    );
    if (span === null) {
      continue;
    }
    const tail = readTail(text, span.end);
    const loose = level === null;
    if (loose && !isLooseReference(span, tail)) {
      continue;
    }
    chains.push({ ...span, tail, loose });
    scanner.lastIndex = span.end;
  }
};
