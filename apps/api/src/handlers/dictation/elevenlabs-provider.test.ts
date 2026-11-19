import { describe, expect, test } from "bun:test";

import { AI_FAILURE_CODES } from "@stll/api-contract";

import { makeM4aAudioBytes } from "@/api/handlers/dictation/audio-fixtures.test-helper";
import {
  deleteKeptTranscript,
  elevenLabsServes,
  normalizeElevenLabsResponse,
  transcribeWithElevenLabs,
} from "@/api/handlers/dictation/elevenlabs-provider";
import {
  deleteElevenLabsTranscript,
  fetchElevenLabsTranscription,
} from "@/api/lib/chat/provider-data-policy";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";

const MODEL = "elevenlabs-direct/scribe-v3";
const DEPLOYMENT = {
  apiKey: "elevenlabs-fixture",
  environment: "eu",
  zeroRetention: true,
} as const;

const rejectionOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new TypeError("Expected a rejection");
};

const scope = () => ({
  userId: null,
  organizationId: null,
  admission: NO_ORGANIZATION_MODEL_DISPATCH,
});

const audio = (durationMs = 1500) =>
  new File([makeM4aAudioBytes(durationMs)], "hlas.m4a", { type: "audio/mp4" });

describe("ElevenLabs environments", () => {
  test("the EU residency environment is the EU region, the others the US region, and each serves elsewhere as outside the region", () => {
    const serves = (environment: "default" | "us" | "eu") =>
      (["eu", "us", "global"] as const).filter((endpoint) =>
        elevenLabsServes(
          { apiKey: "k", environment, zeroRetention: true },
          endpoint,
        ),
      );
    expect(serves("eu")).toEqual(["eu", "global"]);
    expect(serves("us")).toEqual(["us", "global"]);
    expect(serves("default")).toEqual(["us", "global"]);
    expect(elevenLabsServes(null, "global")).toBe(false);
  });

  test("audio goes only to the transcription URL of a known environment", async () => {
    for (const target of [
      "https://api.elevenlabs.io/v1/speech-to-text?enable_logging=true",
      "https://api.eu.residency.elevenlabs.io/v1/speech-to-text/extra?enable_logging=false",
      "https://api.eu.residency.elevenlabs.io/v1/speech-to-text?enable_logging=true",
      "https://api.elevenlabs.example/v1/speech-to-text?enable_logging=false",
      "http://api.elevenlabs.io/v1/speech-to-text?enable_logging=false",
    ]) {
      expect(
        await rejectionOf(
          fetchElevenLabsTranscription(target, {
            method: "POST",
            timeout: { type: "headers", ms: 1000 },
          }),
        ),
      ).toMatchObject({
        message: "Transcription target is outside the provider policy.",
      });
    }
  });
});

describe("ElevenLabs answers", () => {
  test("words keep their timings, spacing is dropped, and the stated duration is billed", () => {
    const result = normalizeElevenLabsResponse(
      {
        text: "Dobrý den",
        language_code: "ces",
        words: [
          { text: "Dobrý", type: "word", start: 0, end: 0.4 },
          { text: " ", type: "spacing", start: 0.4, end: 0.5 },
          { text: "den", type: "word", start: 0.5, end: 0.9 },
        ],
        audio_duration_secs: 1.25,
      },
      MODEL,
      1500,
    );
    expect(result.isOk() ? result.value : result.error).toEqual({
      text: "Dobrý den",
      segments: [{ startMs: 0, endMs: 1250, text: "Dobrý den" }],
      words: [
        { startMs: 0, endMs: 400, text: "Dobrý" },
        { startMs: 500, endMs: 900, text: "den" },
      ],
      detectedLanguage: "ces",
      durationMs: 1250,
      modelId: MODEL,
      vocabulary: "not-supported",
    });
  });

  test("without a stated duration the measured one is used, and timings past it are refused", () => {
    const measured = normalizeElevenLabsResponse(
      { text: "", language_code: null, words: [] },
      MODEL,
      1500,
    );
    expect(measured.isOk() && measured.value.durationMs).toBe(1500);
    expect(measured.isOk() && measured.value.segments).toEqual([]);
    for (const body of [
      {
        text: "a",
        words: [{ text: "a", type: "word", start: 0, end: 2 }],
      },
      { text: "a", words: [{ text: "a", type: "word", start: 1, end: 0.5 }] },
      { words: [] },
      { text: "a", audio_duration_secs: 0 },
    ]) {
      const result = normalizeElevenLabsResponse(body, MODEL, 1500);
      expect(result.isErr() && result.error.code).toBe(
        AI_FAILURE_CODES.output_invalid,
      );
    }
  });
});

