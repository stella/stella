import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  resourceRef,
  resourceUpdatedRealtimeEvent,
  type WorkspaceRealtimeEvent,
} from "@stll/api-contract";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  featureEnrolments,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { deliverFlowRunWorkspaceEvent } from "@/api/lib/flows/flow-run-events";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const db = await getTestDb();
const database =
  asTestRaw<Parameters<typeof deliverFlowRunWorkspaceEvent>[0]["database"]>(db);
const organizationId = mintAuthProviderId<"organization">();
const otherOrganizationId = mintAuthProviderId<"organization">();
const workspaceId = createSafeId<"workspace">();
const enrolledUserId = mintAuthProviderId<"user">();
const ungrantedUserId = mintAuthProviderId<"user">();
const unassignedUserId = mintAuthProviderId<"user">();
const foreignUserId = mintAuthProviderId<"user">();
const userIds = [
  enrolledUserId,
  ungrantedUserId,
  unassignedUserId,
  foreignUserId,
];
const flowEvent = {
  type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
  data: {
    runId: createSafeId<"flowRun">(),
    status: "running",
    currentStepIndex: 0,
    steps: [],
  },
} as const satisfies WorkspaceRealtimeEvent;

beforeAll(async () => {
  await db.insert(organization).values(
    [organizationId, otherOrganizationId].map((id) => ({
      id,
      name: "Flow delivery fixture",
      slug: `flow-delivery-${id}`,
      createdAt: new Date(),
    })),
  );
  await db.insert(user).values(
    userIds.map((id) => ({
      id,
      email: `${id}@example.test`,
      name: "Flow recipient",
      emailVerified: true,
    })),
  );
  await db.insert(member).values(
    userIds.map((userId) => ({
      id: Bun.randomUUIDv7(),
      organizationId:
        userId === foreignUserId ? otherOrganizationId : organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    })),
  );
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    clientId: null,
    name: "Flow delivery matter",
    reference: "FLOW-DELIVERY",
  });
  await db.insert(workspaceMembers).values(
    [enrolledUserId, ungrantedUserId, foreignUserId].map((userId) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId,
    })),
  );
  await db.insert(featureEnrolments).values(
    [enrolledUserId, unassignedUserId, foreignUserId].map((userId) => ({
      organizationId:
        userId === foreignUserId ? otherOrganizationId : organizationId,
      userId,
      featureId: "flows" as const,
    })),
  );
});

afterAll(releaseTestDb);

const observeDelivery = async (event: WorkspaceRealtimeEvent) => {
  const delivered = new Set<SafeId<"user">>();
  await deliverFlowRunWorkspaceEvent({
    database,
    organizationId,
    workspaceId,
    userIds,
    event,
    deliver: (recipients) => {
      for (const recipient of recipients) {
        delivered.add(recipient);
      }
    },
  });
  return delivered;
};

describe("flow progress recipient admission", () => {
  test("live flag, grant, organization and matter access govern delivery after revoke and re-grant", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    try {
      expect(await observeDelivery(flowEvent)).toEqual(
        new Set([enrolledUserId]),
      );
      await db
        .delete(featureEnrolments)
        .where(
          and(
            eq(featureEnrolments.organizationId, organizationId),
            eq(featureEnrolments.userId, enrolledUserId),
            eq(featureEnrolments.featureId, "flows"),
          ),
        );
      expect(await observeDelivery(flowEvent)).toEqual(new Set());
      await db.insert(featureEnrolments).values({
        organizationId,
        userId: enrolledUserId,
        featureId: "flows",
      });
      expect(await observeDelivery(flowEvent)).toEqual(
        new Set([enrolledUserId]),
      );
      env.FEATURE_FLOWS = false;
      expect(await observeDelivery(flowEvent)).toEqual(new Set());
      const ordinaryEvent = resourceUpdatedRealtimeEvent(
        resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: createSafeId<"entity">(),
        }),
      );
      expect(await observeDelivery(ordinaryEvent)).toEqual(new Set(userIds));
    } finally {
      env.FEATURE_FLOWS = previousFlag;
      restoreMode();
    }
  });
});
