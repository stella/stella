import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import {
  BILLING_STATUS,
  contacts,
  featureEnrolments,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  sellerProfiles,
  timeEntries,
  vatRates,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createClientInvoice from "@/api/handlers/client-invoices/create";
import deleteInvoice from "@/api/handlers/invoices/delete";
import readInvoice from "@/api/handlers/invoices/get";
import createLine from "@/api/handlers/invoices/lines/create";
import deleteLine from "@/api/handlers/invoices/lines/delete";
import transitionInvoice from "@/api/handlers/invoices/transition";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { SafeHandlerLogContext } from "@/api/lib/api-handlers";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
let ids: TestIds;
const clientId = createSafeId<"contact">();
const matters = [
  {
    workspaceId: createSafeId<"workspace">(),
    entryId: createSafeId<"timeEntry">(),
  },
  {
    workspaceId: createSafeId<"workspace">(),
    entryId: createSafeId<"timeEntry">(),
  },
];
const matterIds = matters.map(({ workspaceId }) => workspaceId);
const entryIds = matters.map(({ entryId }) => entryId);
type InvoiceSource = (typeof matters)[number];
// A third matter of the client that no client invoice bills yet.
const quotaMatterId = createSafeId<"workspace">();
const quotaEntryId = createSafeId<"timeEntry">();
const quotaSources = matters.map(({ workspaceId }) => ({
  workspaceId,
  entryId: createSafeId<"timeEntry">(),
}));
const scopeMatterIds = [...matterIds, quotaMatterId];
// Fresh entries on the same two matters, one set per running-entry case.
const runningCaseSources = (["delete", "void"] as const).map((operation) => ({
  operation,
  sources: matters.map(({ workspaceId }) => ({
    workspaceId,
    entryId: createSafeId<"timeEntry">(),
  })),
}));
const sellerId = createSafeId<"sellerProfile">();
const vatIds = [createSafeId<"vatRate">(), createSafeId<"vatRate">()];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
  await db
    .update(authUser)
    .set({ emailVerified: true })
    .where(eq(authUser.id, ids.userAdmin));
  await db
    .insert(featureEnrolments)
    .values({
      organizationId: ids.orgA,
      userId: ids.userAdmin,
      featureId: "time-billing",
    })
    .onConflictDoNothing();
  await db.insert(contacts).values({
    id: clientId,
    organizationId: ids.orgA,
    type: "organization",
    displayName: "Invoice client",
    billingAddress: {
      line1: "Hlavní 1",
      city: "Praha",
      postalCode: "11000",
      country: "CZ",
    },
  });
  await db.insert(workspaces).values(
    scopeMatterIds.map((id) => ({
      id,
      organizationId: ids.orgA,
      clientId,
      name: "Invoice matter",
      reference: id,
    })),
  );
  await db.insert(sellerProfiles).values({
    id: sellerId,
    organizationId: ids.orgA,
    legalName: "Legal services",
    vatId: "CZ12345678",
    vatPayer: true,
    defaultCurrency: "CZK",
  });
  await db.insert(vatRates).values(
    vatIds.map((id, index) => ({
      id,
      organizationId: ids.orgA,
      code: "standard",
      name: "Standard",
      rateBps: index === 0 ? 2100 : 2300,
      validFrom: index === 0 ? "2020-01-01" : "2026-09-20",
      validTo: index === 0 ? "2026-09-20" : null,
    })),
  );
});

// timeout: removes the 10 000 invoices the quota test seeds for one matter.
afterAll(async () => {
  try {
    await db.delete(invoices).where(eq(invoices.clientId, clientId));
    await db
      .delete(timeEntries)
      .where(
        inArray(timeEntries.id, [
          ...entryIds,
          quotaEntryId,
          ...quotaSources.map(({ entryId }) => entryId),
          ...runningCaseSources.flatMap(({ sources }) =>
            sources.map(({ entryId }) => entryId),
          ),
        ]),
      );
    await db.delete(workspaces).where(inArray(workspaces.id, scopeMatterIds));
    await db.delete(contacts).where(eq(contacts.id, clientId));
    await db.delete(sellerProfiles).where(eq(sellerProfiles.id, sellerId));
    await db.delete(vatRates).where(inArray(vatRates.id, vatIds));
  } finally {
    await releaseRlsFixture();
  }
}, 120_000);

