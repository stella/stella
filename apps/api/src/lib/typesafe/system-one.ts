/**
 * TypeSafe System One transport.
 *
 * A System One model (Jev) does not generate text: it reads one `state` and
 * answers typed questions about it, each with a probability distribution.
 * Stella keeps every workflow in code and asks it only for the judgments
 * ordinary code cannot make: how a citing court treats a decision, which
 * option a passage settles, which of the dates found by a regex the question
 * names. The generative path stays where an answer has to be written.
 *
 * One module owns the wire contract: request shape, response validation,
 * retry on rate limiting, and the credential. Callers build questions with
 * the typed constructors below and read answers under the ids they chose.
 * Answers are validated against the questions that produced them, so a
 * choice outside its own criteria is a transport error, never a value.
 */

import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { createFetchWithTimeout } from "@stll/fetch";
import type { Fetcher } from "@stll/fetch";

export const SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_SYSTEM_ONE_MODEL = "jev-latest";

/** Responses arrive in well under a second; the timeout covers a queued retry. */
const REQUEST_TIMEOUT_MS = 30_000;
/** 429 (rate limit) and 529 (overloaded) are the two statuses the API documents as retryable. */
const RETRYABLE_STATUSES = new Set([429, 529]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 5000;

/** Instructions and criteria accept JSON structure, not only strings. */
export type SystemOneEntry =
  | string
  | number
  | boolean
  | null
  | SystemOneEntry[]
  | { [key: string]: SystemOneEntry };

/** What the model evaluates: a passage, or an object of named parts. */
export type SystemOneState =
  | string
  | SystemOneEntry[]
  | Record<string, SystemOneEntry>;

export type ChoiceQuestion<TOption extends string = string> = {
  type: "choice";
  instructions: SystemOneEntry;
  /** Option to rubric; null when the option name needs no gloss. */
  criteria: Record<TOption, SystemOneEntry>;
};

export type NoulQuestion = {
  type: "noul";
  instructions: SystemOneEntry;
  criteria?: { true?: SystemOneEntry; false?: SystemOneEntry } | undefined;
};

export type ScoreQuestion = {
  type: "score";
  instructions: SystemOneEntry;
  /** Ordered levels, lowest first; at least two. */
  criteria: readonly SystemOneEntry[];
};

export type SystemOneQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export type ChoiceAnswer<TOption extends string = string> = {
  type: "choice";
  choice: TOption;
  probabilities: Record<TOption, number>;
  confidence: number;
};

export type NoulAnswer = {
  type: "noul";
  /** Probability that the answer is yes. */
  noul: number;
};

export type ScoreAnswer = {
  type: "score";
  /** Probability-weighted level index; may land between levels. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

export type SystemOneAnswerFor<TQuestion extends SystemOneQuestion> =
  TQuestion extends ChoiceQuestion<infer TOption>
    ? ChoiceAnswer<TOption>
    : TQuestion extends NoulQuestion
      ? NoulAnswer
      : TQuestion extends ScoreQuestion
        ? ScoreAnswer
        : never;

export type SystemOneQuestions = Record<string, SystemOneQuestion>;

export type SystemOneAnswers<TQuestions extends SystemOneQuestions> = {
  [K in keyof TQuestions]: SystemOneAnswerFor<TQuestions[K]>;
};

export type SystemOneUsage = { inputTokens: number; outputTokens: number };

export type SystemOneResult<TQuestions extends SystemOneQuestions> = {
  /** The versioned model that answered, as the response reports it. */
  model: string;
  answers: SystemOneAnswers<TQuestions>;
  usage: SystemOneUsage;
  latencyMs: number;
};

export const SYSTEM_ONE_ERROR_KINDS = [
  "unconfigured",
  "http",
  "invalid_response",
  "network",
] as const;
export type SystemOneErrorKind = (typeof SYSTEM_ONE_ERROR_KINDS)[number];

export class SystemOneError extends TaggedError("SystemOneError")<{
  message: string;
  kind: SystemOneErrorKind;
  status?: number | undefined;
  cause?: unknown;
}> {}

/** Typed constructors, so a question's option type flows into its answer. */
export const choice = <const TOption extends string>(
  instructions: SystemOneEntry,
  criteria: Record<TOption, SystemOneEntry>,
): ChoiceQuestion<TOption> => ({ type: "choice", instructions, criteria });

export const noul = (
  instructions: SystemOneEntry,
  criteria?: NoulQuestion["criteria"],
): NoulQuestion =>
  criteria === undefined
    ? { type: "noul", instructions }
    : { type: "noul", instructions, criteria };

export const score = (
  instructions: SystemOneEntry,
  criteria: readonly SystemOneEntry[],
): ScoreQuestion => ({ type: "score", instructions, criteria });

const unitInterval = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const wireAnswerSchema = v.variant("type", [
  v.object({ type: v.literal("noul"), noul: unitInterval }),
  v.object({
    type: v.literal("choice"),
    choice: v.string(),
    probabilities: v.record(v.string(), unitInterval),
    confidence: unitInterval,
  }),
  v.object({
    type: v.literal("score"),
    score: v.number(),
    legend: v.record(v.string(), v.string()),
    probabilities: v.record(v.string(), unitInterval),
    confidence: unitInterval,
  }),
]);

const wireResponseSchema = v.object({
  model: v.string(),
  answers: v.record(v.string(), wireAnswerSchema),
  usage: v.object({
    input_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    output_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
});

type WireAnswer = v.InferOutput<typeof wireAnswerSchema>;

/**
 * An answer is accepted only in the shape its question promised: the same
 * type, and for a choice an option from its own criteria with a probability
 * for every option. The typed answer is the wire answer after these checks,
 * which is what the cast at the end asserts.
 */
const bindAnswer = (
  id: string,
  question: SystemOneQuestion,
  answer: WireAnswer,
): Result<ChoiceAnswer | NoulAnswer | ScoreAnswer, SystemOneError> => {
  if (answer.type !== question.type) {
    return Result.err(
      new SystemOneError({
        kind: "invalid_response",
        message: `Answer "${id}" is a ${answer.type}, question is a ${question.type}`,
      }),
    );
  }
  if (answer.type !== "choice" || question.type !== "choice") {
    return Result.ok(answer);
  }
  const options = Object.keys(question.criteria);
  const answered = Object.keys(answer.probabilities);
  const complete =
    options.length === answered.length &&
    options.every((option) => option in answer.probabilities);
  if (!complete || !(answer.choice in question.criteria)) {
    return Result.err(
      new SystemOneError({
        kind: "invalid_response",
        message: `Answer "${id}" names options outside its question`,
      }),
    );
  }
  return Result.ok(answer);
};

export type SystemOneRequest<TQuestions extends SystemOneQuestions> = {
  state: SystemOneState;
  questions: TQuestions;
  abortSignal?: AbortSignal | undefined;
};

export type SystemOneClient = {
  model: string;
  ask: <TQuestions extends SystemOneQuestions>(
    request: SystemOneRequest<TQuestions>,
  ) => Promise<Result<SystemOneResult<TQuestions>, SystemOneError>>;
};

export type SystemOneClientOptions = {
  apiKey: string;
  model?: string | undefined;
  endpoint?: string | undefined;
  /** Injected by tests; the runtime's fetch otherwise. */
  fetcher?: Fetcher | undefined;
  /** Injected by tests to skip the backoff wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

const retryDelayMs = (response: Response, attempt: number): number => {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
  }
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
};

const readErrorBody = async (response: Response): Promise<string> => {
  const text = await Result.tryPromise(async () => await response.text());
  return Result.isOk(text) ? text.value.slice(0, 500) : "";
};

export const createSystemOneClient = ({
  apiKey,
  model = DEFAULT_SYSTEM_ONE_MODEL,
  endpoint = SYSTEM_ONE_ENDPOINT,
  fetcher,
  sleep = async (ms) => await Bun.sleep(ms),
}: SystemOneClientOptions): SystemOneClient => {
  const fetchWithTimeout = createFetchWithTimeout(fetcher ?? globalThis.fetch);
  const send = async (
    body: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<Result<Response, SystemOneError>> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const sent = await Result.tryPromise({
        try: async () =>
          await fetchWithTimeout(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body,
            timeoutMs: REQUEST_TIMEOUT_MS,
            signal: abortSignal,
          }),
        catch: (cause) =>
          new SystemOneError({
            kind: "network",
            message: "TypeSafe request failed before a response arrived",
            cause,
          }),
      });
      if (Result.isError(sent)) {
        return sent;
      }
      const response = sent.value;
      if (response.ok) {
        return Result.ok(response);
      }
      if (
        !RETRYABLE_STATUSES.has(response.status) ||
        attempt === MAX_ATTEMPTS - 1
      ) {
        return Result.err(
          new SystemOneError({
            kind: "http",
            status: response.status,
            message: `TypeSafe responded ${String(response.status)}: ${await readErrorBody(response)}`,
          }),
        );
      }
      await sleep(retryDelayMs(response, attempt));
    }
    return Result.err(
      new SystemOneError({
        kind: "http",
        message: "TypeSafe retry ladder exhausted",
      }),
    );
  };

  return {
    model,
    ask: async <TQuestions extends SystemOneQuestions>({
      state,
      questions,
      abortSignal,
    }: SystemOneRequest<TQuestions>): Promise<
      Result<SystemOneResult<TQuestions>, SystemOneError>
    > => {
      const startedAt = performance.now();
      const body = JSON.stringify({ state, model, questions });
      const sent = await send(body, abortSignal);
      if (Result.isError(sent)) {
        return sent;
      }
      const json = await Result.tryPromise({
        try: async (): Promise<unknown> => await sent.value.json(),
        catch: (cause) =>
          new SystemOneError({
            kind: "invalid_response",
            message: "TypeSafe response is not JSON",
            cause,
          }),
      });
      if (Result.isError(json)) {
        return json;
      }
      const parsed = v.safeParse(wireResponseSchema, json.value);
      if (!parsed.success) {
        return Result.err(
          new SystemOneError({
            kind: "invalid_response",
            message: "TypeSafe response does not match the documented shape",
            cause: parsed.issues,
          }),
        );
      }
      const answers: Record<string, ChoiceAnswer | NoulAnswer | ScoreAnswer> =
        {};
      for (const [id, question] of Object.entries(questions)) {
        const answer = parsed.output.answers[id];
        if (answer === undefined) {
          return Result.err(
            new SystemOneError({
              kind: "invalid_response",
              message: `TypeSafe response carries no answer for "${id}"`,
            }),
          );
        }
        const bound = bindAnswer(id, question, answer);
        if (Result.isError(bound)) {
          return bound;
        }
        answers[id] = bound.value;
      }
      return Result.ok({
        model: parsed.output.model,
        // SAFETY: `bindAnswer` checked every answer against its own question
        // (same type; a choice inside its criteria with a probability per
        // option), which is exactly what the mapped type promises per key.
        answers: answers as SystemOneAnswers<TQuestions>,
        usage: {
          inputTokens: parsed.output.usage.input_tokens,
          outputTokens: parsed.output.usage.output_tokens,
        },
        latencyMs: Math.round(performance.now() - startedAt),
      });
    },
  };
};

/** Per-input-token price on the public price list, for the cost a caller logs. */
export const SYSTEM_ONE_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
