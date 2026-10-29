import { Result } from "better-result";
import * as v from "valibot";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import type {
  TranscriptionModelId,
  TranscriptionVocabularyMechanism,
} from "@stll/ai-catalog/transcription";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
  TRANSCRIPTION_AUDIO_MEDIA_TYPES,
} from "@stll/api-contract/transcription";
import { TimeoutError, withTimeout } from "@stll/concurrency/with-timeout";
import type { WithTimeoutScheduler } from "@stll/concurrency/with-timeout";
import { classifyFailure } from "@stll/errors";
import { isLanguageCode } from "@stll/locales";
import { readCappedBytes } from "@stll/skills/streaming";

import {
  createUnreadableAudioError,
  readAdmissibleAudioDuration,
} from "@/api/handlers/dictation/audio-duration";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import {
  fetchManagedOpenRouterTranscription,
  PROVIDER_DATA_POLICY,
} from "@/api/lib/chat/provider-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { admittedDispatchSignal } from "@/api/lib/rate-limit/model-dispatch-admission";
import type { ModelDispatchScope } from "@/api/lib/rate-limit/model-dispatch-admission";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 60_000;
const RETRY_AFTER_MS = 1000;
const MAX_SAFE_SECONDS = Number.MAX_SAFE_INTEGER / 1000;
const MIME_FORMATS = {
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
} as const satisfies Record<
  (typeof TRANSCRIPTION_AUDIO_MEDIA_TYPES)[number],
  "wav" | "m4a"
>;
type AudioFormat = (typeof MIME_FORMATS)[keyof typeof MIME_FORMATS];
const VOCABULARY_STATUS = {
  none: "not-supported",
  "groq-prompt": "applied",
  "azure-phrase-list": "applied",
  "context-hint": "not-supported",
} as const satisfies Record<
  TranscriptionVocabularyMechanism,
  "applied" | "not-supported"
>;

const timingSchema = v.object({
  startMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  endMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  text: v.string(),
});
export const transcriptionResultSchema = v.object({
  text: v.string(),
  segments: v.array(timingSchema),
  words: v.optional(v.array(timingSchema)),
  detectedLanguage: v.nullable(v.string()),
  durationMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  modelId: v.string(),
  vocabulary: v.picklist(Object.values(VOCABULARY_STATUS)),
});
export type TranscriptionResult = v.InferOutput<
  typeof transcriptionResultSchema
>;

const secondsSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(MAX_SAFE_SECONDS),
);
const wireTimingSchema = v.object({
  start: secondsSchema,
  end: secondsSchema,
});
const wireSchema = v.object({
  text: v.string(),
  language: v.optional(v.string()),
  duration: v.optional(secondsSchema),
  segments: v.optional(
    v.array(v.object({ ...wireTimingSchema.entries, text: v.string() })),
    [],
  ),
  words: v.optional(
    v.array(v.object({ ...wireTimingSchema.entries, word: v.string() })),
  ),
  usage: v.optional(v.object({ seconds: v.optional(secondsSchema) })),
});

const unavailable = () =>
  classifyFailure(
    new HandlerError({
      status: 503,
      code: AI_FAILURE_CODES.managed_provider_unavailable,
      message:
        "Transcription is unavailable for the selected model and region.",
      hint: "Select a transcription model available in your organization's region.",
      retryable: false,
    }),
    "model_unavailable",
  );

const oversize = () =>
  new HandlerError({
    status: 413,
    code: "audio_too_large",
    message: "The audio chunk exceeds the transcription request limit.",
    hint: "Split the recording into smaller audio chunks.",
  });

const providerFailure = (retryable: boolean) =>
  classifyFailure(
    new HandlerError({
      status: 502,
      code: AI_FAILURE_CODES.provider_unavailable,
      message: "The transcription provider could not process this audio chunk.",
      hint: "Retry the audio chunk or select another available transcription model.",
      ...(retryable
        ? { retryable: true, retryAfterMs: RETRY_AFTER_MS }
        : { retryable: false }),
    }),
    "provider_unavailable",
  );

