import { panic, Result } from "better-result";
import * as v from "valibot";

import { DEFAULT_OPENAI_DECISION_MODEL } from "@stll/api-contract/ai-decision-provider";
import { createFetchWithTimeout } from "@stll/fetch";
import type { Fetcher } from "@stll/fetch";
import { readCappedBytes } from "@stll/skills/streaming";

import {
  bindAnswer,
  hasEveryAnswer,
  SystemOneError,
  SYSTEM_ONE_MAX_CHOICE_OPTIONS,
  SYSTEM_ONE_MAX_QUESTIONS,
  SYSTEM_ONE_MAX_REQUEST_BYTES,
} from "@/api/lib/workflow/decisions/system-one";
import type {
  RefusalAnswer,
  SystemOneAnswer,
  SystemOneClient,
  SystemOneEntry,
  SystemOneQuestions,
  SystemOneState,
  SystemOneErrorKind,
} from "@/api/lib/workflow/decisions/system-one";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5000;
const RETRY_BASE_DELAY_MS = 400;
const OPENAI_DECISION_ENDPOINTS = {
  eu: "https://eu.api.openai.com/v1/decisions",
  global: "https://api.openai.com/v1/decisions",
} as const;

// The installed OpenAI SDK predates Decisions. This validated boundary follows
// https://developers.openai.com/api/reference/resources/decisions/methods/create.
const probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const wireAnswerSchema = v.variant("type", [
  v.object({ type: v.literal("predicate"), name: v.string(), probability }),
  v.object({
    type: v.literal("choice"),
    name: v.string(),
    choice: v.string(),
    confidence: probability,
    probabilities: v.array(v.object({ value: v.string(), probability })),
  }),
  v.object({ type: v.literal("refusal"), name: v.string() }),
]);
const wireResponseSchema = v.object({
  model: v.pipe(v.string(), v.minLength(1)),
  answers: v.array(wireAnswerSchema),
  usage: v.object({
    input_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    output_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
});

const textEntry = (entry: SystemOneEntry): string =>
  typeof entry === "string" ? entry : JSON.stringify(entry);

type SerializeOpenAIDecisionRequestOptions = {
  state: SystemOneState;
  model: string;
  questions: SystemOneQuestions;
};

/** JSON state remains structured text; no role or content is inferred from it. */
export const serializeOpenAIDecisionRequest = ({
  state,
  model,
  questions,
}: SerializeOpenAIDecisionRequestOptions): string =>
  JSON.stringify({
    model,
    input: typeof state === "string" ? state : JSON.stringify(state),
    questions: Object.entries(questions).map(([name, question]) => {
      switch (question.type) {
        case "noul":
          return {
            type: "predicate",
            name,
            instructions:
              question.criteria === undefined
                ? textEntry(question.instructions)
                : JSON.stringify({
                    instructions: question.instructions,
                    criteria: question.criteria,
                  }),
          };
        case "choice":
          return {
            type: "choice",
            name,
            instructions: textEntry(question.instructions),
            choices: Object.entries(question.criteria).map(
              ([value, description]) => ({
                value,
                description: textEntry(description),
              }),
            ),
          };
        default:
          question satisfies never;
          return panic("Unhandled decision question type");
      }
    }),
  });

type OpenAIDecisionsClientOptions = {
  apiKey: string;
  model?: string | undefined;
  region?: "eu" | "global" | undefined;
  fetcher?: Fetcher | undefined;
  /** Per-attempt deadline; defaults to the shared transport timeout. */
  timeoutMs?: number | undefined;
  sleep?:
    | ((ms: number, abortSignal?: AbortSignal) => Promise<void>)
    | undefined;
};

const sleepWithSignal = async (
  ms: number,
  signal?: AbortSignal,
): Promise<void> => {
  const slept = new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(
        new SystemOneError({
          kind: "aborted",
          message: "OpenAI decision retry was cancelled",
          cause: signal?.reason,
        }),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
  await slept;
};

const invalidResponse = (message: string) =>
  Result.err(new SystemOneError({ kind: "invalid_response", message }));

const bindOpenAIResponse = <TQuestions extends SystemOneQuestions>(
  questions: TQuestions,
  body: unknown,
) => {
  const parsed = v.safeParse(wireResponseSchema, body);
  if (!parsed.success) {
    return invalidResponse(
      "OpenAI decision response does not match the documented shape",
    );
  }
  if (parsed.output.answers.length !== Object.keys(questions).length) {
    return invalidResponse(
      "OpenAI decision response has an incorrect answer count",
    );
  }
  const answerMap = new Map<string, SystemOneAnswer | RefusalAnswer>();
  for (const answer of parsed.output.answers) {
    const question = Object.hasOwn(questions, answer.name)
      ? questions[answer.name]
      : undefined;
    if (question === undefined || answerMap.has(answer.name)) {
      return invalidResponse(
        "OpenAI decision response names an unknown or duplicate question",
      );
    }
    switch (answer.type) {
      case "refusal":
        answerMap.set(answer.name, { type: "refusal" });
        break;
      case "predicate": {
        const bound = bindAnswer({
          id: answer.name,
          question,
          answer: {
            type: "noul",
            noul: answer.probability,
          },
        });
        if (Result.isError(bound)) {
          return bound;
        }
        answerMap.set(answer.name, bound.value);
        break;
      }
      case "choice": {
        const probabilities = Object.fromEntries(
          answer.probabilities.map(
            ({ value, probability: valueProbability }) => [
              value,
              valueProbability,
            ],
          ),
        );
        if (Object.keys(probabilities).length !== answer.probabilities.length) {
          return invalidResponse("OpenAI decision response repeats an option");
        }
        const bound = bindAnswer({
          id: answer.name,
          question,
          answer: {
            type: "choice",
            choice: answer.choice,
            confidence: answer.confidence,
            probabilities,
          },
        });
        if (Result.isError(bound)) {
          return bound;
        }
        answerMap.set(answer.name, bound.value);
        break;
      }
      default:
        answer satisfies never;
        return panic("Unhandled OpenAI decision answer type");
    }
  }
  const answers = Object.fromEntries(answerMap);
  if (!hasEveryAnswer(questions, answers)) {
    return invalidResponse("OpenAI decision response omitted an answer");
  }
  return Result.ok({
    model: parsed.output.model,
    answers,
    usage: {
      inputTokens: parsed.output.usage.input_tokens,
      outputTokens: parsed.output.usage.output_tokens,
    },
  });
};

export const createOpenAIDecisionsClient = ({
  apiKey,
  model = DEFAULT_OPENAI_DECISION_MODEL,
  region = "eu",
  fetcher,
  sleep = sleepWithSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: OpenAIDecisionsClientOptions): SystemOneClient => {
  const fetchWithTimeout = createFetchWithTimeout(fetcher ?? globalThis.fetch);
  const send = async (body: string, abortSignal?: AbortSignal) => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const sent = await Result.tryPromise({
        try: async () =>
          await fetchWithTimeout(OPENAI_DECISION_ENDPOINTS[region], {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
            },
            body,
            redirect: "error",
            timeout: { type: "idle", ms: timeoutMs },
            signal: abortSignal,
          }),
        catch: (cause) =>
          new SystemOneError({
            kind: abortSignal?.aborted ? "aborted" : "network",
            message: "OpenAI decision request failed before a response arrived",
            cause,
          }),
      });
      if (Result.isError(sent) || sent.value.ok) {
        return sent;
      }
      const { status, headers } = sent.value;
      // Drain unsuccessful responses before retrying without retaining content.
      const cancelled = await Result.tryPromise({
        try: async () => await sent.value.body?.cancel(),
        catch: (cause) =>
          new SystemOneError({
            kind: "network",
            message: "OpenAI decision response could not be released",
            cause,
          }),
      });
      if (Result.isError(cancelled)) {
        return Result.err(cancelled.error);
      }
      if (status !== 429 || attempt === MAX_ATTEMPTS - 1) {
        return Result.err(
          new SystemOneError({
            kind: "http",
            status,
            message: `OpenAI Decisions responded with HTTP ${String(status)}`,
          }),
        );
      }
      const retryAfter = headers.get("retry-after");
      const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
      const delay = Math.min(
        Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1000
          : RETRY_BASE_DELAY_MS * 2 ** attempt,
        MAX_RETRY_DELAY_MS,
      );
      const waited = await Result.tryPromise({
        try: async () => await sleep(delay, abortSignal),
        catch: (cause) =>
          new SystemOneError({
            kind: abortSignal?.aborted ? "aborted" : "network",
            message: "OpenAI decision retry backoff failed",
            cause,
          }),
      });
      if (Result.isError(waited)) {
        return Result.err(waited.error);
      }
    }
    return panic("OpenAI decision retry ladder fell through");
  };

  return {
    provider: "openai",
    region,
    model,
    ask: async ({ state, questions, abortSignal }) => {
      const startedAt = performance.now();
      if (
        Object.keys(questions).length > SYSTEM_ONE_MAX_QUESTIONS ||
        Object.values(questions).some(
          (question) =>
            question.type === "choice" &&
            Object.keys(question.criteria).length >
              SYSTEM_ONE_MAX_CHOICE_OPTIONS,
        )
      ) {
        return Result.err(
          new SystemOneError({
            kind: "invalid_request",
            message:
              "OpenAI decision request exceeds the local question or option limit",
          }),
        );
      }
      const body = serializeOpenAIDecisionRequest({ state, model, questions });
      if (
        new TextEncoder().encode(body).byteLength > SYSTEM_ONE_MAX_REQUEST_BYTES
      ) {
        return Result.err(
          new SystemOneError({
            kind: "invalid_request",
            message: "OpenAI decision request exceeds the local body limit",
          }),
        );
      }
      const sent = await send(body, abortSignal);
      if (Result.isError(sent)) {
        return sent;
      }
      const bytes = await Result.tryPromise({
        try: async () =>
          sent.value.body === null
            ? new Uint8Array()
            : await readCappedBytes(sent.value.body, MAX_RESPONSE_BYTES),
        catch: (cause) =>
          new SystemOneError({
            kind: abortSignal?.aborted ? "aborted" : "network",
            message: "OpenAI decision response body could not be read",
            cause,
          }),
      });
      if (Result.isError(bytes)) {
        return Result.err(bytes.error);
      }
      const bodyBytes = bytes.value;
      if (bodyBytes === null) {
        return Result.err(
          new SystemOneError({
            kind: "invalid_response",
            message: "OpenAI decision response exceeds the local body limit",
          }),
        );
      }
      const json = Result.try({
        try: (): unknown => JSON.parse(new TextDecoder().decode(bodyBytes)),
        catch: (cause) => {
          let kind: SystemOneErrorKind = "network";
          if (abortSignal?.aborted) {
            kind = "aborted";
          } else if (cause instanceof SyntaxError) {
            kind = "invalid_response";
          }
          return new SystemOneError({
            kind,
            message: "OpenAI decision response could not be read as JSON",
            // JSON parser errors can include response text.
            cause: cause instanceof SyntaxError ? undefined : cause,
          });
        },
      });
      if (Result.isError(json)) {
        return json;
      }
      const bound = bindOpenAIResponse(questions, json.value);
      if (Result.isError(bound)) {
        return bound;
      }
      return Result.ok({
        ...bound.value,
        latencyMs: Math.round(performance.now() - startedAt),
      });
    },
  };
};
