/**
 * Typed decisions.
 *
 * A decision is a choice from a closed set or a yes/no: something
 * a workflow needs settled and ordinary code cannot settle. `decide` asks the
 * organization's decision model, applies a confidence floor, and returns a
 * `Decision` that is either decided or says why not. The caller narrows on
 * `state` before it can read an answer, so the path a deployment without a
 * decision model takes (`no-backend`) is the same code the caller writes for
 * an answer under the floor: there is no separate "model missing" branch to
 * forget, and the generative or rule-based path stays byte-identical when no
 * model is configured.
 *
 * One call carries every question that shares a state (`decideMany`), which
 * is how the provider prices and how a paragraph-level loop stays one round
 * trip. Every call logs one line: the decision id, the model, what each
 * question chose and how sure it was, tokens and latency, so a decision can
 * be replayed against the generative answer later.
 *
 * Transport failures are telemetry, not errors: the questions come back
 * undecided and the caller continues on its own path.
 */

import { panic, Result } from "better-result";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import type { AIDataClass } from "@/api/lib/chat/ai-data-policy";
import { isManagedProviderAvailable } from "@/api/lib/chat/provider-data-policy";
import { logger } from "@/api/lib/observability/logger";
import { resolveDecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import {
  decisionConfidenceFloor,
  decisionPrice,
} from "@/api/lib/workflow/decisions/decision-policy";
import { recordDecisionUsage } from "@/api/lib/workflow/decisions/decision-usage";
import type { DecisionUsageMetering } from "@/api/lib/workflow/decisions/decision-usage";
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  NoulAnswer,
  NoulQuestion,
  SystemOneAnswer,
  SystemOneAnswerFor,
  SystemOneQuestion,
  SystemOneQuestions,
  SystemOneState,
} from "@/api/lib/workflow/decisions/system-one";
import { isSystemOneAnswerForQuestion } from "@/api/lib/workflow/decisions/system-one";

/** Answers arrive in well under a second; the default covers a queued retry. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Readings carried into the log line; the rest of a large batch is cut. */
const READINGS_MAX = 20;

const DECISION_UNDECIDED_REASONS = [
  /** No decision model is configured for the org or the instance. */
  "no-backend",
  /** The model answered under the confidence floor. */
  "below-floor",
  /** The call failed; the error was captured. */
  "failed",
  "refusal",
] as const;
export type DecisionUndecidedReason =
  (typeof DECISION_UNDECIDED_REASONS)[number];

export type Decision<TAnswer> =
  | {
      state: "decided";
      answer: TAnswer;
      /** Probability of the chosen option, or the yes probability for a noul. */
      probability: number;
      confidence: number;
    }
  | {
      state: "undecided";
      reason: DecisionUndecidedReason;
      /** The model's confidence when it answered under the floor; null otherwise. */
      confidence: number | null;
    };

export type Decisions<TQuestions extends SystemOneQuestions> = {
  [K in keyof TQuestions]: Decision<SystemOneAnswerFor<TQuestions[K]>>;
};

type DecideBaseOptions = {
  /** Stable name of the decision, for the log line and later replay: `case-law.polarity`. */
  id: string;
  orgAIConfig: OrgAIConfig | null | undefined;
  dataClass: AIDataClass;
  state: SystemOneState;
  floor?: number | undefined;
  confidencePurpose?: "default" | "polarity" | undefined;
  abortSignal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Injected by tests and comparison runs; the org's resolved model otherwise. */
  client?: DecisionModel | null | undefined;
  usageMetering?: DecisionUsageMetering | undefined;
};

type DecideManyOptions<TQuestions extends SystemOneQuestions> =
  DecideBaseOptions & { questions: TQuestions };

type DecideManyResult<TQuestions extends SystemOneQuestions> = {
  decisions: Decisions<TQuestions>;
  /** The versioned model that answered; null when nothing was asked. */
  model: string | null;
};

export type DecideOptions<TQuestion extends SystemOneQuestion> =
  DecideBaseOptions & { question: TQuestion };

type AnyAnswer = SystemOneAnswer;

type Reading = {
  answer: AnyAnswer;
  probability: number;
  confidence: number;
};

/** One reading per answer type: what it chose and how sure it was. */
const readAnswer = (answer: AnyAnswer): Reading => {
  switch (answer.type) {
    case "choice":
      return {
        answer,
        probability:
          answer.probabilities[answer.choice] ??
          panic("Decision answer omitted the chosen probability"),
        confidence: answer.confidence,
      };
    case "noul":
      // A noul is one probability; how far it sits from even is its confidence.
      return {
        answer,
        probability: answer.noul,
        confidence: Math.abs(answer.noul * 2 - 1),
      };
    default:
      answer satisfies never;
      return panic("Unhandled decision answer type");
  }
};

const readingValue = (answer: AnyAnswer): string | number => {
  switch (answer.type) {
    case "choice":
      return answer.choice;
    case "noul":
      return answer.noul;
    default:
      answer satisfies never;
      return panic("Unhandled decision answer type");
  }
};

const hasEveryDecision = <TQuestions extends SystemOneQuestions>(
  questions: TQuestions,
  decisions: Record<string, Decision<SystemOneAnswer>>,
): decisions is Decisions<TQuestions> =>
  Object.entries(questions).every(([id, question]) => {
    const decision = decisions[id];
    return (
      Object.hasOwn(decisions, id) &&
      decision !== undefined &&
      (decision.state === "undecided" ||
        isSystemOneAnswerForQuestion(question, decision.answer))
    );
  });

