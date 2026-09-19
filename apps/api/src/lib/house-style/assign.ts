/**
 * Which house style each paragraph gets.
 *
 * Two tiers, in order. The decision model reads the style guide and the
 * paragraph's own evidence and chooses one style from the closed set, with a
 * probability; a choice under the floor, a failed call and a deployment with
 * no decision model all arrive as the same `undecided`. Whatever is left
 * falls to a rule over the catalogue's outline levels, which is what a
 * conversion without a model is: it still converts, just more bluntly.
 *
 * Batches are independent: no batch is told what an earlier batch decided,
 * so they run concurrently and a rerun of one batch is the same question.
 */

import { mapWithConcurrency } from "@stll/concurrency";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import {
  DECISION_ACCEPT_CONFIDENCE,
  decideMany,
} from "@/api/lib/decisions/decide";
import type { DecisionUndecidedReason } from "@/api/lib/decisions/decide";
import { choice } from "@/api/lib/decisions/system-one";
import type {
  ChoiceQuestion,
  SystemOneClient,
  SystemOneEntry,
} from "@/api/lib/decisions/system-one";
import type {
  CatalogueStyle,
  StyleCatalogue,
} from "@/api/lib/house-style/catalogue";
import type { StyleGuide } from "@/api/lib/house-style/guide";
import type { ParagraphFeatures } from "@/api/lib/house-style/paragraphs";

/** The decision's stable name, for its log line and a later replay. */
export const HOUSE_STYLE_DECISION_ID = "document.house-style";

/** The option that says no house style fits; the rule tier then answers. */
export const NO_HOUSE_STYLE = "__none";

/**
 * Paragraphs per `decideMany` call. The state carries the guide and the
 * batch once, but the criteria are repeated per question, so the request
 * grows with the paragraph count times the style count; a style set with
 * twenty styles overran the model's input limit at twenty-four paragraphs.
 */
export const DEFAULT_BATCH_SIZE = 12;
export const DEFAULT_BATCH_CONCURRENCY = 4;

export const ASSIGNMENT_TIERS = ["decision-model", "rule"] as const;
export type AssignmentTier = (typeof ASSIGNMENT_TIERS)[number];

export type ParagraphAssignment = {
  index: number;
  styleId: string;
  tier: AssignmentTier;
  /** The chosen option's probability; null where the rule decided. */
  probability: number | null;
  /** Why the model did not settle it, when it was asked and did not. */
  undecidedReason: DecisionUndecidedReason | null;
};

export const planDecisionBatches = (
  features: readonly ParagraphFeatures[],
  size: number,
): ParagraphFeatures[][] => {
  const batches: ParagraphFeatures[][] = [];
  for (let start = 0; start < features.length; start += size) {
    batches.push([...features.slice(start, start + size)]);
  }
  return batches;
};

/** One question id per paragraph, derived from its position, so answers bind back. */
export const questionKey = (index: number): string => `p${String(index)}`;

const paragraphState = (features: ParagraphFeatures): SystemOneEntry => ({
  index: features.index,
  text: features.text,
  original_style: features.originalStyleName,
  outline_level: features.outlineLevel,
  numbering_level: features.numberingLevel,
  number_format: features.numberFormat,
  number_example: features.numberExample,
  typed_marker: features.typedMarker,
  bold: features.bold,
  all_caps: features.allCaps,
  centred: features.centred,
  in_table: features.inTable,
  previous: features.previous,
  next: features.next,
});

const INSTRUCTIONS =
  "Choose the house style this paragraph should carry in the converted " +
  "document. Read the paragraph named by `index` in `state.paragraphs`, and " +
  "judge it against the style guide in `state.guide`: what the paragraph " +
  "says, the style it carried before, its outline and numbering level, " +
  "whether it is bold, capitalised or centred, any number the drafter typed " +
  "into the text, and what surrounds it. The style it carried before is " +
  "evidence, not an answer: a document drafted in plain styles marks its " +
  "headings with bold text and hand-typed numbers alone.";

export type BatchRequest = {
  state: Record<string, SystemOneEntry>;
  questions: Record<string, ChoiceQuestion>;
};

/**
 * One state for the whole batch and one question per paragraph: the guide and
 * the surrounding paragraphs are read once, which is how the provider prices
 * a batch and why a paragraph is judged in its context.
 */
