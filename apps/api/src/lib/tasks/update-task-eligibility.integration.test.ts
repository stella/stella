import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import {
  entities,
  taskAssignees,
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { TASK_ASSIGNEE_ROLE } from "@/api/lib/entity-constants";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

const FEATURES_ENABLED = {
  governedWorkflow: true,
  legalLists: true,
} as const;

let testDb: TestDatabase;
let ids: TestIds;
const seededEntityIds: SafeId<"entity">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (seededEntityIds.length > 0) {
      await testDb
        .delete(entities)
        .where(inArray(entities.id, seededEntityIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

const seedTask = async (listItemType: "task" | "fact") => {
  const entityId = createSafeId<"entity">();
  seededEntityIds.push(entityId);
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "task",
    listItemType,
    name: `governed ${listItemType}`,
    status: "open",
    createdBy: ids.userA1,
  });
  return entityId;
};

const changeListItemType = async (
  taskId: SafeId<"entity">,
  listItemType: "task" | "fact",
) =>
  await Result.gen(() =>
    updateTaskHandler({
      safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      recordAuditEvent: async () => undefined,
      body: { taskId, listItemType },
      features: FEATURES_ENABLED,
    }),
  );

const storedListItemType = async (entityId: SafeId<"entity">) => {
  const task = await testDb.query.entities.findFirst({
    where: { id: { eq: entityId } },
    columns: { listItemType: true },
  });
  return task?.listItemType;
};

const storedObligation = async (entityId: SafeId<"entity">) =>
  await testDb.query.workObligations.findFirst({
    where: { entityId: { eq: entityId } },
    columns: { status: true, ownerUserId: true },
  });

describe("list item type changes across the governance boundary", () => {
  test("reference material drops work nobody has taken up", async () => {
    const entityId = await seedTask("task");
    await testDb.insert(workObligations).values({
      entityId,
      workspaceId: ids.wsA1,
      status: WORK_OBLIGATION_STATUS.UNASSIGNED,
      createdByUserId: ids.userA1,
    });
    await testDb.insert(workObligationEvents).values({
      id: createSafeId<"workObligationEvent">(),
      workspaceId: ids.wsA1,
      obligationEntityId: entityId,
      actorUserId: ids.userA1,
      type: WORK_OBLIGATION_EVENT_TYPE.CREATED,
      details: { type: "created", cause: "legacy_backfill" },
    });

    const result = await changeListItemType(entityId, "fact");

    expect(Result.isOk(result)).toBe(true);
    expect(await storedListItemType(entityId)).toBe("fact");
    expect(await storedObligation(entityId)).toBeUndefined();
    const events = await testDb.query.workObligationEvents.findMany({
      where: { obligationEntityId: { eq: entityId } },
    });
    expect(events).toHaveLength(0);
  });

  test("accountable work refuses the change and survives it", async () => {
    const entityId = await seedTask("task");
    await testDb.insert(workObligations).values({
      entityId,
      workspaceId: ids.wsA1,
      ownerUserId: ids.userA1,
      status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
      createdByUserId: ids.userA2,
    });

    const result = await changeListItemType(entityId, "fact");

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 409,
        message:
          "Governed work must be unassigned and removed before this row can become reference material",
      });
    }
    expect(await storedListItemType(entityId)).toBe("task");
    const obligation = await storedObligation(entityId);
    expect(obligation?.status).toBe(
      WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    );
    expect(obligation?.ownerUserId).toBe(ids.userA1);
  });

  test("actionable work is governed from the same transaction", async () => {
    const entityId = await seedTask("fact");
    await testDb.insert(taskAssignees).values({
      id: createSafeId<"taskAssignee">(),
      workspaceId: ids.wsA1,
      entityId,
      userId: ids.userA1,
      role: TASK_ASSIGNEE_ROLE.ASSIGNEE,
    });

    const result = await changeListItemType(entityId, "task");

    expect(Result.isOk(result)).toBe(true);
    expect(await storedListItemType(entityId)).toBe("task");
    const obligation = await storedObligation(entityId);
    expect(obligation?.status).toBe(
      WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    );
    expect(obligation?.ownerUserId).toBe(ids.userA1);
    const events = await testDb.query.workObligationEvents.findMany({
      where: {
        obligationEntityId: { eq: entityId },
        type: { eq: WORK_OBLIGATION_EVENT_TYPE.CREATED },
      },
    });
    expect(events).toHaveLength(1);
  });
});
