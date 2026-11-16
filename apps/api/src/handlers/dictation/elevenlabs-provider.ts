import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import type {
  TranscriptionEndpoint,
  TranscriptionModelId,
} from "@stll/ai-catalog/transcription";
import { TimeoutError, withTimeout } from "@stll/concurrency/with-timeout";
import type { WithTimeoutScheduler } from "@stll/concurrency/with-timeout";
import { fetchWithTimeout, type FetchWithTimeoutInit } from "@stll/fetch";
import { isLanguageCode } from "@stll/locales";
import { readCappedBytes } from "@stll/skills/streaming";

import { env } from "@/api/env";
import {
  invalidResponse,
  loadTranscriptionAudio,
  MAX_RESPONSE_BYTES,
  PROVIDER_TIMEOUT_MS,
  providerFailure,
  timeoutFailure,
  unavailable,
  VOCABULARY_STATUS,
} from "@/api/handlers/dictation/provider";
import type { TranscriptionResult } from "@/api/handlers/dictation/provider";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { admittedDispatchSignal } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { ModelDispatchScope } from "@/api/lib/rate-limit/model-dispatch-admission";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

const ELEVENLABS_DEFAULT_ORIGIN = "https://api.elevenlabs.io";
const ELEVENLABS_US_ORIGIN = "https://api.us.elevenlabs.io";
const ELEVENLABS_EU_ORIGIN = "https://api.eu.residency.elevenlabs.io";
const ELEVENLABS_TRANSCRIPTION_ORIGINS = [
  ELEVENLABS_DEFAULT_ORIGIN,
  ELEVENLABS_US_ORIGIN,
  ELEVENLABS_EU_ORIGIN,
] as const;

/** The ElevenLabs environments a deployment key can belong to. */
export type ElevenLabsEnvironment = "default" | "us" | "eu";

/** Each ElevenLabs environment's API origin; a key works only on its own. */
export const ELEVENLABS_ORIGINS = {
  default: ELEVENLABS_DEFAULT_ORIGIN,
  us: ELEVENLABS_US_ORIGIN,
  eu: ELEVENLABS_EU_ORIGIN,
} as const satisfies Record<
  ElevenLabsEnvironment,
  (typeof ELEVENLABS_TRANSCRIPTION_ORIGINS)[number]
>;

export type ElevenLabsDeployment = {
  apiKey: string;
  environment: ElevenLabsEnvironment;
};

/** The deployment's ElevenLabs key and its environment; `null` offers no
 *  direct ElevenLabs model. */
export const readElevenLabsDeployment = (): ElevenLabsDeployment | null => {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  return apiKey === undefined || apiKey === ""
    ? null
    : { apiKey, environment: env.ELEVENLABS_ENVIRONMENT };
};

/**
 * Whether a deployment's ElevenLabs environment serves an endpoint: the EU
 * residency environment is the EU region, the default and US environments
 * the US region, and either serves organizations elsewhere as outside
 * their region.
 */
export const elevenLabsServes = (
  deployment: ElevenLabsDeployment | null,
  endpoint: TranscriptionEndpoint,
): boolean =>
  deployment !== null &&
  (endpoint === "global" ||
    endpoint === (deployment.environment === "eu" ? "eu" : "us"));

// Zero retention on every request: ElevenLabs keeps neither the audio nor
// the transcript beyond the request.
const transcriptionUrl = (environment: ElevenLabsEnvironment) =>
  `${ELEVENLABS_ORIGINS[environment]}/v1/speech-to-text?enable_logging=false`;

const TRANSCRIPTION_URLS: ReadonlySet<string> = new Set([
  transcriptionUrl("default"),
  transcriptionUrl("us"),
  transcriptionUrl("eu"),
]);

/** Audio goes only to a zero-retention transcription URL of a known
 *  environment, and redirects are refused. */
export const fetchElevenLabsTranscription = async (
  input: string | URL,
  init: FetchWithTimeoutInit,
) => {
  const target = restrictOutboundUrl({
    rawUrl: String(input),
    hostPolicy: {
      type: "exact-origin",
      origins: ELEVENLABS_TRANSCRIPTION_ORIGINS,
    },
    pathPrefixes: ["/v1/speech-to-text"],
  });
  if (target === null || !TRANSCRIPTION_URLS.has(target.href)) {
    return panic("Transcription target is outside the provider policy.");
  }
  return await fetchWithTimeout(target, { ...init, redirect: "error" });
};

const secondsSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER / 1000),
);
const wireSchema = v.object({
  text: v.string(),
  language_code: v.optional(v.nullable(v.string())),
  words: v.optional(
    v.array(
      v.object({
        text: v.string(),
        type: v.optional(v.string()),
        start: v.optional(v.nullable(secondsSchema)),
        end: v.optional(v.nullable(secondsSchema)),
      }),
    ),
    [],
  ),
  audio_duration_secs: v.optional(v.nullable(secondsSchema)),
});

/**
 * The ElevenLabs answer in the shape every transcription returns. Its
 * duration is the provider's when it states one and the measured duration
 * otherwise; word timings must lie within it.
 */
