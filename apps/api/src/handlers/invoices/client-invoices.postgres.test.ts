import { Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { cents } from "@stll/money";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  contacts,
  featureEnrolments,
  invoiceLines,
  invoices,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const expectSqlState = async (
  operation: PromiseLike<unknown>,
  sqlState: string,
) => {
  const result = await Result.tryPromise(async () => await operation);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(getPgErrorCode(result.error)).toBe(sqlState);
  }
};

setDefaultTimeout(120_000);
const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("client invoice constraints and visibility (postgres)", () => {
    test("requires Postgres test gate and database URL", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("client invoice constraints and visibility (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const orgIds: SafeId<"organization">[] = [];
    const userIds: SafeId<"user">[] = [];

    cleanUp(async () => {
      if (orgIds.length > 0) {
        await db
          .delete(invoices)
          .where(inArray(invoices.organizationId, orgIds));
        await db
          .delete(workspaces)
          .where(inArray(workspaces.organizationId, orgIds));
        await db.delete(organization).where(inArray(organization.id, orgIds));
      }
      if (userIds.length > 0) {
        await db.delete(user).where(inArray(user.id, userIds));
      }
    });

    type LineOptions = {
      organizationId: SafeId<"organization">;
      workspaceId: SafeId<"workspace">;
      invoiceId: SafeId<"invoice">;
      position?: number;
    };
    const insertLine = async ({
      organizationId,
      workspaceId,
      invoiceId,
      position = 0,
    }: LineOptions) => {
      const id = createSafeId<"invoiceLine">();
      await db.insert(invoiceLines).values({
        id,
        organizationId,
        workspaceId,
        invoiceId,
        position,
        description: "Legal services",
        quantity: "1.0000",
        unit: "h",
        unitPrice: cents(100),
        vatRateBps: 2100,
        vatTreatment: "domestic_vat",
        netAmount: cents(100),
        vatAmount: cents(21),
        grossAmount: cents(121),
        source: "manual",
      });
      return id;
    };

    const seedScenario = async () => {
      const orgId = mintAuthProviderId<"organization">();
      const clientId = createSafeId<"contact">();
      const otherClientId = createSafeId<"contact">();
      const firstMatterId = createSafeId<"workspace">();
      const secondMatterId = createSafeId<"workspace">();
      const otherClientMatterId = createSafeId<"workspace">();
      const invoiceId = createSafeId<"invoice">();
      const actors = {
        partial: mintAuthProviderId<"user">(),
        full: mintAuthProviderId<"user">(),
        owner: mintAuthProviderId<"user">(),
        admin: mintAuthProviderId<"user">(),
      };
      orgIds.push(orgId);
      userIds.push(...Object.values(actors));
      await db.insert(user).values(
        Object.values(actors).map((id) => ({
          id,
          name: "Invoice visibility",
          email: `${id}@example.test`,
          emailVerified: true,
        })),
      );
      await db.insert(organization).values({
        id: orgId,
        name: "Invoice visibility",
        slug: orgId,
        createdAt: new Date(),
      });
      await db.insert(member).values(
        Object.entries(actors).map(([kind, userId]) => ({
          id: mintAuthProviderIdValue(),
          organizationId: orgId,
          userId,
          role: kind === "owner" || kind === "admin" ? kind : "member",
          createdAt: new Date(),
        })),
      );
      await db.insert(featureEnrolments).values(
        Object.values(actors).map((userId) => ({
          organizationId: orgId,
          userId,
          featureId: "time-billing" as const,
        })),
      );
      await db.insert(contacts).values(
        [clientId, otherClientId].map((id) => ({
          id,
          organizationId: orgId,
          type: "organization" as const,
          displayName: "Invoice client",
        })),
      );
      await db.insert(workspaces).values(
        [
          { id: firstMatterId, clientId },
          { id: secondMatterId, clientId },
          { id: otherClientMatterId, clientId: otherClientId },
        ].map(({ id, clientId: matterClientId }) => ({
          id,
          clientId: matterClientId,
          organizationId: orgId,
          name: "Invoice matter",
          reference: id,
        })),
      );
      await db.insert(workspaceMembers).values(
        [
          { workspaceId: firstMatterId, userId: actors.partial },
          { workspaceId: firstMatterId, userId: actors.full },
          { workspaceId: secondMatterId, userId: actors.full },
        ].map((value) => ({ id: createSafeId<"workspaceMember">(), ...value })),
      );
      await db.insert(invoices).values({
        id: invoiceId,
        organizationId: orgId,
        clientId,
        workspaceId: null,
        invoiceDate: "2026-10-15",
        currency: "EUR",
      });
      const firstLineId = await insertLine({
        organizationId: orgId,
        workspaceId: firstMatterId,
        invoiceId,
      });
      const secondLineId = await insertLine({
        organizationId: orgId,
        workspaceId: secondMatterId,
        invoiceId,
        position: 1,
      });
      return {
        orgId,
        clientId,
        otherClientId,
        firstMatterId,
        secondMatterId,
        otherClientMatterId,
        invoiceId,
        firstLineId,
        secondLineId,
        actors,
      };
    };
    type Scenario = Awaited<ReturnType<typeof seedScenario>>;
    const scoped = ({ orgId }: Scenario, userId: SafeId<"user">) =>
      createMembershipScopedDb(markRlsDatabase(db), {
        organizationId: orgId,
        userId,
        serverValidatedWorkspaceIds: [],
      });

    test("an invoice and every line require access to every included matter, with owner and admin overrides", async () => {
      const scenario = await seedScenario();
      const {
        invoiceId,
        firstMatterId,
        secondMatterId,
        firstLineId,
        secondLineId,
        actors,
      } = scenario;
      for (const [kind, actor] of Object.entries(actors)) {
        const result = await scoped(
          scenario,
          actor,
        )(async (tx) => ({
          matters: await tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(inArray(workspaces.id, [firstMatterId, secondMatterId])),
          invoices: await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(eq(invoices.id, invoiceId)),
          lines: await tx
            .select({ id: invoiceLines.id })
            .from(invoiceLines)
            .where(eq(invoiceLines.invoiceId, invoiceId)),
          updated: await tx
            .update(invoices)
            .set({ notes: "Draft edit" })
            .where(eq(invoices.id, invoiceId))
            .returning({ id: invoices.id }),
          updatedLines: await tx
            .update(invoiceLines)
            .set({ description: "Draft edit" })
            .where(eq(invoiceLines.invoiceId, invoiceId))
            .returning({ id: invoiceLines.id }),
        }));
        expect(result.matters.map(({ id }) => id).toSorted()).toEqual(
          (kind === "partial"
            ? [firstMatterId]
            : [firstMatterId, secondMatterId]
          ).toSorted(),
        );
        expect(result.invoices).toEqual(
          kind === "partial" ? [] : [{ id: invoiceId }],
        );
        expect(result.lines.map(({ id }) => id).toSorted()).toEqual(
          kind === "partial" ? [] : [firstLineId, secondLineId].toSorted(),
        );
        expect(result.updated).toEqual(
          kind === "partial" ? [] : [{ id: invoiceId }],
        );
        expect(result.updatedLines.map(({ id }) => id).toSorted()).toEqual(
          kind === "partial" ? [] : [firstLineId, secondLineId].toSorted(),
        );
      }
    });

    test("revoking one matter hides the whole invoice and all lines immediately", async () => {
      const scenario = await seedScenario();
      const scope = scoped(scenario, scenario.actors.full);
      expect(
        await scope(
          async (tx) =>
            await tx
              .select({ id: invoices.id })
              .from(invoices)
              .where(eq(invoices.id, scenario.invoiceId)),
        ),
      ).toEqual([{ id: scenario.invoiceId }]);
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.userId, scenario.actors.full));
      await db.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId: scenario.firstMatterId,
        userId: scenario.actors.full,
      });
      expect(
        await scope(async (tx) => ({
          invoices: await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(eq(invoices.id, scenario.invoiceId)),
          lines: await tx
            .select({ id: invoiceLines.id })
            .from(invoiceLines)
            .where(eq(invoiceLines.invoiceId, scenario.invoiceId)),
        })),
      ).toEqual({ invoices: [], lines: [] });
    });

    test("line constraints reject a different client and cross-tenant invoice or matter even on a root write", async () => {
      const scenario = await seedScenario();
      const foreign = await seedScenario();
      for (const options of [
        {
          organizationId: scenario.orgId,
          workspaceId: scenario.otherClientMatterId,
          invoiceId: scenario.invoiceId,
        },
        {
          organizationId: scenario.orgId,
          workspaceId: foreign.firstMatterId,
          invoiceId: scenario.invoiceId,
        },
        {
          organizationId: foreign.orgId,
          workspaceId: foreign.firstMatterId,
          invoiceId: scenario.invoiceId,
        },
      ]) {
        await expectSqlState(insertLine(options), "23514");
      }
      expect(
        await scoped(
          foreign,
          foreign.actors.owner,
        )(async (tx) => ({
          invoices: await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(eq(invoices.id, scenario.invoiceId)),
          lines: await tx
            .select({ id: invoiceLines.id })
            .from(invoiceLines)
            .where(eq(invoiceLines.invoiceId, scenario.invoiceId)),
        })),
      ).toEqual({ invoices: [], lines: [] });
    });

    test("an invoiced matter and its invoice cannot move to a different client", async () => {
      const scenario = await seedScenario();
      await expectSqlState(
        db
          .update(workspaces)
          .set({ clientId: scenario.otherClientId })
          .where(eq(workspaces.id, scenario.firstMatterId)),
        "23514",
      );
      await expectSqlState(
        db
          .update(workspaces)
          .set({ clientId: null })
          .where(eq(workspaces.id, scenario.firstMatterId)),
        "23514",
      );
      await expectSqlState(
        db
          .update(invoices)
          .set({ clientId: scenario.otherClientId })
          .where(eq(invoices.id, scenario.invoiceId)),
        "23514",
      );
      await expectSqlState(
        db
          .update(invoiceLines)
          .set({ workspaceId: scenario.otherClientMatterId })
          .where(eq(invoiceLines.id, scenario.firstLineId)),
        "23514",
      );
    });

    test("invoice scope and client tenant constraints reject unowned drafts", async () => {
      const scenario = await seedScenario();
      const foreign = await seedScenario();
      await expectSqlState(
        db.insert(invoices).values({
          id: createSafeId<"invoice">(),
          organizationId: scenario.orgId,
          invoiceDate: "2026-10-15",
          currency: "EUR",
        }),
        "23514",
      );
      await expectSqlState(
        db.insert(invoices).values({
          id: createSafeId<"invoice">(),
          organizationId: scenario.orgId,
          clientId: foreign.clientId,
          invoiceDate: "2026-10-15",
          currency: "EUR",
        }),
        "23503",
      );
    });

    test("a single-matter draft derives its client and rejects another matter of the same client", async () => {
      const scenario = await seedScenario();
      const invoiceId = createSafeId<"invoice">();
      await db.insert(invoices).values({
        id: invoiceId,
        organizationId: scenario.orgId,
        workspaceId: scenario.firstMatterId,
        invoiceDate: "2026-10-15",
        currency: "EUR",
      });
      expect(
        await db
          .select({ clientId: invoices.clientId })
          .from(invoices)
          .where(eq(invoices.id, invoiceId)),
      ).toEqual([{ clientId: scenario.clientId }]);
      await insertLine({
        organizationId: scenario.orgId,
        workspaceId: scenario.firstMatterId,
        invoiceId,
      });
      await expectSqlState(
        insertLine({
          organizationId: scenario.orgId,
          workspaceId: scenario.secondMatterId,
          invoiceId,
        }),
        "23514",
      );
      expect(
        await scoped(
          scenario,
          scenario.actors.partial,
        )(
          async (tx) =>
            await tx
              .select({ id: invoices.id })
              .from(invoices)
              .where(eq(invoices.id, invoiceId)),
        ),
      ).toEqual([{ id: invoiceId }]);
    });

    test("hidden shared invoices still reserve only the authorized matter's charges and quota", async () => {
      const scenario = await seedScenario();
      for (const [workspaceId, lineId, netAmount] of [
        [scenario.firstMatterId, scenario.firstLineId, cents(100)],
        [scenario.secondMatterId, scenario.secondLineId, cents(900)],
      ] as const) {
        const timeEntryId = createSafeId<"timeEntry">();
        await db.insert(timeEntries).values({
          id: timeEntryId,
          organizationId: scenario.orgId,
          workspaceId,
          userId: scenario.actors.full,
          dateWorked: "2026-10-15",
          timezoneId: "Europe/Prague",
          durationMinutes: 60,
          billedMinutes: 60,
          rateAtEntry: netAmount,
          currency: "EUR",
          narrative: "Legal services",
          invoiceId: scenario.invoiceId,
          invoiceAttachment: "charged",
        });
        await db
          .update(invoiceLines)
          .set({
            source: "time_entry",
            timeEntryId,
            netAmount,
            vatAmount: cents(0),
            grossAmount: netAmount,
            vatRateBps: 0,
          })
          .where(eq(invoiceLines.id, lineId));
      }
      const scope = scoped(scenario, scenario.actors.partial);
      const result = await scope(async (tx) => ({
        invoices: await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.id, scenario.invoiceId)),
        lines: await tx
          .select({ id: invoiceLines.id })
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, scenario.invoiceId)),
        charges: await tx
          .select({
            amount: sql<string>`amount::text`,
            mismatches: sql<string>`mismatches::text`,
          })
          .from(
            sql`public.stella_matter_reserved_charges(${scenario.firstMatterId}, 'EUR', NULL)`,
          ),
        quota: await tx
          .select({
            count: sql<string>`public.stella_matter_invoice_count(${scenario.firstMatterId})::text`,
          })
          .from(sql`(SELECT 1) quota`),
        excluded: await tx
          .select({ amount: sql<string>`amount::text` })
          .from(
            sql`public.stella_matter_reserved_charges(${scenario.firstMatterId}, 'EUR', ${scenario.invoiceId})`,
          ),
        mismatchedCurrency: await tx
          .select({
            amount: sql<string>`amount::text`,
            mismatches: sql<string>`mismatches::text`,
          })
          .from(
            sql`public.stella_matter_reserved_charges(${scenario.firstMatterId}, 'USD', NULL)`,
          ),
      }));
      expect(result).toEqual({
        invoices: [],
        lines: [],
        charges: [{ amount: "100", mismatches: "0" }],
        quota: [{ count: "1" }],
        excluded: [{ amount: "0" }],
        mismatchedCurrency: [{ amount: "0", mismatches: "1" }],
      });
      // Both functions authorize independently; knowing a matter ID is insufficient.
      for (const matterId of [
        scenario.secondMatterId,
        (await seedScenario()).firstMatterId,
      ]) {
        await expectSqlState(
          scope(
            async (tx) =>
              await tx
                .select({ amount: sql<string>`amount::text` })
                .from(
                  sql`public.stella_matter_reserved_charges(${matterId}, 'EUR', NULL)`,
                ),
          ),
          "42501",
        );
        await expectSqlState(
          scope(
            async (tx) =>
              await tx
                .select({
                  count: sql<string>`public.stella_matter_invoice_count(${matterId})::text`,
                })
                .from(sql`(SELECT 1) quota`),
          ),
          "42501",
        );
      }
    });
  });
}