describe("ElevenLabs transcription", () => {
  test("sends the chunk as Scribe v3 with the key, language and word timings, and never an OpenRouter model", async () => {
    const sent: {
      url: string;
      init: Parameters<typeof fetchElevenLabsTranscription>[1];
    }[] = [];
    const result = await transcribeWithElevenLabs({
      audio: audio(),
      modelId: MODEL,
      language: "cs",
      deployment: DEPLOYMENT,
      scope: scope(),
      fetch: async (url, init) => {
        sent.push({ url: String(url), init });
        return Response.json({ text: "Dobrý den", language_code: "ces" });
      },
    });
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value.admittedDurationMs).toBeGreaterThan(0);
    expect(result.value.transcript.durationMs).toBe(
      result.value.admittedDurationMs,
    );
    const request = sent.at(0);
    expect(request?.url).toBe(
      "https://api.eu.residency.elevenlabs.io/v1/speech-to-text?enable_logging=false",
    );
    expect(new Headers(request?.init.headers).get("xi-api-key")).toBe(
      "elevenlabs-fixture",
    );
    const form = request?.init.body;
    if (!(form instanceof FormData)) {
      throw new TypeError("Expected a multipart body");
    }
    expect(form.get("model_id")).toBe("scribe_v3");
    expect(form.get("language_code")).toBe("cs");
    expect(form.get("timestamps_granularity")).toBe("word");
    expect(form.get("file")).toBeInstanceOf(Blob);

    const refused = await transcribeWithElevenLabs({
      audio: audio(),
      modelId: "mistralai/voxtral-mini-transcribe",
      deployment: DEPLOYMENT,
      scope: scope(),
      fetch: async () => {
        throw new TypeError("An OpenRouter model must never go to ElevenLabs");
      },
    });
    expect(refused.isErr() && refused.error.code).toBe(
      AI_FAILURE_CODES.managed_provider_unavailable,
    );
  });

  test("a refused or throttled request is a provider failure, retryable only when the provider may recover", async () => {
    for (const [status, retryable] of [
      [401, false],
      [429, true],
      [503, true],
    ] as const) {
      const result = await transcribeWithElevenLabs({
        audio: audio(),
        modelId: MODEL,
        deployment: DEPLOYMENT,
        scope: scope(),
        fetch: async () => new Response("no", { status }),
      });
      expect(result.isErr() && result.error).toMatchObject({
        code: AI_FAILURE_CODES.provider_unavailable,
        retryable,
      });
    }
  });
});

describe("ElevenLabs kept transcripts", () => {
  const KEPT = {
    ...DEPLOYMENT,
    environment: "default",
    zeroRetention: false,
  } as const;

  const transcribeKept = async (
    deployment: typeof KEPT | typeof DEPLOYMENT,
    answer: unknown,
  ) => {
    const deleted: string[] = [];
    const result = await transcribeWithElevenLabs({
      audio: audio(),
      modelId: MODEL,
      deployment,
      scope: scope(),
      fetch: async () => Response.json(answer),
      deleteKept: ({ transcriptionId }) => {
        deleted.push(transcriptionId);
      },
    });
    return { result, deleted };
  };

  test("without zero retention the transcript ElevenLabs kept is deleted, even when its answer is unusable", async () => {
    const usable = await transcribeKept(KEPT, {
      text: "Dobrý den",
      transcription_id: "mkIIQ7dqfmic6Mpb0fWR",
    });
    expect(usable.result.isOk()).toBe(true);
    expect(usable.deleted).toEqual(["mkIIQ7dqfmic6Mpb0fWR"]);

    const unusable = await transcribeKept(KEPT, {
      transcription_id: "kept-but-unusable",
    });
    expect(unusable.result.isErr()).toBe(true);
    expect(unusable.deleted).toEqual(["kept-but-unusable"]);

    const unnamed = await transcribeKept(KEPT, { text: "Dobrý den" });
    expect(unnamed.deleted).toEqual([]);
  });

  test("with zero retention nothing is kept, so nothing is deleted", async () => {
    const { deleted } = await transcribeKept(DEPLOYMENT, {
      text: "Dobrý den",
      transcription_id: "mkIIQ7dqfmic6Mpb0fWR",
    });
    expect(deleted).toEqual([]);
  });

  test("the delete goes to the key's environment with the key", async () => {
    const sent = Promise.withResolvers<{
      url: string;
      init: Parameters<typeof deleteElevenLabsTranscript>[1];
    }>();
    deleteKeptTranscript({
      deployment: { ...KEPT, environment: "eu" },
      transcriptionId: "mkIIQ7dqfmic6Mpb0fWR",
      fetch: async (url, init) => {
        sent.resolve({ url: String(url), init });
        return new Response(null, { status: 200 });
      },
    });
    const { url, init } = await sent.promise;
    expect(url).toBe(
      "https://api.eu.residency.elevenlabs.io/v1/speech-to-text/transcripts/mkIIQ7dqfmic6Mpb0fWR",
    );
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get("xi-api-key")).toBe(
      "elevenlabs-fixture",
    );
  });

  test("deletes go only to a transcript URL of a known environment", async () => {
    for (const target of [
      "https://api.elevenlabs.io/v1/speech-to-text",
      "https://api.elevenlabs.io/v1/speech-to-text/transcripts/",
      "https://api.elevenlabs.io/v1/speech-to-text/transcripts/a/b",
      "https://api.elevenlabs.io/v1/speech-to-text/transcripts/a?x=1",
      "https://api.elevenlabs.io/v1/speech-to-text/transcripts/%2e%2e",
      "https://api.elevenlabs.example/v1/speech-to-text/transcripts/a",
      "http://api.elevenlabs.io/v1/speech-to-text/transcripts/a",
    ]) {
      expect(
        await rejectionOf(
          deleteElevenLabsTranscript(target, {
            timeout: { type: "headers", ms: 1000 },
          }),
        ),
      ).toMatchObject({
        message: "Transcript deletion target is outside the provider policy.",
      });
    }
  });
});