const context = <TContext extends SafeHandlerLogContext>(
  _handler: (context: TContext) => unknown,
  body: unknown,
  params: Record<string, unknown>,
): TContext =>
  asTestRaw<TContext>({
    body,
    params,
    workspaceId: matterIds.at(0),
    safeDb: createSafeDb(db, scopeMatterIds, ids.orgA, ids.userAdmin),
    scopedDb: createScopedDb(db, scopeMatterIds, ids.orgA, ids.userAdmin),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userAdmin },
    memberRole: sessionMemberRole("owner"),
    getActiveWorkspaceIds: async () => scopeMatterIds,
    getAccessibleWorkspaces: async () =>
      scopeMatterIds.map((id) => ({ id, status: "active" })),
    getWorkspaceAccess: async () => ({ id: matterIds.at(0), status: "active" }),
    request: new Request("https://example.test/client-invoices", {
      method: "PUT",
    }),
    route: "/test/client-invoices",
    recordAuditEvent: async () => {},
    createAuditRecorder: () => async () => {},
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu",
    promptCachingEnabled: false,
  });

const create = async (sources: readonly InvoiceSource[] = matters) => {
  await db.insert(timeEntries).values(
    sources.map(({ entryId: id, workspaceId }, index) => ({
      id,
      organizationId: ids.orgA,
      workspaceId,
      userId: ids.userAdmin,
      dateWorked: index === 0 ? "2026-09-10" : "2026-09-25",
      timezoneId: "UTC",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: cents(20_000),
      currency: "CZK",
      status: BILLING_STATUS.APPROVED,
      narrative: "Legal services",
    })),
  );
  const result = await createClientInvoice.handler(
    context(
      createClientInvoice.handler,
      {
        invoiceDate: "2026-10-15",
        currency: "CZK",
        sellerProfileId: sellerId,
        expectedTotalAmount: 49_200,
        matters: sources.map(({ workspaceId, entryId }) => ({
          workspaceId,
          timeEntryIds: [entryId],
          expenseIds: [],
        })),
      },
      { clientId },
    ),
  );
  if (!("id" in result) || typeof result.id !== "string") {
    throw new Error(`Expected client invoice: ${JSON.stringify(result)}`);
  }
  return asTestRaw<SafeId<"invoice">>(result.id);
};

const read = async (invoiceId: SafeId<"invoice">) =>
  readInvoice.handler(
    context(readInvoice.handler, undefined, {
      invoiceId,
      workspaceId: matterIds.at(0),
    }),
  );

describe("client invoice composition", () => {
  test("client composition uses one supply date and remains addressable after line removal", async () => {
    const invoiceId = await create();
    const row = await db.query.invoices.findFirst({
      where: { id: { eq: invoiceId } },
      with: { lines: true },
    });
    expect(row).toMatchObject({
      workspaceId: null,
      clientId,
      taxableSupplyDate: "2026-09-25",
      netAmount: 40_000,
      vatAmount: 9200,
      totalAmount: 49_200,
    });
    expect(row?.lines).toHaveLength(2);
    expect(row?.lines.every((line) => line.vatRateBps === 2300)).toBe(true);

    // Removing every matter and finally every line preserves client ownership and addressability.
    for (const line of row?.lines ?? []) {
      const result = await deleteLine.handler({
        ...context(deleteLine.handler, undefined, {
          invoiceId,
          lineId: line.id,
          workspaceId: line.workspaceId,
        }),
        workspaceId: line.workspaceId,
      });
      expect(result).toHaveProperty("id", line.id);
    }
    expect(await read(invoiceId)).toMatchObject({
      id: invoiceId,
      workspaceId: null,
      totalAmount: 0,
      lines: [],
    });
    expect(
      await db
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId)),
    ).toEqual([]);
    const entries = await db
      .select({ invoiceId: timeEntries.invoiceId, status: timeEntries.status })
      .from(timeEntries)
      .where(inArray(timeEntries.id, entryIds));
    expect(entries).toEqual([
      { invoiceId: null, status: "approved" },
      { invoiceId: null, status: "approved" },
    ]);
  });
});

