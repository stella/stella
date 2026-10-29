import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";

import { auditLogs, usageAllocations, usageEvents } from "@/api/db/schema";
import { env } from "@/api/env";
import { createDictationTranscribeEndpoint } from "@/api/handlers/dictation/transcribe";
import { HttpStatusResponse } from "@/api/http/status";
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
