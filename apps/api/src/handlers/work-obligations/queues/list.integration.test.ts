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
  WORK_OBLIGATION_STATUS,
  workObligations,
} from "@/api/db/schema";
import type { WorkObligationStatus } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import myWork from "@/api/handlers/work-obligations/queues/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type MyWorkContext = Parameters<typeof myWork.handler>[0];
type MyWorkQueue = NonNullable<MyWorkContext["query"]["queue"]>;

const AS_OF = "2026-03-01";
const OPEN_QUEUES = ["inbox", "upcoming", "at_risk"] as const;

let testDb: TestDatabase;
let ids: TestIds;
const seededEntityIds: SafeId<"entity">[] = [];

type SeedWork = {
  label: string;
  listItemType: "task" | "fact";
  status: WorkObligationStatus;
  workingTargetDate: string | null;
  hardDeadlineDate: string | null;
};

/**
 * One row per case the partition has to decide: acknowledged or not, dated or
 * not, due or not, plus a List row that is not actionable at all. A fixture
 * that skipped the dateless rows would pass even if the queues used plain
 * three-valued logic and dropped them from every queue.
 */
const SEED: SeedWork[] = [
  {
    label: "awaiting, no dates",
    listItemType: "task",
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    workingTargetDate: null,
    hardDeadlineDate: null,
  },
  {
    label: "awaiting, working target in the future",
    listItemType: "task",
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    workingTargetDate: "2026-04-01",
    hardDeadlineDate: null,
  },
  {
    label: "awaiting, working target passed",
    listItemType: "task",
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    workingTargetDate: "2026-02-01",
    hardDeadlineDate: null,
  },
  {
    label: "awaiting, hard deadline is today",
    listItemType: "task",
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    workingTargetDate: null,
    hardDeadlineDate: AS_OF,
  },
  {
    label: "active, no dates",
    listItemType: "task",
    status: WORK_OBLIGATION_STATUS.ACTIVE,
    workingTargetDate: null,
    hardDeadlineDate: null,
  },
  {
    label: "active, hard deadline in the future",
    listItemType: "task",
    status: WORK_OBLIGATION_STATUS.ACTIVE,
    workingTargetDate: null,
    hardDeadlineDate: "2026-04-01",
  },
  {
    label: "active, hard deadline passed",
    listItemType: "task",
    status: WORK_OBLIGATION_STATUS.ACTIVE,
    workingTargetDate: null,
    hardDeadlineDate: "2026-02-01",
  },
  {
    label: "completed",
    listItemType: "task",
    status: WORK_OBLIGATION_STATUS.COMPLETED,
    workingTargetDate: "2026-02-01",
    hardDeadlineDate: null,
  },
  {
    label: "a List fact row that should never be governed",
    listItemType: "fact",
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    workingTargetDate: null,
    hardDeadlineDate: null,
  },
];

const seeded = new Map<string, SafeId<"entity">>();

const seedWork = async (work: SeedWork) => {
  const entityId = createSafeId<"entity">();
  seededEntityIds.push(entityId);
  seeded.set(work.label, entityId);
  const acknowledged = work.status === WORK_OBLIGATION_STATUS.ACTIVE;
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "task",
    listItemType: work.listItemType,
    name: work.label,
    status: "open",
    createdBy: ids.userA1,
  });
  await testDb.insert(workObligations).values({
    entityId,
    workspaceId: ids.wsA1,
    ownerUserId: ids.userA1,
    status: work.status,
    acknowledgedAt: acknowledged ? new Date() : null,
    acknowledgedByUserId: acknowledged ? ids.userA1 : null,
    workingTargetDate: work.workingTargetDate,
    hardDeadlineDate: work.hardDeadlineDate,
    createdByUserId: ids.userA1,
  });
};

const entityIdOf = (label: string) =>
  seeded.get(label) ?? expect.unreachable(`missing fixture row: ${label}`);

const queueEntityIds = async (queue: MyWorkQueue) => {
  const scopedDb = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const page = await myWork.handler(
    asTestRaw<MyWorkContext>({
      getActiveWorkspaceIds: async () => [ids.wsA1],
      getAccessibleWorkspaces: async () => [{ id: ids.wsA1, status: "active" }],
      getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
      memberRole: { role: "owner" },
      query: { queue, asOf: AS_OF, limit: 100 },
      request: new Request("https://example.test/my-work"),
      route: "/test/my-work",
      safeDb,
      scopedDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );
  if (!("items" in page)) {
    return expect.unreachable(
      `my work ${queue} failed: ${JSON.stringify(page)}`,
    );
  }
  return new Set(
    page.items
      .filter(({ entityId }) => seededEntityIds.includes(entityId))
      .map(({ entityId }) => entityId),
  );
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  for (const work of SEED) {
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding keeps the insert order readable
    await seedWork(work);
  }
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

describe("my work queues", () => {
  test("the open queues partition the owner's open work", async () => {
    const [inbox, upcoming, atRisk] = await Promise.all([
      queueEntityIds("inbox"),
      queueEntityIds("upcoming"),
      queueEntityIds("at_risk"),
    ]);

    expect(inbox).toEqual(
      new Set([
        entityIdOf("awaiting, no dates"),
        entityIdOf("awaiting, working target in the future"),
      ]),
    );
    expect(upcoming).toEqual(
      new Set([
        entityIdOf("active, no dates"),
        entityIdOf("active, hard deadline in the future"),
      ]),
    );
    expect(atRisk).toEqual(
      new Set([
        entityIdOf("awaiting, working target passed"),
        entityIdOf("awaiting, hard deadline is today"),
        entityIdOf("active, hard deadline passed"),
      ]),
    );

    const openRows = [...inbox, ...upcoming, ...atRisk];
    expect(new Set(openRows).size).toBe(openRows.length);
    expect(openRows).toHaveLength(7);
  });

  test("completed work leaves the open queues", async () => {
    const completed = await queueEntityIds("completed");

    expect(completed).toEqual(new Set([entityIdOf("completed")]));
  });

  test("a non-task List row never surfaces as work", async () => {
    const factEntityId = entityIdOf(
      "a List fact row that should never be governed",
    );
    const queues = await Promise.all(
      [...OPEN_QUEUES, "completed" as const].map(queueEntityIds),
    );

    for (const queue of queues) {
      expect(queue.has(factEntityId)).toBe(false);
    }
  });
});