export const buildBatchRequest = ({
  features,
  guide,
}: {
  features: readonly ParagraphFeatures[];
  guide: StyleGuide;
}): BatchRequest => {
  // One line per option, because the criteria are repeated in every question
  // of the batch; the whole guide entry sits in the state, which is sent once.
  const criteria: Record<string, SystemOneEntry> = {};
  for (const entry of guide.styles) {
    criteria[entry.id] = `${entry.name}: ${entry.purpose}`;
  }
  criteria[NO_HOUSE_STYLE] = "No house style fits; keep it as plain body text.";
  const questions: Record<string, ChoiceQuestion> = {};
  for (const paragraph of features) {
    questions[questionKey(paragraph.index)] = choice(
      { task: INSTRUCTIONS, index: paragraph.index },
      criteria,
    );
  }
  return {
    state: {
      guide: guide.styles.map((entry) => ({ ...entry })),
      paragraphs: features.map(paragraphState),
    },
    questions,
  };
};

/**
 * The catalogue read as a hierarchy: the outline levels a heading style sits
 * on, and the style ordinary prose falls back to. This is the whole of what
 * the rule tier knows, which is why it is only a fallback.
 */
export type RulePlan = {
  headingByLevel: Map<number, string>;
  numberedBodyByLevel: Map<number, string>;
  bodyStyleId: string;
};

/**
 * A style's depth: the list level it sits on, or its outline level where it
 * belongs to no list. The list level is read first because `w:outlineLvl` is
 * inherited through `basedOn` and real house documents set it on some levels
 * and not others, so a second-level heading based on the first often claims
 * the first's outline level.
 */
const styleDepth = ({ formatting }: CatalogueStyle): number | null =>
  formatting.numbering?.level ?? formatting.outlineLevel ?? null;

/** A style that prints a number, or declares an outline level, heads a level. */
const headsALevel = ({ formatting }: CatalogueStyle): boolean =>
  formatting.outlineLevel !== null ||
  (formatting.numbering !== null && formatting.numbering.format !== "none");

export const planRuleTier = (
  catalogue: StyleCatalogue,
  guide: StyleGuide,
): RulePlan | null => {
  const headingByLevel = new Map<number, string>();
  const numberedBodyByLevel = new Map<number, string>();
  const byId = new Map(catalogue.styles.map((style) => [style.id, style]));
  // The catalogue is everything the set defines; the guide is what the house
  // uses. A content-free set has no usage counts, so the guide's order breaks
  // the tie between two styles on one level.
  const guideOrder = new Map(
    guide.styles.map(({ id }, index) => [id, index] as const),
  );
  const guided = catalogue.styles
    .filter(({ id }) => guideOrder.has(id))
    .toSorted(
      (left, right) =>
        right.usageCount - left.usageCount ||
        (guideOrder.get(left.id) ?? 0) - (guideOrder.get(right.id) ?? 0),
    );
  const keep = (
    levels: Map<number, string>,
    level: number,
    candidate: CatalogueStyle,
  ): void => {
    const kept = byId.get(levels.get(level) ?? "");
    if (kept === undefined || candidate.usageCount > kept.usageCount) {
      levels.set(level, candidate.id);
    }
  };
  for (const style of guided) {
    const depth = styleDepth(style);
    if (depth === null) {
      continue;
    }
    keep(
      headsALevel(style) ? headingByLevel : numberedBodyByLevel,
      depth,
      style,
    );
  }
  // Plain body text is the style a paragraph carries when it names none;
  // where the style set does not use it, the most used style outside the
  // hierarchy stands in.
  const body =
    catalogue.styles.find(({ id }) => id === catalogue.defaultStyleId) ??
    guided.find((style) => styleDepth(style) === null) ??
    guided.at(0);
  if (body === undefined) {
    return null;
  }
  return { headingByLevel, numberedBodyByLevel, bodyStyleId: body.id };
};

/**
 * The deterministic tier: an outline level becomes the house heading of that
 * depth, a numbered paragraph the house body style of its level, and
 * everything else the main body style. It reads no text, so it cannot see a
 * heading that only looks like one.
 */
