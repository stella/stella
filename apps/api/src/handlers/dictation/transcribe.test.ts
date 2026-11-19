import { Result } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import * as v from "valibot";

import {
  defaultTranscriptionModelId,
  isTranscriptionModelId,
  TRANSCRIPTION_MODELS,
} from "@stll/ai-catalog/transcription";
import {
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  MAX_TRANSCRIPTION_AUDIO_SECONDS,
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH,
  MAX_TRANSCRIPTION_VOCABULARY_TERMS,
  TRANSCRIPTION_DURATION_TOLERANCE_MS,
  TRANSCRIPTION_LABELS_SHOWN_FIELD,
} from "@stll/api-contract/transcription";
import { assertProperty } from "@stll/property-testing";
import { createTestState } from "@stll/test-state";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { env } from "@/api/env";
import { makeM4aAudioBytes } from "@/api/handlers/dictation/audio-fixtures.test-helper";
import { transcribeWithElevenLabs } from "@/api/handlers/dictation/elevenlabs-provider";
import { transcribeAudio } from "@/api/handlers/dictation/provider";
import type { TranscriptionResult } from "@/api/handlers/dictation/provider";
import type { TranscriptionDeployment } from "@/api/handlers/dictation/transcription-deployment";
import { HttpStatusResponse } from "@/api/http/status";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { admitFixtureModelDispatch } from "@/api/lib/rate-limit/model-dispatch-admission";
import { computeUsageUnitCost } from "@/api/lib/usage/action-weights";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { transcriptionUsageUnits } from "@/api/lib/usage/unit-model";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { desktopDictationBodySchema, dictationBodySchema } from "./schema";
import {
  createDictationTranscribeEndpoint,
  executeDictation,
} from "./transcribe";

const testState = createTestState({ file: import.meta.path, config: env });

type DictationContext = Exclude<
  Parameters<typeof executeDictation>[0],
  { orgAIConfigStatus: "unreadable" }
>;
type Dependencies = Parameters<typeof executeDictation>[1];
const TEXT = "K návrhu Žofie Černé a Ľubomíra Kováča.";
const VOCABULARY = ["Žofia Černá", "Ľubomír Kováč"];
const MODEL = "mistralai/voxtral-mini-transcribe";

const audioChunk = (durationMs = 1234) =>
  new File([makeM4aAudioBytes(durationMs)], "hlas.m4a", { type: "audio/mp4" });

const OPENROUTER_ONLY = { openRouter: true, elevenLabs: null } as const;

