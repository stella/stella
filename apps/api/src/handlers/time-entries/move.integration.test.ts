import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { user as authUser } from "@/api/db/auth-schema";
import {
  auditLogs,
  featureEnrolments,
  invoiceLines,
  invoices,
  rateEntries,
  rateTables,
  timeEntries,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import updateTimeEntry from "./update";

// timeout: Boot the shared PGlite engine and RLS fixture before the move assertions.
setDefaultTimeout(120_000);
type UpdateCtx = Parameters<typeof updateTimeEntry.handler>[0];

let db: TestDatabase;
let ids: TestIds;
const entryIds: SafeId<"timeEntry">[] = [];
const rateTableIds: SafeId<"rateTable">[] = [];
const invoiceIds: SafeId<"invoice">[] = [];
const DAY = Temporal.Now.plainDateISO("UTC").subtract({ days: 1 }).toString();
const START = new Date(`${DAY}T10:00:00Z`);

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(inArray(authUser.id, [ids.userA1, ids.userA2, ids.userAdmin]));
  await db
    .insert(featureEnrolments)
    .values(
      [ids.userA1, ids.userA2, ids.userAdmin].map((userId) => ({
        organizationId: ids.orgA,
        userId,
        featureId: "time-billing",
      })),
    )
    .onConflictDoNothing();
});

const cleanup = async () => {
  if (invoiceIds.length) {
    await db
      .delete(invoiceLines)
      .where(inArray(invoiceLines.invoiceId, invoiceIds));
  }
  if (entryIds.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.resourceId, entryIds));
    await db
      .delete(timeEntries)
      .where(inArray(timeEntries.id, entryIds.splice(0)));
  }
  if (invoiceIds.length) {
    await db.delete(invoices).where(inArray(invoices.id, invoiceIds.splice(0)));
  }
  if (rateTableIds.length) {
    const tables = rateTableIds.splice(0);
    await db
      .delete(rateEntries)
      .where(inArray(rateEntries.rateTableId, tables));
    await db.delete(rateTables).where(inArray(rateTables.id, tables));
  }
};
beforeEach(cleanup);
afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await releaseRlsFixture();
  }
});

/** A draft of userA1's in the second matter, priced by its old rate. */
const seedEntry = async (
  overrides: Partial<Omit<typeof timeEntries.$inferInsert, "id">> = {},
) => {
  const id = createSafeId<"timeEntry">();
  await db.insert(timeEntries).values({
    id,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
    dateWorked: DAY,
    timezoneId: "UTC",
    durationMinutes: 60,
    billedMinutes: 60,
    rateAtEntry: cents(10_000),
    currency: "USD",
    narrative: "Drafted the lease review",
    status: "draft",
    ...overrides,
  });
  entryIds.push(id);
  return id;
};

/** The first matter's rate for userA1. */
const seedRate = async (hourlyRate: number, currency: string) => {
  const rateTableId = createSafeId<"rateTable">();
  await db.insert(rateTables).values({
    id: rateTableId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    name: "Move test rate",
    currency,
    isDefault: true,
  });
  await db.insert(rateEntries).values({
    id: createSafeId<"rateEntry">(),
    workspaceId: ids.wsA1,
    rateTableId,
    userId: ids.userA1,
    hourlyRate: cents(hourlyRate),
    effectiveFrom: DAY,
  });
  rateTableIds.push(rateTableId);
};

/** userA1 and the owner use both matters of the organization; userA2 only the second. */
const accessible = (actor: SafeId<"user">) =>
  actor === ids.userA2 ? [ids.wsA2] : [ids.wsA1, ids.wsA2];

const moveFor = async (
  id: SafeId<"timeEntry">,
  to: SafeId<"workspace">,
  {
    actor = ids.userA1,
    role = "member",
    fields = {},
  }: {
    actor?: SafeId<"user">;
    role?: "member" | "owner";
    fields?: Record<string, unknown>;
  } = {},
) => {
  const workspaceIds = accessible(actor);
  const request = new Request("https://example.test/time-entries");
  return await updateTimeEntry.handler(
    asTestRaw<UpdateCtx>({
      request,
      route: "/v1/time-entries/:workspaceId" satisfies ApiRoutePath,
      session: { activeOrganizationId: ids.orgA },
      user: { id: actor },
      memberRole: sessionMemberRole(role),
      workspaceId: ids.wsA2,
      safeDb: createSafeDb(db, workspaceIds, ids.orgA, actor),
      scopedDb: createScopedDb(db, workspaceIds, ids.orgA, actor),
      getActiveWorkspaceIds: async () => workspaceIds,
      getWorkspaceAccess: async (workspaceId: SafeId<"workspace">) =>
        workspaceIds.includes(workspaceId)
          ? { id: workspaceId, status: "active" }
          : null,
      recordAuditEvent: createAuditRecorder({
        organizationId: ids.orgA,
        workspaceId: ids.wsA2,
        userId: actor,
        request,
        server: null,
      }),
      body: { id, moveToWorkspaceId: to, ...fields },
    }),
  );
};

