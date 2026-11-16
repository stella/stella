import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  organizationSettings,
  usageAllocations,
  usageEntitlements,
  usageEvents,
  usagePolicies,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import {
  createDesktopDictationModelsEndpoint,
  readDesktopDictationModels,
} from "@/api/handlers/dictation/desktop-transcription";
import type { TranscriptionResult } from "@/api/handlers/dictation/provider";
import transcribeDictation, {
  createDictationTranscribeEndpoint,
} from "@/api/handlers/dictation/transcribe";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
      await deleteOrganizationsForTest(db, [organizationId]);
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
        return await Promise.resolve(
          Result.ok({ transcript: RESPONSE, admittedDurationMs: DURATION_MS }),
        );
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

const MODELS_ROUTE = "/v1/desktop/dictation/models" satisfies ApiRoutePath;

/**
 * A linked desktop's organization in the EU region among `size` other
 * organizations whose settings place them elsewhere, so a settings read that
 * dropped its organization predicate would list another region's models.
 */
export const seedDesktopDictationModelsScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const otherOrganizationIds = Array.from({ length: size }, () =>
    mintAuthProviderId<"organization">(),
  );
  const createdAt = new Date();
  await db.insert(organization).values(
    [organizationId, ...otherOrganizationIds].map((id) => ({
      id,
      name: "Desktop dictation fixture",
      slug: id,
      createdAt,
    })),
  );
  await db.insert(organizationAccessStates).values({
    organizationId,
    state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
    evaluationStartedAt: new Date(createdAt.getTime() - 86_400_000),
    evaluationEndsAt: new Date(createdAt.getTime() + 86_400_000),
  });
  await db.insert(organizationSettings).values([
    ...otherOrganizationIds.map((id) => ({
      organizationId: id,
      managedAIResidency: "us" as const,
    })),
    { organizationId, managedAIResidency: "eu" as const },
  ]);
  await db.insert(user).values({
    id: userId,
    name: "Radka Dvořáková",
    email: `${userId}@fixture.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt,
  });
  return {
    organizationId,
    userId,
    email: `${userId}@fixture.test`,
    scopedDb: createMembershipScopedDb(markRlsDatabase(db), {
      organizationId,
      userId,
      serverValidatedWorkspaceIds: [],
    }),
    cleanup: async () => {
      await deleteOrganizationsForTest(db, [
        organizationId,
        ...otherOrganizationIds,
      ]);
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type DesktopDictationModelsFixture = Awaited<
  ReturnType<typeof seedDesktopDictationModelsScaling>
>;

/**
 * Listing a linked desktop's transcription models reads the organization's
 * AI settings and the member's access; the device credential is the only
 * collaborator supplied. Nothing it reads grows with other organizations.
 */
export const desktopDictationModelsScalingScenario = {
  name: "desktop dictation models",
  definition: readDesktopDictationModels,
  measure: async (fixture: DesktopDictationModelsFixture) => {
    const request = new Request(`https://example.test${MODELS_ROUTE}`);
    const device = await createDesktopDeviceSigner();
    const credential = "desktop-dictation-scaling";
    const consumedProof = await claimFixtureDeviceProof({
      request: await device.signRequest({ request, credential }),
      deviceJkt: device.deviceJkt,
      keyId: "desktop-dictation-scaling",
      credential,
    });
    const endpoint = createDesktopDictationModelsEndpoint({
      authorizeAccount: async () =>
        await Promise.resolve(
          Result.ok({
            featureAccessSnapshot: buildFeatureAccessSnapshot({
              organizationId: fixture.organizationId,
              userId: fixture.userId,
              identity: { email: fixture.email, emailVerified: true },
              enrolments: [],
            }),
            consumedProof,
            organizationId: fixture.organizationId,
            userId: fixture.userId,
            keyId: "desktop-dictation-scaling",
            memberRole: sessionMemberRole("member"),
            scopedDb: fixture.scopedDb,
          }),
        ),
    });
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await endpoint.handler(
        asTestRaw<Parameters<typeof endpoint.handler>[0]>({
          request,
          route: MODELS_ROUTE,
          set: { headers: {} },
        }),
      );
      if (
        response instanceof HttpStatusResponse ||
        response.unavailable !== null
      ) {
        return panic(
          "Desktop dictation models scaling requires the region's models",
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.models.length,
        response,
      };
    });
  },
};
