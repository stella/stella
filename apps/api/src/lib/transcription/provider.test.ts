import { describe, expect, spyOn, test } from "bun:test";
import * as fc from "fast-check";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import type { TranscriptionModelId } from "@stll/ai-catalog/transcription";
import { AI_FAILURE_CODES } from "@stll/api-contract";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
} from "@stll/api-contract/transcription";
import { assertProperty } from "@stll/property-testing";

import * as capture from "@/api/lib/analytics/capture";
import { logger } from "@/api/lib/observability/logger";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";

import {
  buildTranscriptionRequest,
  normalizeTranscriptionResponse,
  transcribeAudio,
} from "./provider";

const MODEL_ID = "mistralai/voxtral-mini-transcribe";
const TEXT = "K návrhu paní Žofii Černé a pánu Ľubomíru Kováčovi.";
const TERMS = ["Žofia Černá", "Ľubomír Kováč", "vyporiadanie"];
const wav = () => {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"));
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 2, true);
  return bytes;
};
const audio = () => new File([wav()], "diktát.wav", { type: "audio/wav" });
const input = () => ({
  audio: audio(),
  modelId: MODEL_ID,
  apiKey: "fake-credential",
  residency: "eu" as const,
  scope: {
    userId: null,
    organizationId: null,
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
  },
  fetch: async () => Response.json({ text: TEXT, usage: { seconds: 1 } }),
});

describe("transcription request contract", () => {
  test("every model carries the mandatory policy, vocabulary, and supported timestamps", () => {
    const expectedVocabulary = {
      none: {},
      "groq-prompt": { groq: { prompt: TERMS.join(", ") } },
      "azure-phrase-list": { azure: { phraseList: { phrases: TERMS } } },
      "context-hint": {},
    } as const satisfies Record<
      (typeof TRANSCRIPTION_MODELS)[TranscriptionModelId]["vocabularyMechanism"],
      object
    >;
    for (const [modelId, model] of Object.entries(TRANSCRIPTION_MODELS)) {
      if (!isTranscriptionModelId(modelId)) {
        throw new TypeError("Catalog keys must be transcription model ids");
      }
      const built = buildTranscriptionRequest({
        audioBytes: wav(),
        format: "wav",
        modelId,
        language: "cs",
        vocabulary: TERMS,
      });
      if (model.vocabularyMechanism === "context-hint") {
        expect(built.isErr()).toBe(true);
        if (built.isErr()) {
          expect(built.error.code).toBe("transcription_vocabulary_unsupported");
        }
        continue;
      }
      const request = built.unwrap();
      expect(request).toMatchObject({
        model: modelId,
        language: "cs",
        input_audio: {
          format: "wav",
          data: Buffer.from(wav()).toString("base64"),
        },
        provider: {
          zdr: true,
          data_collection: "deny",
          options: expectedVocabulary[model.vocabularyMechanism],
        },
      });
      const granularities = {
        none: undefined,
        segment: ["segment"],
        word: ["segment", "word"],
      } as const;
      expect(
        "timestamp_granularities" in request
          ? request.timestamp_granularities
          : undefined,
      ).toEqual(granularities[model.timestamps]);
      expect(request.response_format).toBe(
        model.timestamps === "none" ? "json" : "verbose_json",
      );
    }
  });

  test("auto language and omitted vocabulary do not introduce invented hints", () => {
    const request = buildTranscriptionRequest({
      audioBytes: wav(),
      format: "wav",
      modelId: MODEL_ID,
    }).unwrap();
    expect(request).not.toHaveProperty("language");
    expect(request.provider).not.toHaveProperty("options");
  });

  test("maximum decoded audio and escaped vocabulary fit the provider body limit", () => {
    const vocabulary = Array.from(
      { length: MAX_TRANSCRIPTION_VOCABULARY_TERMS },
      () => "\u0000".repeat(MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH),
    );
    const request = buildTranscriptionRequest({
      audioBytes: new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES),
      format: "webm",
      modelId: "microsoft/mai-transcribe-2",
      language: "sk",
      vocabulary,
    }).unwrap();
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
      MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES,
    );
    const oversized = buildTranscriptionRequest({
      audioBytes: new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES + 1),
      format: "webm",
      modelId: MODEL_ID,
    });
    expect(oversized.isErr()).toBe(true);
    if (oversized.isErr()) {
      expect(oversized.error.status).toBe(413);
    }
  });

  test("vocabulary count and per-term limits reject direct callers", () => {
    for (const vocabulary of [
      Array.from(
        { length: MAX_TRANSCRIPTION_VOCABULARY_TERMS + 1 },
        () => "Žofia",
      ),
      ["Ľ".repeat(MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH + 1)],
      [""],
    ]) {
      const result = buildTranscriptionRequest({
        audioBytes: wav(),
        format: "wav",
        modelId: MODEL_ID,
        vocabulary,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("invalid_vocabulary");
      }
    }
  });

  test("direct callers cannot expand the language field beyond the provider envelope", () => {
    for (const language of [
      "cs-CZ",
      "zz",
      "cs".repeat(MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES / 2),
    ]) {
      const result = buildTranscriptionRequest({
        audioBytes: wav(),
        format: "wav",
        modelId: MODEL_ID,
        language,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("invalid_language");
      }
    }
  });

  test("regional request uses only the selected origin and credential", async () => {
    let requests = 0;
    const result = await transcribeAudio({
      ...input(),
      language: "sk",
      vocabulary: TERMS,
      fetch: async (url, init) => {
        requests++;
        expect(url).toBe(
          "https://eu.openrouter.ai/api/v1/audio/transcriptions",
        );
        expect(init.headers).toEqual({
          authorization: "Bearer fake-credential",
          "content-type": "application/json",
        });
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.timeout).toEqual({ type: "headers", ms: 60_000 });
        expect(typeof init.body).toBe("string");
        if (typeof init.body !== "string") {
          throw new TypeError("Expected JSON request body");
        }
        expect(JSON.parse(init.body)).toMatchObject({
          language: "sk",
          provider: { zdr: true, data_collection: "deny" },
        });
        return Response.json({ text: TEXT, usage: { seconds: 6.4 } });
      },
    });
    expect(requests).toBe(1);
    expect(result.unwrap()).toEqual({
      text: TEXT,
      segments: [],
      detectedLanguage: null,
      durationMs: 6400,
      modelId: MODEL_ID,
    });
  });

  test("unavailable and unconfirmed regions never dispatch", async () => {
    for (const [modelId, model] of Object.entries(TRANSCRIPTION_MODELS)) {
      for (const residency of ["eu", "us"] as const) {
        if (model.residency[residency].status === "available") {
          continue;
        }
        const result = await transcribeAudio({
          ...input(),
          modelId,
          residency,
          fetch: async () => {
            throw new TypeError("Unavailable models must never dispatch");
          },
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.code).toBe(
            AI_FAILURE_CODES.managed_provider_unavailable,
          );
        }
      }
    }
  });

  test("unsupported model fails closed", async () => {
    const result = await transcribeAudio({
      ...input(),
      modelId: "not-a-model",
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe(503);
    }
  });
});

