import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  resourceRef,
  resourceUpdatedRealtimeEvent,
  resourceSetUpdatedRealtimeEvent,
  resourceDeletedRealtimeEvent,
  resourceDeletedChange,
  resourcesChangedRealtimeEvent,
  type WorkspaceRealtimeEvent,
  type BuiltRealtimeEvent,
} from "@stll/api-contract";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  flowRuns,
  flowRunSteps,
  featureEnrolments,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { deliverFlowRunWorkspaceEvent } from "@/api/lib/flows/flow-run-events";
import { classifyEntityResourceDeletions } from "@/api/lib/flows/visibility";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const testState = createTestState({ file: import.meta.path, config: env });
const db = await getTestDb();
const database =
  asTestRaw<Parameters<typeof deliverFlowRunWorkspaceEvent>[0]["database"]>(db);
const organizationId = mintAuthProviderId<"organization">();
const workspaceId = createSafeId<"workspace">();
const enrolledUserId = mintAuthProviderId<"user">();
const ungrantedUserId = mintAuthProviderId<"user">();
const unassignedUserId = mintAuthProviderId<"user">();
const userIds = [enrolledUserId, ungrantedUserId, unassignedUserId];
const flowEvent = {
  type: REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE,
  data: {
    runId: createSafeId<"flowRun">(),
    status: "running",
    currentStepIndex: 0,
    steps: [],
  },
} as const satisfies WorkspaceRealtimeEvent;

testState.beforeAll(async () => {
  await db.insert(organization).values(
    [organizationId].map((id) => ({
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
      organizationId,
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
  await db.insert(flowRuns).values({
    id: flowEvent.data.runId,
    workspaceId,
    definitionSnapshot: { name: "Flow delivery fixture", steps: [] },
    triggerSource: { type: "manual", userId: enrolledUserId },
    status: "running",
  });
  await db.insert(workspaceMembers).values(
    [enrolledUserId, ungrantedUserId].map((userId) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId,
    })),
  );
  await db.insert(featureEnrolments).values(
    [enrolledUserId, unassignedUserId].map((userId) => ({
      organizationId,
      userId,
      featureId: "flows" as const,
    })),
  );
});

afterAll(releaseTestDb);

const observeDeliveryEvents = async (
  input: WorkspaceRealtimeEvent | BuiltRealtimeEvent,
  candidateUserIds = userIds,
) => {
  const event = "toJSON" in input ? input.toJSON() : input;
  const delivered = new Map<SafeId<"user">, WorkspaceRealtimeEvent[]>();
  await deliverFlowRunWorkspaceEvent({
    database,
    organizationId,
    workspaceId,
    userIds: candidateUserIds,
    event,
    deliver: (recipients, authorizedEvent) => {
      for (const recipient of recipients) {
        const prior = delivered.get(recipient);
        if (prior) {
          prior.push(authorizedEvent);
        } else {
          delivered.set(recipient, [authorizedEvent]);
        }
      }
    },
  });
  return delivered;
};

const observeDelivery = async (
  event: WorkspaceRealtimeEvent | BuiltRealtimeEvent,
) => new Set((await observeDeliveryEvents(event)).keys());

describe("flow progress recipient admission", () => {
  test("live flag, grant and matter access govern delivery after revoke and re-grant", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    testState.setConfig("FEATURE_FLOWS", true);
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
      testState.setConfig("FEATURE_FLOWS", false);
      expect(await observeDelivery(flowEvent)).toEqual(new Set());
      const ordinaryEvent = resourceUpdatedRealtimeEvent(
        resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: createSafeId<"entity">(),
        }),
      );
      expect(await observeDelivery(ordinaryEvent)).toEqual(new Set(userIds));
    } finally {
      testState.setConfig("FEATURE_FLOWS", previousFlag);
      restoreMode();
    }
  });
});

