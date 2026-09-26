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
 * beginning until the budget runs out. The budget is spent on the rendered
 * block, separators and designations included, so what the section hands the
 * prompt is already within it and nothing downstream has to cut again.
 */

import type { Block } from "@stll/legal-ast/document-ast";

// Anchored plain text (`[anchor] text`) is what the decision section already
// puts in front of the model, and the anchor is what the model quotes a
// passage back by. Corpus-neutral despite the name.
import { formatDecisionForPrompt } from "@/api/lib/case-law/analysis-prompt";

type SelectedStatuteProvision = {
  /** The provision's own anchor, from the heading that opens it. */
  anchorId: string;
  /**
   * What the prompt prints for this provision: its anchored blocks, or the
   * bare `[anchor]` designation when none of its wording fit.
   */
  text: string;
  /** Selected because the reader marked it, not because it leads the act. */
  annotated: boolean;
  /** Blocks of this provision did not fit and are missing from `text`. */
  clipped: boolean;
};

export type StatuteProvisionSelection = {
  /** Document order, whichever pass chose them. */
  provisions: readonly SelectedStatuteProvision[];
  /** The rendered block, already within the budget. */
  text: string;
  /** Something was left out or cut: the model is not reading the whole act. */
  partial: boolean;
  omittedProvisionCount: number;
};

type StatuteProvisionSelectionOptions = {
  /** Block anchors the reader's own marks sit on, in any order. */
  annotatedAnchorIds: readonly string[];
  /** The act's blocks, in document order. */
  blocks: readonly Block[];
  maxChars: number;
};

const PROVISION_SEPARATOR = "\n\n";

type StatuteProvisionGroup = {
  anchorId: string;
  /** Anchors of every block filed here, so a mark can find its provision. */
  blockAnchorIds: readonly string[];
  /** One rendered block each: the unit a clip is allowed to cut at. */
  passages: readonly string[];
};

const joinPassages = (passages: readonly string[]): string =>
  passages.join(PROVISION_SEPARATOR);

/** What the prompt prints: the wording, or the designation when none fit. */
const renderProvision = (
  anchorId: string,
  passages: readonly string[],
): string => (passages.length === 0 ? `[${anchorId}]` : joinPassages(passages));

/**
 * Every provision costs its rendered form plus the separator that follows it.
 * Charging the separator to each provision rather than to the gaps between
 * them overshoots by one separator, which keeps the arithmetic monotonic and
 * the final block strictly inside the budget.
 */
const costOf = (rendered: string): number =>
  rendered.length + PROVISION_SEPARATOR.length;

/**
 * The act split into provisions, cut at every heading.
 *
 * Deliberately not a split on the anchor path: a hyphen means different things
 * in different corpora, so `sec-1` and `sec-2` share a prefix while naming two
 * distinct sections, and grouping by that prefix would merge them. A heading is
 * what every corpus agrees opens a new unit. Blocks before the first heading
 * are the act's preamble and form a unit of their own.
 */
