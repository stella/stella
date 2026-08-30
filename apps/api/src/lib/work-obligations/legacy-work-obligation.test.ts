import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ensureLegacyWorkObligation,
  legacyWorkObligationCreatedEvents,
  legacyWorkObligationValues,
} from "@/api/lib/work-obligations/legacy-work-obligation";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

describe("legacy work obligation mapping", () => {
  test("replay maps the same legacy deadline to the same governed state", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const task = {
      id: createSafeId<"entity">(),
      workspaceId: createSafeId<"workspace">(),
      agendaKind: "deadline",
      agendaSource: "calendar",
      status: "done",
      dueDate: "2026-02-01",
      createdBy: mintAuthProviderId<"user">(),
      createdAt,
      updatedAt: null,
      assigneeUserIds: [],
    };

    const first = legacyWorkObligationValues(task);
    const replay = legacyWorkObligationValues(task);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      type: WORK_OBLIGATION_TYPE.DEADLINE,
      status: WORK_OBLIGATION_STATUS.COMPLETED,
      sourceType: WORK_OBLIGATION_SOURCE.CALENDAR,
      workingTargetDate: "2026-02-01",
      hardDeadlineDate: "2026-02-01",
      updatedAt: createdAt,
    });
  });

  test("derives ownership only from one unambiguous assignee", () => {
    const assignee = mintAuthProviderId<"user">();
    const task = {
      id: createSafeId<"entity">(),
      workspaceId: createSafeId<"workspace">(),
      agendaKind: "task",
      agendaSource: null,
      status: "open",
      dueDate: null,
      createdBy: mintAuthProviderId<"user">(),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: null,
      assigneeUserIds: [assignee],
    };

    expect(legacyWorkObligationValues(task)).toMatchObject({
      ownerUserId: assignee,
      status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    });
    expect(
      legacyWorkObligationValues({
        ...task,
        assigneeUserIds: [assignee, mintAuthProviderId<"user">()],
      }),
    ).toMatchObject({
      ownerUserId: null,
      status: WORK_OBLIGATION_STATUS.UNASSIGNED,
    });
  });

  // `infosoud` is the court-registry agenda source; before `court` existed it
  // fell through to `manual`, which read as if a person had typed the deadline.
  test("derives court provenance from a court-registry agenda source", () => {
    const task = {
      id: createSafeId<"entity">(),
      workspaceId: createSafeId<"workspace">(),
      agendaKind: "deadline",
      agendaSource: "infosoud",
      status: "open",
      dueDate: "2026-02-01",
      createdBy: mintAuthProviderId<"user">(),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: null,
      assigneeUserIds: [],
    };

    expect(legacyWorkObligationValues(task)).toMatchObject({
      sourceType: WORK_OBLIGATION_SOURCE.COURT,
    });
    expect(
      legacyWorkObligationValues({ ...task, agendaSource: "something-else" }),
    ).toMatchObject({ sourceType: WORK_OBLIGATION_SOURCE.MANUAL });
  });

  test("stamps derived work with one created event at insertion time", () => {
    const entityId = createSafeId<"entity">();
    const workspaceId = createSafeId<"workspace">();
    const createdByUserId = mintAuthProviderId<"user">();
    const occurredAt = new Date("2026-03-01T10:00:00Z");

    expect(
      legacyWorkObligationCreatedEvents(
        [
          { entityId, workspaceId, createdByUserId },
          {
            entityId: createSafeId<"entity">(),
            workspaceId,
            createdByUserId: null,
          },
        ],
        occurredAt,
      ),
    ).toMatchObject([
      {
        workspaceId,
        obligationEntityId: entityId,
        actorUserId: createdByUserId,
        type: WORK_OBLIGATION_EVENT_TYPE.CREATED,
        details: { type: "created", cause: "legacy_backfill" },
        occurredAt,
      },
      {
        actorUserId: null,
        details: { type: "created", cause: "legacy_backfill" },
      },
    ]);
  });
});

let testDb: TestDatabase;
let ids: TestIds;
const seededEntityIds: SafeId<"entity">[] = [];

const seedLegacyTask = async (listItemType: "task" | "fact") => {
  const entityId = createSafeId<"entity">();
  seededEntityIds.push(entityId);
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "task",
    listItemType,
    name: `Legacy ${listItemType}`,
    status: "open",
    createdBy: ids.userA1,
  });
  return entityId;
};

const bridge = async (entityId: SafeId<"entity">) =>
  await testDb.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    await ensureLegacyWorkObligation({
      tx: asTestRaw<Transaction>(tx),
      entityId,
      workspaceId: ids.wsA1,
    });
  });

const bridgedState = async (entityId: SafeId<"entity">) => ({
  obligation: await testDb.query.workObligations.findFirst({
    where: { entityId: { eq: entityId } },
    columns: { status: true },
  }),
  events: await testDb.query.workObligationEvents.findMany({
    where: { obligationEntityId: { eq: entityId } },
    columns: { type: true, actorUserId: true, details: true },
  }),
});

describe("legacy work obligation bridge", () => {
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

  test("derived work carries a created event, and replay adds no second one", async () => {
    const entityId = await seedLegacyTask("task");

    await bridge(entityId);
    const first = await bridgedState(entityId);
    await bridge(entityId);
    const replay = await bridgedState(entityId);

    expect(first.obligation?.status).toBe(WORK_OBLIGATION_STATUS.UNASSIGNED);
    expect(first.events).toEqual([
      {
        type: WORK_OBLIGATION_EVENT_TYPE.CREATED,
        actorUserId: ids.userA1,
        details: { type: "created", cause: "legacy_backfill" },
      },
    ]);
    expect(replay).toEqual(first);
  });

  test("a non-task List row never gets governed work", async () => {
    const entityId = await seedLegacyTask("fact");

    await bridge(entityId);

    expect(await bridgedState(entityId)).toEqual({
      obligation: undefined,
      events: [],
    });
  });
});