const undecidedAll = <TQuestions extends SystemOneQuestions>(
  questions: TQuestions,
  reason: DecisionUndecidedReason,
): Decisions<TQuestions> => {
  const decisionMap = new Map<string, Decision<SystemOneAnswer>>();
  for (const key of Object.keys(questions)) {
    decisionMap.set(key, { state: "undecided", reason, confidence: null });
  }
  const decisions = Object.fromEntries(decisionMap);
  return hasEveryDecision(questions, decisions)
    ? decisions
    : panic("Undecided decision construction lost a question");
};

export const decideMany = async <TQuestions extends SystemOneQuestions>({
  id,
  orgAIConfig,
  dataClass,
  state,
  questions,
  floor,
  confidencePurpose = "default",
  abortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  client,
  usageMetering,
}: DecideManyOptions<TQuestions>): Promise<DecideManyResult<TQuestions>> => {
  const model =
    client === undefined
      ? resolveDecisionModel(orgAIConfig, dataClass)
      : client;
  // A generative BYOK preflight did not reserve platform funds. Never add an
  // instance-funded decision to that action just because its org has no key.
  if (
    model === null ||
    Object.keys(questions).length === 0 ||
    (model.keySource === "instance" &&
      !isManagedProviderAvailable(model.provider, dataClass)) ||
    (usageMetering && orgAIConfig && model.keySource === "instance")
  ) {
    return { decisions: undecidedAll(questions, "no-backend"), model: null };
  }
  const confidenceFloor =
    floor ?? decisionConfidenceFloor(model.model, confidencePurpose);
  const timeout = AbortSignal.timeout(timeoutMs);
  const asked = await model.ask({
    state,
    questions,
    abortSignal: abortSignal
      ? AbortSignal.any([abortSignal, timeout])
      : timeout,
  });
  if (Result.isError(asked)) {
    if (abortSignal?.aborted) {
      abortSignal.throwIfAborted();
    }
    captureError(asked.error, { source: "decide", decision: id });
    return { decisions: undecidedAll(questions, "failed"), model: null };
  }

  if (usageMetering) {
    await recordDecisionUsage({
      metering: usageMetering,
      keySource: model.keySource,
      provider: model.provider,
      region: model.region,
      inputTokens: asked.value.usage.inputTokens,
    });
  }

  const decisionMap = new Map<string, Decision<SystemOneAnswer>>();
  const readings: Record<string, string | number>[] = [];
  let decided = 0;
  for (const key of Object.keys(questions)) {
    const answer = asked.value.answers[key];
    if (answer === undefined) {
      return panic(`Decision model returned no answer for "${key}"`);
    }
    if (answer.type === "refusal") {
      decisionMap.set(key, {
        state: "undecided",
        reason: "refusal",
        confidence: null,
      });
      if (readings.length < READINGS_MAX) {
        readings.push({ q: key, type: "refusal", state: "undecided" });
      }
      continue;
    }
    const reading = readAnswer(answer);
    const accepted = reading.confidence >= confidenceFloor;
    decisionMap.set(
      key,
      accepted
        ? {
            state: "decided",
            answer: reading.answer,
            probability: reading.probability,
            confidence: reading.confidence,
          }
        : {
            state: "undecided",
            reason: "below-floor",
            confidence: reading.confidence,
          },
    );
    decided += accepted ? 1 : 0;
    if (readings.length < READINGS_MAX) {
      readings.push({
        q: key,
        type: answer.type,
        value: readingValue(answer),
        probability: reading.probability,
        confidence: reading.confidence,
        state: accepted ? "decided" : "below-floor",
      });
    }
  }
  const decisions = Object.fromEntries(decisionMap);
  const questionCount = Object.keys(questions).length;
  logger.info("ai.decision", {
    decision: id,
    model: asked.value.model,
    provider: model.provider,
    questionCount,
    decidedCount: decided,
    undecidedCount: questionCount - decided,
    floor: confidenceFloor,
    inputTokens: asked.value.usage.inputTokens,
    usd: asked.value.usage.inputTokens * decisionPrice(model).usdPerInputToken,
    latencyMs: asked.value.latencyMs,
    readings: JSON.stringify(readings),
  });
  return {
    decisions: hasEveryDecision(questions, decisions)
      ? decisions
      : panic("Decision construction lost a question"),
    model: asked.value.model,
  };
};

/** One question over one state; `decideMany` for several. */
export function decide<TOption extends string>(
  options: DecideOptions<ChoiceQuestion<TOption>>,
): Promise<Decision<ChoiceAnswer<TOption>>>;
export function decide(
  options: DecideOptions<NoulQuestion>,
): Promise<Decision<NoulAnswer>>;
export function decide(
  options: DecideOptions<SystemOneQuestion>,
): Promise<Decision<SystemOneAnswer>>;
export async function decide({
  question,
  ...options
}: DecideOptions<SystemOneQuestion>): Promise<Decision<SystemOneAnswer>> {
  const { decisions } = await decideMany({
    ...options,
    questions: { answer: question },
  });
  return decisions.answer;
}
