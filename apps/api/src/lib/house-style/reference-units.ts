// Turns a chain's segments into units: each designator with the path it is
// read under, so `čl. XI odst. 2 písm. d)` yields article XI, its paragraph
// 2, and letter d) of that paragraph.

import { panic } from "better-result";

import { parseRomanNumeral } from "@stll/api-contract/magyar-kozlony-designation";

import type { Segment, Token } from "@/api/lib/house-style/reference-chain";
import type { HeadLevel } from "@/api/lib/house-style/reference-grammar";

type UnitKind = "annex" | "article" | "clause" | "item" | "recital";

/** One designator with the path it is read under. */
export type Unit = {
  token: Token;
  kind: UnitKind;
  annex: Token | null;
  /** Null when the chain names no article; `ordinal` is null for one that
   *  cannot be counted (`5a`). */
  article: { ordinal: number | null } | null;
  clausePath: number[] | null;
  /** Letters and romans from the clause down to this unit. */
  items: string[];
  /** A dotted number under a clause head may also be read from the current
   *  article: `odst. 2.1` as sub-clause 1 of clause 2. */
  relativePath: number[] | null;
  /** The head word says letter (`písm.`, `lit.`): a letter wins over a
   *  roman numeral spelled the same. */
  preferLetter: boolean;
};

const RANK = {
  annex: 0,
  section: 1,
  article: 1,
  clause: 2,
  point: 2,
  letter: 3,
  recital: 4,
} as const satisfies Record<HeadLevel, number>;

type ChainContext = {
  annex: Token | null;
  /** `derived` when the article was read off a dotted number (`odst. 5.2`)
   *  rather than named; the next dotted number names its own. */
  article: { ordinal: number | null; derived: boolean } | null;
  clausePath: number[] | null;
  items: string[];
};

const decimalPath = (core: string): number[] | null =>
  /^\d+(?:\.\d+)*$/u.test(core) ? core.split(".").map(Number) : null;

export const tokenOrdinal = (token: Token): number | null =>
  token.family === "upperRoman"
    ? parseRomanNumeral(token.core)
    : (decimalPath(token.core)?.at(0) ?? null);

/** Applies one designator to the chain's context and returns the unit it
 *  names. */
const applyToken = (
  context: ChainContext,
  level: HeadLevel,
  token: Token,
): Unit => {
  const snapshot = (
    kind: UnitKind,
    relativePath: number[] | null = null,
  ): Unit => ({
    token,
    kind,
    annex: context.annex,
    article: context.article,
    clausePath: context.clausePath,
    items: [...context.items],
    relativePath,
    preferLetter: level === "letter",
  });
  if (token.attached || level === "letter") {
    if (token.family === "number") {
      context.clausePath = [...(context.clausePath ?? []), Number(token.core)];
      context.items = [];
      return snapshot("clause");
    }
    context.items = [...context.items, token.core.toLowerCase()];
    return snapshot("item");
  }
  switch (level) {
    case "annex":
      context.annex = token;
      context.article = null;
      context.clausePath = null;
      context.items = [];
      return snapshot("annex");
    case "recital":
      return snapshot("recital");
    case "section":
    case "article": {
      const path = decimalPath(token.core);
      context.items = [];
      if (path !== null && path.length > 1) {
        context.article = { ordinal: path.at(0) ?? null, derived: true };
        context.clausePath = path.slice(1);
        return snapshot("clause");
      }
      context.article = { ordinal: tokenOrdinal(token), derived: false };
      context.clausePath = null;
      return snapshot("article");
    }
    case "clause":
    case "point": {
      if (token.family === "bracketed") {
        context.items = [...context.items, token.core.toLowerCase()];
        return snapshot("item");
      }
      context.items = [];
      const path =
        token.family === "decimal"
          ? decimalPath(token.core)
          : [tokenOrdinal(token) ?? Number(token.core)];
      if (path === null || path.some((part) => !Number.isFinite(part))) {
        context.clausePath = [];
        return snapshot("clause");
      }
      if (path.length > 1 && context.article === null) {
        context.article = { ordinal: path.at(0) ?? null, derived: true };
        context.clausePath = path.slice(1);
        return snapshot("clause", path);
      }
      // `čl. 5 odst. 5.2`: the dotted number repeats its article.
      context.clausePath =
        path.length > 1 && context.article?.ordinal === path.at(0)
          ? path.slice(1)
          : path;
      return snapshot("clause");
    }
    default: {
      level satisfies never;
      return panic("Unhandled level");
    }
  }
};

const trimContext = (context: ChainContext, rank: number): void => {
  if (rank <= RANK.annex) {
    context.annex = null;
  }
  if (rank <= RANK.clause) {
    context.clausePath = null;
  }
  if (
    rank <= RANK.article ||
    (rank <= RANK.clause && context.article?.derived === true)
  ) {
    context.article = null;
  }
  context.items = [];
};

/** `bod (ii)` and `paragraph (b)` name an item, whatever the head word. */
const segmentRank = ({ level, tokens }: Segment): number =>
  (level === "clause" || level === "point") &&
  tokens.at(0)?.family === "bracketed"
    ? RANK.letter
    : RANK[level];

const lacksRank = (context: ChainContext, rank: number): boolean => {
  if (rank <= RANK.annex) {
    return context.annex === null;
  }
  if (rank <= RANK.article) {
    return context.article === null;
  }
  return context.clausePath === null;
};

/** Turns the segments into units, carrying the wider provision down a
 *  descending chain (`čl. XI odst. 2 písm. d)`) and back over an ascending
 *  one (`odst. 2 čl. XI`, `paragraph (b) of Clause 5`). */
export const buildUnits = (segments: readonly Segment[]): Unit[] => {
  const units: Unit[] = [];
  const context: ChainContext = {
    annex: null,
    article: null,
    clausePath: null,
    items: [],
  };
  let previousRank = -1;
  for (const segment of segments) {
    const rank = segmentRank(segment);
    // The wider provision follows only when the chain has not named it yet:
    // in `čl. 5 odst. 2, čl. 6 odst. 3` the second article opens a new path.
    const ascending =
      segment.join === "of" ||
      (segment.join === "adjacent" &&
        rank < previousRank &&
        lacksRank(context, rank));
    if (ascending) {
      const wider: ChainContext = {
        annex: null,
        article: null,
        clausePath: null,
        items: [],
      };
      for (const token of segment.tokens) {
        units.push(applyToken(wider, segment.level, token));
      }
      const own = units.length - segment.tokens.length;
      for (const unit of units.slice(0, own)) {
        unit.annex ??= wider.annex;
        if (unit.kind !== "article" && unit.kind !== "annex") {
          if (unit.article === null && wider.article !== null) {
            unit.article = wider.article;
            unit.relativePath = null;
          }
          if (unit.kind === "item" && unit.clausePath === null) {
            unit.clausePath = wider.clausePath;
          }
        }
      }
      context.annex ??= wider.annex;
      context.article ??= wider.article;
      context.clausePath ??= wider.clausePath;
      previousRank = rank;
      continue;
    }
    // An item set straight after an item sits inside it: `písm. d) bod
    // (ii)`. Articles and clauses side by side are siblings.
    const nests =
      segment.join === "adjacent" &&
      (rank > previousRank || (rank === previousRank && rank === RANK.letter));
    if (!nests) {
      trimContext(context, rank);
    }
    for (const token of segment.tokens) {
      if (!token.attached && token.join !== null) {
        trimContext(context, rank);
      }
      units.push(applyToken(context, segment.level, token));
    }
    previousRank = rank;
  }
  return units;
};
