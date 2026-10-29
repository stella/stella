import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, count, eq, isNotNull } from "drizzle-orm";

import { MAX_TRANSCRIPTION_AUDIO_SECONDS } from "@stll/api-contract/transcription";

import { auditLogs, usageAllocations, usageEvents } from "@/api/db/schema";
import { env } from "@/api/env";
import type { TranscriptionResult } from "@/api/handlers/dictation/provider";
import { createDictationTranscribeEndpoint } from "@/api/handlers/dictation/transcribe";
import { HttpStatusResponse } from "@/api/http/status";
import { transcriptionUsageUnits } from "@/api/lib/usage/unit-model";
import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";

import { dictationScalingScenario, seedDictationScaling } from "./dictation";
import { writeScalingViolations } from "./measurement";

const testState = createTestState({ file: import.meta.path, config: env });

const measureAt = async (db: GatedTestDb, size: number) => {
  const fixture = await seedDictationScaling(db, size);
  try {
    return await dictationScalingScenario.measure(fixture);
  } finally {
    await fixture.cleanup();
  }
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "dictation scaling",
  () => {
    test("an exhausted allowance returns 402 before credentials, provider or settlement", async () => {
      testState.setConfig("USAGE_ENFORCEMENT_ENABLED", true);
      testState.setConfig("FEATURE_FREE_TIER", false);
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const fixture = await seedDictationScaling(db, 10);
        try {
          await db
            .delete(usageAllocations)
            .where(eq(usageAllocations.organizationId, fixture.organizationId));
          let providerRequests = 0;
          let credentialRequests = 0;
          const endpoint = createDictationTranscribeEndpoint({
            transcribe: async () => {
              providerRequests += 1;
              return panic(
                "An exhausted allowance must not reach the provider",
              );
            },
            credential: async () => {
              credentialRequests += 1;
              return panic(
                "An exhausted allowance must not acquire credentials",
              );
            },
            limit: async () => await Promise.resolve(Result.ok(undefined)),
          });
          const response = await endpoint.handler(
            createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
              ...fixture.context,
              body: {
                file: new File(["fixture audio"], "dictation.wav", {
                  type: "audio/wav",
                }),
                modelId: "mistralai/voxtral-mini-transcribe",
              },
              route: "/v1/dictation/transcribe",
            }),
          );
          expect(response).toBeInstanceOf(HttpStatusResponse);
          if (!(response instanceof HttpStatusResponse)) {
            panic("An exhausted allowance must return an HTTP refusal");
          }
          expect(response.code).toBe(402);
          expect(JSON.stringify(response.response)).toContain(
            "usage_limit_exceeded",
          );
          expect(providerRequests).toBe(0);
          expect(credentialRequests).toBe(0);
          const usage = await db
            .select({ count: count() })
            .from(usageEvents)
            .where(eq(usageEvents.organizationId, fixture.organizationId));
          const audit = await db
            .select({ count: count() })
            .from(auditLogs)
            .where(eq(auditLogs.organizationId, fixture.organizationId));
          expect(usage).toEqual([{ count: 10 }]);
          expect(audit).toEqual([{ count: 0 }]);
        } finally {
          await fixture.cleanup();
        }
      });
    }, 120_000); // timeout: seeds and exercises allowance admission against real PostgreSQL

    // timeout: exercises admission and bounded settlement against real PostgreSQL
    test.each([
      {
        name: "below the maximum cost",
        type: "refused",
        remainingDelta: -1,
        durationMs: 1234,
        credentials: "managed",
      },
      {
        name: "above the maximum cost with short audio",
        type: "settled",
        remainingDelta: 1,
        durationMs: 1234,
        credentials: "managed",
      },
      {
        name: "above the maximum cost with excessive provider duration",
        type: "settled",
        remainingDelta: 1,
        durationMs: 1_000_000,
        credentials: "managed",
      },
      {
        name: "organization credentials with no remaining allowance",
        type: "settled",
        remainingDelta: 0,
        durationMs: 1_000_000,
        credentials: "organization",
      },
    ] as const)(
      "bounds admission and settlement: $name",
      async (scenario) => {
        testState.setConfig("USAGE_ENFORCEMENT_ENABLED", true);
        testState.setConfig("FEATURE_FREE_TIER", false);
        const databaseUrl =
          process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
        const modelId = "mistralai/voxtral-mini-transcribe";
        const maximumDurationMs = MAX_TRANSCRIPTION_AUDIO_SECONDS * 1000;
        const maximumCost = transcriptionUsageUnits({
          modelId,
          residency: "eu",
          durationMs: maximumDurationMs,
          isByok: false,
        });
        expect(maximumCost.unitsConsumed).toBeGreaterThan(2);
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const fixture = await seedDictationScaling(db, 10);
          try {
            const isByok = scenario.credentials === "organization";
            const remaining = isByok
              ? 0
              : maximumCost.unitsConsumed + scenario.remainingDelta;
            await db
              .update(usageAllocations)
              .set({ units: 10 + remaining })
              .where(
                eq(usageAllocations.organizationId, fixture.organizationId),
              );
            let providerRequests = 0;
            let credentialRequests = 0;
            const transcript = {
              text: "Návrh paní Šimůnkové.",
              segments: [],
              detectedLanguage: "cs",
              vocabulary: "not-supported",
              durationMs: scenario.durationMs,
              modelId,
            } satisfies TranscriptionResult;
            const endpoint = createDictationTranscribeEndpoint({
              transcribe: async () => {
                providerRequests += 1;
                return await Promise.resolve(Result.ok(transcript));
              },
              credential: async () => {
                credentialRequests += 1;
                return await Promise.resolve(
                  Result.ok({ type: "static", apiKey: "recorded-credential" }),
                );
              },
              limit: async () => await Promise.resolve(Result.ok(undefined)),
            });
            const response = await endpoint.handler(
              createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
                ...fixture.context,
                ...(isByok
                  ? {
                      orgAIConfig: {
                        providers: [
                          {
                            provider: "openrouter",
                            apiKey: "recorded-organization-credential",
                          },
                        ],
                        overrideModels: null,
                        decision: null,
                      },
                    }
                  : {}),
                body: {
                  file: new File(["fixture audio"], "dictation.wav", {
                    type: "audio/wav",
                  }),
                  modelId,
                },
                route: "/v1/dictation/transcribe",
              }),
            );
            const recorded = await db
              .select({
                unitsConsumed: usageEvents.unitsConsumed,
                rawUsageMicroUnits: usageEvents.rawUsageMicroUnits,
                isByok: usageEvents.isByok,
              })
              .from(usageEvents)
              .where(
                and(
                  eq(usageEvents.organizationId, fixture.organizationId),
                  isNotNull(usageEvents.idempotencyKey),
                ),
              );
            const audits = await db
              .select({ metadata: auditLogs.metadata })
              .from(auditLogs)
              .where(eq(auditLogs.organizationId, fixture.organizationId));
            switch (scenario.type) {
              case "refused": {
                if (!(response instanceof HttpStatusResponse)) {
                  panic(
                    "An insufficient maximum-duration allowance must return an HTTP refusal",
                  );
                }
                expect(response.code).toBe(402);
                expect(JSON.stringify(response.response)).toContain(
                  "usage_limit_exceeded",
                );
                expect(providerRequests).toBe(0);
                expect(credentialRequests).toBe(0);
                expect(recorded).toEqual([]);
                expect(audits).toEqual([]);
                break;
              }
              case "settled": {
                if (response instanceof HttpStatusResponse) {
                  panic("An admitted transcription must settle successfully");
                }
                expect(response.text).toBe(transcript.text);
                expect(providerRequests).toBe(1);
                expect(credentialRequests).toBe(isByok ? 0 : 1);
                const durationMs = Math.min(
                  scenario.durationMs,
                  maximumDurationMs,
                );
                const measured = transcriptionUsageUnits({
                  modelId,
                  residency: "eu",
                  durationMs,
                  isByok,
                });
                expect(recorded).toEqual([{ ...measured, isByok }]);
                expect(audits).toHaveLength(1);
                expect(audits.at(0)?.metadata).toMatchObject({
                  operation: "dictation.transcribe",
                  modelId,
                  durationMs,
                });
                if (scenario.durationMs > maximumDurationMs) {
                  expect(measured.rawUsageMicroUnits).toBe(
                    maximumCost.rawUsageMicroUnits,
                  );
                  expect(measured.unitsConsumed).toBe(
                    isByok ? 0 : maximumCost.unitsConsumed,
                  );
                } else {
                  expect(measured.unitsConsumed).toBeLessThan(
                    maximumCost.unitsConsumed,
                  );
                }
                break;
              }
              default:
                scenario satisfies never;
            }
          } finally {
            await fixture.cleanup();
          }
        });
      },
      120_000,
    );

    test("transcription keeps database work and response bytes fixed at 10 and 200 usage events", async () => {
      testState.setConfig("USAGE_ENFORCEMENT_ENABLED", true);
      testState.setConfig("FEATURE_FREE_TIER", false);
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      expect(
        apiApp.routes.some(
          ({ definition }) =>
            definition === dictationScalingScenario.definition,
        ),
      ).toBe(true);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const small = await measureAt(db, 10);
        const large = await measureAt(db, 200);
        expect(small.providerRequests).toBe(1);
        expect(large.providerRequests).toBe(1);
        expect(small.transactionRoundTrips).toBeGreaterThan(0);
        expect(writeScalingViolations({ small, large })).toEqual([]);
        console.info(
          "handler-scaling",
          JSON.stringify({ name: dictationScalingScenario.name, small, large }),
        );
      });
    }, 120_000); // timeout: seeds and exercises real PostgreSQL accounting at two populations
  },
);