const groupByHeading = (
  blocks: readonly Block[],
): readonly StatuteProvisionGroup[] => {
  const groups: {
    anchorId: string;
    blockAnchorIds: string[];
    passages: string[];
  }[] = [];
  for (const block of blocks) {
    const open = groups.at(-1);
    if (open === undefined || block.type === "heading") {
      groups.push({
        anchorId: block.anchorId,
        blockAnchorIds: [],
        passages: [],
      });
    }
    const group = groups.at(-1);
    group?.blockAnchorIds.push(block.anchorId);
    const passage = formatDecisionForPrompt([block]);
    if (passage.length > 0) {
      group?.passages.push(passage);
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
        : passage.length + PROVISION_SEPARATOR.length;
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
/** The same, once the budget has said how much of its wording it gets. */
type BudgetedProvision = AnnotatedProvision & { kept: readonly string[] };

/** What a provision costs when only its designation is printed. */
const designationCost = (group: StatuteProvisionGroup): number =>
  costOf(renderProvision(group.anchorId, []));

/**
 * The budget split over the marked provisions.
 *
 * Designations are reserved first, for all of them, before a single character
 * of wording is spent. Spending greedily instead lets an early provision buy
 * itself a block with room a later one needed to be named at all, and a
 * provision the reader marked would vanish from the prompt entirely. Naming it
 * is the point: the model can ask for wording it can see is missing, not for a
 * provision it was never told exists.
 *
 * What is left after the reservation is then shared as wording, shortest first,
 * so a provision that needs little leaves its remainder to the ones that need
 * much.
 */
const shareBudget = (
  annotated: readonly AnnotatedProvision[],
  budget: number,
): { budgeted: readonly BudgetedProvision[]; remaining: number } => {
  const budgeted: BudgetedProvision[] = [];
  let spent = 0;
  for (const entry of annotated) {
    const cost = designationCost(entry.group);
    if (spent + cost > budget) {
      // Too many marks for the budget to name; keep the act's order and stop.
      break;
    }
    budgeted.push({ ...entry, kept: [] });
    spent += cost;
  }

  let remaining = budget - spent;
  let contenders = budgeted.length;
  // Same object references as `budgeted`, so growing a slot here is seen there.
  for (const slot of budgeted.toSorted(
    (left, right) =>
      joinPassages(left.group.passages).length -
      joinPassages(right.group.passages).length,
  )) {
    const share = Math.floor(remaining / contenders);
    contenders -= 1;
    const designation =
      designationCost(slot.group) - PROVISION_SEPARATOR.length;
    const kept = clipPassages(slot.group.passages, designation + share);
    if (kept.length === 0) {
      continue;
    }
    // A passage opens with `[anchor] `, so wording always costs at least the
    // designation it replaces, and never more than the share on top of it.
    slot.kept = kept;
    remaining -= joinPassages(kept).length - designation;
  }
  return { budgeted, remaining };
};

export const selectStatuteProvisions = ({
  annotatedAnchorIds,
  blocks,
  maxChars,
}: StatuteProvisionSelectionOptions): StatuteProvisionSelection => {
  const groups = groupByHeading(blocks);
  const budget = Math.max(0, maxChars);

  // A mark names a block, so the provision it belongs to is a lookup rather
  // than an inference from the anchor's shape. A mark whose block is gone from
  // this consolidation matches nothing and selects nothing.
  const provisionByBlockAnchor = new Map<string, number>();
  for (const [index, group] of groups.entries()) {
    for (const blockAnchorId of group.blockAnchorIds) {
      provisionByBlockAnchor.set(blockAnchorId, index);
    }
  }
  const marked = new Set(
    annotatedAnchorIds.flatMap((anchorId) => {
      const index = provisionByBlockAnchor.get(anchorId);
      return index === undefined ? [] : [index];
    }),
  );

  const annotated = groups.flatMap((group, index) =>
    marked.has(index) ? [{ group, index }] : [],
  );
  const { budgeted, remaining: afterMarks } = shareBudget(annotated, budget);

  const selected = new Map<number, SelectedStatuteProvision>();
  for (const { group, index, kept } of budgeted) {
    selected.set(index, {
      anchorId: group.anchorId,
      text: renderProvision(group.anchorId, kept),
      annotated: true,
      clipped: kept.length < group.passages.length,
    });
  }

  // The remainder as a prefix of the act: the first provision that does not
  // fit ends the pass, so what the model reads is a beginning rather than an
  // arbitrary sample of the statute.
  let remaining = afterMarks;
  for (const [index, group] of groups.entries()) {
    if (selected.has(index)) {
      continue;
    }
    const text = renderProvision(group.anchorId, group.passages);
    if (costOf(text) > remaining) {
      break;
    }
    selected.set(index, {
      anchorId: group.anchorId,
      text,
      annotated: false,
      clipped: false,
    });
    remaining -= costOf(text);
  }

  const provisions = groups.flatMap((_group, index) => {
    const provision = selected.get(index);
    return provision === undefined ? [] : [provision];
  });
  const omittedProvisionCount = groups.length - provisions.length;

  return {
    provisions,
    // Within `budget` by construction: every provision was charged its
    // rendered length plus one separator, and the join spends one fewer.
    text: provisions.map(({ text }) => text).join(PROVISION_SEPARATOR),
    omittedProvisionCount,
    partial:
      omittedProvisionCount > 0 ||
      provisions.some((provision) => provision.clipped),
  };
};
