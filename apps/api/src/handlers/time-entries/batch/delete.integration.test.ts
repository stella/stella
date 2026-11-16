import { panic, Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import {
  BILLING_STATUS,
  billingArrangements,
  featureEnrolments,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import deleteTimeEntryById from "../delete";
import batchDelete from "./delete";

const ids = createTestIds();
let db: TestDatabase;
const createdEntryIds: (typeof timeEntries.$inferSelect.id)[] = [];
const START = new Date("2026-09-01T10:00:00Z");
type BatchContext = Parameters<typeof batchDelete.handler>[0];
type SingleContext = Parameters<typeof deleteTimeEntryById.handler>[0];

beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);

  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userAdmin]));
  await db
    .insert(featureEnrolments)
    .values([
      {
        organizationId: ids.orgA,
        userId: ids.userAdmin,
        featureId: "time-billing",
      },
    ])
    .onConflictDoNothing();
});
beforeEach(async () => {
  const cleared = await createSafeDb(
    db,
    [ids.wsA2],
    ids.orgA,
    ids.userAdmin,
  )(
    async (tx) =>
      await tx
        .delete(billingArrangements)
        .where(eq(billingArrangements.workspaceId, ids.wsA2)),
  );
  if (Result.isError(cleared)) {
    panic("Billing arrangement cleanup must succeed");
  }
  if (createdEntryIds.length > 0) {
    await db
      .delete(timeEntries)
      .where(inArray(timeEntries.id, createdEntryIds.splice(0)));
  }
});
afterAll(async () => {
  await releaseTestDb();
});

const createEntry = async (status: typeof timeEntries.$inferSelect.status) => {
  const id = createSafeId<"timeEntry">();
  await db.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    userId: ids.userAdmin,
    workspaceId: ids.wsA2,
    status,
    dateWorked: "2026-09-01",
    timezoneId: "UTC",
    durationMinutes: 30,
    billedMinutes: 30,
    narrative: "Recorded work",
    rateAtEntry: cents(0),
    currency: "USD",
    billable: false,
    ...(status === BILLING_STATUS.APPROVED
      ? { approvedByUserId: ids.userAdmin, approvedAt: START }
      : {}),
  });
  createdEntryIds.push(id);
  return id;
};

const context = () => ({
  request: new Request("https://example.test/time-entries", {
    method: "DELETE",
  }),
  memberRole: sessionMemberRole("owner"),
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userAdmin },
  workspaceId: ids.wsA2,
  safeDb: createSafeDb(db, [ids.wsA2], ids.orgA, ids.userAdmin),
  scopedDb: createScopedDb(db, [ids.wsA2], ids.orgA, ids.userAdmin),
});
const runBatch = async (
  entryIds: BatchContext["body"]["ids"],
  events: AuditEvent[],
) => {
  const recordAuditEvent: BatchContext["recordAuditEvent"] = async (
    _tx,
    event,
  ) => {
    events.push(...(Array.isArray(event) ? event : [event]));
  };
  return await batchDelete.handler(
    asTestRaw<BatchContext>({
      ...context(),
      body: { ids: entryIds },
      route: "/v1/time-entries/:workspaceId/batch" satisfies ApiRoutePath,
      recordAuditEvent,
    }),
  );
};
const runSingle = async (
  id: SingleContext["body"]["id"],
  events: AuditEvent[],
  safeDb?: SingleContext["safeDb"],
) => {
  const recordAuditEvent: SingleContext["recordAuditEvent"] = async (
    _tx,
    event,
  ) => {
    events.push(...(Array.isArray(event) ? event : [event]));
  };
  return await deleteTimeEntryById.handler(
    asTestRaw<SingleContext>({
      ...context(),
      ...(safeDb === undefined ? {} : { safeDb }),
      body: { id },
      route: "/v1/time-entries/:workspaceId" satisfies ApiRoutePath,
      recordAuditEvent,
    }),
  );
};
const readEntry = async (id: typeof timeEntries.$inferSelect.id) =>
  (await db.select().from(timeEntries).where(eq(timeEntries.id, id))).at(0);

test("batch deletion writes off only selected unbilled entries and audits drafts first", async () => {
  const draft = await createEntry(BILLING_STATUS.DRAFT);
  const submitted = await createEntry(BILLING_STATUS.SUBMITTED);
  const approved = await createEntry(BILLING_STATUS.APPROVED);
  const billed = await createEntry(BILLING_STATUS.BILLED);
  const writtenOff = await createEntry(BILLING_STATUS.WRITTEN_OFF);
  const beforeBilled = await readEntry(billed);
  const beforeWrittenOff = await readEntry(writtenOff);
  const events: AuditEvent[] = [];
  expect(
    await runBatch(
      [
        draft,
        submitted,
        approved,
        billed,
        writtenOff,
        createSafeId<"timeEntry">(),
      ],
      events,
    ),
  ).toEqual({ updated: 3 });
  expect(await readEntry(draft)).toBeUndefined();
  expect(await readEntry(submitted)).toMatchObject({
    status: BILLING_STATUS.WRITTEN_OFF,
  });
  expect(await readEntry(approved)).toMatchObject({
    status: BILLING_STATUS.WRITTEN_OFF,
    approvedByUserId: ids.userAdmin,
    approvedAt: START,
  });
  expect(await readEntry(billed)).toEqual(beforeBilled);
  expect(await readEntry(writtenOff)).toEqual(beforeWrittenOff);
  expect(events).toHaveLength(3);
  expect(events.at(0)).toMatchObject({
    action: AUDIT_ACTION.DELETE,
    resourceId: draft,
    changes: { deleted: { old: { reason: "batch_delete_draft" }, new: null } },
  });
  expect(new Set(events.slice(1).map((event) => event.resourceId))).toEqual(
    new Set([submitted, approved]),
  );
  for (const event of events.slice(1)) {
    expect(event).toMatchObject({
      action: AUDIT_ACTION.UPDATE,
      changes: { status: { old: null, new: BILLING_STATUS.WRITTEN_OFF } },
    });
  }
});