describe("client invoice release and running time", () => {
  const release = {
    delete: async (invoiceId: SafeId<"invoice">) =>
      await deleteInvoice.handler(
        context(deleteInvoice.handler, undefined, {
          invoiceId,
          workspaceId: matterIds.at(0),
        }),
      ),
    void: async (invoiceId: SafeId<"invoice">) =>
      await transitionInvoice.handler(
        context(
          transitionInvoice.handler,
          { action: "void" },
          { invoiceId, workspaceId: matterIds.at(0) },
        ),
      ),
  };

  // The URL names the first matter, while the running entry sits on the
  // second: the guard must cover every matter the invoice bills.
  test.each(runningCaseSources)(
    "$operation through one matter refuses another member's running entry on another matter",
    async ({ operation, sources }) => {
      const invoiceId = await create(sources);
      const [first, second] = sources;
      if (first === undefined || second === undefined) {
        throw new Error("Expected two client invoice matters");
      }
      expect(second.workspaceId).not.toBe(matterIds.at(0));
      if (operation === "void") {
        await db
          .update(invoices)
          .set({
            status: INVOICE_STATUS.FINALIZED,
            invoiceNumber: `RUN-${invoiceId}`,
          })
          .where(eq(invoices.id, invoiceId));
      }
      await db
        .update(timeEntries)
        .set({
          userId: ids.userA1,
          timerStartedAt: new Date(Date.now() - 3 * 60_000),
          timerStoppedAt: null,
        })
        .where(eq(timeEntries.id, second.entryId));
      const state = async () =>
        await Promise.all([
          db.select().from(invoices).where(eq(invoices.id, invoiceId)),
          db
            .select()
            .from(invoiceLines)
            .where(eq(invoiceLines.invoiceId, invoiceId)),
          db
            .select()
            .from(timeEntries)
            .where(
              inArray(
                timeEntries.id,
                sources.map(({ entryId }) => entryId),
              ),
            ),
        ]);
      const before = await state();
      expect(
        before[1].map(({ workspaceId }) => workspaceId).toSorted(),
      ).toEqual([...matterIds].toSorted());
      expect(before[2]).toContainEqual(
        expect.objectContaining({
          id: second.entryId,
          invoiceId,
          status: BILLING_STATUS.BILLED,
        }),
      );

      try {
        expect(await release[operation](invoiceId)).toMatchObject({
          code: 409,
          response: { code: "running_timer" },
        });
        expect(await state()).toEqual(before);
      } finally {
        // A member has one running timer at a time; end it for the next case.
        await db
          .update(timeEntries)
          .set({ timerStartedAt: null })
          .where(eq(timeEntries.id, second.entryId));
      }
    },
  );
});