export const ruleStyleId = (
  features: ParagraphFeatures,
  plan: RulePlan,
): string => {
  if (features.outlineLevel !== null) {
    const levels = [...plan.headingByLevel.keys()].sort(
      (left, right) => left - right,
    );
    const deepest = levels.at(-1);
    const level =
      plan.headingByLevel.get(features.outlineLevel) ??
      (deepest === undefined
        ? undefined
        : plan.headingByLevel.get(Math.min(features.outlineLevel, deepest)));
    if (level !== undefined) {
      return level;
    }
  }
  if (features.numberingLevel !== null) {
    const numbered = plan.numberedBodyByLevel.get(features.numberingLevel);
    if (numbered !== undefined) {
      return numbered;
    }
  }
  return plan.bodyStyleId;
};

export type DecisionUsage = {
  requests: number;
  inputTokens: number;
  latenciesMs: number[];
  /** The versioned model that answered, as the first answering call reports it. */
  model: string | null;
};

export type AssignHouseStylesOptions = {
  features: readonly ParagraphFeatures[];
  guide: StyleGuide;
  catalogue: StyleCatalogue;
  orgAIConfig: OrgAIConfig | null;
  /** Paragraphs put to the model; the rest take the rule tier. */
  limit?: number | null | undefined;
  batchSize?: number | undefined;
  concurrency?: number | undefined;
  abortSignal?: AbortSignal | undefined;
  /** A test seam and the script's pinned model; the org's otherwise. */
  client?: SystemOneClient | null | undefined;
};

export type AssignHouseStylesResult = {
  assignments: ParagraphAssignment[];
  usage: DecisionUsage;
};

export const assignHouseStyles = async ({
  features,
  guide,
  catalogue,
  orgAIConfig,
  limit = null,
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_BATCH_CONCURRENCY,
  abortSignal,
  client,
}: AssignHouseStylesOptions): Promise<AssignHouseStylesResult> => {
  const plan = planRuleTier(catalogue, guide);
  const usage: DecisionUsage = {
    requests: 0,
    inputTokens: 0,
    latenciesMs: [],
    model: null,
  };
  if (plan === null) {
    // A style set whose document uses no paragraph style at all; there is
    // nothing to assign and the caller keeps the source styles.
    return { assignments: [], usage };
  }
  const asked = limit === null ? features : features.slice(0, limit);
  const decided = new Map<number, ParagraphAssignment>();

  const batches = planDecisionBatches(asked, batchSize);
  const results = await mapWithConcurrency({
    items: batches,
    limit: concurrency,
    operation: async (batch: ParagraphFeatures[]) => {
      const { state, questions } = buildBatchRequest({
        features: batch,
        guide,
      });
      return {
        batch,
        answered: await decideMany({
          id: HOUSE_STYLE_DECISION_ID,
          orgAIConfig,
          state,
          questions,
          floor: DECISION_ACCEPT_CONFIDENCE,
          ...(abortSignal ? { abortSignal } : {}),
          ...(client === undefined ? {} : { client }),
        }),
      };
    },
  });

  const known = new Set(catalogue.styles.map((style) => style.id));
  for (const { batch, answered } of results) {
    usage.requests += 1;
    usage.inputTokens += answered.usage?.inputTokens ?? 0;
    if (answered.latencyMs !== null) {
      usage.latenciesMs.push(answered.latencyMs);
    }
    usage.model ??= answered.model;
    for (const paragraph of batch) {
      const decision = answered.decisions[questionKey(paragraph.index)];
      if (decision === undefined || decision.state === "undecided") {
        decided.set(paragraph.index, {
          index: paragraph.index,
          styleId: ruleStyleId(paragraph, plan),
          tier: "rule",
          probability: null,
          undecidedReason: decision?.reason ?? null,
        });
        continue;
      }
      const chosen = decision.answer.choice;
      // A choice outside the catalogue cannot be applied; the transport
      // already refuses an option outside the question, so this is the
      // `__none` branch and any style the guide named but the set lost.
      decided.set(paragraph.index, {
        index: paragraph.index,
        styleId: known.has(chosen) ? chosen : ruleStyleId(paragraph, plan),
        tier: known.has(chosen) ? "decision-model" : "rule",
        probability: known.has(chosen) ? decision.probability : null,
        undecidedReason: null,
      });
    }
  }

  return {
    assignments: features.map(
      (paragraph) =>
        decided.get(paragraph.index) ?? {
          index: paragraph.index,
          styleId: ruleStyleId(paragraph, plan),
          tier: "rule" as const,
          probability: null,
          undecidedReason: null,
        },
    ),
    usage,
  };
};