describe("transcription response boundary", () => {
  test("normalizes segment and word seconds to integer milliseconds", () => {
    const result = normalizeTranscriptionResponse(
      {
        text: TEXT,
        language: "sk",
        duration: 6.4,
        segments: [{ start: 0.0014, end: 1.2346, text: "K návrhu" }],
        words: [{ start: 0.0014, end: 0.1236, word: "K" }],
      },
      MODEL_ID,
    );
    expect(result.unwrap()).toEqual({
      text: TEXT,
      detectedLanguage: "sk",
      durationMs: 6400,
      modelId: MODEL_ID,
      segments: [{ startMs: 1, endMs: 1235, text: "K návrhu" }],
      words: [{ startMs: 1, endMs: 124, text: "K" }],
    });
  });

  test("transcription timings remain ordered and bounded after millisecond conversion", () => {
    assertProperty(
      "transcription timings remain ordered and bounded after millisecond conversion",
      fc.property(
        fc.tuple(
          fc.integer({ min: 1, max: 86_400_000 }),
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.integer({ min: 0, max: 1_000_000 }),
        ),
        ([durationMs, a, b]) => {
          const start = ((Math.min(a, b) / 1_000_000) * durationMs) / 1000;
          const end = ((Math.max(a, b) / 1_000_000) * durationMs) / 1000;
          const result = normalizeTranscriptionResponse(
            {
              text: TEXT,
              duration: durationMs / 1000,
              segments: [{ start, end, text: TEXT }],
            },
            MODEL_ID,
          ).unwrap();
          const segment = result.segments.at(0);
          expect(segment).toBeDefined();
          if (segment === undefined) {
            throw new TypeError("Expected one segment");
          }
          expect(Number.isInteger(segment.startMs)).toBe(true);
          expect(Number.isInteger(segment.endMs)).toBe(true);
          expect(segment.startMs).toBeGreaterThanOrEqual(0);
          expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs);
          expect(segment.endMs).toBeLessThanOrEqual(result.durationMs);
        },
      ),
    );
  });

  test("rejects missing duration and malformed timing values without retaining response data", () => {
    for (const body of [
      { text: TEXT },
      { text: TEXT, duration: 0 },
      { text: TEXT, duration: Number.NaN },
      { text: TEXT, duration: Infinity },
      { text: TEXT, duration: -1 },
      { text: TEXT, duration: 1, segments: [{ start: 1, end: 0, text: TEXT }] },
      { text: TEXT, duration: 1, words: [{ start: 0, end: 2, word: TEXT }] },
    ]) {
      const result = normalizeTranscriptionResponse(body, MODEL_ID);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe(AI_FAILURE_CODES.output_invalid);
        expect(JSON.stringify(result.error)).not.toContain(TEXT);
        expect(result.error.cause).toBeUndefined();
      }
    }
  });
});

