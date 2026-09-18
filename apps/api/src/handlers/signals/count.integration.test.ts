import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract/entity-options";
import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";

import { entities, signals, taskAssignees } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import countInbox from "@/api/handlers/signals/count";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { TASK_ASSIGNEE_ROLE } from "@/api/lib/entity-constants";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type CountContext = Parameters<typeof countInbox.handler>[0];

const AS_OF = "2026-02-01";

let testDb: TestDatabase;
let ids: TestIds;
const seededEntities: SafeId<"entity">[] = [];
const seededSignals: SafeId<"signal">[] = [];

type SeedTaskOptions = {
  workspaceId: SafeId<"workspace">;
  dueDate: string;
  status?: string;
  assignee: SafeId<"user"> | null;
};

const seedTask = async ({
  workspaceId,
  dueDate,
  status = TASK_STATUS.OPEN,
  assignee,
}: SeedTaskOptions) => {
  const id = createSafeId<"entity">();
  await testDb.insert(entities).values({
    id,
    workspaceId,
    kind: "task",
    name: `due ${dueDate}`,
    status,
    dueDate,
  });
  seededEntities.push(id);
  if (assignee !== null) {
    await testDb.insert(taskAssignees).values({
      id: createSafeId<"taskAssignee">(),
      workspaceId,
      entityId: id,
      userId: assignee,
      role: TASK_ASSIGNEE_ROLE.ASSIGNEE,
    });
  }
};

const seedOpenSignal = async (workspaceId: SafeId<"workspace">) => {
  const id = createSafeId<"signal">();
  await testDb.insert(signals).values({
    id,
    organizationId: ids.orgA,
    workspaceId,
    kind: SIGNAL_KIND.REQUEST_SUBMITTED,
    origin: SIGNAL_KIND_ORIGIN[SIGNAL_KIND.REQUEST_SUBMITTED],
    scoutKey: SCOUT_KEY.MANUAL_REQUEST,
    severity: SIGNAL_SEVERITY.NOTICE,
    confidence: null,
    title: "badge",
    summary: "badge",
    subject: { type: "workspace", workspaceId },
    evidence: {
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      description: "badge",
      attachments: [],
    },
    suggestions: [],
    dedupeKey: `test:${id}`,
  });
  seededSignals.push(id);
};

const countFor = async (workspaceIds: SafeId<"workspace">[]) => {
  const result = await countInbox.handler(
    asTestRaw<CountContext>({
      getActiveWorkspaceIds: async () => workspaceIds,
      memberRole: { role: "owner" },
      request: new Request("https://example.test/signals/count"),
      route: "/test/signals/count",
      safeDb: createSafeDb(testDb, workspaceIds, ids.orgA, ids.userA1),
      scopedDb: createScopedDb(testDb, workspaceIds, ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      query: { asOf: AS_OF },
    }),
  );
  if (!("count" in result)) {
    return expect.unreachable(`count failed: ${JSON.stringify(result)}`);
  }
  return result.count;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (seededSignals.length > 0) {
      await testDb.delete(signals).where(inArray(signals.id, seededSignals));
    }
    if (seededEntities.length > 0) {
      await testDb.delete(entities).where(inArray(entities.id, seededEntities));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("Inbox badge count", () => {
  test("adds the caller's overdue and due-today tasks to open signals", async () => {
    const workspaceIds = [ids.wsA1, ids.wsA2, ids.wsB1];
    const before = await countFor(workspaceIds);

    // Counted: overdue and due today, assigned to the caller.
    await seedTask({
      workspaceId: ids.wsA1,
      dueDate: "2026-01-15",
      assignee: ids.userA1,
    });
    await seedTask({
      workspaceId: ids.wsA2,
      dueDate: AS_OF,
      assignee: ids.userA1,
    });
    await seedOpenSignal(ids.wsA1);
    // Not counted: upcoming, finished, someone else's, unassigned, and a
    // task in another organization the caller also belongs to.
    await seedTask({
      workspaceId: ids.wsA1,
      dueDate: "2026-02-02",
      assignee: ids.userA1,
    });
    await seedTask({
      workspaceId: ids.wsA1,
      dueDate: "2026-01-15",
      status: TASK_STATUS.DONE,
      assignee: ids.userA1,
    });
    await seedTask({
      workspaceId: ids.wsA2,
      dueDate: "2026-01-15",
      assignee: ids.userA2,
    });
    await seedTask({
      workspaceId: ids.wsA1,
      dueDate: "2026-01-15",
      assignee: null,
    });
    await seedTask({
      workspaceId: ids.wsB1,
      dueDate: "2026-01-15",
      assignee: ids.userA1,
    });

    expect(await countFor(workspaceIds)).toBe(before + 3);
    // A matter outside the caller's membership contributes nothing.
    expect(await countFor([ids.wsA1])).toBeLessThan(before + 3);
  });
});
