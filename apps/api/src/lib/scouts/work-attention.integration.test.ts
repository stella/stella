import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { SCOUT_KEY, SIGNAL_KIND } from "@stll/api-contract/signals";
import { WORK_OBLIGATION_STATUS } from "@stll/api-contract/workflow-status";
import type { WorkObligationStatus } from "@stll/api-contract/workflow-status";
import { DAY_IN_MS } from "@stll/time";

import type { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  scoutRuns,
  signals,
  WORK_OBLIGATION_EVENT_TYPE,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import { runWorkAttentionScout } from "@/api/lib/scouts/work-attention";
import type { WorkAttentionScoutDependencies } from "@/api/lib/scouts/work-attention";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

const NOW = new Date("2026-03-01T09:00:00.000Z");

const dateOffset = (days: number): string =>
  new Date(NOW.getTime() + days * DAY_IN_MS).toISOString().slice(0, 10);

const instantOffset = (days: number): Date =>
  new Date(NOW.getTime() + days * DAY_IN_MS);

let testDb: TestDatabase;
let ids: TestIds;
const seededEntityIds: SafeId<"entity">[] = [];

type SeedWork = {
  label: string;
  status: WorkObligationStatus;
  hardDeadlineDate: string | null;
  /** Days before `NOW` the row itself was created. */
  createdDaysAgo: number;
  /** Days before `NOW` an `owner_assigned` event was recorded, if any. */
  assignedDaysAgo: number | null;
};

/**
 * One row per decision the scout has to make: how long an assignment has gone
 * unanswered, whether the waiting clock comes from an event or from the row's
 * own creation, how close a hard deadline is, and whether closed work is out
 * of scope at all.
 */
const SEED: SeedWork[] = [
  {
    label: "awaiting, assigned five days ago",
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    hardDeadlineDate: null,
    createdDaysAgo: 30,
    assignedDaysAgo: 5,
  },
  {
    label: "awaiting, assigned yesterday on an old row",
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    hardDeadlineDate: null,
    createdDaysAgo: 30,
    assignedDaysAgo: 1,
  },
  {
    label: "awaiting, backfilled without an assignment event",
    status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
    hardDeadlineDate: null,
    createdDaysAgo: 10,
    assignedDaysAgo: null,
  },
  {
    label: "active, hard deadline passed",
    status: WORK_OBLIGATION_STATUS.ACTIVE,
    hardDeadlineDate: dateOffset(-1),
    createdDaysAgo: 20,
    assignedDaysAgo: 20,
  },
  {
    label: "active, hard deadline a month out",
    status: WORK_OBLIGATION_STATUS.ACTIVE,
    hardDeadlineDate: dateOffset(30),
    createdDaysAgo: 20,
    assignedDaysAgo: 20,
  },
  {
    label: "completed, hard deadline passed",
    status: WORK_OBLIGATION_STATUS.COMPLETED,
    hardDeadlineDate: dateOffset(-1),
    createdDaysAgo: 20,
    assignedDaysAgo: 20,
  },
];

const seeded = new Map<string, SafeId<"entity">>();

const entityIdOf = (label: string) =>
  seeded.get(label) ?? expect.unreachable(`missing fixture row: ${label}`);

const seedWork = async (work: SeedWork) => {
  const entityId = createSafeId<"entity">();
  seededEntityIds.push(entityId);
  seeded.set(work.label, entityId);
  const acknowledged = work.status === WORK_OBLIGATION_STATUS.ACTIVE;
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    kind: "task",
    name: work.label,
    status: "open",
    createdBy: ids.userA1,
  });
  await testDb.insert(workObligations).values({
    entityId,
    workspaceId: ids.wsA1,
    ownerUserId: ids.userA1,
    status: work.status,
    acknowledgedAt: acknowledged ? instantOffset(-1) : null,
    acknowledgedByUserId: acknowledged ? ids.userA1 : null,
    hardDeadlineDate: work.hardDeadlineDate,
    createdByUserId: ids.userA1,
    createdAt: instantOffset(-work.createdDaysAgo),
  });
  if (work.assignedDaysAgo !== null) {
    await testDb.insert(workObligationEvents).values({
      id: createSafeId<"workObligationEvent">(),
      workspaceId: ids.wsA1,
      obligationEntityId: entityId,
      actorUserId: ids.userA1,
      type: WORK_OBLIGATION_EVENT_TYPE.OWNER_ASSIGNED,
      details: {
        type: "ownership_changed",
        previousOwnerUserId: null,
        nextOwnerUserId: ids.userA1,
      },
      occurredAt: instantOffset(-work.assignedDaysAgo),
    });
  }
};

const dependencies = (): WorkAttentionScoutDependencies => ({
  db: asTestRaw<typeof rootDb>(testDb),
  createScopedDb: ({ organizationId, userId, workspaceIds }) =>
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, workspaceIds, organizationId, userId),
    ),
});