describe("transcription failure isolation", () => {
  test("audio, hints, and provider output never reach logging or exception capture on any outcome", async () => {
    const logSpies = (
      ["debug", "info", "warn", "error", "request"] as const
    ).map((method) =>
      spyOn(logger, method).mockImplementation(() => undefined),
    );
    const captureSpies = (
      ["captureError", "captureRequestError", "captureObservedError"] as const
    ).map((method) =>
      spyOn(capture, method).mockImplementation(() => undefined),
    );
    try {
      const failures = [400, 500].map((status) => ({
        ...input(),
        vocabulary: TERMS,
        fetch: async () => new Response(TEXT + TERMS.join(" "), { status }),
      }));
      const timeout = {
        ...input(),
        vocabulary: TERMS,
        fetch: async () => await new Promise<Response>(() => {}),
        scheduleTimeout: (expire: () => void) => {
          queueMicrotask(expire);
          return () => undefined;
        },
      };
      const malformed = {
        ...input(),
        vocabulary: TERMS,
        audio: new File([TEXT], "vadný.wav", { type: "audio/wav" }),
      };
      const oversized = {
        ...input(),
        vocabulary: TERMS,
        audio: new File(
          [new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES + 1)],
          "dlouhý.wav",
          {
            type: "audio/wav",
          },
        ),
      };
      const success = {
        ...input(),
        vocabulary: TERMS,
        fetch: async () => Response.json({ text: TEXT, usage: { seconds: 1 } }),
      };
      expect((await transcribeAudio(success)).isOk()).toBe(true);
      for (const failure of [...failures, timeout, malformed, oversized]) {
        expect((await transcribeAudio(failure)).isErr()).toBe(true);
      }
      for (const sink of [...logSpies, ...captureSpies]) {
        expect(sink).not.toHaveBeenCalled();
      }
    } finally {
      for (const sink of [...logSpies, ...captureSpies]) {
        sink.mockRestore();
      }
    }
  });

  test("accepts each documented container signature without using the file name", async () => {
    const m4a = new Uint8Array(12);
    m4a.set(new TextEncoder().encode("ftyp"), 4);
    const cases = [
      { mime: "audio/mp4", bytes: m4a, format: "m4a" },
      {
        mime: "audio/aac",
        bytes: new Uint8Array([0xff, 0xf1, 0, 0, 0, 0, 0]),
        format: "aac",
      },
      {
        mime: "audio/webm;codecs=opus",
        bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
        format: "webm",
      },
      { mime: "audio/wav", bytes: wav(), format: "wav" },
    ];
    for (const { mime, bytes, format } of cases) {
      const result = await transcribeAudio({
        ...input(),
        audio: new File([bytes], "názov.dat", { type: mime }),
        fetch: async (_url, init) => {
          if (typeof init.body !== "string") {
            throw new TypeError("Expected JSON request");
          }
          expect(JSON.parse(init.body)).toHaveProperty(
            "input_audio.format",
            format,
          );
          return Response.json({ text: TEXT, usage: { seconds: 1 } });
        },
      });
      expect(result.isOk()).toBe(true);
    }
  });

  test("audio read failures return fixed diagnostics without dispatch", async () => {
    class UnreadableFile extends File {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        throw new TypeError(TEXT);
      }
    }
    const result = await transcribeAudio({
      ...input(),
      audio: new UnreadableFile([wav()], "diktát.wav", { type: "audio/wav" }),
      fetch: async () => {
        throw new TypeError("Unreadable audio must never dispatch");
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe("invalid_audio");
      expect(result.error.cause).toBeUndefined();
      expect(JSON.stringify(result.error)).not.toContain(TEXT);
    }
  });

  test("rejects empty, malformed, and unsupported audio before dispatch", async () => {
    for (const file of [
      new File([], "prázdný.wav", { type: "audio/wav" }),
      new File([TEXT], "vadný.wav", { type: "audio/wav" }),
      new File([wav()], "vadný.mp4", { type: "audio/mp4" }),
      new File([wav()], "diktát.txt", { type: "text/plain" }),
    ]) {
      const result = await transcribeAudio({
        ...input(),
        audio: file,
        fetch: async () => {
          throw new TypeError("Invalid audio must never dispatch");
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("invalid_audio");
      }
    }
  });

  test("rejects file and encoded request limits before dispatch", async () => {
    let reads = 0;
    class CountingFile extends File {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        reads++;
        return await super.arrayBuffer();
      }
    }
    for (const size of [
      MAX_TRANSCRIPTION_AUDIO_BYTES + 1,
      MAX_TRANSCRIPTION_PROVIDER_BODY_BYTES,
    ]) {
      const bytes = new Uint8Array(size);
      bytes.set(wav());
      const result = await transcribeAudio({
        ...input(),
        audio: new CountingFile([bytes], "dlouhý.wav", { type: "audio/wav" }),
        fetch: async () => {
          throw new TypeError("Oversized audio must never dispatch");
        },
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.status).toBe(413);
      }
    }
    expect(reads).toBe(0);
  });

  test("provider failures return only fixed diagnostics", async () => {
    for (const status of [400, 401, 403, 422, 429, 500, 503]) {
      const result = await transcribeAudio({
        ...input(),
        vocabulary: TERMS,
        fetch: async () =>
          new Response(
            JSON.stringify({
              audio: Buffer.from(wav()).toString("base64"),
              vocabulary: TERMS,
              error: TEXT,
            }),
            { status },
          ),
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe(AI_FAILURE_CODES.provider_unavailable);
        expect(result.error.retryable).toBe(status === 429 || status >= 500);
        expect(result.error.cause).toBeUndefined();
        expect(JSON.stringify(result.error)).not.toContain(TEXT);
        for (const term of TERMS) {
          expect(JSON.stringify(result.error)).not.toContain(term);
        }
      }
    }
  });

  test("transport errors drop provider exception content", async () => {
    const result = await transcribeAudio({
      ...input(),
      vocabulary: TERMS,
      fetch: async () => {
        throw new TypeError(TEXT + TERMS.join(" "));
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.cause).toBeUndefined();
      expect(JSON.stringify(result.error)).not.toContain(TEXT);
    }
  });

  test("deadline aborts the transport and returns a retryable typed timeout", async () => {
    let transportSignal: AbortSignal | undefined;
    const result = await transcribeAudio({
      ...input(),
      fetch: async (_url, init) => {
        transportSignal = init.signal;
        return await new Promise<Response>(() => {});
      },
      scheduleTimeout: (expire) => {
        queueMicrotask(expire);
        return () => undefined;
      },
    });
    expect(transportSignal?.aborted).toBe(true);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe(AI_FAILURE_CODES.deadline_exceeded);
      expect(result.error.retryable).toBe(true);
      expect(result.error.cause).toBeUndefined();
    }
  });

  test("rejects invalid and oversized provider responses", async () => {
    for (const body of [
      "not json",
      JSON.stringify({ text: TEXT }),
      " ".repeat(4 * 1024 * 1024 + 1),
    ]) {
      const result = await transcribeAudio({
        ...input(),
        fetch: async () => new Response(body),
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe(AI_FAILURE_CODES.output_invalid);
      }
    }
  });
});
