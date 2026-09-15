/**
 * Which provisions of an open act the chat shows the model.
 *
 * A decision fits in a prompt; a consolidated act does not. One runs to
 * hundreds of thousands of characters, so the active-statute section can
 * neither dump it nor clip it at an arbitrary character — a cut mid-sentence
 * reads to the model exactly like an act that ends there. It selects whole
 * provisions instead, and reports what it left out, so the section can tell
 * the model to ask for a designation rather than answer from a silent stump.
 *
 * The rule: the provisions the reader has marked, then the act from its
 * beginning until the budget runs out.
 */

import type { Block } from "@stll/legal-ast/document-ast";
import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";

// Anchored plain text (`[anchor] text`) is what the decision section already
// puts in front of the model, and the anchor is what the model quotes a
// passage back by. Corpus-neutral despite the name.
import { formatDecisionForPrompt } from "@/api/lib/case-law/analysis-prompt";

export type SelectedStatuteProvision = {
  /** The provision's own anchor: `par_90`, `cl_7`, `prilohy`. */
  anchorId: string;
  /** Anchored plain text of the blocks filed under it. */
  text: string;
  /** Selected because the reader marked it, not because it leads the act. */
  annotated: boolean;
  /** Blocks of this provision did not fit and are missing from `text`. */
  clipped: boolean;
};

export type StatuteProvisionSelection = {
  /** Document order, whichever pass chose them. */
  provisions: readonly SelectedStatuteProvision[];
  /** Something was left out or cut: the model is not reading the whole act. */
  partial: boolean;
  omittedProvisionCount: number;
};

type StatuteProvisionSelectionOptions = {
  /** Anchors the reader's own marks sit on, in any order. */
  annotatedAnchorIds: readonly string[];
  /** The act's blocks, in document order. */
  blocks: readonly Block[];
  maxChars: number;
};

const PASSAGE_SEPARATOR = "\n\n";

type StatuteProvisionGroup = {
  anchorId: string;
  /** One rendered block each: the unit a clip is allowed to cut at. */
  passages: readonly string[];
};

const joinPassages = (passages: readonly string[]): string =>
  passages.join(PASSAGE_SEPARATOR);

/**
 * The act split into provisions.
 *
 * A subdivision's nesting lives in its anchor path (`par_3-odst_2` is filed
 * under `par_3`), and a provision's blocks are contiguous, so a run of
 * consecutive blocks sharing a provision anchor is exactly one provision.
 */
const groupByProvision = (
  blocks: readonly Block[],
): readonly StatuteProvisionGroup[] => {
  const groups: { anchorId: string; passages: string[] }[] = [];
  for (const block of blocks) {
    const anchorId = provisionHeadingAnchor(block.anchorId);
    const open = groups.at(-1);
    if (open?.anchorId !== anchorId) {
      groups.push({ anchorId, passages: [] });
    }
    const passage = formatDecisionForPrompt([block]);
    if (passage.length > 0) {
      groups.at(-1)?.passages.push(passage);
    }
  }
  return groups;
};

/**
 * The passages that fit in `limit`, cut only between blocks.
 *
 * A character-level clip would leave a half-written anchor (`[par_9` for
 * `[par_90]`), which the model reads as a different provision. A block is the
 * smallest unit that still says which provision it belongs to.
 */
const clipPassages = (
  passages: readonly string[],
  limit: number,
): readonly string[] => {
  const kept: string[] = [];
  let used = 0;
  for (const passage of passages) {
    const cost =
      kept.length === 0
        ? passage.length
        : passage.length + PASSAGE_SEPARATOR.length;
    if (used + cost > limit) {
      break;
    }
    kept.push(passage);
    used += cost;
  }
  return kept;
};

/** A provision the reader marked, at its place in the act. */
type AnnotatedProvision = { group: StatuteProvisionGroup; index: number };
type BudgetedProvision = AnnotatedProvision & { kept: readonly string[] };

/**
 * The budget split over the marked provisions so that none of them is dropped
 * outright: each draws what it needs up to an equal share, and what a short
 * provision leaves behind raises the share of those still drawing. Shortest
 * first, so the leftovers have accumulated before the greediest one draws.
 *
 * A marked provision can still lose blocks, and at a budget smaller than the
 * number of marks it keeps none of them. It keeps its entry either way: its
 * designation is what lets the model ask for the wording it did not get.
 */
const shareBudget = (
  annotated: readonly AnnotatedProvision[],
  budget: number,
): readonly BudgetedProvision[] => {
  const shortestFirst = annotated.toSorted(
    (left, right) =>
      joinPassages(left.group.passages).length -
      joinPassages(right.group.passages).length,
  );

  const budgeted: BudgetedProvision[] = [];
  let remaining = budget;
  let contenders = shortestFirst.length;
  for (const entry of shortestFirst) {
    const kept = clipPassages(
      entry.group.passages,
      Math.floor(remaining / contenders),
    );
    budgeted.push({ ...entry, kept });
    remaining -= joinPassages(kept).length;
    contenders -= 1;
  }
  return budgeted;
};

export const selectStatuteProvisions = ({
  annotatedAnchorIds,
  blocks,
  maxChars,
}: StatuteProvisionSelectionOptions): StatuteProvisionSelection => {
  const groups = groupByProvision(blocks);
  const budget = Math.max(0, maxChars);
  const marked = new Set(
    annotatedAnchorIds.map((anchorId) => provisionHeadingAnchor(anchorId)),
  );

  const annotated = groups.flatMap((group, index) =>
    marked.has(group.anchorId) ? [{ group, index }] : [],
  );
  const selected = new Map<number, SelectedStatuteProvision>();
  let spent = 0;
  for (const { group, index, kept } of shareBudget(annotated, budget)) {
    const text = joinPassages(kept);
    selected.set(index, {
      anchorId: group.anchorId,
      text,
      annotated: true,
      clipped: kept.length < group.passages.length,
    });
    spent += text.length;
  }

  // The remainder as a prefix of the act: the first provision that does not
  // fit ends the pass, so what the model reads is a beginning rather than an
  // arbitrary sample of the statute.
  let remaining = budget - spent;
  for (const [index, group] of groups.entries()) {
    if (selected.has(index)) {
      continue;
    }
    const text = joinPassages(group.passages);
    if (text.length > remaining) {
      break;
    }
    selected.set(index, {
      anchorId: group.anchorId,
      text,
      annotated: false,
      clipped: false,
    });
    remaining -= text.length;
  }

  const provisions = groups.flatMap((_group, index) => {
    const provision = selected.get(index);
    return provision === undefined ? [] : [provision];
  });
  const omittedProvisionCount = groups.length - provisions.length;

  return {
    provisions,
    omittedProvisionCount,
    partial:
      omittedProvisionCount > 0 ||
      provisions.some((provision) => provision.clipped),
  };
};