const fixture = (
  durationMs = 1234,
  admittedDurationMs = Math.min(
    durationMs,
    MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
  ),
  deployment: ReturnType<Dependencies["deployment"]> = OPENROUTER_ONLY,
) => {
  const context = createTestHandlerContext<DictationContext>({
    audit: NO_AUDIT,
    safeDb: NO_DB,
    scopedDb: NO_DB,
    body: {
      file: audioChunk(admittedDurationMs),
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
  const directRequests: { url: string; form: FormData; key: string | null }[] =
    [];
  const dependencies = {
    deployment: () => deployment,
    transcribeElevenLabs: async (options) =>
      await transcribeWithElevenLabs({
        ...options,
        fetch: async (url, init) => {
          if (!(init.body instanceof FormData)) {
            throw new TypeError("Expected a multipart body");
          }
          directRequests.push({
            url: String(url),
            form: init.body,
            key: new Headers(init.headers).get("xi-api-key"),
          });
          return Response.json({
            text: TEXT,
            language_code: "ces",
            words: [{ text: "K", type: "word", start: 0, end: 0.2 }],
            audio_duration_secs: durationMs / 1000,
          });
        },
      }),
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
    directRequests,
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
    MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 +
      TRANSCRIPTION_DURATION_TOLERANCE_MS,
    MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 +
      TRANSCRIPTION_DURATION_TOLERANCE_MS +
      1,
    1_000_000,
    Number.MAX_SAFE_INTEGER,
  ])(
    "settles the reported duration against admitted media while returning the full transcript for %s milliseconds",
    async (durationMs) => {
      const f = fixture(durationMs);
      const result = await executeDictation(f.context, {
        ...f.dependencies,
        transcribe: async () =>
          Result.ok({
            transcript: {
              text: TEXT,
              segments: [],
              durationMs,
              detectedLanguage: "cs",
              modelId: MODEL,
              vocabulary: "not-supported",
            } satisfies TranscriptionResult,
            admittedDurationMs: Math.min(
              durationMs,
              MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
            ),
          }),
      });
      expect(result.isOk()).toBe(true);
      if (result.isErr()) {
        throw result.error;
      }
      expect(result.value.text).toBe(TEXT);
      expect(result.value.durationMs).toBe(durationMs);
      const maximumDurationMs = MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000;
      expect(result.value).not.toHaveProperty("admittedDurationMs");
      expect(f.settlements.at(0)?.result).toEqual({
        modelId: MODEL,
        durationMs:
          durationMs > maximumDurationMs + TRANSCRIPTION_DURATION_TOLERANCE_MS
            ? durationMs
            : Math.min(durationMs, maximumDurationMs),
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

  test("duration mismatch emits catalog metadata only beyond the admitted timing tolerance", async () => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    try {
      for (const durationMs of [
        1234,
        MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
        MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 +
          TRANSCRIPTION_DURATION_TOLERANCE_MS,
      ]) {
        const f = fixture(durationMs);
        expect((await executeDictation(f.context, f.dependencies)).isOk()).toBe(
          true,
        );
      }
      expect(lines).toEqual([]);
      const f = fixture(1234, 1000);
      expect((await executeDictation(f.context, f.dependencies)).isOk()).toBe(
        true,
      );
      expect(lines).toHaveLength(1);
      const line = lines.at(0);
      if (line === undefined) {
        throw new TypeError("Expected duration mismatch metric");
      }
      const record: unknown = JSON.parse(line);
      expect(record).toEqual({
        event: "transcription.duration_mismatch",
        modelId: MODEL,
        TranscriptionDurationMismatch: 1,
      });
      for (const content of [TEXT, ...VOCABULARY, "hlas.m4a"]) {
        expect(line).not.toContain(content);
      }
    } finally {
      resetMetricLineSinkForTesting();
    }
  });

  test("honest media timing keeps settlement monotone and within preflight for every available model", async () => {
    await assertProperty(
      "honest media timing keeps settlement monotone and within preflight for every available model",
      fc.asyncProperty(
        fc.tuple(
          fc.integer({
            min: 1,
            max:
              MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 +
              TRANSCRIPTION_DURATION_TOLERANCE_MS,
          }),
          fc.integer({
            min: 1,
            max:
              MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000 +
              TRANSCRIPTION_DURATION_TOLERANCE_MS,
          }),
        ),
        async ([a, b]) => {
          let exercised = 0;
          for (const [modelId, model] of Object.entries(TRANSCRIPTION_MODELS)) {
            if (!isTranscriptionModelId(modelId)) {
              throw new TypeError("Expected catalog model id");
            }
            if (model.route !== "openrouter") {
              continue;
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
                  body: { ...f.context.body, modelId, vocabulary: undefined },
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
    "an organization on provider %p transcribes on stella's credential, as stella usage",
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
      expect(result.isOk()).toBe(true);
      expect(f.counts()).toEqual({ credentials: 1, preflights: 1 });
      expect(f.requests.at(0)?.key).toBe("Bearer managed-fixture");
      expect(f.settlements).toHaveLength(1);
      expect(f.settlements.at(0)?.isByok).toBe(false);
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

  test("a model the region does not serve never tries the global or another region's endpoint without the caller's opt-in", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      managedAIResidency: "us",
    } as const satisfies DictationContext;
    expect(TRANSCRIPTION_MODELS[MODEL].residency.us.status).not.toBe(
      "available",
    );
    const result = await executeDictation(context, f.dependencies);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new TypeError("Expected regional refusal");
    }
    expect(result.error).toMatchObject({
      code: "transcription_model_unavailable",
      message: "This transcription model is not available in your region",
      hint: "Choose a transcription model available in your region, or leave the model out.",
    });
    expect(f.requests).toEqual([]);
    expect(f.counts()).toEqual({ credentials: 0, preflights: 0 });
  });

  test("a caller that labels models outside the region sends a named one to the global endpoint and is billed its price", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      managedAIResidency: "us",
      allowOutsideRegion: true,
    } as const satisfies DictationContext;
    const result = await executeDictation(context, f.dependencies);
    if (result.isErr()) {
      throw result.error;
    }
    expect(f.requests.at(0)).toMatchObject({
      url: "https://openrouter.ai/api/v1/audio/transcriptions",
      body: { model: MODEL, provider: { zdr: true, data_collection: "deny" } },
    });
    expect(f.settlements.at(0)?.caller.transcriptionEndpoint).toBe("global");
    expect(f.preflightRequirements).toEqual([
      transcriptionUsageUnits({
        modelId: MODEL,
        residency: "global",
        durationMs: MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000,
        isByok: false,
      }).unitsConsumed,
    ]);
  });

  test("Scribe v3 goes straight to the deployment's ElevenLabs environment with zero retention, billed to stella", async () => {
    const f = fixture(1234, 1234, {
      openRouter: true,
      elevenLabs: {
        apiKey: "elevenlabs-fixture",
        environment: "eu",
        zeroRetention: true,
      },
    });
    const context = {
      ...f.context,
      orgAIConfig: null,
      body: {
        ...f.context.body,
        modelId: "elevenlabs-direct/scribe-v3",
        vocabulary: undefined,
      },
    } as const satisfies DictationContext;
    const result = await executeDictation(context, f.dependencies);
    if (result.isErr()) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      text: TEXT,
      detectedLanguage: "ces",
      durationMs: 1234,
      modelId: "elevenlabs-direct/scribe-v3",
      words: [{ startMs: 0, endMs: 200, text: "K" }],
    });
    expect(f.requests).toEqual([]);
    expect(f.counts().credentials).toBe(0);
    const request = f.directRequests.at(0);
    expect(request?.url).toBe(
      "https://api.eu.residency.elevenlabs.io/v1/speech-to-text?enable_logging=false",
    );
    expect(request?.key).toBe("elevenlabs-fixture");
    expect(request?.form.get("model_id")).toBe("scribe_v3");
    expect(request?.form.get("language_code")).toBe("cs");
    const settlement = f.settlements.at(0);
    expect(settlement?.isByok).toBe(false);
    expect(settlement?.caller.transcriptionEndpoint).toBe("eu");
  });

  test("Scribe v3 is refused without the deployment's key", async () => {
    const f = fixture(1234, 1234, OPENROUTER_ONLY);
    const context = {
      ...f.context,
      body: { ...f.context.body, modelId: "elevenlabs-direct/scribe-v3" },
    } satisfies DictationContext;
    const result = await executeDictation(context, f.dependencies);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new TypeError("Expected refusal");
    }
    expect(result.error).toMatchObject({
      code: "transcription_model_unavailable",
    });
    expect(f.directRequests).toEqual([]);
  });

  test("an organization on its own provider transcribes with Scribe v3 on the deployment's key, as stella usage", async () => {
    const deployment = {
      openRouter: true,
      elevenLabs: {
        apiKey: "elevenlabs-fixture",
        environment: "eu",
        zeroRetention: true,
      },
    } as const satisfies TranscriptionDeployment;
    for (const provider of [
      { provider: "openrouter", apiKey: "organization-fixture" },
      { provider: "anthropic", apiKey: "organization-fixture" },
    ] as const) {
      const f = fixture(1234, 1234, deployment);
      const context = {
        ...f.context,
        orgAIConfig: {
          providers: [provider],
          overrideModels: null,
          decision: null,
        },
        body: { ...f.context.body, modelId: "elevenlabs-direct/scribe-v3" },
      } satisfies DictationContext;
      expect((await executeDictation(context, f.dependencies)).isOk()).toBe(
        true,
      );
      expect(f.directRequests).toHaveLength(1);
      expect(f.directRequests.at(0)?.key).toBe("elevenlabs-fixture");
      expect(f.requests).toEqual([]);
      expect(f.settlements.at(0)?.isByok).toBe(false);
    }
  });

  test("a deployment without a transcription credential says how to configure one, not that the region lacks a model", async () => {
    const f = fixture(1234, 1234, { openRouter: false, elevenLabs: null });
    const result = await executeDictation(
      {
        ...f.context,
        orgAIConfig: {
          providers: [
            { provider: "anthropic", apiKey: "organization-fixture" },
          ],
          overrideModels: null,
          decision: null,
        },
      },
      f.dependencies,
    );
    expect(result.isErr() && result.error).toMatchObject({
      status: 503,
      code: "transcription_model_unavailable",
      message: "No transcription provider is available to your organization",
      hint: "Configure an organization OpenRouter key in organization AI settings, or ask your server administrator to configure transcription.",
    });
    expect(f.requests).toEqual([]);
    expect(f.counts().credentials).toBe(0);
  });

  test("a key without zero retention never asks for it, serves only a caller that warns, and is never a default", async () => {
    const deployment = {
      openRouter: false,
      elevenLabs: {
        apiKey: "elevenlabs-fixture",
        environment: "eu",
        zeroRetention: false,
      },
    } as const;
    const named = {
      modelId: "elevenlabs-direct/scribe-v3",
      vocabulary: undefined,
    } as const;
    const web = fixture(1234, 1234, deployment);
    const refused = await executeDictation(
      {
        ...web.context,
        orgAIConfig: null,
        body: { ...web.context.body, ...named },
      },
      web.dependencies,
    );
    expect(refused.isErr() && refused.error).toMatchObject({
      code: "transcription_model_unavailable",
    });
    const defaulted = fixture(1234, 1234, deployment);
    const noDefault = await executeDictation(
      {
        ...defaulted.context,
        orgAIConfig: null,
        allowRetainingModels: true,
        body: { ...defaulted.context.body, modelId: undefined },
      },
      defaulted.dependencies,
    );
    expect(noDefault.isErr() && noDefault.error).toMatchObject({
      code: "transcription_model_unavailable",
    });
    const desktop = fixture(1234, 1234, deployment);
    const result = await executeDictation(
      {
        ...desktop.context,
        orgAIConfig: null,
        allowRetainingModels: true,
        body: { ...desktop.context.body, ...named },
      },
      desktop.dependencies,
    );
    if (result.isErr()) {
      throw result.error;
    }
    expect(desktop.directRequests.at(0)?.url).toBe(
      "https://api.eu.residency.elevenlabs.io/v1/speech-to-text",
    );
    expect([...web.directRequests, ...defaulted.directRequests]).toEqual([]);
  });

  test("a default never leaves the region, even for a caller that allows it", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      allowOutsideRegion: true,
      body: { ...f.context.body, modelId: undefined },
    } as const satisfies DictationContext;
    const result = await executeDictation(context, f.dependencies);
    if (result.isErr()) {
      throw result.error;
    }
    expect(f.requests.at(0)?.url).toBe(
      "https://eu.openrouter.ai/api/v1/audio/transcriptions",
    );
    expect(f.settlements.at(0)?.caller.transcriptionEndpoint).toBe("eu");
  });

  test("a request naming no model is sent to the region's default and settled under it", async () => {
    const f = fixture();
    const context = {
      ...f.context,
      body: { ...f.context.body, modelId: undefined },
    } as const satisfies DictationContext;
    const result = await executeDictation(context, f.dependencies);
    if (result.isErr()) {
      throw result.error;
    }
    expect(defaultTranscriptionModelId("eu")).toBe(MODEL);
    expect(f.requests.at(0)?.body).toMatchObject({ model: MODEL });
    expect(f.settlements.at(0)?.result).toEqual({
      modelId: MODEL,
      durationMs: 1234,
    });
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
          file: audioChunk(),
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
          file: audioChunk(),
          modelId: MODEL,
          ...patch,
        }).success,
      ).toBe(false);
    }
  });
});

