/**
 * Which claim of a new run is the claim a reviewer acted on in the previous
 * run of the same document. The one owner of that question: carrying review
 * decisions forward (`carry-over.ts`) reads nothing else.
 *
 * Two passes, each one-to-one or nothing:
 * 1. The same words. Texts are compared after `normaliseClaimText`, so case,
 *    spacing, quote and dash styles do not count, and where the claim sits
 *    does not either: a moved paragraph keeps its claims.
 * 2. Edited words in the same place. A claim with no exact counterpart
 *    matches a claim of the same block (DOCX paragraph or PDF page) whose
 *    words, in order, are at least `CLAIM_MATCH_SIMILARITY_MIN` alike.
 *    Edited words may say something else, so only notes and fact links
 *    follow such a match (`CLAIM_REVIEW_CARRY_RULE`).
 *
 * A pairing is made only when it is the single candidate on both sides.
 * Several candidates are `ambiguous`, none is `unmatched`: a guess would
 * put one claim's decisions on another, so either carries nothing.
 *
 * It also owns what a claim's words are (`claimWords`), which staleness
 * reads to say whether a new fact is on a claim's point.
 */

import { normalizeUnicode } from "@stll/text-normalize";

import type { ClaimAnchor } from "@/api/lib/lists/verification/contract";

/** How alike, in order, two claims' words must be to pair in the same
 *  block (`claimTextSimilarity`): two word edits in ten, one in five. */
export const CLAIM_MATCH_SIMILARITY_MIN = 0.8;

export type MatchableClaim<Id extends string> = {
  id: Id;
  text: string;
  anchor: ClaimAnchor;
};

/** Where a claim of the old run went in the new one. */
export type ClaimMatch<Id extends string> =
  | { type: "matched"; targetId: Id }
  | { type: "changed-text"; targetId: Id; similarity: number }
  | { type: "unmatched" }
  | { type: "ambiguous" };

const QUOTE_PATTERN = /[‘’‚‛′`´]/gu;
const DOUBLE_QUOTE_PATTERN = /[“”„‟″«»]/gu;
const DASH_PATTERN = /[‐-―−]/gu;
const SPACE_PATTERN = /\s+/gu;
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

/** A claim's words as matching compares them: compatibility forms folded,
 *  lower case, one quote and one dash style, single spaces. */
export const normaliseClaimText = (text: string): string =>
  normalizeUnicode(text, "NFKC")
    .toLowerCase()
    .replaceAll(QUOTE_PATTERN, "'")
    .replaceAll(DOUBLE_QUOTE_PATTERN, '"')
    .replaceAll(DASH_PATTERN, "-")
    .replaceAll(SPACE_PATTERN, " ")
    .trim();

/** A text's words as matching compares them, in order. */
export const claimWords = (text: string): string[] =>
  normaliseClaimText(text).match(WORD_PATTERN) ?? [];

/** Fewest word insertions, deletions and substitutions turning one word
 *  sequence into the other. */
const wordEditDistance = (
  left: readonly string[],
  right: readonly string[],
): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [row, word] of left.entries()) {
    const current = [row + 1];
    for (const [column, other] of right.entries()) {
      current.push(
        Math.min(
          (previous[column + 1] ?? 0) + 1,
          (current[column] ?? 0) + 1,
          (previous[column] ?? 0) + (word === other ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
};

/**
 * How alike two claims' words are, in order: one minus the word edit
 * distance over the longer claim's length. Order counts, so "the seller
 * shall pay the buyer" and "the buyer shall pay the seller" are not alike
 * however many words they share. 0 when either side has no words.
 */
export const claimTextSimilarity = (left: string, right: string): number => {
  const leftWords = claimWords(left);
  const rightWords = claimWords(right);
  const longer = Math.max(leftWords.length, rightWords.length);
  if (leftWords.length === 0 || rightWords.length === 0) {
    return 0;
  }
  return 1 - wordEditDistance(leftWords, rightWords) / longer;
};

/** The block a claim sits in, as both runs name it. */
const blockKey = (anchor: ClaimAnchor): string =>
  anchor.type === "docx-block"
    ? `docx:${anchor.blockId}`
    : `pdf:${String(anchor.pageNumber)}`;

const groupBy = <Item>(
  items: readonly Item[],
  key: (item: Item) => string,
): Map<string, Item[]> => {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) {
      groups.set(key(item), [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
};

type Candidate<Id extends string> = { targetId: Id; similarity: number };

/**
 * Where each claim of `source` went in `target`; every source claim gets an
 * entry. No target claim is the match of two source claims.
 */
export const matchClaims = <Id extends string>(
  source: readonly MatchableClaim<Id>[],
  target: readonly MatchableClaim<Id>[],
): Map<Id, ClaimMatch<Id>> => {
  const matches = new Map<Id, ClaimMatch<Id>>();
  const textOf = (claim: MatchableClaim<Id>) => normaliseClaimText(claim.text);
  const sourceByText = groupBy(source, textOf);
  const targetByText = groupBy(target, textOf);

  // Pass 1: the same words, one on each side.
  const unpaired: MatchableClaim<Id>[] = [];
  for (const claim of source) {
    const text = textOf(claim);
    const targets = targetByText.get(text) ?? [];
    const sources = sourceByText.get(text) ?? [];
    const [only] = targets;
    if (only === undefined) {
      unpaired.push(claim);
    } else if (targets.length === 1 && sources.length === 1) {
      matches.set(claim.id, { type: "matched", targetId: only.id });
    } else {
      matches.set(claim.id, { type: "ambiguous" });
    }
  }

  // Pass 2: edited words in the same block, among the target claims no
  // source claim has the exact words of.
  const open = target.filter((claim) => !sourceByText.has(textOf(claim)));
  const openByBlock = groupBy(open, (claim) => blockKey(claim.anchor));
  const candidates = new Map<Id, Candidate<Id>[]>();
  const claimants = new Map<Id, number>();
  for (const claim of unpaired) {
    const found = (openByBlock.get(blockKey(claim.anchor)) ?? []).flatMap(
      (other): Candidate<Id>[] => {
        const similarity = claimTextSimilarity(claim.text, other.text);
        return similarity >= CLAIM_MATCH_SIMILARITY_MIN
          ? [{ targetId: other.id, similarity }]
          : [];
      },
    );
    candidates.set(claim.id, found);
    for (const { targetId } of found) {
      claimants.set(targetId, (claimants.get(targetId) ?? 0) + 1);
    }
  }
  for (const claim of unpaired) {
    const found = candidates.get(claim.id) ?? [];
    const [only] = found;
    if (only === undefined) {
      matches.set(claim.id, { type: "unmatched" });
    } else if (found.length === 1 && claimants.get(only.targetId) === 1) {
      matches.set(claim.id, { type: "changed-text", ...only });
    } else {
      matches.set(claim.id, { type: "ambiguous" });
    }
  }
  return matches;
};
