import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

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
import deleteLine from "@/api/handlers/invoices/lines/delete";
import transitionInvoice from "@/api/handlers/invoices/transition";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { SafeHandlerLogContext } from "@/api/lib/api-handlers";
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
    matterIds.map((id) => ({
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

afterAll(async () => {
  try {
    await db.delete(invoices).where(eq(invoices.clientId, clientId));
    await db
      .delete(timeEntries)
      .where(
        inArray(timeEntries.id, [
          ...entryIds,
          ...runningCaseSources.flatMap(({ sources }) =>
            sources.map(({ entryId }) => entryId),
          ),
        ]),
      );
    await db.delete(workspaces).where(inArray(workspaces.id, matterIds));
    await db.delete(contacts).where(eq(contacts.id, clientId));
    await db.delete(sellerProfiles).where(eq(sellerProfiles.id, sellerId));
    await db.delete(vatRates).where(inArray(vatRates.id, vatIds));
  } finally {
    await releaseRlsFixture();
  }
});

const context = <TContext extends SafeHandlerLogContext>(
  _handler: (context: TContext) => unknown,
  body: unknown,
  params: Record<string, unknown>,
): TContext =>
  asTestRaw<TContext>({
    body,
    params,
    workspaceId: matterIds.at(0),
    safeDb: createSafeDb(db, matterIds, ids.orgA, ids.userAdmin),
    scopedDb: createScopedDb(db, matterIds, ids.orgA, ids.userAdmin),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userAdmin },
    memberRole: sessionMemberRole("owner"),
    getActiveWorkspaceIds: async () => matterIds,
    getAccessibleWorkspaces: async () =>
      matterIds.map((id) => ({ id, status: "active" })),
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