describe("client invoice matter quota", () => {
  const quota = async () =>
    await createScopedDb(
      db,
      scopeMatterIds,
      ids.orgA,
      ids.userAdmin,
    )(async (tx) => {
      const [row] = await tx
        .select({
          count: sql<number>`public.stella_matter_invoice_count(${quotaMatterId})::int`,
        })
        .from(sql`(SELECT 1) quota`);
      return row?.count;
    });
  const throughQuotaMatter = <TContext extends SafeHandlerLogContext>(
    handler: (context: TContext) => unknown,
    body: unknown,
    params: Record<string, unknown>,
  ) => ({ ...context(handler, body, params), workspaceId: quotaMatterId });
  const manualLine = {
    source: {
      type: "manual",
      description: "Advice",
      quantity: "1",
      unitPriceMinor: 10_000,
    },
    vatRateBps: 2300,
    vatTreatment: "domestic_vat",
  } as const;
  const limitRefusal = {
    code: 409,
    response: { message: "Matter invoice limit reached" },
  };

  // timeout: seeds a matter to its 10 000-invoice limit, and every quota read counts across all of them.
  test("a matter at its invoice limit cannot join a client invoice on any path", async () => {
    const invoiceId = await create(quotaSources);
    await db.insert(timeEntries).values({
      id: quotaEntryId,
      organizationId: ids.orgA,
      workspaceId: quotaMatterId,
      userId: ids.userAdmin,
      dateWorked: "2026-09-25",
      timezoneId: "UTC",
      durationMinutes: 60,
      billedMinutes: 60,
      rateAtEntry: cents(20_000),
      currency: "CZK",
      status: BILLING_STATUS.APPROVED,
      narrative: "Legal services",
    });
    await db.execute(sql`INSERT INTO invoices
        (id, organization_id, workspace_id, client_id, invoice_date, currency, status)
        SELECT gen_random_uuid(), ${ids.orgA}, ${quotaMatterId}::uuid,
          ${clientId}::uuid, '2026-10-16'::date, 'CZK', 'draft'
        FROM generate_series(1, ${LIMITS.invoicesPerWorkspace})`);
    expect(await quota()).toBe(LIMITS.invoicesPerWorkspace);
    const state = async () =>
      await Promise.all([
        db.select().from(invoices).where(eq(invoices.id, invoiceId)),
        db
          .select()
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, invoiceId)),
        db.select().from(timeEntries).where(eq(timeEntries.id, quotaEntryId)),
        db
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(eq(invoices.clientId, clientId), eq(invoices.status, "draft")),
          ),
      ]);
    const before = await state();
    const params = { invoiceId, workspaceId: quotaMatterId };

    expect(
      await createLine.handler(
        throughQuotaMatter(createLine.handler, manualLine, params),
      ),
    ).toMatchObject(limitRefusal);
    // Entries reach a client invoice as time-entry lines; entries.add
    // addresses only single-matter invoices.
    expect(
      await createLine.handler(
        throughQuotaMatter(
          createLine.handler,
          {
            source: { type: "time_entry", timeEntryId: quotaEntryId },
            vatRateBps: 2300,
            vatTreatment: "domestic_vat",
          },
          params,
        ),
      ),
    ).toMatchObject(limitRefusal);
    expect(
      await createClientInvoice.handler(
        context(
          createClientInvoice.handler,
          {
            invoiceDate: "2026-10-15",
            currency: "CZK",
            sellerProfileId: sellerId,
            matters: [
              {
                workspaceId: quotaMatterId,
                timeEntryIds: [quotaEntryId],
                expenseIds: [],
              },
            ],
          },
          { clientId },
        ),
      ),
    ).toMatchObject(limitRefusal);
    expect(await state()).toEqual(before);
    expect(await quota()).toBe(LIMITS.invoicesPerWorkspace);

    // One slot below the limit, the matter joins and fills it.
    await db.execute(sql`DELETE FROM invoices WHERE id = (
        SELECT id FROM invoices WHERE workspace_id = ${quotaMatterId}::uuid LIMIT 1)`);
    expect(await quota()).toBe(LIMITS.invoicesPerWorkspace - 1);
    expect(
      await createLine.handler(
        throughQuotaMatter(createLine.handler, manualLine, params),
      ),
    ).toHaveProperty("id");
    expect(
      (
        await db
          .select({ workspaceId: invoiceLines.workspaceId })
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, invoiceId))
      ).filter(({ workspaceId }) => workspaceId === quotaMatterId),
    ).toHaveLength(1);
    expect(await quota()).toBe(LIMITS.invoicesPerWorkspace);
  }, 120_000);
});
