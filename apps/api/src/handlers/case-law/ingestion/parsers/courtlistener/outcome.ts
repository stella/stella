/**
 * What a CourtListener text parser returns, and the bounds every parser of
 * one cluster shares.
 *
 * A candidate is one text column of one opinion row. It is `parsed`,
 * `unusable` (selection moves to the next column), `requires-assets` (its
 * text depends on images nothing captured) or `over-limit` (the cluster's
 * shared budget ran out).
 */

import type { AnyNode } from "domhandler";

// parser-output-unchanged: imports the document AST from its package owner
import type { Block } from "@stll/legal-ast/document-ast";

import type { UnitPosition } from "./opinion-class";

/**
 * Named bounds on one cluster's text. Past any, the cluster is held whole;
 * nothing is truncated.
 */
export const COURTLISTENER_TEXT_LIMITS = {
  /** DOM nodes parsed across every candidate the cluster's opinions try. */
  DOM_NODES: 200_000,
  /** Blocks the composed document emits. */
  BLOCKS: 50_000,
  /**
   * Element nesting of one candidate. The walks recurse by depth; court
   * markup nests a few dozen deep, and far deeper nesting would exhaust the
   * stack before the node limit is reached.
   */
  DOM_DEPTH: 256,
} as const;

export type CourtListenerTextLimit = keyof typeof COURTLISTENER_TEXT_LIMITS;

/** Why a candidate cannot be used. Selection records it and moves on. */
export const TEXT_CANDIDATE_UNUSABLE = {
  BLANK: "blank",
  /** A DTD or entity declaration: nothing is expanded or resolved. */
  DECLARED_DTD: "declared-dtd",
  MALFORMED_XML: "malformed-xml",
  /** Well-formed XML holding no `<opinion>` element. */
  MISSING_OPINION: "missing-opinion",
  /** Markup whose visible text is empty, such as a script-only body. */
  NO_VISIBLE_TEXT: "no-visible-text",
  CONTENT_LOSS: "content-loss",
  MARKUP_RESIDUE: "markup-residue",
  /** Some source text did not reach the blocks, in order and in full. */
  TEXT_NOT_CONSERVED: "text-not-conserved",
} as const;

export type TextCandidateUnusable =
  (typeof TEXT_CANDIDATE_UNUSABLE)[keyof typeof TEXT_CANDIDATE_UNUSABLE];

/**
 * A contiguous run of blocks under one structural opinion element, or
 * outside every opinion (caption and front matter).
 */
export type TextUnit = {
  readonly kind: "opinion" | "outside";
  /** The publisher's type attribute on the opinion element, as written. */
  readonly domType: string | null;
  /** The row's own opinion, or an opinion nested inside another. */
  readonly position: UnitPosition;
  /**
   * How the blocks were told apart: by the publisher's markup, which marks
   * notes, or by layout alone, which proves no body and note runs.
   */
  readonly boundaries: "markup" | "layout";
  readonly blocks: readonly Block[];
};

/** Counts a reader of the parse can check against the source. */
export type TextCounts = {
  readonly pageAnchors: number;
  readonly notes: number;
  /** Source note spans that HTML repair could not preserve. */
  readonly noteSpanDefects: number;
  /** Publisher citation links unwrapped to their words. */
  readonly publisherLinks: number;
  /** Characters of printed page labels moved off the text axis. */
  readonly paginationCharacters: number;
  /** Characters of note backlinks whose label moved to the note. */
  readonly backlinkCharacters: number;
  /** Element names outside the format's vocabulary, walked as text. */
  readonly unknownConstructs: Readonly<Record<string, number>>;
};

export type ParsedOpinionText = {
  readonly units: readonly TextUnit[];
  readonly counts: TextCounts;
  /**
   * The source as the content-retention check reads it: the same markup
   * with only the declared removals taken out.
   */
  readonly validationHtml: string;
};

export type FormatParse =
  | { readonly status: "parsed"; readonly text: ParsedOpinionText }
  | { readonly status: "unusable"; readonly reason: TextCandidateUnusable }
  | {
      readonly status: "requires-assets";
      /** Graphic constructs found, by element name. */
      readonly graphics: Readonly<Record<string, number>>;
    }
  | { readonly status: "over-limit"; readonly limit: CourtListenerTextLimit };

/**
 * One budget per cluster: DOM nodes parsed by every candidate its opinions
 * try, and blocks of the candidates already accepted.
 */
export type TextBudget = { domNodes: number; blocks: number };

export const createTextBudget = (): TextBudget => ({ domNodes: 0, blocks: 0 });

/** The blocks one more candidate may emit before the cluster is over. */
export const blockAllowance = (budget: TextBudget): number =>
  COURTLISTENER_TEXT_LIMITS.BLOCKS - budget.blocks;

/**
 * Charges `root`'s nodes to the budget and measures its nesting, without
 * recursing, before any walk does. Stops at the first limit passed, so an
 * oversized tree is not read to its end; `null` when the tree is within both.
 */
export const spendDomNodes = (
  budget: TextBudget,
  root: AnyNode,
): Extract<CourtListenerTextLimit, "DOM_NODES" | "DOM_DEPTH"> | null => {
  const stack: { node: AnyNode; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) {
      break;
    }
    budget.domNodes += 1;
    if (budget.domNodes > COURTLISTENER_TEXT_LIMITS.DOM_NODES) {
      return "DOM_NODES";
    }
    if (next.depth > COURTLISTENER_TEXT_LIMITS.DOM_DEPTH) {
      return "DOM_DEPTH";
    }
    if ("children" in next.node) {
      for (const child of next.node.children) {
        stack.push({ node: child, depth: next.depth + 1 });
      }
    }
  }
  return null;
};
