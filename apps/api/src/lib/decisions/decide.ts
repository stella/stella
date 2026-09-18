/**
 * Typed decisions.
 *
 * A decision is a choice from a closed set, a yes/no, or a score: something
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
import { resolveDecisionModel } from "@/api/lib/decisions/decision-model";
import type {
  SystemOneAnswerFor,
  SystemOneClient,
  SystemOneQuestion,
  SystemOneQuestions,
  SystemOneState,
  SystemOneUsage,
} from "@/api/lib/decisions/system-one";
import { SYSTEM_ONE_USD_PER_INPUT_TOKEN } from "@/api/lib/decisions/system-one";
import { logger } from "@/api/lib/observability/logger";

/**
 * Below this confidence a decision is not taken. Measured against Jev 1.13 on
 * the citation-polarity comparison; move it with the model, not per call
 * site. A site whose cost of a wrong answer is higher passes its own floor.
 */
export const DECISION_ACCEPT_CONFIDENCE = 0.6;

/** Answers arrive in well under a second; the default covers a queued retry. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Readings carried into the log line; the rest of a large batch is cut. */
const READINGS_MAX = 20;

export const DECISION_UNDECIDED_REASONS = [
  /** No decision model is configured for the org or the instance. */
  "no-backend",
  /** The model answered under the confidence floor. */
  "below-floor",
  /** The call failed; the error was captured. */
  "failed",
] as const;
export type DecisionUndecidedReason =
  (typeof DECISION_UNDECIDED_REASONS)[number];

export type Decision<TAnswer> =
  | {
      state: "decided";
      answer: TAnswer;
      /** Probability of the chosen option, the yes for a noul, the top level for a score. */
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
  state: SystemOneState;
  floor?: number | undefined;
  abortSignal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Injected by tests and comparison runs; the org's resolved model otherwise. */
  client?: SystemOneClient | null | undefined;
};

export type DecideManyOptions<TQuestions extends SystemOneQuestions> =
  DecideBaseOptions & { questions: TQuestions };

export type DecideManyResult<TQuestions extends SystemOneQuestions> = {
  decisions: Decisions<TQuestions>;
  /** The versioned model that answered; null when nothing was asked. */
  model: string | null;
  /** What the call cost, for a caller that prices a run; null when nothing was asked. */
  usage: SystemOneUsage | null;
  latencyMs: number | null;
};

export type DecideOptions<TQuestion extends SystemOneQuestion> =
  DecideBaseOptions & { question: TQuestion };

type AnyAnswer = SystemOneAnswerFor<SystemOneQuestion>;

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
        probability: answer.probabilities[answer.choice] ?? 0,
        confidence: answer.confidence,
      };
    case "noul":
      // A noul is one probability; how far it sits from even is its confidence.
      return {
        answer,
        probability: answer.noul,
        confidence: Math.abs(answer.noul * 2 - 1),
      };
    case "score":
      return {
        answer,
        probability: Math.max(0, ...Object.values(answer.probabilities)),
        confidence: answer.confidence,
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
    case "score":
      return answer.score;
    default:
      answer satisfies never;
      return panic("Unhandled decision answer type");
  }
};

const undecidedAll = <TQuestions extends SystemOneQuestions>(
  questions: TQuestions,
  reason: DecisionUndecidedReason,
): Decisions<TQuestions> => {
  const decisions: Record<string, Decision<never>> = {};
  for (const key of Object.keys(questions)) {
    decisions[key] = { state: "undecided", reason, confidence: null };
  }
  // SAFETY: an undecided decision carries no answer, so it inhabits
  // `Decision<T>` for every T, and there is one per question key, which is
  // what the mapped type promises.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- undecided is answer-free and the key set matches the questions
  return decisions as Decisions<TQuestions>;
};

export const decideMany = async <TQuestions extends SystemOneQuestions>({
  id,
  orgAIConfig,
  state,
  questions,
  floor = DECISION_ACCEPT_CONFIDENCE,
  abortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  client,
}: DecideManyOptions<TQuestions>): Promise<DecideManyResult<TQuestions>> => {
  const model =
    client === undefined ? resolveDecisionModel(orgAIConfig) : client;
  if (model === null || Object.keys(questions).length === 0) {
    return {
      decisions: undecidedAll(questions, "no-backend"),
      model: null,
      usage: null,
      latencyMs: null,
    };
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const asked = await model.ask({
    state,
    questions,
    abortSignal: abortSignal
      ? AbortSignal.any([abortSignal, timeout])
      : timeout,
  });
  if (Result.isError(asked)) {
    captureError(asked.error, { source: "decide", decision: id });
    return {
      decisions: undecidedAll(questions, "failed"),
      model: null,
      usage: null,
      latencyMs: null,
    };
  }

  const decisions: Record<string, Decision<AnyAnswer>> = {};
  const readings: Record<string, string | number>[] = [];
  let decided = 0;
  for (const key of Object.keys(questions)) {
    const answer = asked.value.answers[key];
    // `ask` bound one answer per question; a missing key is a transport bug
    // and would have been an error above.
    if (answer === undefined) {
      continue;
    }
    const reading = readAnswer(answer);
    const accepted = reading.confidence >= floor;
    decisions[key] = accepted
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
        };
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
  const questionCount = Object.keys(questions).length;
  logger.info("ai.decision", {
    decision: id,
    model: asked.value.model,
    questionCount,
    decidedCount: decided,
    undecidedCount: questionCount - decided,
    floor,
    inputTokens: asked.value.usage.inputTokens,
    usd: asked.value.usage.inputTokens * SYSTEM_ONE_USD_PER_INPUT_TOKEN,
    latencyMs: asked.value.latencyMs,
    readings: JSON.stringify(readings),
  });
  return {
    // SAFETY: `ask` returned each question's answer in that question's own
    // type, and the loop wrapped each under its own key, which is what
    // `Decisions<TQuestions>` maps per key.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- per-key wrapping of an already per-key typed answer set
    decisions: decisions as Decisions<TQuestions>,
    model: asked.value.model,
    usage: asked.value.usage,
    latencyMs: asked.value.latencyMs,
  };
};

/** One question over one state; `decideMany` for several. */
export const decide = async <TQuestion extends SystemOneQuestion>({
  question,
  ...options
}: DecideOptions<TQuestion>): Promise<
  Decision<SystemOneAnswerFor<TQuestion>>
> => {
  const { decisions } = await decideMany({
    ...options,
    questions: { answer: question },
  });
  return decisions.answer;
};