const seededSignals = async () =>
  await testDb
    .select({
      kind: signals.kind,
      severity: signals.severity,
      origin: signals.origin,
      confidence: signals.confidence,
      workspaceId: signals.workspaceId,
      dedupeKey: signals.dedupeKey,
      subject: signals.subject,
      evidence: signals.evidence,
    })
    .from(signals)
    .where(eq(signals.scoutKey, SCOUT_KEY.WORK_ATTENTION));

const signalsFor = async (label: string) => {
  const entityId = entityIdOf(label);
  const rows = await seededSignals();
  return rows.filter((row) =>
    row.evidence.kind === SIGNAL_KIND.WORK_UNACKNOWLEDGED ||
    row.evidence.kind === SIGNAL_KIND.WORK_DEADLINE_AT_RISK
      ? row.evidence.obligationEntityId === entityId
      : false,
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
    await testDb
      .delete(signals)
      .where(eq(signals.scoutKey, SCOUT_KEY.WORK_ATTENTION));
    await testDb
      .delete(scoutRuns)
      .where(eq(scoutRuns.scoutKey, SCOUT_KEY.WORK_ATTENTION));
    if (seededEntityIds.length > 0) {
      await testDb
        .delete(entities)
        .where(inArray(entities.id, seededEntityIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("work attention scout", () => {
  test("emits once per stuck obligation and records the run", async () => {
    const outcome = await runWorkAttentionScout({
      cursor: null,
      now: NOW,
      dependencies: dependencies(),
    });

    expect(outcome.nextCursor).not.toBeNull();
    expect(outcome.inserted).toBeGreaterThan(0);

    expect(
      (await signalsFor("awaiting, assigned five days ago")).map(
        ({ kind, severity, origin, confidence }) => ({
          kind,
          severity,
          origin,
          confidence,
        }),
      ),
    ).toEqual([
      {
        kind: SIGNAL_KIND.WORK_UNACKNOWLEDGED,
        severity: "warning",
        origin: "source",
        confidence: null,
      },
    ]);

    expect(
      await signalsFor("awaiting, assigned yesterday on an old row"),
    ).toEqual([]);

    const backfilled = await signalsFor(
      "awaiting, backfilled without an assignment event",
    );
    expect(backfilled.map(({ kind }) => kind)).toEqual([
      SIGNAL_KIND.WORK_UNACKNOWLEDGED,
    ]);
    expect(backfilled.at(0)?.evidence).toMatchObject({ daysWaiting: 10 });

    const overdue = await signalsFor("active, hard deadline passed");
    expect(
      overdue.map(({ kind, severity, workspaceId }) => ({
        kind,
        severity,
        workspaceId,
      })),
    ).toEqual([
      {
        kind: SIGNAL_KIND.WORK_DEADLINE_AT_RISK,
        severity: "critical",
        workspaceId: ids.wsA1,
      },
    ]);
    expect(overdue.at(0)?.subject).toEqual({
      type: "entity",
      workspaceId: ids.wsA1,
      entityId: entityIdOf("active, hard deadline passed"),
    });

    expect(await signalsFor("active, hard deadline a month out")).toEqual([]);
    expect(await signalsFor("completed, hard deadline passed")).toEqual([]);

    const runs = await testDb
      .select({
        status: scoutRuns.status,
        insertedCount: scoutRuns.insertedCount,
        emittedCount: scoutRuns.emittedCount,
      })
      .from(scoutRuns)
      .where(
        and(
          eq(scoutRuns.scoutKey, SCOUT_KEY.WORK_ATTENTION),
          eq(scoutRuns.organizationId, ids.orgA),
        ),
      );
    expect(runs).toHaveLength(1);
    expect(runs.at(0)?.status).toBe("succeeded");
    expect(runs.at(0)?.insertedCount).toBe(3);
    expect(runs.at(0)?.emittedCount).toBe(3);
  });

  test("a second sweep of the same state inserts nothing", async () => {
    const before = await seededSignals();

    const outcome = await runWorkAttentionScout({
      cursor: null,
      now: NOW,
      dependencies: dependencies(),
    });

    expect(outcome.emitted).toBe(3);
    expect(outcome.inserted).toBe(0);
    expect(await seededSignals()).toHaveLength(before.length);
  });

  test("moving a hard deadline is a new observation", async () => {
    const entityId = entityIdOf("active, hard deadline passed");
    await testDb
      .update(workObligations)
      .set({ hardDeadlineDate: dateOffset(-2) })
      .where(eq(workObligations.entityId, entityId));

    await runWorkAttentionScout({
      cursor: null,
      now: NOW,
      dependencies: dependencies(),
    });

    expect(
      (await signalsFor("active, hard deadline passed")).map(
        ({ dedupeKey }) => dedupeKey,
      ),
    ).toHaveLength(2);
  });

  test("an empty page closes the cycle instead of stalling the cursor", async () => {
    const outcome = await runWorkAttentionScout({
      cursor: brandPersistedEntityId("ffffffff-ffff-4fff-bfff-ffffffffffff"),
      now: NOW,
      dependencies: dependencies(),
    });

    expect(outcome).toMatchObject({
      scanned: 0,
      emitted: 0,
      inserted: 0,
      nextCursor: null,
    });
  });
});
