/**
 * Where a replaced decision's block anchors went.
 *
 * A reparse keeps most anchors (stable anchors follow the text, see
 * `stable-block-anchors.ts`), but an anchor still disappears when its block's
 * words changed, when it was split or joined, and on a decision's first write
 * with stable anchors, when every positional anchor goes. A link that carries
 * such an anchor is redirected to the block now holding its text, or reported
 * gone; it must never land on other text.
 *
 * Matching, in order, within the anchor's own supplement or opinion prefix:
 * 1. the same words: the k-th old block with these words goes to the k-th new
 *    block with them, so repeated paragraphs keep their order;
 * 2. the one new block that contains the old words (lines joined into it);
 * 3. the one new block the old words start with (a block split in two lands
 *    on its first part).
 * Steps 2 and 3 need enough words to be unambiguous; anything shorter, or
 * matching several blocks, is gone.
 */

import type { DocumentAst } from "./document-ast.js";
import { blockAnchorPrefix, blockAnchorText } from "./stable-block-anchors.js";

/** One block of the replaced document: its anchor and its words. */
export type ReplacedBlockAnchor = {
  anchorId: string;
  /** `blockAnchorText` of the block. */
  text: string;
};

/** The shortest word key steps 2 and 3 match on. */
const MIN_PARTIAL_MATCH_LENGTH = 12;

type CurrentBlock = { anchorId: string; text: string; prefix: string | null };

/**
 * Whether `target` may receive an anchor from a block with `prefix`. A block
 * whose place is known (main decision, an opinion, a supplement) moves only
 * within it; a publisher anchor carries no place, so it never receives one.
 */
const samePlace = (prefix: string | null, target: CurrentBlock): boolean =>
  prefix === null || prefix === target.prefix;

const onlyMatch = (
  candidates: readonly CurrentBlock[],
  matches: (candidate: CurrentBlock) => boolean,
): string | null => {
  const found = candidates.filter(matches);
  return found.length === 1 ? (found[0]?.anchorId ?? null) : null;
};

/** The replaced document's anchors as the replaced blocks of a document. */
export const replacedBlockAnchorsOf = (
  ast: DocumentAst,
): ReplacedBlockAnchor[] =>
  ast.blocks.map((block) => ({
    anchorId: block.anchorId,
    text: blockAnchorText(block),
  }));

/**
 * For every replaced anchor the current document no longer has: the anchor
 * now holding its text, or null when nothing does. Anchors the current
 * document still has are absent from the result.
 */
export const planAnchorRedirects = (
  replaced: readonly ReplacedBlockAnchor[],
  current: DocumentAst,
): Map<string, string | null> => {
  const currentBlocks: CurrentBlock[] = current.blocks.map((block) => ({
    anchorId: block.anchorId,
    text: blockAnchorText(block),
    prefix: blockAnchorPrefix(block.anchorId),
  }));
  const currentAnchors = new Set(currentBlocks.map(({ anchorId }) => anchorId));

  const occurrence = (
    blocks: readonly { text: string; prefix: string | null }[],
  ) => {
    const seen = new Map<string, number>();
    return blocks.map(({ text, prefix }) => {
      const key = `${prefix ?? ""}\u0000${text}`;
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      return { key, index };
    });
  };
  const currentByOccurrence = new Map<string, string>();
  for (const [position, { key, index }] of occurrence(
    currentBlocks,
  ).entries()) {
    const block = currentBlocks[position];
    if (block !== undefined) {
      currentByOccurrence.set(`${key}\u0000${String(index)}`, block.anchorId);
    }
  }

  const replacedBlocks = replaced.map((block) => ({
    ...block,
    prefix: blockAnchorPrefix(block.anchorId),
  }));
  const redirects = new Map<string, string | null>();
  for (const [position, { key, index }] of occurrence(
    replacedBlocks,
  ).entries()) {
    const block = replacedBlocks[position];
    if (block === undefined || currentAnchors.has(block.anchorId)) {
      continue;
    }
    const sameWords = currentByOccurrence.get(`${key}\u0000${String(index)}`);
    if (sameWords !== undefined) {
      redirects.set(block.anchorId, sameWords);
      continue;
    }
    const candidates = currentBlocks.filter((target) =>
      samePlace(block.prefix, target),
    );
    const partial =
      block.text.length < MIN_PARTIAL_MATCH_LENGTH
        ? null
        : (onlyMatch(candidates, ({ text }) => text.includes(block.text)) ??
          onlyMatch(
            candidates,
            ({ text }) =>
              text.length >= MIN_PARTIAL_MATCH_LENGTH &&
              block.text.startsWith(text),
          ));
    redirects.set(block.anchorId, partial);
  }
  return redirects;
};

type NextAnchorRedirectsOptions = {
  /** The redirects stored before this write. */
  stored: ReadonlyMap<string, string | null>;
  /** `planAnchorRedirects` of the replaced document against the current one. */
  step: ReadonlyMap<string, string | null>;
  /** Every anchor the current document holds. */
  currentAnchors: ReadonlySet<string>;
};

/**
 * The complete redirect set after a write: older redirects follow their
 * target through this write's step (chains are flattened, so a redirect is
 * always one hop), an anchor the current document holds again needs none,
 * and a target that left without a successor makes its redirect gone. Every
 * non-null target is a current anchor and no source is, so there is no cycle.
 */
export const nextAnchorRedirects = ({
  stored,
  step,
  currentAnchors,
}: NextAnchorRedirectsOptions): Map<string, string | null> => {
  const next = new Map<string, string | null>();
  for (const [from, to] of stored) {
    if (currentAnchors.has(from)) {
      continue;
    }
    if (to === null || currentAnchors.has(to)) {
      next.set(from, to);
      continue;
    }
    next.set(from, step.get(to) ?? null);
  }
  for (const [from, to] of step) {
    if (!currentAnchors.has(from)) {
      next.set(from, to);
    }
  }
  return next;
};
