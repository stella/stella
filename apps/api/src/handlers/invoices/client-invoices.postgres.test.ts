import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { cents } from "@stll/money";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  contacts,
  featureEnrolments,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { resolveToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { buildMcpContextFromChat } from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import createInvoice from "@/api/handlers/invoices/create";
import createInvoiceLine from "@/api/handlers/invoices/lines/create";
import deleteInvoiceLine from "@/api/handlers/invoices/lines/delete";
import {
  insertInvoiceLines,
  lockDraftInvoiceForLines,
  manualLineDraft,
  recalculateInvoiceTotals,
} from "@/api/lib/billing/invoice-lines";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockInvoiceInStatus,
  withInvoiceMatterLocks,
} from "@/api/lib/db/aggregate-lock";
import type { AcquiredInvoiceMatterLocks } from "@/api/lib/db/aggregate-lock";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { BILLING_TOOL_HANDLERS } from "@/api/mcp/billing-tools";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";
import { clientInvoicePrefillScalingScenario } from "@/api/tests/read-scaling/client-invoice-prefill";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

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

    const scoped = (
      { orgId }: { orgId: SafeId<"organization"> },
      userId: SafeId<"user">,
    ) =>
      createMembershipScopedDb(markRlsDatabase(db), {
        organizationId: orgId,
        userId,
        serverValidatedWorkspaceIds: [],
      });

    type LineOptions = {
      organizationId: SafeId<"organization">;
      workspaceId: SafeId<"workspace">;
      invoiceId: SafeId<"invoice">;
      position?: number;
    };
    const lineValues = ({
      organizationId,
      workspaceId,
      invoiceId,
      position = 0,
    }: LineOptions) => ({
      id: createSafeId<"invoiceLine">(),
      organizationId,
      workspaceId,
      invoiceId,
      position,
      description: "Legal services",
      quantity: "1.0000",
      unit: "h",
      unitPrice: cents(100),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat" as const,
      netAmount: cents(100),
      vatAmount: cents(21),
      grossAmount: cents(121),
      source: "manual" as const,
    });
    // invoice_lines forces row security on its owner, so valid lines are
    // written by the organization owner through the application role.
    const insertLine = async ({
      ownerId,
      ...options
    }: LineOptions & { ownerId: SafeId<"user"> }) => {
      const values = lineValues(options);
      await scoped(
        { orgId: options.organizationId },
        ownerId,
      )(async (tx) => {
        await tx.insert(invoiceLines).values(values);
      });
      return values.id;
    };
    // The client guard runs before row security checks, so it rejects even a
    // root write before the policy is consulted.
    const insertRootLine = async (options: LineOptions) => {
      await db.insert(invoiceLines).values(lineValues(options));
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
        ownerId: actors.owner,
      });
      const secondLineId = await insertLine({
        organizationId: orgId,
        workspaceId: secondMatterId,
        invoiceId,
        position: 1,
        ownerId: actors.owner,
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
    type InvoiceEditScope = {
      tx: Transaction;
      scenario: Awaited<ReturnType<typeof seedScenario>>;
      invoiceId: SafeId<"invoice">;
      workspaceId: SafeId<"workspace">;
    };
    const acquireInvoiceEdit = async ({
      tx,
      scenario,
      invoiceId,
      workspaceId,
    }: InvoiceEditScope) => {
      const guarded = await guardRunningTimeEntries({
        tx,
        organizationId: scenario.orgId,
        workspaceId,
        actorUserId: scenario.actors.owner,
        selection: { type: "invoice", invoiceId, runningCheck: "additional" },
      });
      if (guarded.isErr()) {
        throw guarded.error;
      }
      return guarded.value;
    };
    const appendManualLine = async ({
      tx,
      scenario,
      invoiceId,
      workspaceId,
      matterLocks,
    }: InvoiceEditScope & { matterLocks: AcquiredInvoiceMatterLocks }) => {
      const scope = { invoiceId, organizationId: scenario.orgId, workspaceId };
      const recordAuditEvent = async () => {};
      const invoice = await lockDraftInvoiceForLines(
        tx,
        { ...scope, matterLocks },
        recordAuditEvent,
      );
      if (invoice.isErr()) {
        throw invoice.error;
      }
      if (invoice.value === undefined) {
        throw new HandlerError({
          status: 409,
          message: "Invoice matters changed; reload and try again",
        });
      }
      const draft = manualLineDraft({
        description: "Concurrent addition",
        quantity: "1",
        unit: null,
        unitPrice: cents(100),
        vatRateBps: 2100,
        vatTreatment: "domestic_vat",
      });
      if (draft.isErr()) {
        throw draft.error;
      }
      await insertInvoiceLines(tx, scope, [draft.value], { recordAuditEvent });
      const totals = await recalculateInvoiceTotals(
        tx,
        scope,
        new Date("2026-10-16T12:00:00Z"),
        recordAuditEvent,
      );
      if (totals.isErr()) {
        throw totals.error;
      }
    };

    test("client prefill keeps its selected matters and query cost as other client matters grow", async () => {
      const scenario = await seedScenario();
      const unrelatedMatters = Array.from({ length: 199 }, () => {
        const id = createSafeId<"workspace">();
        return {
          id,
          organizationId: scenario.orgId,
          clientId: scenario.otherClientId,
          name: "Unrelated client matter",
          reference: id,
        };
      });
      // The fixture already has one other-client matter: these populations
      // contain exactly 10 and 200, while the requested client keeps two.
      await db.insert(workspaces).values(unrelatedMatters.slice(0, 9));
      const userId = scenario.actors.owner;
      const context = createTestHandlerContext<
        Parameters<typeof clientInvoicePrefillScalingScenario.handler>[0]
      >({
        safeDb: createMembershipSafeDb(markRlsDatabase(db), {
          organizationId: scenario.orgId,
          userId,
          serverValidatedWorkspaceIds: [],
        }),
        scopedDb: NO_DB,
        audit: NO_AUDIT,
        session: { activeOrganizationId: scenario.orgId },
        user: { id: userId },
        params: { clientId: scenario.clientId },
        query: {},
        request: new Request(
          `https://example.test/v1/client-invoices/${scenario.clientId}/prefill`,
        ),
        route: "/v1/client-invoices/:clientId/prefill",
      });
      const at10 = await clientInvoicePrefillScalingScenario.measure(context);
      await db.insert(workspaces).values(unrelatedMatters.slice(9));
      const at200 = await clientInvoicePrefillScalingScenario.measure(context);
      const expectedMatters = [scenario.firstMatterId, scenario.secondMatterId];
      for (const measurement of [at10, at200]) {
        expect(measurement.rows).toBe(2);
        expect(measurement.matterIds).toEqual(
          expect.arrayContaining(expectedMatters),
        );
        expect(measurement.statements).toBeGreaterThan(0);
        expect(measurement.transactionRoundTrips).toBeGreaterThan(0);
      }
      expect(readScalingViolations({ small: at10, large: at200 })).toEqual([]);
    });

    test("organization deletion cascades through contacts, matters and client-linked invoices", async () => {
      const scenario = await seedScenario();
      // A contact cannot disappear while its invoice remains; an organization
      // deletion removes both in one statement, regardless of cascade order.
      await expectSqlState(
        db.delete(contacts).where(eq(contacts.id, scenario.clientId)),
        "23001",
      );
      const deleted = await db
        .delete(organization)
        .where(eq(organization.id, scenario.orgId))
        .returning({ id: organization.id });
      expect(deleted).toEqual([{ id: scenario.orgId }]);
      expect(
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(eq(contacts.organizationId, scenario.orgId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.organizationId, scenario.orgId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.organizationId, scenario.orgId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: invoiceLines.id })
          .from(invoiceLines)
          .where(eq(invoiceLines.organizationId, scenario.orgId)),
      ).toEqual([]);
    });

    test("opposite client-invoice additions acquire their complete matter union first", async () => {
      const scenario = await seedScenario();
      await scoped(
        scenario,
        scenario.actors.owner,
      )(
        async (tx) =>
          await tx
            .delete(invoiceLines)
            .where(eq(invoiceLines.id, scenario.secondLineId)),
      );
      const otherInvoiceId = createSafeId<"invoice">();
      await db.insert(invoices).values({
        id: otherInvoiceId,
        organizationId: scenario.orgId,
        clientId: scenario.clientId,
        workspaceId: null,
        invoiceDate: "2026-10-15",
        currency: "EUR",
      });
      await insertLine({
        organizationId: scenario.orgId,
        workspaceId: scenario.secondMatterId,
        invoiceId: otherInvoiceId,
        ownerId: scenario.actors.owner,
      });
      let aLocks: AcquiredInvoiceMatterLocks | undefined;
      let bLocks: AcquiredInvoiceMatterLocks | undefined;
      const owner = scoped(scenario, scenario.actors.owner);
      await withInterleaving({
        databaseUrl,
        a: {
          transaction: owner,
          steps: [
            {
              name: "guard",
              run: async (tx) => {
                aLocks = await acquireInvoiceEdit({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.secondMatterId,
                });
              },
            },
            {
              name: "append",
              run: async (tx) =>
                await appendManualLine({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.secondMatterId,
                  matterLocks:
                    aLocks ?? panic("Missing first invoice lock plan"),
                }),
            },
          ],
        },
        b: {
          transaction: owner,
          steps: [
            {
              name: "guard",
              run: async (tx) => {
                bLocks = await acquireInvoiceEdit({
                  tx,
                  scenario,
                  invoiceId: otherInvoiceId,
                  workspaceId: scenario.firstMatterId,
                });
              },
            },
            {
              name: "append",
              run: async (tx) =>
                await appendManualLine({
                  tx,
                  scenario,
                  invoiceId: otherInvoiceId,
                  workspaceId: scenario.firstMatterId,
                  matterLocks:
                    bLocks ?? panic("Missing second invoice lock plan"),
                }),
            },
          ],
        },
        schedules: [
          [
            "a.guard",
            "b.guard",
            "a.append",
            "a.commit",
            "b.append",
            "b.commit",
          ],
        ],
        reset: async () => {},
        readState: async () =>
          await owner(
            async (tx) =>
              await tx
                .select({
                  invoiceId: invoiceLines.invoiceId,
                  workspaceId: invoiceLines.workspaceId,
                })
                .from(invoiceLines)
                .where(
                  inArray(invoiceLines.invoiceId, [
                    scenario.invoiceId,
                    otherInvoiceId,
                  ]),
                ),
          ),
        invariant: ({ outcomes, blocked, state }) => {
          expect(blocked).toContain("b.guard");
          expect(outcomes.a.status).toBe("committed");
          expect(outcomes.b.status).toBe("committed");
          for (const invoiceId of [scenario.invoiceId, otherInvoiceId]) {
            expect(
              state
                .filter((line) => line.invoiceId === invoiceId)
                .map((line) => line.workspaceId)
                .toSorted(),
            ).toEqual(
              [scenario.firstMatterId, scenario.secondMatterId].toSorted(),
            );
          }
        },
      });
    });

    test("the running guard refuses expanded participation while its first matter acquisition waits", async () => {
      const scenario = await seedScenario();
      await scoped(
        scenario,
        scenario.actors.owner,
      )(
        async (tx) =>
          await tx
            .delete(invoiceLines)
            .where(eq(invoiceLines.id, scenario.secondLineId)),
      );
      const thirdMatterId = createSafeId<"workspace">();
      await db.insert(workspaces).values({
        id: thirdMatterId,
        organizationId: scenario.orgId,
        clientId: scenario.clientId,
        name: "Concurrent destination",
        reference: thirdMatterId,
      });
      let bLocks: AcquiredInvoiceMatterLocks | undefined;
      const owner = scoped(scenario, scenario.actors.owner);
      await withInterleaving({
        databaseUrl,
        a: {
          transaction: owner,
          steps: [
            {
              name: "guard",
              run: async (tx) => {
                await acquireInvoiceEdit({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: thirdMatterId,
                });
              },
            },
          ],
        },
        b: {
          transaction: owner,
          steps: [
            {
              name: "guard",
              run: async (tx) => {
                bLocks = await acquireInvoiceEdit({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.secondMatterId,
                });
              },
            },
            {
              name: "append",
              run: async (tx) =>
                await appendManualLine({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.secondMatterId,
                  matterLocks: bLocks ?? panic("Missing writer lock plan"),
                }),
            },
          ],
        },
        schedules: [["b.guard", "a.guard", "b.append", "b.commit", "a.commit"]],
        reset: async () => {},
        readState: async () =>
          await owner(
            async (tx) =>
              await tx
                .select({ workspaceId: invoiceLines.workspaceId })
                .from(invoiceLines)
                .where(eq(invoiceLines.invoiceId, scenario.invoiceId)),
          ),
        invariant: ({ outcomes, blocked, state }) => {
          expect(blocked).toContain("a.guard");
          expect(outcomes.a.status).toBe("app-error");
          if (outcomes.a.status === "app-error") {
            expect(resolveHandlerError(outcomes.a.error)).toMatchObject({
              status: 409,
              code: "invoice_participation_changed",
            });
          }
          expect(outcomes.b.status).toBe("committed");
          expect(state.map((line) => line.workspaceId).toSorted()).toEqual(
            [scenario.firstMatterId, scenario.secondMatterId].toSorted(),
          );
        },
      });
    });

    test("an empty invoice's acquired plan rejects later expansion before any added matter lock", async () => {
      const scenario = await seedScenario();
      await scoped(
        scenario,
        scenario.actors.owner,
      )(
        async (tx) =>
          await tx
            .delete(invoiceLines)
            .where(eq(invoiceLines.invoiceId, scenario.invoiceId)),
      );
      let aLocks: AcquiredInvoiceMatterLocks | undefined;
      const owner = scoped(scenario, scenario.actors.owner);
      await withInterleaving({
        databaseUrl,
        a: {
          transaction: owner,
          steps: [
            {
              name: "guard",
              run: async (tx) => {
                aLocks = await acquireInvoiceEdit({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.firstMatterId,
                });
              },
            },
            {
              name: "append",
              run: async (tx) =>
                await appendManualLine({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.firstMatterId,
                  matterLocks:
                    aLocks ?? panic("Missing empty-invoice lock plan"),
                }),
            },
          ],
        },
        b: {
          transaction: owner,
          steps: [
            {
              name: "append",
              run: async (tx) => {
                const matterLocks = await acquireInvoiceEdit({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.secondMatterId,
                });
                await appendManualLine({
                  tx,
                  scenario,
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.secondMatterId,
                  matterLocks,
                });
              },
            },
          ],
        },
        schedules: [
          ["a.guard", "b.append", "b.commit", "a.append", "a.commit"],
        ],
        reset: async () => {},
        readState: async () =>
          await owner(
            async (tx) =>
              await tx
                .select({ workspaceId: invoiceLines.workspaceId })
                .from(invoiceLines)
                .where(eq(invoiceLines.invoiceId, scenario.invoiceId)),
          ),
        invariant: ({ outcomes, blocked, state }) => {
          expect(outcomes.a.status).toBe("app-error");
          if (outcomes.a.status === "app-error") {
            expect(resolveHandlerError(outcomes.a.error)?.status).toBe(409);
          }
          expect(outcomes.b.status).toBe("committed");
          expect(blocked).not.toContain("a.append");
          expect(state).toEqual([{ workspaceId: scenario.secondMatterId }]);
        },
      });
    });

    test("a newly participating matter invalidates a lock set acquired from an older snapshot", async () => {
      const scenario = await seedScenario();
      const thirdMatterId = createSafeId<"workspace">();
      await db.insert(workspaces).values({
        id: thirdMatterId,
        organizationId: scenario.orgId,
        clientId: scenario.clientId,
        name: "New participating matter",
        reference: thirdMatterId,
      });
      const owner = scoped(scenario, scenario.actors.owner);
      await withInterleaving({
        databaseUrl,
        a: {
          transaction: owner,
          steps: [
            {
              name: "edit",
              run: async (tx) => {
                const invoice = await lockInvoiceInStatus(tx, {
                  invoiceId: scenario.invoiceId,
                  workspaceId: scenario.firstMatterId,
                  status: "draft",
                  matterLocks: { type: "acquire" },
                });
                if (invoice === undefined) {
                  throw new HandlerError({
                    status: 409,
                    message: "Invoice changed; reload and try again",
                  });
                }
                await tx
                  .update(invoices)
                  .set({ notes: "Edited from a stale matter snapshot" })
                  .where(eq(invoices.id, scenario.invoiceId));
              },
            },
          ],
        },
        b: {
          transaction: owner,
          steps: [
            {
              name: "lock",
              run: async (tx) => {
                await withInvoiceMatterLocks(tx, [
                  scenario.firstMatterId,
                  scenario.secondMatterId,
                  thirdMatterId,
                ]);
              },
            },
            {
              name: "attach",
              run: async (tx) => {
                await tx.insert(invoiceLines).values(
                  lineValues({
                    organizationId: scenario.orgId,
                    workspaceId: thirdMatterId,
                    invoiceId: scenario.invoiceId,
                    position: 2,
                  }),
                );
              },
            },
          ],
        },
        schedules: [["b.lock", "a.edit", "b.attach", "b.commit", "a.commit"]],
        reset: async () => {},
        readState: async () =>
          await owner(async (tx) => ({
            invoice: await tx.query.invoices.findFirst({
              where: { id: { eq: scenario.invoiceId } },
              columns: { notes: true },
            }),
            lines: await tx.query.invoiceLines.findMany({
              where: { invoiceId: { eq: scenario.invoiceId } },
              columns: { workspaceId: true },
            }),
          })),
        invariant: ({ outcomes, blocked, state }) => {
          expect(blocked).toContain("a.edit");
          expect(outcomes.a.status).toBe("app-error");
          if (outcomes.a.status === "app-error") {
            expect(resolveHandlerError(outcomes.a.error)?.status).toBe(409);
          }
          expect(outcomes.b.status).toBe("committed");
          expect(state.invoice?.notes).toBeNull();
          expect(
            state.lines.map(({ workspaceId }) => workspaceId).toSorted(),
          ).toEqual(
            [
              scenario.firstMatterId,
              scenario.secondMatterId,
              thirdMatterId,
            ].toSorted(),
          );
        },
      });
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

    test("members create client credit drafts only while authorized for their whole original", async () => {
      const scenario = await seedScenario();
      const foreign = await seedScenario();
      await db
        .update(invoices)
        .set({
          status: INVOICE_STATUS.FINALIZED,
          finalizedAt: new Date("2026-10-15T12:00:00Z"),
          invoiceNumber: "CLIENT-ORIGINAL",
          netAmount: cents(200),
          vatAmount: cents(42),
          totalAmount: cents(242),
        })
        .where(eq(invoices.id, scenario.invoiceId));
      const readQuota = async () =>
        await scoped(
          scenario,
          scenario.actors.full,
        )(
          async (tx) =>
            await tx
              .select({
                first: sql<string>`public.stella_matter_invoice_count(${scenario.firstMatterId})::text`,
                second: sql<string>`public.stella_matter_invoice_count(${scenario.secondMatterId})::text`,
              })
              .from(sql`(SELECT 1) quota`),
        );
      expect(await readQuota()).toEqual([{ first: "1", second: "1" }]);
      const memberRole = sessionMemberRole("member");
      expect(
        hasMemberPermission(memberRole, { invoice: ["create", "update"] }),
      ).toBe(true);
      const auditEvents: unknown[] = [];
      const contextFor = async (
        target: typeof scenario,
        actor: SafeId<"user">,
      ) => {
        const scopedDb = scoped(target, actor);
        const visible = await scopedDb(
          async (tx) =>
            await tx
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(
                inArray(workspaces.id, [
                  target.firstMatterId,
                  target.secondMatterId,
                ]),
              ),
        );
        return {
          safeDb: createMembershipSafeDb(markRlsDatabase(db), {
            organizationId: target.orgId,
            userId: actor,
            serverValidatedWorkspaceIds: [],
          }),
          scopedDb,
          audit: async (_tx: unknown, event: unknown) => {
            auditEvents.push(event);
          },
          memberRole,
          session: { activeOrganizationId: target.orgId },
          user: { id: actor },
          workspaceId: target.firstMatterId,
          getActiveWorkspaceIds: async () => visible.map(({ id }) => id),
          getAccessibleWorkspaces: async () =>
            visible.map(({ id }) => ({ id, status: "active" as const })),
          getWorkspaceAccess: async (id: SafeId<"workspace">) =>
            visible.some((matter) => matter.id === id)
              ? { id, status: "active" as const }
              : null,
          pinServerValidatedWorkspaceId: (id: SafeId<"workspace">) =>
            visible.some((matter) => matter.id === id),
        };
      };
      const body = {
        documentType: "credit_note",
        originalInvoiceId: scenario.invoiceId,
        invoiceDate: "2026-10-16",
        currency: "EUR",
        timeEntryIds: [],
      } satisfies Parameters<typeof createInvoice.handler>[0]["body"];
      const fullContext = await contextFor(scenario, scenario.actors.full);
      const created = await createInvoice.handler(
        createTestHandlerContext<Parameters<typeof createInvoice.handler>[0]>({
          ...fullContext,
          body,
        }),
      );
      if (!("id" in created)) {
        panic("Expected authorized client credit draft", { result: created });
      }
      expect(
        await scoped(
          scenario,
          scenario.actors.full,
        )(
          async (tx) =>
            await tx.query.invoices.findFirst({
              where: { id: { eq: created.id } },
              columns: {
                workspaceId: true,
                clientId: true,
                originalInvoiceId: true,
                documentType: true,
              },
            }),
        ),
      ).toEqual({
        workspaceId: null,
        clientId: scenario.clientId,
        originalInvoiceId: scenario.invoiceId,
        documentType: "credit_note",
      });
      const lines = await scoped(
        scenario,
        scenario.actors.full,
      )(
        async (tx) =>
          await tx.query.invoiceLines.findMany({
            where: { invoiceId: { eq: created.id } },
          }),
      );
      expect(lines).toEqual([]);
      expect(await readQuota()).toEqual([{ first: "2", second: "2" }]);
      expect(auditEvents.length).toBeGreaterThan(0);
      await db.execute(sql`INSERT INTO invoices
        (id, organization_id, workspace_id, client_id, invoice_date, currency, status)
        SELECT gen_random_uuid(), ${scenario.orgId}, ${scenario.secondMatterId}::uuid,
          ${scenario.clientId}::uuid, '2026-10-16'::date, 'EUR', 'draft'
        FROM generate_series(1, ${LIMITS.invoicesPerWorkspace - 2})`);
      expect(await readQuota()).toEqual([
        { first: "2", second: String(LIMITS.invoicesPerWorkspace) },
      ]);
      const creditsBeforeQuotaRefusal = await db.query.invoices.findMany({
        where: {
          organizationId: { eq: scenario.orgId },
          originalInvoiceId: { eq: scenario.invoiceId },
        },
        columns: { id: true },
        orderBy: { id: "asc" },
      });
      const auditCountBeforeQuotaRefusal = auditEvents.length;
      expect(
        await createInvoice.handler(
          createTestHandlerContext<Parameters<typeof createInvoice.handler>[0]>(
            { ...fullContext, body },
          ),
        ),
      ).toMatchObject({
        code: 400,
        response: {
          message: "Invoice limit reached for a participating matter",
        },
      });
      expect(
        await db.query.invoices.findMany({
          where: {
            organizationId: { eq: scenario.orgId },
            originalInvoiceId: { eq: scenario.invoiceId },
          },
          columns: { id: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(creditsBeforeQuotaRefusal);
      expect(auditEvents).toHaveLength(auditCountBeforeQuotaRefusal);
      expect(await readQuota()).toEqual([
        { first: "2", second: String(LIMITS.invoicesPerWorkspace) },
      ]);
      await db
        .delete(invoices)
        .where(
          and(
            eq(invoices.organizationId, scenario.orgId),
            eq(invoices.workspaceId, scenario.secondMatterId),
          ),
        );
      expect(await readQuota()).toEqual([{ first: "2", second: "2" }]);
      const beforeRefusals = await db.query.invoices.findMany({
        where: { organizationId: { eq: scenario.orgId } },
        columns: { id: true },
        orderBy: { id: "asc" },
      });
      expect(
        await scoped(
          scenario,
          scenario.actors.partial,
        )(async (tx) => ({
          quota: await tx
            .select({
              count: sql<string>`public.stella_matter_invoice_count(${scenario.firstMatterId})::text`,
            })
            .from(sql`(SELECT 1) quota`),
          invoices: await tx.query.invoices.findMany({
            where: { id: { in: [scenario.invoiceId, created.id] } },
            columns: { id: true },
          }),
        })),
      ).toEqual({ quota: [{ count: "2" }], invoices: [] });
      await expectSqlState(
        scoped(
          scenario,
          scenario.actors.partial,
        )(
          async (tx) =>
            await tx
              .select({
                count: sql<string>`public.stella_matter_invoice_count(${scenario.secondMatterId})::text`,
              })
              .from(sql`(SELECT 1) quota`),
        ),
        "42501",
      );
      const partialContext = await contextFor(
        scenario,
        scenario.actors.partial,
      );
      for (const context of [
        partialContext,
        await contextFor(foreign, foreign.actors.full),
      ]) {
        expect(
          await createInvoice.handler(
            createTestHandlerContext<
              Parameters<typeof createInvoice.handler>[0]
            >({ ...context, body }),
          ),
        ).toMatchObject({
          code: 422,
          response: { message: "Original invoice not found in this matter" },
        });
      }
      expect(
        await db.query.invoices.findMany({
          where: { organizationId: { eq: scenario.orgId } },
          columns: { id: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(beforeRefusals);
      await expectSqlState(
        scoped(
          scenario,
          scenario.actors.partial,
        )(
          async (tx) =>
            await tx.insert(invoices).values({
              organizationId: scenario.orgId,
              workspaceId: null,
              clientId: scenario.clientId,
              documentType: "credit_note",
              originalInvoiceId: scenario.invoiceId,
              invoiceDate: "2026-10-16",
              currency: "EUR",
            }),
        ),
        "42501",
      );
      await expectSqlState(
        scoped(
          scenario,
          scenario.actors.full,
        )(
          async (tx) =>
            await tx.insert(invoices).values({
              organizationId: scenario.orgId,
              workspaceId: null,
              clientId: scenario.clientId,
              invoiceDate: "2026-10-16",
              currency: "EUR",
            }),
        ),
        "42501",
      );
      const line = await createInvoiceLine.handler(
        createTestHandlerContext<
          Parameters<typeof createInvoiceLine.handler>[0]
        >({
          ...fullContext,
          params: {
            workspaceId: scenario.firstMatterId,
            invoiceId: created.id,
          },
          body: {
            source: {
              type: "manual",
              description: "Correction",
              quantity: "1",
              unitPriceMinor: 100,
            },
            vatRateBps: 2100,
            vatTreatment: "domestic_vat",
          },
        }),
      );
      expect(line).toHaveProperty("id");
      expect(await readQuota()).toEqual([{ first: "2", second: "2" }]);
      await db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, scenario.actors.full),
            eq(workspaceMembers.workspaceId, scenario.secondMatterId),
          ),
        );
      expect(
        await scoped(
          scenario,
          scenario.actors.full,
        )(async (tx) => ({
          invoices: await tx.query.invoices.findMany({
            where: { id: { eq: created.id } },
            columns: { id: true },
          }),
          lines: await tx.query.invoiceLines.findMany({
            where: { invoiceId: { eq: created.id } },
            columns: { id: true },
          }),
        })),
      ).toEqual({ invoices: [], lines: [] });
    });

    test("a client invoice with no lines left is visible and writable only to owners and admins", async () => {
      const scenario = await seedScenario();
      const deleted = await scoped(
        scenario,
        scenario.actors.owner,
      )(
        async (tx) =>
          await tx
            .delete(invoiceLines)
            .where(eq(invoiceLines.invoiceId, scenario.invoiceId))
            .returning({ id: invoiceLines.id }),
      );
      expect(deleted.map(({ id }) => id).toSorted()).toEqual(
        [scenario.firstLineId, scenario.secondLineId].toSorted(),
      );
      for (const [kind, actor] of Object.entries(scenario.actors)) {
        const result = await scoped(
          scenario,
          actor,
        )(async (tx) => ({
          invoices: await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(eq(invoices.id, scenario.invoiceId)),
          updated: await tx
            .update(invoices)
            .set({ notes: "Draft edit" })
            .where(eq(invoices.id, scenario.invoiceId))
            .returning({ id: invoices.id }),
        }));
        const expected =
          kind === "owner" || kind === "admin"
            ? [{ id: scenario.invoiceId }]
            : [];
        expect(result).toEqual({ invoices: expected, updated: expected });
      }
    });

    test("a single-matter invoice is addressable only through its own matter", async () => {
      const scenario = await seedScenario();
      const invoiceId = createSafeId<"invoice">();
      await db.insert(invoices).values({
        id: invoiceId,
        organizationId: scenario.orgId,
        workspaceId: scenario.firstMatterId,
        invoiceDate: "2026-10-15",
        currency: "EUR",
      });
      const addressedThrough = async (workspaceId: SafeId<"workspace">) =>
        await db
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.id, invoiceId),
              invoiceInMatter(invoices, workspaceId),
            ),
          );
      expect(await addressedThrough(scenario.firstMatterId)).toEqual([
        { id: invoiceId },
      ]);
      expect(await addressedThrough(scenario.secondMatterId)).toEqual([]);
      expect(
        await db
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.id, scenario.invoiceId),
              invoiceInMatter(invoices, scenario.secondMatterId),
            ),
          ),
      ).toEqual([{ id: scenario.invoiceId }]);
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
        await expectSqlState(insertRootLine(options), "23514");
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

    test.each(["derived", "explicit"] as const)(
      "invoice creation serializes with matter client changes (%s client)",
      async (clientSource) => {
        for (const first of ["invoice", "matter"] as const) {
          const scenario = await seedScenario();
          const invoiceId = createSafeId<"invoice">();
          await withInterleaving({
            databaseUrl,
            a: {
              steps: [
                {
                  name: "insert",
                  run: async (tx) => {
                    await tx.insert(invoices).values({
                      id: invoiceId,
                      organizationId: scenario.orgId,
                      workspaceId: scenario.otherClientMatterId,
                      ...(clientSource === "explicit"
                        ? { clientId: scenario.otherClientId }
                        : {}),
                      invoiceDate: "2026-10-15",
                      currency: "EUR",
                    });
                  },
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "reassign",
                  run: async (tx) => {
                    await tx
                      .update(workspaces)
                      .set({ clientId: scenario.clientId })
                      .where(eq(workspaces.id, scenario.otherClientMatterId));
                  },
                },
              ],
            },
            schedules: [
              first === "invoice"
                ? ["a.insert", "b.reassign", "a.commit", "b.commit"]
                : ["b.reassign", "a.insert", "b.commit", "a.commit"],
            ],
            reset: async () => {},
            readState: async () => ({
              matter: await db.query.workspaces.findFirst({
                where: { id: { eq: scenario.otherClientMatterId } },
                columns: { clientId: true },
              }),
              invoice: await db.query.invoices.findFirst({
                where: { id: { eq: invoiceId } },
                columns: { clientId: true },
              }),
            }),
            invariant: ({ outcomes, blocked, state }) => {
              if (first === "invoice") {
                expect(blocked).toContain("b.reassign");
                expect(outcomes.a.status).toBe("committed");
                expect(outcomes.b.status).toBe("app-error");
                if (outcomes.b.status === "app-error") {
                  expect(getPgErrorCode(outcomes.b.error)).toBe("23514");
                }
                expect(state.matter).toEqual({
                  clientId: scenario.otherClientId,
                });
                expect(state.invoice).toEqual({
                  clientId: scenario.otherClientId,
                });
                return;
              }
              expect(blocked).toContain("a.insert");
              expect(outcomes.b.status).toBe("committed");
              expect(state.matter).toEqual({ clientId: scenario.clientId });
              if (clientSource === "explicit") {
                expect(outcomes.a.status).toBe("app-error");
                if (outcomes.a.status === "app-error") {
                  expect(getPgErrorCode(outcomes.a.error)).toBe("23514");
                }
                expect(state.invoice).toBeUndefined();
                return;
              }
              expect(outcomes.a.status).toBe("committed");
              expect(state.invoice).toEqual({ clientId: scenario.clientId });
            },
          });
        }
      },
    );

    test.each(["draft", "finalized"] as const)(
      "a matter with a line-free %s invoice retains its client",
      async (status) => {
        const scenario = await seedScenario();
        const invoiceId = createSafeId<"invoice">();
        await db.insert(invoices).values({
          id: invoiceId,
          organizationId: scenario.orgId,
          workspaceId: scenario.otherClientMatterId,
          invoiceDate: "2026-10-15",
          currency: "EUR",
          status,
        });
        for (const clientId of [scenario.clientId, null]) {
          await expectSqlState(
            db
              .update(workspaces)
              .set({ clientId })
              .where(eq(workspaces.id, scenario.otherClientMatterId)),
            "23514",
          );
        }
        expect(
          await db.query.workspaces.findFirst({
            where: { id: { eq: scenario.otherClientMatterId } },
            columns: { clientId: true },
          }),
        ).toEqual({ clientId: scenario.otherClientId });
        expect(
          await db.query.invoices.findFirst({
            where: { id: { eq: invoiceId } },
            columns: { clientId: true },
          }),
        ).toEqual({ clientId: scenario.otherClientId });
      },
    );

    test("a member removing the final client-invoice line gets a deliberate refusal without a partial mutation", async () => {
      const scenario = await seedScenario();
      await scoped(
        scenario,
        scenario.actors.owner,
      )(async (tx) => {
        await tx
          .delete(invoiceLines)
          .where(eq(invoiceLines.id, scenario.secondLineId));
      });
      const userId = scenario.actors.full;
      const memberRole = sessionMemberRole("member");
      expect(hasMemberPermission(memberRole, { invoice: ["update"] })).toBe(
        true,
      );
      const safeDb = createMembershipSafeDb(markRlsDatabase(db), {
        organizationId: scenario.orgId,
        userId,
        serverValidatedWorkspaceIds: [],
      });
      const auditEvents: unknown[] = [];
      const result = await deleteInvoiceLine.handler(
        createTestHandlerContext<
          Parameters<typeof deleteInvoiceLine.handler>[0]
        >({
          safeDb,
          scopedDb: scoped(scenario, userId),
          audit: async (_tx, event) => {
            auditEvents.push(event);
          },
          memberRole,
          session: { activeOrganizationId: scenario.orgId },
          user: { id: userId },
          workspaceId: scenario.firstMatterId,
          params: {
            invoiceId: scenario.invoiceId,
            lineId: scenario.firstLineId,
            workspaceId: scenario.firstMatterId,
          },
        }),
      );
      expect(result).toMatchObject({
        code: 409,
        response: {
          message: "Removing these lines would make the invoice inaccessible",
        },
      });
      expect(auditEvents).toEqual([]);
      expect(
        await scoped(
          scenario,
          userId,
        )(async (tx) => ({
          lines: await tx.query.invoiceLines.findMany({
            where: { invoiceId: { eq: scenario.invoiceId } },
            columns: { id: true },
          }),
          invoice: await tx.query.invoices.findFirst({
            where: { id: { eq: scenario.invoiceId } },
            columns: { totalAmount: true },
          }),
        })),
      ).toEqual({
        lines: [{ id: scenario.firstLineId }],
        invoice: { totalAmount: cents(0) },
      });
    });

    test("MCP invoice reads retain the credential matter allowlist for owners and admins", async () => {
      const scenario = await seedScenario();
      const singleMatterInvoiceId = createSafeId<"invoice">();
      await db.insert(invoices).values({
        id: singleMatterInvoiceId,
        organizationId: scenario.orgId,
        workspaceId: scenario.secondMatterId,
        invoiceDate: "2026-10-15",
        currency: "EUR",
      });
      const creditInvoiceId = createSafeId<"invoice">();
      await db
        .update(invoices)
        .set({
          status: INVOICE_STATUS.FINALIZED,
          finalizedAt: new Date("2026-10-15T12:00:00Z"),
        })
        .where(eq(invoices.id, scenario.invoiceId));
      await db.insert(invoices).values({
        id: creditInvoiceId,
        organizationId: scenario.orgId,
        workspaceId: null,
        clientId: scenario.clientId,
        documentType: "credit_note",
        originalInvoiceId: scenario.invoiceId,
        invoiceDate: "2026-10-16",
        currency: "EUR",
      });
      const contextFor = (
        actor: "owner" | "admin",
        accessibleWorkspaceIds: SafeId<"workspace">[],
      ) => {
        const userId = scenario.actors[actor];
        return buildMcpContextFromChat({
          organizationId: scenario.orgId,
          userId,
          userEmail: "invoice-reader@example.test",
          memberRole: sessionMemberRole(actor),
          featureAccessSnapshot: enrolledTimeBillingSnapshot({
            organizationId: scenario.orgId,
            userId,
          }),
          safeDb: createMembershipSafeDb(markRlsDatabase(db), {
            organizationId: scenario.orgId,
            userId,
            serverValidatedWorkspaceIds: [],
          }),
          scopedDb: scoped(scenario, userId),
          toolWorkspaceIds: resolveToolWorkspaceIds({
            accessibleWorkspaceIds,
            pinnedIds: [],
          }),
        });
      };
      for (const actor of ["owner", "admin"] as const) {
        const partial = contextFor(actor, [scenario.firstMatterId]);
        const complete = contextFor(actor, [
          scenario.firstMatterId,
          scenario.secondMatterId,
        ]);
        const unrelated = contextFor(actor, [scenario.otherClientMatterId]);
        for (const context of [partial, unrelated, contextFor(actor, [])]) {
          expect(
            await BILLING_TOOL_HANDLERS.list_invoices({
              args: { invoice_id: singleMatterInvoiceId },
              context,
            }),
          ).toMatchObject({ status: "error", error: { code: "not_found" } });
          expect(
            await BILLING_TOOL_HANDLERS.list_invoices({
              args: { invoice_id: scenario.invoiceId },
              context,
            }),
          ).toMatchObject({ status: "error", error: { code: "not_found" } });
          for (const args of [
            { invoice_id: creditInvoiceId },
            { invoice_id: creditInvoiceId, matter_id: scenario.firstMatterId },
          ]) {
            expect(
              await BILLING_TOOL_HANDLERS.list_invoices({ args, context }),
            ).toMatchObject({ status: "error", error: { code: "not_found" } });
          }
        }
        expect(
          await BILLING_TOOL_HANDLERS.list_invoices({
            args: {
              invoice_id: scenario.invoiceId,
              matter_id: scenario.firstMatterId,
            },
            context: partial,
          }),
        ).toMatchObject({ status: "error", error: { code: "not_found" } });
        expect(
          await BILLING_TOOL_HANDLERS.list_invoices({
            args: { matter_id: scenario.firstMatterId },
            context: partial,
          }),
        ).toMatchObject({ egress: "structured", payload: { invoices: [] } });
        expect(
          await BILLING_TOOL_HANDLERS.list_invoices({
            args: { invoice_id: singleMatterInvoiceId },
            context: complete,
          }),
        ).toMatchObject({
          egress: "structured",
          payload: {
            invoice: {
              id: singleMatterInvoiceId,
              workspaceId: scenario.secondMatterId,
            },
          },
        });
        for (const args of [
          { invoice_id: scenario.invoiceId },
          { invoice_id: scenario.invoiceId, matter_id: scenario.firstMatterId },
        ]) {
          expect(
            await BILLING_TOOL_HANDLERS.list_invoices({
              args,
              context: complete,
            }),
          ).toMatchObject({
            egress: "structured",
            payload: {
              invoice: {
                id: scenario.invoiceId,
                lines: expect.arrayContaining([
                  expect.objectContaining({
                    workspaceId: scenario.firstMatterId,
                  }),
                  expect.objectContaining({
                    workspaceId: scenario.secondMatterId,
                  }),
                ]),
              },
            },
          });
        }
        for (const args of [
          { invoice_id: creditInvoiceId },
          { invoice_id: creditInvoiceId, matter_id: scenario.firstMatterId },
        ]) {
          expect(
            await BILLING_TOOL_HANDLERS.list_invoices({
              args,
              context: complete,
            }),
          ).toMatchObject({
            egress: "structured",
            payload: {
              invoice: {
                id: creditInvoiceId,
                originalInvoiceId: scenario.invoiceId,
                lines: [],
              },
            },
          });
        }
        expect(
          await BILLING_TOOL_HANDLERS.list_invoices({
            args: { matter_id: scenario.firstMatterId },
            context: complete,
          }),
        ).toMatchObject({
          egress: "structured",
          payload: {
            // Matter lists retain actual line attribution; the empty credit
            // remains addressable by ID through its authorized original.
            invoices: [expect.objectContaining({ id: scenario.invoiceId })],
          },
        });
      }
    });

    test("MCP detail retains empty client invoices through an authorized matter of their client", async () => {
      const scenario = await seedScenario();
      await scoped(
        scenario,
        scenario.actors.owner,
      )(async (tx) => {
        await tx
          .delete(invoiceLines)
          .where(eq(invoiceLines.invoiceId, scenario.invoiceId));
      });
      for (const actor of ["owner", "admin", "full", "partial"] as const) {
        const userId = scenario.actors[actor];
        const memberRole = sessionMemberRole(
          actor === "owner" || actor === "admin" ? actor : "member",
        );
        const accessibleWorkspaceIds = [scenario.firstMatterId];
        if (actor !== "partial") {
          accessibleWorkspaceIds.push(scenario.secondMatterId);
        }
        if (actor === "owner" || actor === "admin") {
          accessibleWorkspaceIds.push(scenario.otherClientMatterId);
        }
        const context = buildMcpContextFromChat({
          organizationId: scenario.orgId,
          userId,
          userEmail: "invoice-reader@example.test",
          memberRole,
          featureAccessSnapshot: enrolledTimeBillingSnapshot({
            organizationId: scenario.orgId,
            userId,
          }),
          safeDb: createMembershipSafeDb(markRlsDatabase(db), {
            organizationId: scenario.orgId,
            userId,
            serverValidatedWorkspaceIds: [],
          }),
          scopedDb: scoped(scenario, userId),
          toolWorkspaceIds: resolveToolWorkspaceIds({
            accessibleWorkspaceIds,
            pinnedIds: [],
          }),
        });
        expect(
          await BILLING_TOOL_HANDLERS.list_invoices({
            args: { invoice_id: scenario.invoiceId },
            context,
          }),
        ).toMatchObject({ status: "error", error: { code: "not_found" } });
        const result = await BILLING_TOOL_HANDLERS.list_invoices({
          args: {
            invoice_id: scenario.invoiceId,
            matter_id: scenario.firstMatterId,
          },
          context,
        });
        if (actor === "owner" || actor === "admin") {
          expect(result).toMatchObject({
            egress: "structured",
            payload: {
              invoice: {
                id: scenario.invoiceId,
                workspaceId: scenario.firstMatterId,
                lines: [],
              },
            },
          });
        } else {
          expect(result).toMatchObject({
            status: "error",
            error: { code: "not_found" },
          });
        }
        const wrongClient = await BILLING_TOOL_HANDLERS.list_invoices({
          args: {
            invoice_id: scenario.invoiceId,
            matter_id: scenario.otherClientMatterId,
          },
          context,
        });
        expect(wrongClient).toMatchObject({
          status: "error",
          error: { code: "not_found" },
        });
      }
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
        scoped(
          scenario,
          scenario.actors.owner,
        )(
          async (tx) =>
            await tx
              .update(invoiceLines)
              .set({ workspaceId: scenario.otherClientMatterId })
              .where(eq(invoiceLines.id, scenario.firstLineId)),
        ),
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
        ownerId: scenario.actors.owner,
      });
      await expectSqlState(
        insertRootLine({
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
        const updated = await scoped(
          scenario,
          scenario.actors.owner,
        )(
          async (tx) =>
            await tx
              .update(invoiceLines)
              .set({
                source: "time_entry",
                timeEntryId,
                netAmount,
                vatAmount: cents(0),
                grossAmount: netAmount,
                vatRateBps: 0,
              })
              .where(eq(invoiceLines.id, lineId))
              .returning({ id: invoiceLines.id }),
        );
        expect(updated).toEqual([{ id: lineId }]);
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
