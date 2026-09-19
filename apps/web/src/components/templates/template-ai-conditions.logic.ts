/**
 * Pure logic behind the fill form's "Decided by AI" chips: which template
 * fields the decision model answers, what one chip shows, how clicking it
 * cycles the user's override, and which values the decide request carries.
 *
 * The response shape is derived from the Eden client so a contract change on
 * `POST /templates/:templateId/decide-conditions` fails to compile here
 * instead of drifting into a stale local copy.
 */

import { panic } from "better-result";

import type { ReviewStatusTone } from "@stll/ui/review-status-badge";

import type { ResolvedField } from "@/components/templates/template-discover-types";
import type { api } from "@/lib/api";

type DecideConditionsResponse = Awaited<
  ReturnType<ReturnType<typeof api.templates>["decide-conditions"]["post"]>
>;

type DecideConditionsData = Exclude<
  NonNullable<Extract<DecideConditionsResponse, { data: unknown }>["data"]>,
  Response
>;

export type DecidedCondition = DecideConditionsData["conditions"][number];
export type ConditionDecision = DecidedCondition["decision"];
type UndecidedReason = Extract<
  ConditionDecision,
  { state: "undecided" }
>["reason"];

/**
 * A condition the decision model answers: a boolean field carrying an
 * `aiPrompt`. The fill form renders no input for it, so without the chips it
 * stays invisible until the document is generated.
 */
export const isAiDecidedCondition = (field: ResolvedField): boolean =>
  field.inputType === "boolean" &&
  field.aiPrompt !== undefined &&
  field.aiPrompt !== "";

/**
 * What one chip shows. `model` defers to the backend's answer (`null` until
 * the first response lands); `forced` is the value the user set by clicking,
 * which lives in the form values and wins at fill time.
 */
export type ConditionChipState =
  | { kind: "model"; decision: ConditionDecision | null }
  | { kind: "forced"; value: boolean }
  | { kind: "error" };

export const conditionChipState = (
  forcedValue: unknown,
  decision: ConditionDecision | undefined,
): ConditionChipState =>
  typeof forcedValue === "boolean"
    ? { kind: "forced", value: forcedValue }
    : { kind: "model", decision: decision ?? null };

/**
 * Clicking a chip cycles model → forced yes → forced no → model. `undefined`
 * removes the value from the form values, which hands the condition back to
 * the decision model.
 */
export const cycleConditionOverride = (
  forcedValue: unknown,
): boolean | undefined => {
  if (forcedValue === true) {
    return false;
  }
  if (forcedValue === false) {
    return undefined;
  }
  return true;
};

/**
 * The values the decide request carries: what the user entered in fields that
 * remain visible, minus the conditions themselves (the model answers those,
 * and an override is applied locally) and minus keys the form has cleared.
 */
type ConditionRequestValuesOptions = {
  values: Readonly<Record<string, unknown>>;
  conditionPaths: readonly string[];
  visibleFields: readonly Pick<ResolvedField, "kind" | "path">[];
  visibleArrayIndexPaths: readonly string[];
};

const belongsToVisibleField = (
  valuePath: string,
  fields: ConditionRequestValuesOptions["visibleFields"],
  arrayIndexPaths: ConditionRequestValuesOptions["visibleArrayIndexPaths"],
): boolean =>
  arrayIndexPaths.includes(valuePath) ||
  fields.some(
    (field) =>
      valuePath === field.path ||
      (field.kind === "array" && valuePath.startsWith(`${field.path}[`)),
  );

export const conditionRequestValues = ({
  values,
  conditionPaths,
  visibleFields,
  visibleArrayIndexPaths,
}: ConditionRequestValuesOptions): Record<string, unknown> => {
  const excluded = new Set(conditionPaths);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([path, value]) =>
        value !== undefined &&
        !excluded.has(path) &&
        belongsToVisibleField(path, visibleFields, visibleArrayIndexPaths),
    ),
  );
};

/**
 * How long the form settles before the decision model is asked. Long enough
 * that a typed sentence is one question rather than one per keystroke.
 */
export const DECIDE_CONDITIONS_DEBOUNCE_MS = 600;

/**
 * The conditions the user took over, read straight out of the form values: a
 * boolean under a condition's path is an override, anything else (including
 * the `undefined` left by handing a condition back) is not.
 */
export const readConditionOverrides = (
  values: Readonly<Record<string, unknown>>,
  conditionPaths: readonly string[],
): Record<string, boolean> => {
  const overrides: Record<string, boolean> = {};
  for (const path of conditionPaths) {
    const value = values[path];
    if (typeof value === "boolean") {
      overrides[path] = value;
    }
  }
  return overrides;
};

