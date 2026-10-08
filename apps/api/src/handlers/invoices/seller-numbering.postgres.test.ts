import { panic } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  INVOICE_STATUS,
  invoices,
  numberSeries,
  numberSeriesAllocations,
  numberSeriesCounters,
  sellerProfiles,
  workspaceMembers,
  workspaces,
  featureEnrolments,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import transitionInvoice from "@/api/handlers/invoices/transition";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

setDefaultTimeout(120_000);
const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("seller invoice numbering (postgres)", () => {
    test("requires Postgres test gate and database URL", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("seller invoice numbering (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const orgIds: SafeId<"organization">[] = [];
    const userIds: SafeId<"user">[] = [];
    const seedScenario = async () => {
      const orgId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const wsId = createSafeId<"workspace">();
      const sellerA = createSafeId<"sellerProfile">();
      const sellerB = createSafeId<"sellerProfile">();
      const sellerC = createSafeId<"sellerProfile">();
      const aSeries = createSafeId<"numberSeries">();
      const bSeries = createSafeId<"numberSeries">();
      const allSeries = createSafeId<"numberSeries">();
      const archivedSeries = createSafeId<"numberSeries">();

      orgIds.push(orgId);
      userIds.push(userId);
      await db.insert(user).values({
        id: userId,
        name: "Invoice numbering",
        email: `${userId}@example.test`,
        emailVerified: true,
      });
      await db.insert(organization).values({
        id: orgId,
        name: "Invoice numbering",
        slug: orgId,
        createdAt: new Date(),
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId: orgId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
      await db.insert(featureEnrolments).values({
        organizationId: orgId,
        userId,
        featureId: "time-billing",
      });
      await db.insert(workspaces).values({
        id: wsId,
        organizationId: orgId,
        name: "Numbering",
        reference: "NUM",
      });
      await db.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId: wsId,
        userId,
      });
      await db.insert(sellerProfiles).values(
        [sellerA, sellerB, sellerC].map((id) => ({
          id,
          organizationId: orgId,
          legalName: id,
          defaultCurrency: "EUR",
        })),
      );
      await db.insert(numberSeries).values(
        [
          {
            id: aSeries,
            sellerProfileId: sellerA,
            documentType: "invoice" as const,
            pattern: "A-{SEQ}",
            isDefault: true,
            archivedAt: null,
          },
          {
            id: bSeries,
            sellerProfileId: sellerB,
            documentType: "invoice" as const,
            pattern: "B-{SEQ}",
            isDefault: true,
            archivedAt: null,
          },
          {
            id: allSeries,
            sellerProfileId: null,
            documentType: "advance" as const,
            pattern: "ALL-{SEQ}",
            isDefault: true,
            archivedAt: null,
          },
          {
            id: archivedSeries,
            sellerProfileId: sellerA,
            documentType: "advance" as const,
            pattern: "OLD-{SEQ}",
            isDefault: false,
            archivedAt: new Date(),
          },
        ].map(
          ({
            id,
            sellerProfileId,
            documentType,
            pattern,
            isDefault,
            archivedAt,
          }) => ({
            id,
            sellerProfileId,
            documentType,
            pattern,
            isDefault,
            archivedAt,
            organizationId: orgId,
            name: id,
            padding: 3,
          }),
        ),
      );
      return {
        orgId,
        userId,
        wsId,
        sellerA,
        sellerB,
        sellerC,
        aSeries,
        bSeries,
        allSeries,
        archivedSeries,
      };
    };
    cleanUp(async () => {
      if (orgIds.length > 0) {
        await db.delete(organization).where(inArray(organization.id, orgIds));
      }
      if (userIds.length > 0) {
        await db.delete(user).where(inArray(user.id, userIds));
      }
    });

    type Scenario = Awaited<ReturnType<typeof seedScenario>>;
    type SeedInvoiceOptions = {
      sellerProfileId: SafeId<"sellerProfile">;
      documentType?: "invoice" | "advance";
    };
    const seedInvoice = async (
      scenario: Scenario,
      { sellerProfileId, documentType = "invoice" }: SeedInvoiceOptions,
    ) => {
      const { orgId, wsId } = scenario;
      const id = createSafeId<"invoice">();
      await db.insert(invoices).values({
        id,
        organizationId: orgId,
        workspaceId: wsId,
        sellerProfileId,
        documentType,
        invoiceNumber: null,
        invoiceDate: "2026-10-02",
        currency: "EUR",
      });
      return id;
    };

    type FinalizeOptions = {
      db: GatedTestDb;
      scenario: Scenario;
      invoiceId: SafeId<"invoice">;
      events?: AuditEvent[];
    };
    const finalize = async ({
      db: connection,
      scenario: { wsId, orgId, userId },
      invoiceId,
      events = [],
    }: FinalizeOptions) =>
      await transitionInvoice.handler(
        asTestRaw<Parameters<typeof transitionInvoice.handler>[0]>({
          params: { workspaceId: wsId, invoiceId },
          workspaceId: wsId,
          body: { action: "finalize" },
          safeDb: createSafeDb(
            markRlsDatabase(connection),
            [wsId],
            orgId,
            userId,
          ),
          user: { id: userId, email: `${userId}@example.test` },
          memberRole: sessionMemberRole("owner"),
          session: { activeOrganizationId: orgId },
          request: new Request(
            `https://example.test/v1/workspaces/${wsId}/invoices/${invoiceId}/transition`,
            { method: "POST" },
          ),
          route: "/v1/workspaces/:workspaceId/invoices/:invoiceId/transition",
          recordAuditEvent: async (
            _tx: unknown,
            recorded: AuditEvent | AuditEvent[],
          ) => {
            if (Array.isArray(recorded)) {
              events.push(...recorded);
            } else {
              events.push(recorded);
            }
          },
        }),
      );

    test("concurrent finalization uses each seller's own series without reusing numbers", async () => {
      const scenario = await seedScenario();
      const { sellerA, sellerB, aSeries, bSeries, orgId } = scenario;
      const sellers = [sellerA, sellerB, sellerA, sellerB, sellerA, sellerB];
      const invoiceIds = await Promise.all(
        sellers.map(
          async (sellerProfileId) =>
            await seedInvoice(scenario, { sellerProfileId }),
        ),
      );
      const events: AuditEvent[] = [];
      const outcomes = await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) =>
          await Promise.all(
            invoiceIds.map(
              async (invoiceId) =>
                await finalize({
                  scenario,
                  db: openClient().db,
                  invoiceId,
                  events,
                }),
            ),
          ),
      );
      expect(outcomes).toEqual(invoiceIds.map((id) => ({ id })));
      const rows = await db
        .select({
          id: invoices.id,
          status: invoices.status,
          invoiceNumber: invoices.invoiceNumber,
          sellerProfileId: invoices.sellerProfileId,
        })
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds));
      expect(rows).toHaveLength(invoiceIds.length);
      const numbers = rows.map(
        (row) => row.invoiceNumber ?? panic("Expected an assigned number"),
      );
      expect(new Set(numbers).size).toBe(invoiceIds.length);
      for (const [sellerId, prefix] of [
        [sellerA, "A"],
        [sellerB, "B"],
      ] as const) {
        const sellerNumbers = rows
          .filter((row) => row.sellerProfileId === sellerId)
          .map((row) => row.invoiceNumber);
        expect(sellerNumbers).toHaveLength(3);
        expect(new Set(sellerNumbers)).toEqual(
          new Set([`${prefix}-001`, `${prefix}-002`, `${prefix}-003`]),
        );
      }
      expect(rows.every((row) => row.status === INVOICE_STATUS.FINALIZED)).toBe(
        true,
      );
      const counters = await db
        .select({
          seriesId: numberSeriesCounters.seriesId,
          lastValue: numberSeriesCounters.lastValue,
        })
        .from(numberSeriesCounters)
        .where(inArray(numberSeriesCounters.seriesId, [aSeries, bSeries]));
      expect(counters).toHaveLength(2);
      expect(counters).toEqual(
        expect.arrayContaining([
          { seriesId: aSeries, lastValue: 3 },
          { seriesId: bSeries, lastValue: 3 },
        ]),
      );
      const receipts = await db
        .select({ number: numberSeriesAllocations.number })
        .from(numberSeriesAllocations)
        .where(eq(numberSeriesAllocations.organizationId, orgId));
      expect(receipts.map((row) => row.number).toSorted()).toEqual(
        numbers.toSorted(),
      );
      const finalizeEvents = events.flatMap((event) => {
        if (event.resourceType !== AUDIT_RESOURCE_TYPE.INVOICE) {
          return [];
        }
        if (event.changes?.["action"]?.new !== "finalize") {
          return [];
        }
        const invoiceNumber = event.changes["invoiceNumber"]?.new;
        if (typeof invoiceNumber !== "string") {
          panic(
            "Expected an invoice number string in the finalize audit event",
          );
        }
        return [
          {
            invoiceId: event.resourceId,
            invoiceNumber,
          },
        ];
      });
      expect(
        finalizeEvents.map(({ invoiceId }) => invoiceId).toSorted(),
      ).toEqual(invoiceIds.toSorted());
      expect(
        finalizeEvents.map(({ invoiceNumber }) => invoiceNumber).toSorted(),
      ).toEqual(numbers.toSorted());
    });

    test("competing finalizations of one invoice allocate only once", async () => {
      const scenario = await seedScenario();
      const { sellerB, allSeries } = scenario;
      const invoiceId = await seedInvoice(scenario, {
        sellerProfileId: sellerB,
        documentType: "advance",
      });
      const outcomes = await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) =>
          await Promise.all(
            [openClient().db, openClient().db].map(
              async (connection) =>
                await finalize({ scenario, db: connection, invoiceId }),
            ),
          ),
      );
      expect(outcomes.filter((outcome) => "id" in outcome)).toEqual([
        { id: invoiceId },
      ]);
      expect(outcomes.filter((outcome) => "code" in outcome)).toEqual([
        {
          code: 409,
          response: {
            message: "Cannot finalize invoice from its current status",
          },
        },
      ]);
      const row = await db.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { invoiceNumber: true, status: true },
      });
      expect(row).toEqual({
        invoiceNumber: "ALL-001",
        status: INVOICE_STATUS.FINALIZED,
      });
      expect(
        await db.query.numberSeriesCounters.findFirst({
          where: { seriesId: { eq: allSeries } },
          columns: { lastValue: true },
        }),
      ).toEqual({ lastValue: 1 });
    });

    test("an archived seller series is ignored during finalization in favor of the all-sellers default", async () => {
      const scenario = await seedScenario();
      const { sellerA, archivedSeries } = scenario;
      const invoiceId = await seedInvoice(scenario, {
        sellerProfileId: sellerA,
        documentType: "advance",
      });
      expect(await finalize({ scenario, db, invoiceId })).toEqual({
        id: invoiceId,
      });
      const row = await db.query.invoices.findFirst({
        where: { id: { eq: invoiceId } },
        columns: { invoiceNumber: true },
      });
      expect(row).toEqual({ invoiceNumber: "ALL-001" });
      expect(
        await db.query.numberSeriesCounters.findFirst({
          where: { seriesId: { eq: archivedSeries } },
        }),
      ).toBeUndefined();
    });

    test("another seller's default cannot finalize an invoice without its own or all-sellers default", async () => {
      const scenario = await seedScenario();
      const { sellerC } = scenario;
      const invoiceId = await seedInvoice(scenario, {
        sellerProfileId: sellerC,
      });
      expect(await finalize({ scenario, db, invoiceId })).toEqual({
        code: 409,
        response: {
          message: "No default number series configured for this document type",
          hint: "Create a number series for this documentType and this seller or all sellers, set it as default, then finalize again.",
        },
      });
      expect(
        await db.query.invoices.findFirst({
          where: { id: { eq: invoiceId } },
          columns: { invoiceNumber: true, finalizedAt: true, status: true },
        }),
      ).toEqual({
        invoiceNumber: null,
        finalizedAt: null,
        status: INVOICE_STATUS.DRAFT,
      });
    });
  });
}