test("review-task identifiers require current grant while ordinary invalidations stay visible", async () => {
  const previousFlag = env.FEATURE_FLOWS;
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  testState.setConfig("FEATURE_FLOWS", true);
  const taskEntityId = createSafeId<"entity">();
  const runId = createSafeId<"flowRun">();
  try {
    await db.insert(entities).values({
      id: taskEntityId,
      workspaceId,
      kind: "task",
      name: "Review task",
    });
    await db.insert(flowRuns).values({
      id: runId,
      workspaceId,
      status: "awaiting_review",
      definitionSnapshot: {
        name: "Review flow",
        steps: [
          {
            kind: "review-gate",
            name: "Review",
            instructions: "Review output",
          },
        ],
      },
      triggerSource: { type: "manual", userId: enrolledUserId },
    });
    await db.insert(flowRunSteps).values({
      id: createSafeId<"flowRunStep">(),
      runId,
      workspaceId,
      index: 0,
      kind: "review-gate",
      status: "awaiting_review",
      reviewTaskEntityId: taskEntityId,
    });
    const linkedEvent = resourceUpdatedRealtimeEvent(
      resourceRef({ type: RESOURCE_TYPE.ENTITY, id: taskEntityId }),
    );
    expect(await observeDelivery(linkedEvent)).toEqual(
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
    expect(await observeDelivery(linkedEvent)).toEqual(new Set());
    await db
      .insert(featureEnrolments)
      .values({ organizationId, userId: enrolledUserId, featureId: "flows" });
    expect(await observeDelivery(linkedEvent)).toEqual(
      new Set([enrolledUserId]),
    );
    testState.setConfig("FEATURE_FLOWS", false);
    expect(await observeDelivery(linkedEvent)).toEqual(new Set());
    const ordinaryEvent = resourceUpdatedRealtimeEvent(
      resourceRef({ type: RESOURCE_TYPE.ENTITY, id: createSafeId<"entity">() }),
    );
    expect(await observeDelivery(ordinaryEvent)).toEqual(new Set(userIds));
    expect(
      await observeDelivery(
        resourceSetUpdatedRealtimeEvent(RESOURCE_TYPE.ENTITY),
      ),
    ).toEqual(new Set(userIds));
  } finally {
    await db.delete(flowRuns).where(eq(flowRuns.id, runId));
    await db.delete(entities).where(eq(entities.id, taskEntityId));
    testState.setConfig("FEATURE_FLOWS", previousFlag);
    restoreMode();
  }
});

test("committed task deletions preserve recipient-specific single and mixed changes", async () => {
  const previousFlag = env.FEATURE_FLOWS;
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  testState.setConfig("FEATURE_FLOWS", true);
  const taskEntityId = createSafeId<"entity">();
  const ordinaryEntityId = createSafeId<"entity">();
  const runId = createSafeId<"flowRun">();
  const recipients = [enrolledUserId, ungrantedUserId];
  try {
    await db.insert(entities).values([
      { id: taskEntityId, workspaceId, kind: "task", name: "Review task" },
      {
        id: ordinaryEntityId,
        workspaceId,
        kind: "task",
        name: "Ordinary task",
      },
    ]);
    await db.insert(flowRuns).values({
      id: runId,
      workspaceId,
      status: "awaiting_review",
      definitionSnapshot: {
        name: "Review flow",
        steps: [
          {
            kind: "review-gate",
            name: "Review",
            instructions: "Review output",
          },
        ],
      },
      triggerSource: { type: "manual", userId: enrolledUserId },
    });
    await db.insert(flowRunSteps).values({
      id: createSafeId<"flowRunStep">(),
      runId,
      workspaceId,
      index: 0,
      kind: "review-gate",
      status: "awaiting_review",
      reviewTaskEntityId: taskEntityId,
    });
    const classified = await db.transaction(async (tx) => {
      const classification = await classifyEntityResourceDeletions(tx, {
        workspaceId,
        entityIds: [taskEntityId, ordinaryEntityId],
      });
      await tx
        .delete(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            inArray(entities.id, [taskEntityId, ordinaryEntityId]),
          ),
        );
      return classification.deletions;
    });
    const linkedDeletion =
      classified.at(0) ?? panic("Missing linked deletion classification");
    const ordinaryDeletion =
      classified.at(1) ?? panic("Missing ordinary deletion classification");
    expect(
      (
        await db
          .select({ entityId: flowRunSteps.reviewTaskEntityId })
          .from(flowRunSteps)
          .where(eq(flowRunSteps.runId, runId))
          .limit(1)
      ).at(0)?.entityId,
    ).toBeNull();
    const ordinaryChange = resourceDeletedChange(ordinaryDeletion);
    const fullBatch = resourcesChangedRealtimeEvent([
      ordinaryChange,
      resourceDeletedChange(linkedDeletion),
    ]);
    const filteredBatch = resourcesChangedRealtimeEvent([ordinaryChange]);
    const delivered = await observeDeliveryEvents(fullBatch, recipients);
    expect(delivered).toEqual(
      new Map([
        [enrolledUserId, [fullBatch.toJSON()]],
        [ungrantedUserId, [filteredBatch.toJSON()]],
      ]),
    );
    const ordinarySingle = resourceDeletedRealtimeEvent(ordinaryDeletion);
    expect(await observeDeliveryEvents(ordinarySingle, recipients)).toEqual(
      new Map(recipients.map((id) => [id, [ordinarySingle.toJSON()]])),
    );
    const single = resourceDeletedRealtimeEvent(linkedDeletion);
    expect(await observeDeliveryEvents(single, recipients)).toEqual(
      new Map([[enrolledUserId, [single.toJSON()]]]),
    );
    testState.setConfig("FEATURE_FLOWS", false);
    expect(await observeDeliveryEvents(fullBatch, recipients)).toEqual(
      new Map([
        [enrolledUserId, [filteredBatch.toJSON()]],
        [ungrantedUserId, [filteredBatch.toJSON()]],
      ]),
    );
    expect(await observeDeliveryEvents(single, recipients)).toEqual(new Map());
    expect(await observeDeliveryEvents(ordinarySingle, recipients)).toEqual(
      new Map(recipients.map((id) => [id, [ordinarySingle.toJSON()]])),
    );
  } finally {
    await db.delete(flowRuns).where(eq(flowRuns.id, runId));
    await db.delete(entities).where(eq(entities.id, taskEntityId));
    await db.delete(entities).where(eq(entities.id, ordinaryEntityId));
    testState.setConfig("FEATURE_FLOWS", previousFlag);
    restoreMode();
  }
});