test("draft-only batch deletion still audits when no entry transitions", async () => {
  const id = await createEntry(BILLING_STATUS.DRAFT);
  const events: AuditEvent[] = [];
  expect(await runBatch([id], events)).toEqual({ updated: 1 });
  expect(await readEntry(id)).toBeUndefined();
  expect(events).toHaveLength(1);
  expect(events.at(0)).toMatchObject({
    resourceId: id,
    action: AUDIT_ACTION.DELETE,
  });
});

test.each([BILLING_STATUS.SUBMITTED, BILLING_STATUS.APPROVED])(
  "single deletion retains %s work as an audited write-off",
  async (status) => {
    const id = await createEntry(status);
    const events: AuditEvent[] = [];
    expect(await runSingle(id, events)).toEqual({ deleted: false });
    expect(await readEntry(id)).toMatchObject({
      status: BILLING_STATUS.WRITTEN_OFF,
    });
    expect(events).toHaveLength(1);
    expect(events.at(0)).toMatchObject({
      resourceId: id,
      action: AUDIT_ACTION.UPDATE,
      changes: { status: { old: status, new: BILLING_STATUS.WRITTEN_OFF } },
    });
  },
);

test("single write-off refuses a status changed after its initial read", async () => {
  const id = await createEntry(BILLING_STATUS.SUBMITTED);
  const base = context().safeDb;
  let changed = false;
  const safeDb: typeof base = async (operation, retry) => {
    const result = await base(operation, retry);
    if (
      !changed &&
      Result.isOk(result) &&
      typeof result.value === "object" &&
      result.value !== null &&
      "status" in result.value &&
      result.value.status === BILLING_STATUS.SUBMITTED
    ) {
      changed = true;
      await db
        .update(timeEntries)
        .set({ status: BILLING_STATUS.APPROVED })
        .where(eq(timeEntries.id, id));
    }
    return result;
  };
  const events: AuditEvent[] = [];
  expect(await runSingle(id, events, safeDb)).toEqual({
    code: 409,
    response: { message: "Time entry changed; reload and try again" },
  });
  expect(changed).toBe(true);
  expect(await readEntry(id)).toMatchObject({
    status: BILLING_STATUS.APPROVED,
  });
  expect(events).toEqual([]);
});

test.each(["single", "batch"] as const)(
  "%s write-off recomputes cap crossings from the remaining billable work",
  async (kind) => {
    const removed = await createEntry(BILLING_STATUS.APPROVED);
    const retained = await createEntry(BILLING_STATUS.APPROVED);
    await db
      .update(timeEntries)
      .set({
        billable: true,
        billedMinutes: 60,
        durationMinutes: 60,
        rateAtEntry: cents(1000),
      })
      .where(eq(timeEntries.id, removed));
    await db
      .update(timeEntries)
      .set({
        billable: true,
        billedMinutes: 90,
        durationMinutes: 90,
        rateAtEntry: cents(1000),
      })
      .where(eq(timeEntries.id, retained));
    const configured = await context().safeDb(
      async (tx) =>
        await tx.insert(billingArrangements).values({
          workspaceId: ids.wsA2,
          organizationId: ids.orgA,
          mode: "hourly",
          currency: "USD",
          capMinutes: 100,
          alertThresholdBps: 8000,
        }),
    );
    if (Result.isError(configured)) {
      panic("Cap fixture must be installed");
    }
    const events: AuditEvent[] = [];
    expect(
      kind === "single"
        ? await runSingle(removed, events)
        : await runBatch([removed], events),
    ).toEqual(kind === "single" ? { deleted: false } : { updated: 1 });
    const state = await context().safeDb(
      async (tx) =>
        await tx.query.billingArrangements.findFirst({
          where: { workspaceId: { eq: ids.wsA2 } },
        }),
    );
    const arrangement =
      (Result.isOk(state) ? state.value : undefined) ??
      panic("Cap fixture must remain readable");
    expect(arrangement).toMatchObject({
      minuteThresholdState: "above",
      minuteCapState: "below",
      crossingSequence: 1,
    });
    const crossings = events.filter(
      (event) => event.metadata?.["event"] === "billing_cap_crossed",
    );
    expect(crossings).toHaveLength(1);
    expect(crossings.at(0)).toMatchObject({
      metadata: { unit: "minutes", usedMinutes: "90", capMinutes: 100 },
    });
    expect(events.at(0)).toMatchObject({
      resourceId: removed,
      action: AUDIT_ACTION.UPDATE,
    });
    expect(await readEntry(retained)).toMatchObject({
      status: BILLING_STATUS.APPROVED,
      billedMinutes: 90,
    });
  },
);