export const normalizeElevenLabsResponse = (
  body: unknown,
  modelId: TranscriptionModelId,
  measuredDurationMs: number,
) => {
  const parsed = v.safeParse(wireSchema, body);
  if (!parsed.success) {
    return Result.err(invalidResponse());
  }
  const { text, language_code, words, audio_duration_secs } = parsed.output;
  const durationMs =
    audio_duration_secs === undefined || audio_duration_secs === null
      ? measuredDurationMs
      : Math.round(audio_duration_secs * 1000);
  if (durationMs < 1) {
    return Result.err(invalidResponse());
  }
  const timed = words.flatMap(({ text: word, type, start, end }) =>
    (type === undefined || type === "word") &&
    start !== undefined &&
    start !== null &&
    end !== undefined &&
    end !== null
      ? [
          {
            startMs: Math.round(start * 1000),
            endMs: Math.round(end * 1000),
            text: word,
          },
        ]
      : [],
  );
  if (
    timed.some(({ startMs, endMs }) => endMs < startMs || endMs > durationMs)
  ) {
    return Result.err(invalidResponse());
  }
  return Result.ok({
    text,
    segments: text === "" ? [] : [{ startMs: 0, endMs: durationMs, text }],
    words: timed,
    detectedLanguage: language_code ?? null,
    durationMs,
    modelId,
    vocabulary:
      VOCABULARY_STATUS[TRANSCRIPTION_MODELS[modelId].vocabularyMechanism],
  } satisfies TranscriptionResult);
};

type TranscribeWithElevenLabsOptions = {
  audio: File;
  modelId: string;
  language?: string | undefined;
  deployment: ElevenLabsDeployment | null;
  scope: ModelDispatchScope;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetchElevenLabsTranscription | undefined;
  scheduleTimeout?: WithTimeoutScheduler | undefined;
};

/** One audio chunk transcribed by ElevenLabs with the deployment's key,
 *  in its environment, with zero retention. */
export const transcribeWithElevenLabs = async ({
  audio,
  modelId,
  language,
  deployment,
  scope,
  signal,
  fetch: fetchProvider = fetchElevenLabsTranscription,
  scheduleTimeout,
}: TranscribeWithElevenLabsOptions) => {
  const abortSignal = admittedDispatchSignal({ ...scope, abortSignal: signal });
  if (!isTranscriptionModelId(modelId) || deployment === null) {
    return Result.err(unavailable());
  }
  const model = TRANSCRIPTION_MODELS[modelId];
  if (model.route !== "elevenlabs") {
    return Result.err(unavailable());
  }
  if (language !== undefined && !isLanguageCode(language)) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: "invalid_language",
        message: "The transcription language must be an ISO 639-1 code.",
        hint: "Use a supported two-letter language code or omit language for automatic detection.",
      }),
    );
  }
  const loaded = await loadTranscriptionAudio(audio);
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { bytes, mime, format, durationMs } = loaded.value;
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), `audio.${format}`);
  form.append("model_id", model.providerModelId);
  if (language !== undefined) {
    form.append("language_code", language);
  }
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");
  const fetched = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async (requestSignal) => {
          const response = await fetchProvider(
            transcriptionUrl(deployment.environment),
            {
              method: "POST",
              headers: { "xi-api-key": deployment.apiKey },
              body: form,
              signal: requestSignal,
              redirect: "error",
              timeout: { type: "headers", ms: PROVIDER_TIMEOUT_MS },
            },
          );
          if (!response.ok) {
            const failure = providerFailure(
              response.status === 429 || response.status >= 500,
            );
            const cancelled = await Result.tryPromise({
              try: async () => await response.body?.cancel(),
              catch: () => failure,
            });
            return Result.err(cancelled.isErr() ? cancelled.error : failure);
          }
          if (response.body === null) {
            return Result.err(invalidResponse());
          }
          const answer = await readCappedBytes(
            response.body,
            MAX_RESPONSE_BYTES,
          );
          if (answer === null) {
            return Result.err(invalidResponse());
          }
          const decoded = Result.try({
            try: (): unknown =>
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(answer),
              ),
            catch: () => invalidResponse(),
          });
          if (decoded.isErr()) {
            return Result.err(decoded.error);
          }
          return normalizeElevenLabsResponse(
            decoded.value,
            modelId,
            durationMs,
          );
        },
        {
          label: "Audio transcription",
          timeoutMs: PROVIDER_TIMEOUT_MS,
          signal: abortSignal,
          scheduleTimeout,
        },
      ),
    catch: (error) =>
      TimeoutError.is(error) ||
      (error instanceof Error && error.name === "TimeoutError")
        ? timeoutFailure()
        : providerFailure(true),
  });
  if (fetched.isErr()) {
    return Result.err(fetched.error);
  }
  if (fetched.value.isErr()) {
    return Result.err(fetched.value.error);
  }
  return Result.ok({
    transcript: fetched.value.value,
    admittedDurationMs: durationMs,
  });
};