/** Whether the form carries an answer that can inform a decision. */
export const hasEnteredValues = (
  values: Readonly<Record<string, unknown>>,
): boolean => Object.values(values).some(isEnteredValue);

const isEnteredValue = (value: unknown): boolean => {
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return typeof value === "boolean" || typeof value === "number";
};

/** A disabled query may retain its last data. Once the effective request is
 *  empty, treat those decisions as stale so they cannot keep driving the
 *  document preview after the last answer is cleared. */
export const activeConditionDecisions = (
  requestValues: Readonly<Record<string, unknown>>,
  conditions: readonly DecidedCondition[],
): readonly DecidedCondition[] =>
  hasEnteredValues(requestValues) ? conditions : [];

/**
 * Effective answer per condition, keyed by field path: the user's override
 * when set, else the model's answer once it settled. An unsettled condition
 * is absent, because the fill still decides it.
 */
export const effectiveConditionValues = (
  conditions: readonly DecidedCondition[],
  overrides: Readonly<Record<string, boolean>>,
): Record<string, boolean> => {
  const effective: Record<string, boolean> = { ...overrides };
  for (const condition of conditions) {
    if (condition.path in effective) {
      continue;
    }
    if (condition.decision.state === "decided") {
      effective[condition.path] = condition.decision.value;
    }
  }
  return effective;
};

/**
 * Which sentence a chip states. A case rather than a translation key: the
 * component picks a literal key per case, which keeps the interpolated
 * `probability` typed and off the union-of-every-key instantiation path.
 */
type ConditionChipAnswer =
  | { kind: "decided"; value: boolean; probability: number }
  | { kind: "forced"; value: boolean }
  | { kind: "error" }
  | { kind: "notSettled" }
  | { kind: "onGenerate" };

export type ConditionChipDescription = {
  tone: ReviewStatusTone;
  answer: ConditionChipAnswer;
};

/**
 * A user-set value reads as theirs, a model answer carries its probability,
 * and anything unanswered says plainly that the fill decides it.
 */
export const describeConditionChip = (
  state: ConditionChipState,
): ConditionChipDescription => {
  switch (state.kind) {
    case "forced":
      return {
        tone: "highlight",
        answer: { kind: "forced", value: state.value },
      };
    case "error":
      return { tone: "destructive", answer: { kind: "error" } };
    case "model": {
      const { decision } = state;
      if (decision === null) {
        return { tone: "neutral", answer: { kind: "onGenerate" } };
      }
      switch (decision.state) {
        case "decided":
          return {
            tone: decision.value ? "success" : "neutral",
            answer: {
              kind: "decided",
              value: decision.value,
              probability: decision.probability,
            },
          };
        case "undecided":
          return {
            tone: UNDECIDED_TONE[decision.reason],
            answer: UNDECIDED_ANSWER[decision.reason],
          };
        default:
          decision satisfies never;
          return panic(`Unhandled condition decision: ${String(decision)}`);
      }
    }
    default:
      state satisfies never;
      return panic(`Unhandled condition chip state: ${String(state)}`);
  }
};

/** "Below the floor" is the one undecided reason the entered details could
 *  have settled, so it reads as an open question rather than a quiet
 *  no-answer. */
const UNDECIDED_TONE = {
  "below-floor": "warning",
  "no-backend": "neutral",
  failed: "neutral",
} as const satisfies Record<UndecidedReason, ReviewStatusTone>;

const UNDECIDED_ANSWER = {
  "below-floor": { kind: "notSettled" },
  "no-backend": { kind: "onGenerate" },
  failed: { kind: "onGenerate" },
} as const satisfies Record<UndecidedReason, ConditionChipAnswer>;

/** Whole percent, so `0.962` reads as `96 %` (or `96%`, per locale). */
const PROBABILITY_FORMAT = {
  style: "percent",
  maximumFractionDigits: 0,
} as const satisfies Intl.NumberFormatOptions;

/**
 * Render a decision probability through the caller's locale-aware formatter
 * (`useFormatter`), never a bare `Intl.NumberFormat`: the user's numbering
 * system and percent spacing both come from the active locale. Clamped,
 * because a scored probability just outside [0, 1] would otherwise read as
 * `101 %`.
 */
export const formatProbability = (
  probability: number,
  formatNumber: (value: number, options: typeof PROBABILITY_FORMAT) => string,
): string =>
  formatNumber(Math.min(1, Math.max(0, probability)), PROBABILITY_FORMAT);