describe("a member's labels flag", () => {
  const USER_ID = toSafeId<"user">("labelling-member");
  const ORGANIZATION_ID = toSafeId<"organization">("labelling-firm");
  const EMAIL = "labelling-member@example.test";
  const GRANT = {
    type: "member",
    organizationId: ORGANIZATION_ID,
    email: EMAIL,
  } as const;
  const SCRIBE = "elevenlabs-direct/scribe-v3";
  /** An ElevenLabs key without zero retention: Scribe v3 keeps the audio. */
  const RETAINING = {
    openRouter: true,
    elevenLabs: {
      apiKey: "elevenlabs-fixture",
      environment: "eu",
      zeroRetention: false,
    },
  } as const;

  beforeEach(() => {
    testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
  });

  const grantRetainingModels = () => {
    testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
      "desktop-dictation": [GRANT],
      "desktop-dictation-cloud": [GRANT],
      "desktop-dictation-retaining-models": [GRANT],
    });
  };

  const transcribeAs = async ({
    modelId,
    labels,
    residency = "eu",
    deployment = RETAINING,
  }: {
    modelId: string;
    labels: boolean;
    residency?: "eu" | "us";
    deployment?: TranscriptionDeployment;
  }) => {
    const f = fixture(1234, 1234, deployment);
    const { scopedDb } = createScopedDbMock({});
    const endpoint = createDictationTranscribeEndpoint({
      ...f.dependencies,
      admit: asTestRaw<typeof withActionAdmission>(
        async ({ run }: Parameters<typeof withActionAdmission>[0]) =>
          Result.ok(
            await run(new AbortController().signal, {
              reservePeriod: async () => Result.ok(undefined),
            }),
          ),
      ),
    });
    const result = await endpoint.handler(
      createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
        audit: NO_AUDIT,
        scopedDb,
        safeDb: safeDbFromScoped(scopedDb),
        session: { activeOrganizationId: ORGANIZATION_ID },
        user: { id: USER_ID, email: EMAIL },
        managedAIResidency: residency,
        featureAccessSnapshot: buildFeatureAccessSnapshot({
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
          identity: { email: EMAIL, emailVerified: true },
          enrolments: [],
        }),
        body: {
          file: audioChunk(),
          modelId,
          language: "cs",
          ...(labels ? { [TRANSCRIPTION_LABELS_SHOWN_FIELD]: "1" } : {}),
        },
        request: new Request("https://stella.test/v1/dictation/transcribe", {
          method: "POST",
        }),
        route: "/v1/dictation/transcribe",
      }),
    );
    return { result, f };
  };

  const refusalSchema = v.object({ code: v.string() });
  const refusalCode = (result: unknown) => {
    if (!(result instanceof HttpStatusResponse)) {
      return undefined;
    }
    const refusal = v.safeParse(refusalSchema, result.response);
    return refusal.success ? refusal.output.code : undefined;
  };

  test("lets a granted member name a model whose provider keeps the audio", async () => {
    grantRetainingModels();
    const { result, f } = await transcribeAs({ modelId: SCRIBE, labels: true });
    expect(result).not.toBeInstanceOf(HttpStatusResponse);
    expect(result).toMatchObject({ modelId: SCRIBE, text: TEXT });
    expect(f.directRequests).toHaveLength(1);
  });

  test("never lets a member without the grant name such a model", async () => {
    const { result, f } = await transcribeAs({ modelId: SCRIBE, labels: true });
    expect(result instanceof HttpStatusResponse && result.code).toBe(503);
    expect(refusalCode(result)).toBe("transcription_model_unavailable");
    expect(f.directRequests).toEqual([]);
  });

  test("without it, a granted member still gets the region's models only", async () => {
    grantRetainingModels();
    const retaining = await transcribeAs({ modelId: SCRIBE, labels: false });
    expect(refusalCode(retaining.result)).toBe(
      "transcription_model_unavailable",
    );
    expect(retaining.f.directRequests).toEqual([]);
    expect(TRANSCRIPTION_MODELS[MODEL].residency.us.status).not.toBe(
      "available",
    );
    const outside = await transcribeAs({
      modelId: MODEL,
      labels: false,
      residency: "us",
      deployment: OPENROUTER_ONLY,
    });
    expect(refusalCode(outside.result)).toBe("transcription_model_unavailable");
    expect(outside.f.requests).toEqual([]);
  });

  test("lets a member name a model outside the region, sent to the global endpoint", async () => {
    const { result, f } = await transcribeAs({
      modelId: MODEL,
      labels: true,
      residency: "us",
      deployment: OPENROUTER_ONLY,
    });
    expect(result).not.toBeInstanceOf(HttpStatusResponse);
    expect(f.requests.at(0)?.url).toBe(
      "https://openrouter.ai/api/v1/audio/transcriptions",
    );
    expect(f.settlements.at(0)?.caller.transcriptionEndpoint).toBe("global");
  });

  test("reads the grant only for a named model whose provider keeps the audio, after matter access", async () => {
    let reads = 0;
    const readGrant = async () => {
      reads += 1;
      return await Promise.resolve(Result.ok(true));
    };
    const run = async (
      body: Partial<DictationContext["body"]>,
      getWorkspaceAccess?: DictationContext["getWorkspaceAccess"],
    ) => {
      const f = fixture(1234, 1234, RETAINING);
      const result = await executeDictation(
        {
          ...f.context,
          ...(getWorkspaceAccess === undefined ? {} : { getWorkspaceAccess }),
          allowOutsideRegion: true,
          allowRetainingModels: readGrant,
          body: { ...f.context.body, ...body },
        },
        f.dependencies,
      );
      return { result, f };
    };
    // The region's default and a model that keeps nothing never read it.
    expect((await run({ modelId: undefined })).result.isOk()).toBe(true);
    expect((await run({ modelId: MODEL })).result.isOk()).toBe(true);
    expect(reads).toBe(0);
    // A matter the member cannot see is refused before the grant is read.
    const hidden = await run(
      {
        modelId: SCRIBE,
        matterId: createTestHandlerContext({
          audit: NO_AUDIT,
          safeDb: NO_DB,
          scopedDb: NO_DB,
        }).workspaceId,
      },
      async () => null,
    );
    expect(hidden.result.isErr() && hidden.result.error).toMatchObject({
      status: 404,
    });
    expect(reads).toBe(0);
    const named = await run({ modelId: SCRIBE });
    expect(named.result.isOk()).toBe(true);
    expect(named.f.directRequests).toHaveLength(1);
    expect(reads).toBe(1);
  });

  test("is a multipart field the member body reads and the desktop body refuses", () => {
    const upload = {
      file: audioChunk(),
      modelId: MODEL,
      [TRANSCRIPTION_LABELS_SHOWN_FIELD]: "1",
    };
    expect(v.safeParse(dictationBodySchema, upload).success).toBe(true);
    expect(
      v.safeParse(dictationBodySchema, {
        ...upload,
        [TRANSCRIPTION_LABELS_SHOWN_FIELD]: "yes",
      }).success,
    ).toBe(false);
    expect(v.safeParse(desktopDictationBodySchema, upload).success).toBe(false);
    // A desktop names the matter a recording is filed under; the API reads
    // that matter's vocabulary itself. A recording's piece names itself, so
    // a retry is counted once.
    expect(Object.keys(desktopDictationBodySchema.entries).toSorted()).toEqual([
      "file",
      "language",
      "matterId",
      "modelId",
      "pieceId",
    ]);
  });
});
