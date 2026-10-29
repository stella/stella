/**
 * Heading levels read from the headings' own designators.
 *
 * A judgment's outline nests by the family of each heading's designator:
 * `V. Analysis` > `C. The burden of proof` > `1. The first complaint` >
 * `(a) Arguments of the parties`, or a ground of appeal > `– Findings of the
 * Court`. The published corpus stores some of these subheadings at the level
 * of the heading they belong under, so they read as its siblings: the
 * reader's contents list `(a) Arguments of the parties` once per complaint
 * with the same path, and the breadcrumb leaves out which complaint is being
 * read. The reader nests them the way the outline does. Storage keeps the
 * levels the source gave.
 *
 * The rule, as an outline reads: a heading whose designator family has not
 * been seen on the way down from the top opens a level below the heading
 * before it; one whose family was seen above returns to that family's level,
 * closing everything opened since. A heading with no designator keeps its
 * stored level and closes whatever was opened at or below it. No heading is
 * ever moved above its stored level, so a document whose stored levels
 * already nest is returned as it is.
 */

import type { Block, HeadingBlock, HeadingLevel } from "./document-ast.js";

/** How a designator is set off: `1.`, `(1)` or `a)`, or a leading dash. */
type DesignatorStyle = "dot" | "paren" | "close-paren" | "dash";

/** What counts in a designator. */
type DesignatorKind =
  | "upper-roman"
  | "upper-letter"
  | "arabic"
  | "lower-roman"
  | "lower-letter"
  | "dash";

type Designator = {
  kind: DesignatorKind;
  style: DesignatorStyle;
  token: string;
};

/** A family: designators that count in the same series, set off alike. */
const familyOf = ({ kind, style }: Designator) => `${kind}:${style}`;

const DASH = /^\s*[–—-]\s+\S/u;

/** Each delimited style, tried in this order; the token is group 1. */
const DELIMITED_STYLES = [
  ["paren", /^\s*\(([^\s()]{1,6})\)\s+\S/u],
  ["close-paren", /^\s*([^\s().]{1,6})\)\s+\S/u],
  ["dot", /^\s*([^\s.()]{1,6})\.\s+\S/u],
] as const satisfies readonly (readonly [DesignatorStyle, RegExp])[];

/** The delimited token a title starts with, and how it is set off. */
const delimitedToken = (
  title: string,
): { style: DesignatorStyle; token: string } | null => {
  for (const [style, pattern] of DELIMITED_STYLES) {
    const token = pattern.exec(title)?.[1];
    if (token !== undefined) {
      return { style, token };
    }
  }
  return null;
};

const ROMAN_VALUES: Readonly<Record<string, number>> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

/** A roman numeral's value, or null when the token is not one. */
const romanValue = (token: string): number | null => {
  const digits = [...token.toLowerCase()].map((digit) => ROMAN_VALUES[digit]);
  if (digits.length === 0 || digits.some((value) => value === undefined)) {
    return null;
  }
  let total = 0;
  for (const [index, value = 0] of digits.entries()) {
    const next = digits[index + 1] ?? 0;
    total += value < next ? -value : value;
  }
  return total > 0 ? total : null;
};

/** A single letter's place in the alphabet, from 1. */
const letterOrdinal = (token: string): number =>
  (token.toLowerCase().codePointAt(0) ?? 0) - ("a".codePointAt(0) ?? 0) + 1;

type OpenHeading = {
  /** Null for a heading without a designator: it opens a level, no family. */
  family: string | null;
  level: HeadingLevel;
  /** The last designator's value in its series, to read `C` after `B`. */
  ordinal: number;
};

/**
 * The designator a heading starts with, or null. A single letter that is
 * also a roman numeral (`C`, `I`, `v`) is read in the series it continues:
 * `C` after `B` is a letter, `VI` after `V` a numeral; with neither open,
 * `I`, `V` and `X` read as numerals and the rest as letters.
 */
const designatorOf = (
  title: string,
  open: readonly OpenHeading[],
): (Designator & { ordinal: number }) | null => {
  if (DASH.test(title)) {
    return { kind: "dash", style: "dash", token: "–", ordinal: 0 };
  }
  const delimited = delimitedToken(title);
  if (delimited === null) {
    return null;
  }
  const { style, token } = delimited;
  if (/^\d{1,3}$/u.test(token)) {
    return { kind: "arabic", style, token, ordinal: Number(token) };
  }
  const upper = /^[A-Z]+$/u.test(token);
  const lower = /^[a-z]+$/u.test(token);
  if (!upper && !lower) {
    return null;
  }
  const roman = romanValue(token);
  const romanKind: DesignatorKind = upper ? "upper-roman" : "lower-roman";
  const letterKind: DesignatorKind = upper ? "upper-letter" : "lower-letter";
  if (token.length > 1) {
    return roman === null
      ? null
      : { kind: romanKind, style, token, ordinal: roman };
  }
  const letter = letterOrdinal(token);
  if (roman === null) {
    return { kind: letterKind, style, token, ordinal: letter };
  }
  const continues = (kind: DesignatorKind, ordinal: number) =>
    open.some(
      (heading) =>
        heading.family === `${kind}:${style}` &&
        heading.ordinal + 1 === ordinal,
    );
  if (continues(letterKind, letter)) {
    return { kind: letterKind, style, token, ordinal: letter };
  }
  if (continues(romanKind, roman)) {
    return { kind: romanKind, style, token, ordinal: roman };
  }
  return /^[ivx]$/iu.test(token)
    ? { kind: romanKind, style, token, ordinal: roman }
    : { kind: letterKind, style, token, ordinal: letter };
};

const ONE_LEVEL_DEEPER = {
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
  6: 6,
} as const satisfies Record<HeadingLevel, HeadingLevel>;

const deeperOf = (left: HeadingLevel, right: HeadingLevel): HeadingLevel =>
  left >= right ? left : right;

/**
 * The blocks with every heading at the level its designator places it in the
 * outline, never above its stored level. Every block whose level stays is
 * returned as it is.
 */
export const withDesignatorHeadingLevels = (
  blocks: readonly Block[],
): Block[] => {
  const open: OpenHeading[] = [];
  const closeFrom = (level: HeadingLevel) => {
    while ((open.at(-1)?.level ?? 0) >= level) {
      open.pop();
    }
  };
  return blocks.map((block): Block => {
    if (block.type !== "heading") {
      return block;
    }
    const designator = designatorOf(block.plainText, open);
    if (designator === null) {
      closeFrom(block.level);
      open.push({ family: null, level: block.level, ordinal: 0 });
      return block;
    }
    const family = familyOf(designator);
    const seenAt = open.findIndex((heading) => heading.family === family);
    let outlineLevel = block.level;
    if (seenAt === -1) {
      // A family not seen on the way down opens below the heading before it.
      const parent = open.at(-1);
      if (parent !== undefined) {
        outlineLevel = ONE_LEVEL_DEEPER[parent.level];
      }
    } else {
      // A family seen above returns to its level, closing what opened since.
      outlineLevel = open[seenAt]?.level ?? block.level;
      open.length = seenAt;
    }
    const level = deeperOf(outlineLevel, block.level);
    closeFrom(level);
    open.push({ family, level, ordinal: designator.ordinal });
    return level === block.level
      ? block
      : ({ ...block, level } satisfies HeadingBlock);
  });
};
