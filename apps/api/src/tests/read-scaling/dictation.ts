import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  usageAllocations,
  usageEntitlements,
  usageEvents,
  usagePolicies,
} from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import transcribeDictation, {
  createDictationTranscribeEndpoint,
} from "@/api/handlers/dictation/transcribe";
import { HttpStatusResponse } from "@/api/http/status";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { TranscriptionResult } from "@/api/lib/transcription/provider";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";

const MODEL_ID = "mistralai/voxtral-mini-transcribe";
const DURATION_MS = 20_000;
const RESPONSE = {
  text: "Podání paní Šimůnkové.",
  segments: [],
  detectedLanguage: "cs",
  vocabulary: "not-supported",
  durationMs: DURATION_MS,
  modelId: MODEL_ID,
} satisfies TranscriptionResult;

export const seedDictationScaling = async (db: GatedTestDb, size: number) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const usagePolicyId = createSafeId<"usagePolicy">();
  const now = Date.now();
  const periodStart = new Date(now - 86_400_000);
  const periodEnd = new Date(now + 86_400_000);
  await db.insert(organization).values({
    id: organizationId,
    name: "Spis Lípa",
    slug: organizationId,
    createdAt: periodStart,
  });
  await db.insert(user).values({
    id: userId,
    name: "Žofie Šimůnková",
    email: `${userId}@fixture.test`,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: periodStart,
  });
  await db.insert(usagePolicies).values({
    id: usagePolicyId,
    policyKey: `dictation-${usagePolicyId}`,
    displayName: "Dictation fixture",
    monthlyUsageUnits: 1_000_000,
  });
  await db.insert(usageEntitlements).values({
    organizationId,
    usagePolicyId,
    status: "active",
    seats: 1,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    source: "manual",
  });
  await db.insert(usageAllocations).values({
    organizationId,
    units: 1_000_000,
    reason: "manual",
    sourceType: "admin",
    sourceRef: null,
    periodStart,
    periodEnd,
  });
  await db.insert(usageEvents).values(
    Array.from({ length: size }, () => ({
      organizationId,
      userId,
      periodStart,
      periodEnd,
      actionType: "transcription" as const,
      modelRole: "transcription",
      unitsConsumed: 1,
      serviceTier: "standard" as const,
      isByok: false,
    })),
  );
  const safeDb = createMembershipSafeDb(markRlsDatabase(db), {
    organizationId,
    userId,
    serverValidatedWorkspaceIds: [],
  });
  const request = new Request("https://example.test/v1/dictation/transcribe", {
    method: "POST",
  });
  return {
    organizationId,
    context: {
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      safeDb,
      scopedDb: NO_DB,
      audit: createAuditRecorder({
        organizationId,
        workspaceId: null,
        userId,
        request,
        server: null,
      }),
      modelAdmission: testModelAdmission(
        organizationId,
        "dictation.transcribe",
      ),
      request,
    },
    cleanup: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(usagePolicies).where(eq(usagePolicies.id, usagePolicyId));
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type DictationScalingFixture = Awaited<ReturnType<typeof seedDictationScaling>>;

export const dictationScalingScenario = {
  name: "dictation transcription",
  definition: transcribeDictation,
  measure: async (fixture: DictationScalingFixture) => {
    let providerRequests = 0;
    const endpoint = createDictationTranscribeEndpoint({
      transcribe: async () => {
        providerRequests += 1;
        return await Promise.resolve(Result.ok(RESPONSE));
      },
      credential: async () =>
        await Promise.resolve(
          Result.ok({ type: "static", apiKey: "recorded-credential" }),
        ),
      limit: async () => await Promise.resolve(Result.ok(undefined)),
    });
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await endpoint.handler(
        createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
          ...fixture.context,
          body: {
            file: new File(["fixture audio"], "dictation.wav", {
              type: "audio/wav",
            }),
            modelId: MODEL_ID,
          },
          route: "/v1/dictation/transcribe",
        }),
      );
      if (
        response instanceof HttpStatusResponse ||
        response.text !== RESPONSE.text
      ) {
        return panic("Dictation scaling requires a successful transcription");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        providerRequests,
      };
    });
  },
};
