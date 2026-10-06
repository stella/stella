import { Result } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { user as authUser } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { invoices, timeEntries, featureEnrolments } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { exportCsvHandler } from "@/api/handlers/time-entries/csv/export";
import { exportLedesHandler } from "@/api/handlers/time-entries/ledes/export";
import { exportPdfHandler } from "@/api/handlers/time-entries/pdf/export";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createInvoice from "./create";

type CreateContext = Parameters<typeof createInvoice.handler>[0];
setDefaultTimeout(120_000);
let db: TestDatabase;
let ids: TestIds;
const createdIds: (typeof timeEntries.$inferSelect.id)[] = [];
const DAY = "2026-09-01";

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;

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
afterAll(async () => {
  if (createdIds.length > 0) {
    await db.delete(timeEntries).where(inArray(timeEntries.id, createdIds));
  }
  await releaseRlsFixture();
});

const seedEntries = async () => {
  const clientId = createSafeId<"timeEntry">();
  const internalId = createSafeId<"timeEntry">();
  await db.insert(timeEntries).values([
    {
      id: clientId,
      organizationId: ids.orgA,
      userId: ids.userAdmin,
      workspaceId: ids.wsA2,
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
      dateWorked: DAY,
      timezoneId: "UTC",
      durationMinutes: 30,
      billedMinutes: 30,
      rateAtEntry: cents(10_000),
      currency: "USD",
      billable: true,
      status: "approved",
      narrative: "Exported client work",
    },
    {
      id: internalId,
      organizationId: ids.orgA,
      userId: ids.userAdmin,
      workspaceId: null,
      activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      dateWorked: DAY,
      timezoneId: "UTC",
      durationMinutes: 30,
      billedMinutes: 0,
      rateAtEntry: cents(0),
      currency: UNPRICED_TIME_ENTRY_CURRENCY,
      billable: false,
      status: "approved",
      narrative: "Private internal work",
    },
  ]);
  createdIds.push(clientId, internalId);
  return { clientId, internalId };
};

const exportContext = () => ({
  organizationId: ids.orgA,
  workspaceId: ids.wsA2,
  scopedDb: asTestRaw<ScopedDb>(
    createScopedDb(db, [ids.wsA2], ids.orgA, ids.userAdmin),
  ),
  query: { dateFrom: DAY, dateTo: DAY },
});

test("a mixed client/internal invoice request refuses before claiming either row", async () => {
  const { clientId, internalId } = await seedEntries();
  const invoiceNumber = `GROUP-${clientId}`;
  const result = await createInvoice.handler(
    asTestRaw<CreateContext>({
      request: new Request("https://example.test/invoices", { method: "POST" }),
      route: "/invoices",
      workspaceId: ids.wsA2,
      user: { id: ids.userAdmin },
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: ids.orgA },
      safeDb: createSafeDb(db, [ids.wsA2], ids.orgA, ids.userAdmin),
      scopedDb: createScopedDb(db, [ids.wsA2], ids.orgA, ids.userAdmin),
      recordAuditEvent: async () => undefined,
      body: {
        invoiceNumber,
        invoiceDate: DAY,
        currency: "USD",
        timeEntryIds: [clientId, internalId],
      },
    }),
  );
  expect(result).toMatchObject({ code: 400 });
  for (const id of [clientId, internalId]) {
    expect(
      await db.query.timeEntries.findFirst({ where: { id: { eq: id } } }),
    ).toMatchObject({ status: "approved", invoiceId: null });
  }
  expect(
    await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.invoiceNumber, invoiceNumber)),
  ).toEqual([]);
});

test("matter exports include their explicit client activity group and exclude organization internal time", async () => {
  const { internalId } = await seedEntries();
  const context = exportContext();
  const ledes = await exportLedesHandler(context);
  expect(Result.isError(ledes)).toBe(false);
  if (Result.isOk(ledes)) {
    expect(ledes.value).toContain("Exported client work");
    expect(ledes.value).not.toContain("Private internal work");
  }
  const csv = await exportCsvHandler(context);
  expect(csv).toContain("Activity Group");
  expect(csv).toContain("Exported client work");
  expect(csv).not.toContain("Private internal work");
  const pdf = new TextDecoder().decode(await exportPdfHandler(context));
  expect(pdf).toContain("Activity group: client");
  expect(pdf).not.toContain("Private internal work");
  // The owner can see the internal row: exclusion is the report's scope, not RLS hiding it.
  expect(
    await context.scopedDb((tx) =>
      tx.query.timeEntries.findFirst({
        where: { id: { eq: internalId } },
      }),
    ),
  ).toMatchObject({ activityGroup: "internal", workspaceId: null });
});
