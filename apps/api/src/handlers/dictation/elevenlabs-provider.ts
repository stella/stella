import { Result } from "better-result";
import * as v from "valibot";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import type {
  TranscriptionEndpoint,
  TranscriptionModelId,
} from "@stll/ai-catalog/transcription";
import type { WithTimeoutScheduler } from "@stll/concurrency/with-timeout";
import { isLanguageCode } from "@stll/locales";

import { env } from "@/api/env";
import {
  invalidResponse,
  loadTranscriptionAudio,
  PROVIDER_TIMEOUT_MS,
  requestTranscription,
  unavailable,
  VOCABULARY_STATUS,
} from "@/api/handlers/dictation/provider";
import type { TranscriptionResult } from "@/api/handlers/dictation/provider";
import { detached } from "@/api/lib/analytics/capture";
import {
  deleteElevenLabsTranscript,
  elevenLabsTranscriptionUrl,
  elevenLabsTranscriptUrl,
  fetchElevenLabsTranscription,
} from "@/api/lib/chat/provider-data-policy";
import type { ElevenLabsEnvironment } from "@/api/lib/chat/provider-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { admittedDispatchSignal } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { ModelDispatchScope } from "@/api/lib/rate-limit/model-dispatch-admission";

export type ElevenLabsDeployment = {
  apiKey: string;
  environment: ElevenLabsEnvironment;
  /** The account has ElevenLabs zero retention, so every request asks for
   *  it. Without it ElevenLabs keeps the audio and transcript. */
  zeroRetention: boolean;
};

/** The deployment's ElevenLabs key and its environment; `null` offers no
 *  direct ElevenLabs model. */
export const readElevenLabsDeployment = (): ElevenLabsDeployment | null => {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  return apiKey === undefined || apiKey === ""
    ? null
    : {
        apiKey,
        environment: env.ELEVENLABS_ENVIRONMENT,
        zeroRetention: env.ELEVENLABS_ZERO_RETENTION === "1",
      };
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

const keptSchema = v.object({
  transcription_id: v.optional(v.nullable(v.string())),
});

/** The id of the transcript ElevenLabs kept for an answer, if it names one. */
const keptTranscriptId = (body: unknown) => {
  const parsed = v.safeParse(keptSchema, body);
  return parsed.success ? (parsed.output.transcription_id ?? null) : null;
};

type DeleteKeptTranscriptOptions = {
  deployment: ElevenLabsDeployment;
  transcriptionId: string;
  fetch?: typeof deleteElevenLabsTranscript | undefined;
};

/**
 * Deletes, in the background, the audio and transcript ElevenLabs kept for
 * a request made without zero retention. The dictation does not wait for
 * it; a refused delete is logged and a failed one reported, never shown to
 * the speaker. A transcript already gone counts as deleted.
 */
export const deleteKeptTranscript = ({
  deployment,
  transcriptionId,
  fetch: fetchProvider = deleteElevenLabsTranscript,
}: DeleteKeptTranscriptOptions) => {
  detached(async () => {
    const url = elevenLabsTranscriptUrl(
      deployment.environment,
      transcriptionId,
    );
    if (url === null) {
      logger.warn("ElevenLabs kept a transcript under an unexpected id");
      return;
    }
    const response = await fetchProvider(url, {
      method: "DELETE",
      headers: { "xi-api-key": deployment.apiKey },
      redirect: "error",
      timeout: { type: "headers", ms: PROVIDER_TIMEOUT_MS },
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) {
      logger.warn("ElevenLabs kept a transcript its delete refused", {
        "http.status_code": response.status,
      });
    }
  }, "dictation.elevenlabs-transcript-delete");
};

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
  deleteKept?: typeof deleteKeptTranscript | undefined;
  scheduleTimeout?: WithTimeoutScheduler | undefined;
};

/** One audio chunk transcribed by ElevenLabs with the deployment's key, in
 *  its environment, with zero retention when the account has it. Without
 *  it, the transcript ElevenLabs kept is deleted once the answer is in,
 *  whether or not the answer was usable. */
export const transcribeWithElevenLabs = async ({
  audio,
  modelId,
  language,
  deployment,
  scope,
  signal,
  fetch: fetchProvider = fetchElevenLabsTranscription,
  deleteKept = deleteKeptTranscript,
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
  const kept: { transcriptionId: string | null } = { transcriptionId: null };
  const fetched = await requestTranscription({
    send: async (requestSignal) =>
      await fetchProvider(
        elevenLabsTranscriptionUrl(
          deployment.environment,
          deployment.zeroRetention,
        ),
        {
          method: "POST",
          headers: { "xi-api-key": deployment.apiKey },
          body: form,
          signal: requestSignal,
          redirect: "error",
          timeout: { type: "headers", ms: PROVIDER_TIMEOUT_MS },
        },
      ),
    normalize: (answer) => {
      kept.transcriptionId = keptTranscriptId(answer);
      return normalizeElevenLabsResponse(answer, modelId, durationMs);
    },
    signal: abortSignal,
    scheduleTimeout,
  });
  if (!deployment.zeroRetention && kept.transcriptionId !== null) {
    deleteKept({ deployment, transcriptionId: kept.transcriptionId });
  }
  if (fetched.isErr()) {
    return Result.err(fetched.error);
  }
  return Result.ok({
    transcript: fetched.value,
    admittedDurationMs: durationMs,
  });
};
