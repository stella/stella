import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
  resourceRef,
  resourceUpdatedRealtimeEvent,
  resourceSetUpdatedRealtimeEvent,
  resourceDeletedRealtimeEvent,
  resourceUpdatedChange,
  resourceDeletedChange,
  resourcesChangedRealtimeEvent,
  type WorkspaceRealtimeEvent,
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
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

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

beforeAll(async () => {
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
  event: WorkspaceRealtimeEvent,
  candidateUserIds = userIds,
) => {
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

const observeDelivery = async (event: WorkspaceRealtimeEvent) =>
  new Set((await observeDeliveryEvents(event)).keys());

describe("flow progress recipient admission", () => {
  test("live flag, grant and matter access govern delivery after revoke and re-grant", async () => {
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

test("review-task identifiers require current grant while ordinary invalidations stay visible", async () => {
  const previousFlag = env.FEATURE_FLOWS;
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  env.FEATURE_FLOWS = true;
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
    env.FEATURE_FLOWS = false;
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
    env.FEATURE_FLOWS = previousFlag;
    restoreMode();
  }
});

test("mixed changes preserve ordinary invalidations and single-event parity for each recipient", async () => {
  const previousFlag = env.FEATURE_FLOWS;
  const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
  env.FEATURE_FLOWS = true;
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
    const ordinary = resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: ordinaryEntityId,
    });
    const linked = resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: taskEntityId,
    });
    const ordinaryChange = resourceUpdatedChange(ordinary);
    const fullBatch = resourcesChangedRealtimeEvent([
      ordinaryChange,
      resourceUpdatedChange(linked),
      resourceDeletedChange(linked),
    ]);
    const filteredBatch = resourcesChangedRealtimeEvent([ordinaryChange]);
    expect(await observeDeliveryEvents(fullBatch, recipients)).toEqual(
      new Map([
        [enrolledUserId, [fullBatch]],
        [ungrantedUserId, [filteredBatch]],
      ]),
    );
    const linkedOnlyBatch = resourcesChangedRealtimeEvent([
      resourceUpdatedChange(linked),
    ]);
    expect(await observeDeliveryEvents(linkedOnlyBatch, recipients)).toEqual(
      new Map([[enrolledUserId, [linkedOnlyBatch]]]),
    );
    for (const makeEvent of [
      resourceUpdatedRealtimeEvent,
      resourceDeletedRealtimeEvent,
    ]) {
      const linkedEvent = makeEvent(linked);
      const ordinaryEvent = makeEvent(ordinary);
      // db-await-in-loop: the two semantic single-event kinds must retain the same recipient/payload policy.
      expect(await observeDeliveryEvents(linkedEvent, recipients)).toEqual(
        new Map([[enrolledUserId, [linkedEvent]]]),
      );
      // db-await-in-loop: ordinary single changes must survive without feature admission.
      expect(await observeDeliveryEvents(ordinaryEvent, recipients)).toEqual(
        new Map([
          [enrolledUserId, [ordinaryEvent]],
          [ungrantedUserId, [ordinaryEvent]],
        ]),
      );
    }
    env.FEATURE_FLOWS = false;
    expect(await observeDeliveryEvents(fullBatch, recipients)).toEqual(
      new Map([
        [enrolledUserId, [filteredBatch]],
        [ungrantedUserId, [filteredBatch]],
      ]),
    );
    expect(await observeDeliveryEvents(linkedOnlyBatch, recipients)).toEqual(
      new Map(),
    );
    for (const makeEvent of [
      resourceUpdatedRealtimeEvent,
      resourceDeletedRealtimeEvent,
    ]) {
      // db-await-in-loop: flag-off must suppress both single linked event kinds.
      expect(
        await observeDeliveryEvents(makeEvent(linked), recipients),
      ).toEqual(new Map());
      const ordinaryEvent = makeEvent(ordinary);
      // db-await-in-loop: flag-off must preserve each original ordinary single payload.
      expect(await observeDeliveryEvents(ordinaryEvent, recipients)).toEqual(
        new Map([
          [enrolledUserId, [ordinaryEvent]],
          [ungrantedUserId, [ordinaryEvent]],
        ]),
      );
    }
  } finally {
    await db.delete(flowRuns).where(eq(flowRuns.id, runId));
    await db.delete(entities).where(eq(entities.id, taskEntityId));
    await db.delete(entities).where(eq(entities.id, ordinaryEntityId));
    env.FEATURE_FLOWS = previousFlag;
    restoreMode();
  }
});
