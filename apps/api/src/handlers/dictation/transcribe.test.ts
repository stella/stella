import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import * as v from "valibot";

import {
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
} from "@stll/api-contract/transcription";
import { assertProperty } from "@stll/property-testing";

import { transcribeAudio } from "@/api/handlers/dictation/provider";
import type { TranscriptionResult } from "@/api/handlers/dictation/provider";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { admitFixtureModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import { computeUsageUnitCost } from "@/api/lib/usage/action-weights";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { transcriptionUsageUnits } from "@/api/lib/usage/unit-model";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import { dictationBodySchema } from "./schema";
import { executeDictation } from "./transcribe";

type DictationContext = Exclude<
  Parameters<typeof executeDictation>[0],
  { orgAIConfigStatus: "unreadable" }
>;
type Dependencies = Parameters<typeof executeDictation>[1];
const TEXT = "K návrhu Žofie Černé a Ľubomíra Kováča.";
const VOCABULARY = ["Žofia Černá", "Ľubomír Kováč"];
const MODEL = "mistralai/voxtral-mini-transcribe";

const wav = () => {
  const bytes = new Uint8Array(46);
  bytes.set(new TextEncoder().encode("RIFF"));
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  return new File([bytes], "hlas.wav", { type: "audio/wav" });
};

const fixture = (durationMs = 1234) => {
  const context = createTestHandlerContext<DictationContext>({
    audit: NO_AUDIT,
    safeDb: NO_DB,
    scopedDb: NO_DB,
    body: {
      file: wav(),
      modelId: MODEL,
      language: "cs",
      vocabulary: VOCABULARY,
    },
    request: new Request("https://stella.test/v1/dictation/transcribe", {
      method: "POST",
    }),
  });
  context.modelAdmission = admitFixtureModelDispatch({
    userId: context.user.id,
    organizationId: context.session.activeOrganizationId,
    actionKind: "dictation.transcribe",
    modelTier: MANAGED_MODEL_TIER.standard,
  });
  const requests: { url: string; body: unknown; key: string | null }[] = [];
  const settlements: Parameters<Dependencies["settle"]>[0][] = [];
  const preflightRequirements: number[] = [];
  let credentials = 0;
  let preflights = 0;
  const dependencies = {
    transcribe: async (options) =>
      await transcribeAudio({
        ...options,
        fetch: async (url, init) => {
          requests.push({
            url: String(url),
            body: typeof init.body === "string" ? JSON.parse(init.body) : null,
            key: new Headers(init.headers).get("authorization"),
          });
          return Response.json({
            text: TEXT,
            language: "cs",
            duration: durationMs / 1000,
            segments: [{ start: 0, end: durationMs / 1000, text: TEXT }],
            words: [
              { start: 0, end: Math.min(durationMs / 1000, 0.2), word: "K" },
            ],
          });
        },
      }),
    credential: async () => {
      credentials++;
      return Result.ok({ type: "static" as const, apiKey: "managed-fixture" });
    },
    limit: async () => Result.ok(undefined),
    preflight: async ({ required }) => {
      preflights++;
      preflightRequirements.push(required);
      return Result.ok(undefined);
    },
    settle: async (options) => {
      settlements.push(options);
      return Result.ok(undefined);
    },
  } satisfies Dependencies;
  return {
    context,
    dependencies,
    requests,
    settlements,
    preflightRequirements,
    counts: () => ({ credentials, preflights }),
  };
};

describe("dictation operation request matrix", () => {
  test("uses the regional provider and records only bounded accounting metadata", async () => {
    const f = fixture();
    const result = await executeDictation(f.context, f.dependencies);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      text: TEXT,
      durationMs: 1234,
      detectedLanguage: "cs",
      vocabulary: "not-supported",
      segments: [{ startMs: 0, endMs: 1234, text: TEXT }],
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests.at(0)).toMatchObject({
      url: "https://eu.openrouter.ai/api/v1/audio/transcriptions",
      key: "Bearer managed-fixture",
      body: {
        language: "cs",
        provider: { zdr: true, data_collection: "deny" },
      },
    });
    expect(f.settlements).toHaveLength(1);
    const settlement = f.settlements.at(0);
    expect(settlement?.result).toEqual({ modelId: MODEL, durationMs: 1234 });
    expect(settlement?.workspaceId).toBeNull();
    expect(settlement?.isByok).toBe(false);
    expect(settlement?.caller).not.toHaveProperty("body");
    expect(JSON.stringify(settlement)).not.toContain(TEXT);
    expect(JSON.stringify(settlement)).not.toContain(VOCABULARY.at(0));
  });

  test("organization OpenRouter credential overrides the managed key on the same regional endpoint", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      orgAIConfig: {
        providers: [{ provider: "openrouter", apiKey: "organization-fixture" }],
        overrideModels: null,
        decision: null,
      },
    } satisfies DictationContext;
    expect((await executeDictation(context, f.dependencies)).isOk()).toBe(true);
    expect(f.counts()).toEqual({ credentials: 0, preflights: 1 });
    expect(f.requests.at(0)?.key).toBe("Bearer organization-fixture");
    expect(f.settlements.at(0)?.isByok).toBe(true);
    expect(f.preflightRequirements).toEqual([0]);
    expect(f.settlements.at(0)?.result.durationMs).toBe(1234);
  });

  test("allowance below the maximum chunk cost refuses before credential or provider work", async () => {
    const f = fixture();
    const required = transcriptionUsageUnits({
      modelId: MODEL,
      residency: "eu",
      durationMs: MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
      isByok: false,
    }).unitsConsumed;
    const minimum = computeUsageUnitCost({
      actionType: "transcription",
      serviceTier: "standard",
      isByok: false,
    });
    expect(required).toBeGreaterThan(minimum);
    const available = required - 1;
    const requirements: number[] = [];
    const result = await executeDictation(f.context, {
      ...f.dependencies,
      preflight: async ({ required: actualRequired }) => {
        requirements.push(actualRequired);
        return actualRequired > available
          ? Result.err(
              new HandlerError({
                status: 402,
                code: "usage_limit_exceeded",
                message: "Fixture allowance exhausted",
              }),
            )
          : Result.ok(undefined);
      },
    });
    expect(requirements).toEqual([required]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({
        status: 402,
        code: "usage_limit_exceeded",
      });
    }
    expect(f.requests).toEqual([]);
    expect(f.settlements).toEqual([]);
    expect(f.counts().credentials).toBe(0);
  });

  test.each([0, 1])(
    "allowance at or above maximum chunk cost admits the chunk with %s extra units",
    async (extra) => {
      const f = fixture();
      const required = transcriptionUsageUnits({
        modelId: MODEL,
        residency: "eu",
        durationMs: MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
        isByok: false,
      }).unitsConsumed;
      const available = required + extra;
      const requirements: number[] = [];
      const result = await executeDictation(f.context, {
        ...f.dependencies,
        preflight: async ({ required: actualRequired }) => {
          requirements.push(actualRequired);
          return actualRequired > available
            ? Result.err(
                new HandlerError({
                  status: 402,
                  code: "usage_limit_exceeded",
                  message: "Fixture allowance exhausted",
                }),
              )
            : Result.ok(undefined);
        },
      });
      expect(result.isOk()).toBe(true);
      expect(requirements).toEqual([required]);
      expect(f.requests).toHaveLength(1);
      expect(f.settlements.at(0)?.result.durationMs).toBe(1234);
    },
  );

  test.each([
    1,
    MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
    MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 + 1,
    Number.MAX_SAFE_INTEGER,
  ])(
    "settles the bounded duration while returning the full transcript for %s milliseconds",
    async (durationMs) => {
      const f = fixture(durationMs);
      const result = await executeDictation(f.context, {
        ...f.dependencies,
        transcribe: async () =>
          Result.ok({
            text: TEXT,
            segments: [],
            durationMs,
            detectedLanguage: "cs",
            modelId: MODEL,
            vocabulary: "not-supported",
          } satisfies TranscriptionResult),
      });
      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        throw result.error;
      }
      expect(result.value.text).toBe(TEXT);
      expect(result.value.durationMs).toBe(durationMs);
      expect(f.settlements.at(0)?.result).toEqual({
        modelId: MODEL,
        durationMs: Math.min(
          durationMs,
          MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
        ),
      });
      expect(f.preflightRequirements).toEqual([
        transcriptionUsageUnits({
          modelId: MODEL,
          residency: "eu",
          durationMs: MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
          isByok: false,
        }).unitsConsumed,
      ]);
    },
  );

  test("duration cap emits catalog metadata only for overbound clips", async () => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    try {
      for (const durationMs of [1234, MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000]) {
        const f = fixture(durationMs);
        expect((await executeDictation(f.context, f.dependencies)).isOk()).toBe(
          true,
        );
      }
      expect(lines).toEqual([]);
      const f = fixture(MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 + 1);
      expect((await executeDictation(f.context, f.dependencies)).isOk()).toBe(
        true,
      );
      expect(lines).toHaveLength(1);
      const line = lines.at(0);
      if (line === undefined) {
        throw new TypeError("Expected duration cap metric");
      }
      const record: unknown = JSON.parse(line);
      expect(record).toEqual({
        _aws: expect.any(Object),
        event: "transcription.duration_capped",
        modelId: MODEL,
        TranscriptionDurationCapped: 1,
      });
      for (const content of [TEXT, ...VOCABULARY, "hlas.wav"]) {
        expect(line).not.toContain(content);
      }
    } finally {
      resetMetricLineSinkForTesting();
    }
  });

  test("dictation settlement cost is monotone and bounded by preflight for every available model", async () => {
    await assertProperty(
      "dictation settlement cost is monotone and bounded by preflight for every available model",
      fc.asyncProperty(
        fc.tuple(
          fc.integer({ min: 1, max: MAX_TRANSCRIPTION_AUDIO_SECONDS * 10_000 }),
          fc.integer({ min: 1, max: MAX_TRANSCRIPTION_AUDIO_SECONDS * 10_000 }),
        ),
        async ([a, b]) => {
          let exercised = 0;
          for (const [modelId, model] of Object.entries(TRANSCRIPTION_MODELS)) {
            if (!isTranscriptionModelId(modelId)) {
              throw new TypeError("Expected catalog model id");
            }
            for (const residency of ["eu", "us"] as const) {
              if (model.residency[residency].status !== "available") {
                continue;
              }
              const maximum = transcriptionUsageUnits({
                modelId,
                residency,
                durationMs: MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
                isByok: false,
              }).unitsConsumed;
              const costs: number[] = [];
              for (const durationMs of [Math.min(a, b), Math.max(a, b)]) {
                const f = fixture(durationMs);
                const context = {
                  ...f.context,
                  managedAIResidency: residency,
                  body: { ...f.context.body, modelId },
                } satisfies DictationContext;
                const result = await executeDictation(context, f.dependencies);
                expect(result.isOk()).toBe(true);
                if (result.isErr()) {
                  throw result.error;
                }
                const settlement = f.settlements.at(0);
                if (settlement === undefined) {
                  throw new TypeError("Expected settlement");
                }
                expect(settlement.result.durationMs).toBe(
                  Math.min(durationMs, MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000),
                );
                expect(result.value.durationMs).toBe(durationMs);
                expect(f.preflightRequirements).toEqual([maximum]);
                const cost = transcriptionUsageUnits({
                  modelId,
                  residency,
                  durationMs: settlement.result.durationMs,
                  isByok: false,
                }).unitsConsumed;
                expect(cost).toBeLessThanOrEqual(maximum);
                costs.push(cost);
              }
              const lowerCost = costs.at(0);
              const higherCost = costs.at(1);
              if (lowerCost === undefined || higherCost === undefined) {
                throw new TypeError("Expected both settlement costs");
              }
              expect(lowerCost).toBeLessThanOrEqual(higherCost);
              exercised++;
            }
          }
          expect(exercised).toBeGreaterThan(0);
        },
      ),
    );
  });

  test.each([
    { provider: "openai", apiKey: "organization-fixture" },
    { provider: "anthropic", apiKey: "organization-fixture" },
    { provider: "google", apiKey: "organization-fixture" },
    { provider: "mistral", apiKey: "organization-fixture" },
    {
      provider: "azure_foundry",
      apiKey: "organization-fixture",
      baseURL: "https://fixture-resource.example.invalid/openai",
    },
  ] as const)(
    "organization provider %p requires explicit transcription credentials",
    async (provider) => {
      const f = fixture();
      const context = {
        ...f.context,
        orgAIConfig: {
          providers: [provider],
          overrideModels: null,
          decision: null,
        },
      } satisfies DictationContext;
      const result = await executeDictation(context, f.dependencies);
      expect(result.isErr()).toBe(true);
      if (result.isOk()) {
        throw new TypeError("Expected organization credential refusal");
      }
      expect(result.error).toMatchObject({ code: "ai_own_key_required" });
      expect(f.counts()).toEqual({ credentials: 0, preflights: 0 });
      expect(f.requests).toEqual([]);
      expect(f.settlements).toEqual([]);
    },
  );

  test("self-hosted missing credentials refuses before dispatch", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ownKeyRequired,
    };
    expect((await executeDictation(context, f.dependencies)).isErr()).toBe(
      true,
    );
    expect(f.requests).toEqual([]);
    expect(f.settlements).toEqual([]);
  });

  test("a caller without matter access gets not found before any provider work", async () => {
    const f = fixture();
    f.context.body.matterId = createTestHandlerContext({
      audit: NO_AUDIT,
      safeDb: NO_DB,
      scopedDb: NO_DB,
    }).workspaceId;
    const context = { ...f.context, getWorkspaceAccess: async () => null };
    const result = await executeDictation(context, f.dependencies);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new TypeError("Expected matter refusal");
    }
    expect(result.error).toMatchObject({ status: 404 });
    expect(f.requests).toEqual([]);
    expect(f.settlements).toEqual([]);
  });

  test("an authorized matter is attributed in accounting without influencing the provider request", async () => {
    const f = fixture();
    const matterId = createTestHandlerContext({
      audit: NO_AUDIT,
      safeDb: NO_DB,
      scopedDb: NO_DB,
    }).workspaceId;
    f.context.body.matterId = matterId;
    expect((await executeDictation(f.context, f.dependencies)).isOk()).toBe(
      true,
    );
    expect(f.settlements.at(0)?.workspaceId).toBe(matterId);
    expect(JSON.stringify(f.requests)).not.toContain(matterId);
  });

  test("unknown US model availability never tries a public or alternate-region endpoint", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      managedAIResidency: "us",
    } as const satisfies DictationContext;
    const result = await executeDictation(context, f.dependencies);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new TypeError("Expected regional refusal");
    }
    expect(result.error).toMatchObject({
      code: "transcription_model_unavailable",
    });
    expect(f.requests).toEqual([]);
    expect(f.counts()).toEqual({ credentials: 0, preflights: 0 });
  });

  test.each(["allowance", "rate", "provider"] as const)(
    "%s refusal leaves no stored transcript or settlement",
    async (failure) => {
      const f = fixture();
      const refusal = new HandlerError({
        status: 503,
        code: "service_unavailable",
        message: "Fixture unavailable",
      });
      const cases = {
        allowance: {
          ...f.dependencies,
          preflight: async () => Result.err(refusal),
        },
        rate: { ...f.dependencies, limit: async () => Result.err(refusal) },
        provider: {
          ...f.dependencies,
          transcribe: async () => Result.err(refusal),
        },
      } satisfies Record<typeof failure, Dependencies>;
      const result = await executeDictation(f.context, cases[failure]);
      expect(result.isErr()).toBe(true);
      expect(f.requests).toEqual([]);
      expect(f.settlements).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(TEXT);
      expect(JSON.stringify(result)).not.toContain(VOCABULARY.at(0));
    },
  );
});

