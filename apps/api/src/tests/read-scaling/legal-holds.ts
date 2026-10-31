import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  legalHolds,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import placeEntityHold from "@/api/handlers/entities/legal-holds/place";
import releaseEntityHold from "@/api/handlers/entities/legal-holds/release";
import placeMatterHold from "@/api/handlers/workspaces/legal-holds/place";
import releaseMatterHold from "@/api/handlers/workspaces/legal-holds/release";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

export const seedLegalHoldScaling = async (db: GatedTestDb, size: number) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const matterHoldId = createSafeId<"legalHold">();
  const entityHoldId = createSafeId<"legalHold">();
  await db.insert(user).values({
    id: userId,
    name: "Scaling actor",
    email: `${userId}@hold.test`,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: "Scaling organization",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    userId,
    organizationId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Scaling matter",
    reference: workspaceId,
  });
  await db
    .insert(workspaceMembers)
    .values({ id: createSafeId<"workspaceMember">(), workspaceId, userId });
  await db
    .insert(entities)
    .values({ id: entityId, workspaceId, name: "Scaling item" });
  await db.insert(legalHolds).values([
    {
      id: matterHoldId,
      organizationId,
      scopeType: "matter",
      workspaceId,
      reason: "Matter evidence",
      placedBy: userId,
    },
    {
      id: entityHoldId,
      organizationId,
      scopeType: "entity",
      entityId,
      reason: "Item evidence",
      placedBy: userId,
    },
    ...Array.from({ length: size }, () => ({
      id: createSafeId<"legalHold">(),
      organizationId,
      scopeType: "matter" as const,
      workspaceId,
      reason: "Other hold",
      placedBy: userId,
    })),
  ]);
  return {
    workspaceId,
    entityId,
    matterHoldId,
    entityHoldId,
    context: {
      workspaceId,
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      safeDb: createSafeDb(
        markRlsDatabase(db),
        [workspaceId],
        organizationId,
        userId,
      ),
      scopedDb: NO_DB,
      audit: auditRecorderDouble(),
      body: { reason: "Evidence lifecycle" },
    },
    cleanup: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

type HoldScalingFixture = Awaited<ReturnType<typeof seedLegalHoldScaling>>;

const measureHoldMutation = async (invoke: () => Promise<unknown>) =>
  await runWithMeasuredQueryCounter(async (counter) => {
    const response = await invoke();
    if (response instanceof HttpStatusResponse) {
      return panic("Legal hold scaling requires success");
    }
    return {
      statements: counter.count,
      transactionRoundTrips: counter.transactions,
      responseBytes: Buffer.byteLength(JSON.stringify(response)),
    };
  });

export const legalHoldScalingScenarios = [
  {
    name: "matter legal hold placement",
    definition: placeMatterHold,
    measure: async (fixture: HoldScalingFixture) =>
      await measureHoldMutation(
        async () =>
          await placeMatterHold.handler(
            createTestHandlerContext<
              Parameters<typeof placeMatterHold.handler>[0]
            >({
              ...fixture.context,
              params: { workspaceId: fixture.workspaceId },
            }),
          ),
      ),
  },
  {
    name: "matter legal hold release",
    definition: releaseMatterHold,
    measure: async (fixture: HoldScalingFixture) =>
      await measureHoldMutation(
        async () =>
          await releaseMatterHold.handler(
            createTestHandlerContext<
              Parameters<typeof releaseMatterHold.handler>[0]
            >({
              ...fixture.context,
              params: {
                workspaceId: fixture.workspaceId,
                holdId: fixture.matterHoldId,
              },
            }),
          ),
      ),
  },
  {
    name: "item legal hold placement",
    definition: placeEntityHold,
    measure: async (fixture: HoldScalingFixture) =>
      await measureHoldMutation(
        async () =>
          await placeEntityHold.handler(
            createTestHandlerContext<
              Parameters<typeof placeEntityHold.handler>[0]
            >({
              ...fixture.context,
              params: {
                workspaceId: fixture.workspaceId,
                entityId: fixture.entityId,
              },
            }),
          ),
      ),
  },
  {
    name: "item legal hold release",
    definition: releaseEntityHold,
    measure: async (fixture: HoldScalingFixture) =>
      await measureHoldMutation(
        async () =>
          await releaseEntityHold.handler(
            createTestHandlerContext<
              Parameters<typeof releaseEntityHold.handler>[0]
            >({
              ...fixture.context,
              params: {
                workspaceId: fixture.workspaceId,
                entityId: fixture.entityId,
                holdId: fixture.entityHoldId,
              },
            }),
          ),
      ),
  },
] as const;