const timeoutFailure = () =>
  classifyFailure(
    new HandlerError({
      status: 503,
      code: AI_FAILURE_CODES.deadline_exceeded,
      message: "The transcription request timed out.",
      hint: "Retry with a shorter audio chunk.",
      retryable: true,
      retryAfterMs: RETRY_AFTER_MS,
    }),
    "model_deadline_exceeded",
  );

const invalidResponse = () =>
  classifyFailure(
    new HandlerError({
      status: 502,
      code: AI_FAILURE_CODES.output_invalid,
      message: "The transcription provider returned an invalid response.",
      hint: "Retry the audio chunk or select another available transcription model.",
      retryable: false,
    }),
    "model_output_invalid",
  );

const vocabularyOptions = {
  none: (_terms: readonly string[]) => Result.ok({}),
  "groq-prompt": (terms: readonly string[]) =>
    Result.ok({
      groq: { prompt: terms.join(", ") },
    }),
  "azure-phrase-list": (terms: readonly string[]) =>
    Result.ok({
      azure: { phraseList: { phrases: terms } },
    }),
  "context-hint": (_terms: readonly string[]) =>
    Result.err(
      new HandlerError({
        status: 422,
        code: "transcription_vocabulary_unsupported",
        message:
          "Vocabulary hints are not supported for this transcription model.",
        hint: "Omit vocabulary terms or select a model with supported vocabulary hints.",
      }),
    ),
} as const satisfies Record<
  TranscriptionVocabularyMechanism,
  (terms: readonly string[]) => Result<object, HandlerError>
>;

type BuildTranscriptionRequestOptions = {
  audioBytes: Uint8Array;
  format: AudioFormat;
  modelId: TranscriptionModelId;
  language?: string | undefined;
  vocabulary?: readonly string[] | undefined;
};

export const buildTranscriptionRequest = ({
  audioBytes,
  format,
  modelId,
  language,
  vocabulary,
}: BuildTranscriptionRequestOptions) => {
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
  if (audioBytes.byteLength > MAX_TRANSCRIPTION_AUDIO_BYTES) {
    return Result.err(oversize());
  }
  if (
    vocabulary !== undefined &&
    (vocabulary.length > MAX_TRANSCRIPTION_VOCABULARY_TERMS ||
      vocabulary.some(
        (term) =>
          term.length === 0 ||
          term.length > MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
      ))
  ) {
    return Result.err(
      new HandlerError({
        status: 422,
        code: "invalid_vocabulary",
        message: "Vocabulary terms exceed the transcription request limits.",
        hint: "Use fewer, shorter vocabulary terms.",
      }),
    );
  }
  const model = TRANSCRIPTION_MODELS[modelId];
  const policy = PROVIDER_DATA_POLICY.customer.openrouter.provider;
  const options =
    vocabulary === undefined || vocabulary.length === 0
      ? Result.ok({})
      : vocabularyOptions[model.vocabularyMechanism](vocabulary);
  if (options.isErr()) {
    return Result.err(options.error);
  }
  return Result.ok({
    model: modelId,
    input_audio: { data: Buffer.from(audioBytes).toString("base64"), format },
    ...(language === undefined ? {} : { language }),
    ...(model.timestamps === "none"
      ? { response_format: "json" }
      : {
          response_format: "verbose_json",
          timestamp_granularities:
            model.timestamps === "word" ? ["segment", "word"] : ["segment"],
        }),
    provider: {
      zdr: policy.zdr,
      data_collection: policy.dataCollection,
      ...(vocabulary === undefined || vocabulary.length === 0
        ? {}
        : { options: options.value }),
    },
  });
};