describe("dictation input boundary", () => {
  test("accepts Czech and Slovak language codes and bounded vocabulary", () => {
    for (const language of ["cs", "sk"]) {
      expect(
        v.safeParse(dictationBodySchema, {
          file: wav(),
          modelId: MODEL,
          language,
          vocabulary: JSON.stringify(VOCABULARY),
        }).success,
      ).toBe(true);
    }
  });
  test("rejects malformed input before provider dispatch", () => {
    for (const patch of [
      { file: new File([], "empty.wav", { type: "audio/wav" }) },
      {
        file: new File(
          [new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES + 1)],
          "large.wav",
          { type: "audio/wav" },
        ),
      },
      { modelId: "unsupported/model" },
      { language: "zz" },
      { language: "cs-CZ" },
      {
        vocabulary: JSON.stringify(
          Array.from(
            { length: MAX_TRANSCRIPTION_VOCABULARY_TERMS + 1 },
            () => "Žofia",
          ),
        ),
      },
      {
        vocabulary: JSON.stringify([
          "Ž".repeat(MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH + 1),
        ]),
      },
      { vocabulary: "[" },
      { matterId: "bad-id" },
    ]) {
      expect(
        v.safeParse(dictationBodySchema, {
          file: wav(),
          modelId: MODEL,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });
});