const stored = async (id: SafeId<"timeEntry">) =>
  await db.query.timeEntries.findFirst({ where: { id: { eq: id } } });

const auditOf = async (id: SafeId<"timeEntry">) =>
  await db
    .select({ changes: auditLogs.changes, userId: auditLogs.userId })
    .from(auditLogs)
    .where(eq(auditLogs.resourceId, id));

describe("moving a draft time entry to another matter", () => {
  test("moves it, prices it from the new matter's rates, and audits the move", async () => {
    await seedRate(25_000, "EUR");
    const id = await seedEntry({ workItemId: ids.entityA2 });

    expect(
      await moveFor(id, ids.wsA1, { fields: { narrative: "Reviewed lease" } }),
    ).toEqual({ id });

    expect(await stored(id)).toMatchObject({
      workspaceId: ids.wsA1,
      status: "draft",
      rateAtEntry: 25_000,
      currency: "EUR",
      workItemId: null,
      narrative: "Reviewed lease",
    });
    const logs = await auditOf(id);
    expect(logs).toHaveLength(1);
    expect(logs.at(0)).toMatchObject({
      userId: ids.userA1,
      changes: {
        workspaceId: { old: ids.wsA2, new: ids.wsA1 },
        rateAtEntry: { old: 10_000, new: 25_000 },
        currency: { old: "USD", new: "EUR" },
        workItemId: { old: ids.entityA2, new: null },
      },
    });
  });

  test("a non-billable draft moving to a matter without rates stays unpriced there", async () => {
    const id = await seedEntry({ billable: false });

    expect(await moveFor(id, ids.wsA1)).toEqual({ id });

    expect(await stored(id)).toMatchObject({
      workspaceId: ids.wsA1,
      rateAtEntry: 0,
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
    });
  });

  test("a billable draft cannot move to a matter with no rate for its timekeeper", async () => {
    const id = await seedEntry();

    expect(await moveFor(id, ids.wsA1)).toMatchObject({ code: 400 });

    expect(await stored(id)).toMatchObject({
      workspaceId: ids.wsA2,
      rateAtEntry: 10_000,
      currency: "USD",
    });
    expect(await auditOf(id)).toEqual([]);
  });

  test("only a draft moves, even for an owner who may edit reviewed time", async () => {
    await seedRate(25_000, "EUR");
    for (const status of ["submitted", "approved"] as const) {
      const id = await seedEntry({ status });

      expect(
        await moveFor(id, ids.wsA1, { actor: ids.userAdmin, role: "owner" }),
      ).toMatchObject({ code: 409, response: { code: "wrong_status" } });
      expect(await stored(id)).toMatchObject({
        workspaceId: ids.wsA2,
        status,
      });
    }
  });

  test("a draft with a running timer does not move", async () => {
    await seedRate(25_000, "EUR");
    const id = await seedEntry({ timerStartedAt: START });

    expect(await moveFor(id, ids.wsA1)).toMatchObject({ code: 409 });
    expect((await stored(id))?.workspaceId).toBe(ids.wsA2);
  });

  test("a draft held by an invoice line does not move", async () => {
    await seedRate(25_000, "EUR");
    const id = await seedEntry();
    const invoiceId = createSafeId<"invoice">();
    await db.insert(invoices).values({
      id: invoiceId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA2,
      invoiceNumber: `INV-${invoiceId}`,
      invoiceDate: DAY,
      currency: "USD",
      status: "draft",
    });
    invoiceIds.push(invoiceId);
    await db.insert(invoiceLines).values({
      id: createSafeId<"invoiceLine">(),
      organizationId: ids.orgA,
      workspaceId: ids.wsA2,
      invoiceId,
      position: 0,
      description: "Lease review",
      quantity: "1",
      unitPrice: cents(10_000),
      vatRateBps: 0,
      vatTreatment: "domestic_vat",
      netAmount: cents(10_000),
      vatAmount: cents(0),
      grossAmount: cents(10_000),
      source: "time_entry",
      timeEntryId: id,
    });

    expect(await moveFor(id, ids.wsA1)).toMatchObject({ code: 409 });
    expect((await stored(id))?.workspaceId).toBe(ids.wsA2);
  });

  test("a matter the editor cannot use is not a target", async () => {
    const id = await seedEntry({ userId: ids.userA2 });

    expect(await moveFor(id, ids.wsA1, { actor: ids.userA2 })).toMatchObject({
      code: 404,
    });
    expect((await stored(id))?.workspaceId).toBe(ids.wsA2);
  });

  test("a member cannot move someone else's draft", async () => {
    await seedRate(25_000, "EUR");
    const id = await seedEntry({ userId: ids.userA2 });

    expect(await moveFor(id, ids.wsA1)).toMatchObject({ code: 404 });
    expect((await stored(id))?.workspaceId).toBe(ids.wsA2);
  });
});