export const normalizeTranscriptionResponse = (
  body: unknown,
  modelId: TranscriptionModelId,
) => {
  const parsed = v.safeParse(wireSchema, body);
  if (!parsed.success) {
    return Result.err(invalidResponse());
  }
  const { text, language, duration, segments, words, usage } = parsed.output;
  const audioSeconds = duration ?? usage?.seconds;
  if (audioSeconds === undefined || Math.round(audioSeconds * 1000) < 1) {
    return Result.err(invalidResponse());
  }
  const timings = words === undefined ? segments : [...segments, ...words];
  if (timings.some(({ start, end }) => end < start || end > audioSeconds)) {
    return Result.err(invalidResponse());
  }
  return Result.ok({
    text,
    segments: segments.map(({ start, end, text: segmentText }) => ({
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text: segmentText,
    })),
    ...(words === undefined
      ? {}
      : {
          words: words.map(({ start, end, word }) => ({
            startMs: Math.round(start * 1000),
            endMs: Math.round(end * 1000),
            text: word,
          })),
        }),
    detectedLanguage: language ?? null,
    durationMs: Math.round(audioSeconds * 1000),
    modelId,
    vocabulary:
      VOCABULARY_STATUS[TRANSCRIPTION_MODELS[modelId].vocabularyMechanism],
  } satisfies TranscriptionResult);
};

type TranscribeAudioOptions = {
  audio: File;
  modelId: string;
  language?: string | undefined;
  vocabulary?: readonly string[] | undefined;
  apiKey: string;
  residency: ManagedAIResidency;
  scope: ModelDispatchScope;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetchManagedOpenRouterTranscription | undefined;
  scheduleTimeout?: WithTimeoutScheduler | undefined;
};

type TranscribeAudioResult = Result<TranscriptionResult, HandlerError>;

export const transcribeAudio = async ({
  audio,
  modelId,
  language,
  vocabulary,
  apiKey,
  residency,
  scope,
  signal,
  fetch: fetchProvider = fetchManagedOpenRouterTranscription,
  scheduleTimeout,
}: TranscribeAudioOptions): Promise<TranscribeAudioResult> => {
  const abortSignal = admittedDispatchSignal({ ...scope, abortSignal: signal });
  if (!isTranscriptionModelId(modelId)) {
    return Result.err(unavailable());
  }
  const model = TRANSCRIPTION_MODELS[modelId];
  if (model.residency[residency].status !== "available") {
    return Result.err(unavailable());
  }
  if (audio.size > MAX_TRANSCRIPTION_AUDIO_BYTES) {
    return Result.err(oversize());
  }
  const mime = TRANSCRIPTION_AUDIO_MEDIA_TYPES.find(
    (candidate) => candidate === audio.type.split(";").at(0),
  );
  if (mime === undefined) {
    return Result.err(createUnreadableAudioError());
  }
  const matchedFormat = MIME_FORMATS[mime];
  const loaded = await Result.tryPromise({
    try: async () => new Uint8Array(await audio.arrayBuffer()),
    catch: () => createUnreadableAudioError(),
  });
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const duration = readAdmissibleAudioDuration(loaded.value, matchedFormat);
  if (duration.isErr()) {
    return Result.err(duration.error);
  }
  const requestBody = buildTranscriptionRequest({
    audioBytes: loaded.value,
    format: matchedFormat,
    modelId,
    language,
    vocabulary,
  });
  if (requestBody.isErr()) {
    return Result.err(requestBody.error);
  }
  const body = JSON.stringify(requestBody.value);
  if (Buffer.byteLength(body) > MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES) {
    return Result.err(oversize());
  }
  const serverURL =
    PROVIDER_DATA_POLICY.customer.openrouter.serverURLs[residency];
  const fetched = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async (requestSignal) => {
          const response = await fetchProvider(
            `${serverURL}/audio/transcriptions`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
              },
              body,
              signal: requestSignal,
              redirect: "error",
              timeout: { type: "headers", ms: PROVIDER_TIMEOUT_MS },
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            return Result.err(
              providerFailure(
                response.status === 429 || response.status >= 500,
              ),
            );
          }
          if (response.body === null) {
            return Result.err(invalidResponse());
          }
          const bytes = await readCappedBytes(
            response.body,
            MAX_RESPONSE_BYTES,
          );
          if (bytes === null) {
            return Result.err(invalidResponse());
          }
          const decoded = Result.try({
            try: (): unknown =>
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              ),
            catch: () => invalidResponse(),
          });
          if (decoded.isErr()) {
            return Result.err(decoded.error);
          }
          return normalizeTranscriptionResponse(decoded.value, modelId);
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
  return fetched.value;
};
