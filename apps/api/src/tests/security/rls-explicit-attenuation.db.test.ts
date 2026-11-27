/**
 * Real-DB (PGlite) contract suite for `app.workspace_access_mode = 'explicit'`
 * attenuation, pin boundaries, transaction/connection setting lifecycle, and
 * org-level / optional-workspace table boundaries.
 */

import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_KIND_ORIGIN,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";

import {
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import {
  clauses,
  contacts,
  entities,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  playbookDefinitions,
  signals,
  templates,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createExplicitSafeDb,
  createExplicitScopedDb,
  createMembershipScopedDb,
  createScopedDb,
  runScopedWorkInTransaction,
  TRANSACTION_DEADLINE,
} from "@/api/db/scoped";
import type { RlsDatabase } from "@/api/db/scoped";
import type { Transaction } from "@/api/db/types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { createMcpOperationDatabases } from "@/api/mcp/context";
import { createWorkspaceAccessBoundary } from "@/api/mcp/workspace-access-boundary";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// timeout: PGlite database bootstrap and RLS attenuation fixture seeding
setDefaultTimeout(30_000);

const FIXED_INVOICE_DATE = "2026-10-01";

type SessionSettings = {
  mode: string;
  workspaceIds: string;
};

let testDb: TestDatabase;
let ids: TestIds;

const playbookOrgA = createSafeId<"playbookDefinition">();
const playbookOrgB = createSafeId<"playbookDefinition">();

const signalOrgANullWs = createSafeId<"signal">();
const signalOrgAWsA1 = createSafeId<"signal">();
const signalOrgAWsA2 = createSafeId<"signal">();
const signalOrgBNullWs = createSafeId<"signal">();

const clientInCeiling = createSafeId<"contact">();
const clientOutOfCeiling = createSafeId<"contact">();
const wsClientInCeiling = createSafeId<"workspace">();
const wsClientSameClientOutOfCeiling = createSafeId<"workspace">();
const wsClientOutOfCeiling = createSafeId<"workspace">();

const emptyClientInvoiceInCeiling = createSafeId<"invoice">();
const emptyClientInvoiceOutOfCeiling = createSafeId<"invoice">();
const singleMatterClientInvoice = createSafeId<"invoice">();
const spanningClientInvoice = createSafeId<"invoice">();

const readSessionSettings = async (tx: {
  select: TestDatabase["select"];
}): Promise<SessionSettings> => {
  const [row] = await tx
    .select({
      mode: sql<string>`coalesce(pg_catalog.current_setting('${sql.raw(SETTING_WORKSPACE_ACCESS_MODE)}', true), '')`,
      workspaceIds: sql<string>`coalesce(pg_catalog.current_setting('${sql.raw(SETTING_WORKSPACE_IDS)}', true), '')`,
    })
    .from(sql`(SELECT 1) AS session_settings`);
  if (row === undefined) {
    throw new TypeError("Expected session settings row");
  }
  return row;
};

const seedSignal = async ({
  id,
  organizationId,
  workspaceId,
  label,
}: {
  id: SafeId<"signal">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
  label: string;
}) => {
  await testDb.insert(signals).values({
    id,
    organizationId,
    workspaceId,
    kind: SIGNAL_KIND.REQUEST_SUBMITTED,
    origin: SIGNAL_KIND_ORIGIN[SIGNAL_KIND.REQUEST_SUBMITTED],
    scoutKey: SCOUT_KEY.MANUAL_REQUEST,
    severity: SIGNAL_SEVERITY.NOTICE,
    confidence: null,
    title: label,
    summary: label,
    subject: workspaceId
      ? { type: "workspace", workspaceId }
      : { type: "none" },
    evidence: {
      kind: SIGNAL_KIND.REQUEST_SUBMITTED,
      description: label,
      attachments: [],
    },
    suggestions: [],
    dedupeKey: `rls-explicit-attenuation:${id}`,
  });
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  await testDb.insert(playbookDefinitions).values([
    {
      id: playbookOrgA,
      organizationId: ids.orgA,
      name: "Org A Playbook",
      positions: { version: 3, items: [] },
    },
    {
      id: playbookOrgB,
      organizationId: ids.orgB,
      name: "Org B Playbook",
      positions: { version: 3, items: [] },
    },
  ]);

  await seedSignal({
    id: signalOrgANullWs,
    organizationId: ids.orgA,
    workspaceId: null,
    label: "Org A unscoped signal",
  });
  await seedSignal({
    id: signalOrgAWsA1,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    label: "Org A wsA1 signal",
  });
  await seedSignal({
    id: signalOrgAWsA2,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    label: "Org A wsA2 signal",
  });
  await seedSignal({
    id: signalOrgBNullWs,
    organizationId: ids.orgB,
    workspaceId: null,
    label: "Org B unscoped signal",
  });

  await testDb.insert(contacts).values([
    {
      id: clientInCeiling,
      organizationId: ids.orgA,
      type: "organization",
      organizationName: "Client In Ceiling",
      displayName: "Client In Ceiling",
    },
    {
      id: clientOutOfCeiling,
      organizationId: ids.orgA,
      type: "organization",
      organizationName: "Client Out Of Ceiling",
      displayName: "Client Out Of Ceiling",
    },
  ]);

  await testDb.insert(workspaces).values([
    {
      id: wsClientInCeiling,
      organizationId: ids.orgA,
      clientId: clientInCeiling,
      name: "Client In Ceiling Matter",
      reference: `EXP-IN-${wsClientInCeiling}`,
    },
    {
      id: wsClientSameClientOutOfCeiling,
      organizationId: ids.orgA,
      clientId: clientInCeiling,
      name: "Same Client Out Of Ceiling Matter",
      reference: `EXP-SAME-OUT-${wsClientSameClientOutOfCeiling}`,
    },
    {
      id: wsClientOutOfCeiling,
      organizationId: ids.orgA,
      clientId: clientOutOfCeiling,
      name: "Client Out Of Ceiling Matter",
      reference: `EXP-OUT-${wsClientOutOfCeiling}`,
    },
  ]);

  await testDb.insert(workspaceMembers).values([
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: wsClientInCeiling,
      userId: ids.userA1,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: wsClientSameClientOutOfCeiling,
      userId: ids.userA1,
    },
    {
      id: createSafeId<"workspaceMember">(),
      workspaceId: wsClientOutOfCeiling,
      userId: ids.userA1,
    },
  ]);

  await testDb.insert(invoices).values([
    {
      id: emptyClientInvoiceInCeiling,
      organizationId: ids.orgA,
      clientId: clientInCeiling,
      workspaceId: null,
      invoiceNumber: `EXP-EMPTY-IN-${emptyClientInvoiceInCeiling}`,
      invoiceDate: FIXED_INVOICE_DATE,
      currency: "EUR",
      status: INVOICE_STATUS.DRAFT,
    },
    {
      id: emptyClientInvoiceOutOfCeiling,
      organizationId: ids.orgA,
      clientId: clientOutOfCeiling,
      workspaceId: null,
      invoiceNumber: `EXP-EMPTY-OUT-${emptyClientInvoiceOutOfCeiling}`,
      invoiceDate: FIXED_INVOICE_DATE,
      currency: "EUR",
      status: INVOICE_STATUS.DRAFT,
    },
    {
      id: singleMatterClientInvoice,
      organizationId: ids.orgA,
      clientId: clientInCeiling,
      workspaceId: null,
      invoiceNumber: `EXP-SINGLE-${singleMatterClientInvoice}`,
      invoiceDate: FIXED_INVOICE_DATE,
      currency: "EUR",
      status: INVOICE_STATUS.DRAFT,
    },
    {
      id: spanningClientInvoice,
      organizationId: ids.orgA,
      clientId: clientInCeiling,
      workspaceId: null,
      invoiceNumber: `EXP-SPAN-${spanningClientInvoice}`,
      invoiceDate: FIXED_INVOICE_DATE,
      currency: "EUR",
      status: INVOICE_STATUS.DRAFT,
    },
  ]);

  await testDb.insert(invoiceLines).values([
    {
      id: createSafeId<"invoiceLine">(),
      organizationId: ids.orgA,
      workspaceId: wsClientInCeiling,
      invoiceId: singleMatterClientInvoice,
      position: 0,
      description: "In-ceiling client line",
      quantity: "1.0000",
      unit: "h",
      unitPrice: cents(100),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(100),
      vatAmount: cents(21),
      grossAmount: cents(121),
      source: "manual",
    },
    {
      id: createSafeId<"invoiceLine">(),
      organizationId: ids.orgA,
      workspaceId: wsClientInCeiling,
      invoiceId: spanningClientInvoice,
      position: 0,
      description: "Spanning in-ceiling line",
      quantity: "1.0000",
      unit: "h",
      unitPrice: cents(100),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(100),
      vatAmount: cents(21),
      grossAmount: cents(121),
      source: "manual",
    },
    {
      id: createSafeId<"invoiceLine">(),
      organizationId: ids.orgA,
      workspaceId: wsClientSameClientOutOfCeiling,
      invoiceId: spanningClientInvoice,
      position: 1,
      description: "Spanning out-of-ceiling line",
      quantity: "1.0000",
      unit: "h",
      unitPrice: cents(100),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(100),
      vatAmount: cents(21),
      grossAmount: cents(121),
      source: "manual",
    },
  ]);
});

afterAll(async () => {
  await releaseRlsFixture();
});

// ════════════════════════════════════════════════════════
// 1. Explicit ceiling vs pins and live membership
// ════════════════════════════════════════════════════════

describe("explicit workspace ceiling vs pins and live membership", () => {
  const assertExplicitCeilingForUser = async (userId: SafeId<"user">) => {
    const membershipDb = createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId,
    });
    const baseline = await membershipDb((tx) =>
      tx
        .select({ workspaceId: entities.workspaceId })
        .from(entities)
        .where(inArray(entities.workspaceId, [ids.wsA1, ids.wsA2])),
    );
    expect(baseline.map((row) => row.workspaceId).toSorted()).toEqual(
      [ids.wsA1, ids.wsA2].toSorted(),
    );

    // Even if serverValidatedWorkspaceIds carries an out-of-ceiling pin (wsA2),
    // explicit token attenuation restricts RLS strictly to tokenWorkspaceIds ([wsA1]).
    const { scopedDb, safeDb } = createMcpOperationDatabases(
      asTestRaw<RlsDatabase<Transaction>>(testDb),
      {
        deadline: TRANSACTION_DEADLINE.request,
        organizationId: ids.orgA,
        serverValidatedWorkspaceIds: [ids.wsA2],
        tokenWorkspaceIds: [ids.wsA1],
        userId,
      },
    );

    const scopedResult = await scopedDb(async (tx) => ({
      settings: await readSessionSettings(tx),
      workspaceRows: await tx.select({ id: workspaces.id }).from(workspaces),
      entityRows: await tx
        .select({ id: entities.id, workspaceId: entities.workspaceId })
        .from(entities),
    }));

    expect(scopedResult.settings).toEqual({
      mode: WORKSPACE_ACCESS_MODE.explicit,
      workspaceIds: `{${ids.wsA1}}`,
    });
    expect(scopedResult.workspaceRows.map((row) => row.id)).toEqual([ids.wsA1]);
    expect(scopedResult.entityRows).toEqual([
      { id: ids.entityA1, workspaceId: ids.wsA1 },
    ]);

    const safeResult = await safeDb((tx) =>
      tx
        .select({ id: entities.id, workspaceId: entities.workspaceId })
        .from(entities),
    );
    expect(Result.isOk(safeResult)).toBe(true);
    if (Result.isOk(safeResult)) {
      expect(safeResult.value).toEqual([
        { id: ids.entityA1, workspaceId: ids.wsA1 },
      ]);
    }
  };

  test("out-of-ceiling serverValidatedWorkspaceIds never widen an explicit token scope", async () => {
    // Positive control + explicit attenuation for both owner and assigned member.
    await assertExplicitCeilingForUser(ids.userAdmin);
    await assertExplicitCeilingForUser(ids.userA1);
  });

  test("workspace access boundary rejects out-of-ceiling pin attempts", () => {
    const pinned: SafeId<"workspace">[] = [];
    const boundary = createWorkspaceAccessBoundary([ids.wsA1]);
    const pin = boundary.bindWorkspacePin((workspaceId) => {
      pinned.push(workspaceId);
      return true;
    });

    // Mutating the public projection must not widen the private pin set.
    boundary.accessibleWorkspaceIdSet.add(ids.wsA2);

    expect(pin(ids.wsA2)).toBe(false);
    expect(pin(ids.wsB1)).toBe(false);
    expect(pin(ids.wsA1)).toBe(true);
    expect(pinned).toEqual([ids.wsA1]);
  });

  test("mutating caller workspaceIds after explicit scope creation cannot widen RLS", async () => {
    const callerCeiling = [ids.wsA1];
    const explicitScoped = createExplicitScopedDb(testDb, {
      workspaceIds: callerCeiling,
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });
    const explicitSafe = createExplicitSafeDb(testDb, {
      workspaceIds: callerCeiling,
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });

    callerCeiling.push(ids.wsA2);

    const scopedRows = await explicitScoped((tx) =>
      tx.select({ workspaceId: entities.workspaceId }).from(entities),
    );
    expect(scopedRows.map((row) => row.workspaceId)).toEqual([ids.wsA1]);

    const safeRows = await explicitSafe((tx) =>
      tx.select({ workspaceId: entities.workspaceId }).from(entities),
    );
    expect(Result.isOk(safeRows)).toBe(true);
    if (Result.isOk(safeRows)) {
      expect(safeRows.value.map((row) => row.workspaceId)).toEqual([ids.wsA1]);
    }
  });

  test("empty explicit ceiling hides all matters even for an organization owner", async () => {
    const emptyExplicit = createExplicitScopedDb(testDb, {
      workspaceIds: [],
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });

    const result = await emptyExplicit(async (tx) => ({
      settings: await readSessionSettings(tx),
      workspaces: await tx.$count(workspaces),
      entities: await tx.$count(entities),
    }));

    expect(result).toEqual({
      settings: {
        mode: WORKSPACE_ACCESS_MODE.explicit,
        workspaceIds: "{}",
      },
      workspaces: 0,
      entities: 0,
    });
  });

  test("service-owned explicit scope discards foreign-organization workspace IDs", async () => {
    const serviceScoped = createScopedDb(
      testDb,
      [ids.wsA1, ids.wsB1],
      ids.orgA,
      null,
    );
    const rows = await serviceScoped((tx) =>
      tx.select({ workspaceId: entities.workspaceId }).from(entities),
    );
    expect(rows.map((row) => row.workspaceId)).toEqual([ids.wsA1]);
  });
});

// ════════════════════════════════════════════════════════
// 2. Rollback, connection reuse, and nested scope restoration
// ════════════════════════════════════════════════════════

describe("transaction rollback, connection reuse, and nested scope restoration", () => {
  test("rolled-back explicit scope never leaks settings to subsequent scopes on the same connection", async () => {
    const failingExplicit = createExplicitScopedDb(testDb, {
      workspaceIds: [ids.wsA1],
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });

    let caughtError: unknown;
    try {
      await failingExplicit(async (tx) => {
        const inside = await readSessionSettings(tx);
        expect(inside).toEqual({
          mode: WORKSPACE_ACCESS_MODE.explicit,
          workspaceIds: `{${ids.wsA1}}`,
        });
        throw new Error("simulated explicit scope rollback");
      });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(Error);

    // Immediately reuse the same PGlite connection with an empty explicit scope.
    const emptyAfterRollback = createExplicitScopedDb(testDb, {
      workspaceIds: [],
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });
    const afterEmpty = await emptyAfterRollback(async (tx) => ({
      settings: await readSessionSettings(tx),
      entityCount: await tx.$count(entities),
    }));
    expect(afterEmpty).toEqual({
      settings: {
        mode: WORKSPACE_ACCESS_MODE.explicit,
        workspaceIds: "{}",
      },
      entityCount: 0,
    });

    // Reuse again with membership mode and verify full owner visibility resumes cleanly.
    const membershipAfterRollback = createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId: ids.userAdmin,
    });
    const afterMembership = await membershipAfterRollback(async (tx) => ({
      settings: await readSessionSettings(tx),
      workspaceIds: (
        await tx
          .select({ workspaceId: entities.workspaceId })
          .from(entities)
          .where(inArray(entities.workspaceId, [ids.wsA1, ids.wsA2]))
      )
        .map((row) => row.workspaceId)
        .toSorted(),
    }));
    expect(afterMembership).toEqual({
      settings: {
        mode: WORKSPACE_ACCESS_MODE.membership,
        workspaceIds: "{}",
      },
      workspaceIds: [ids.wsA1, ids.wsA2].toSorted(),
    });
  });

  test("nested runScopedWorkInTransaction restores outer mode and workspace IDs on success and on savepoint rollback", async () => {
    const outerMembership = createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId: ids.userAdmin,
    });

    const successOutcome = await outerMembership(async (outerTx) => {
      const before = await readSessionSettings(outerTx);
      const inner = await runScopedWorkInTransaction({
        tx: asTestRaw<Transaction>(outerTx),
        organizationId: ids.orgA,
        userId: ids.userAdmin,
        workspaceScope: {
          type: WORKSPACE_ACCESS_MODE.explicit,
          workspaceIds: [ids.wsA1],
        },
        fn: async (innerTx) => ({
          settings: await readSessionSettings(innerTx),
          entityWorkspaceIds: (
            await innerTx
              .select({ workspaceId: entities.workspaceId })
              .from(entities)
          ).map((row) => row.workspaceId),
        }),
      });
      const after = await readSessionSettings(outerTx);
      const outerVisible = (
        await outerTx
          .select({ workspaceId: entities.workspaceId })
          .from(entities)
          .where(inArray(entities.workspaceId, [ids.wsA1, ids.wsA2]))
      )
        .map((row) => row.workspaceId)
        .toSorted();

      return { before, inner, after, outerVisible };
    });

    expect(successOutcome.before).toEqual({
      mode: WORKSPACE_ACCESS_MODE.membership,
      workspaceIds: "{}",
    });
    expect(successOutcome.inner).toEqual({
      settings: {
        mode: WORKSPACE_ACCESS_MODE.explicit,
        workspaceIds: `{${ids.wsA1}}`,
      },
      entityWorkspaceIds: [ids.wsA1],
    });
    expect(successOutcome.after).toEqual({
      mode: WORKSPACE_ACCESS_MODE.membership,
      workspaceIds: "{}",
    });
    expect(successOutcome.outerVisible).toEqual(
      [ids.wsA1, ids.wsA2].toSorted(),
    );

    // Outer explicit scope [wsA1] -> failing nested membership scope -> savepoint rollback
    // must leave the outer transaction pinned to explicit {wsA1} with no leakage.
    const outerExplicit = createExplicitScopedDb(testDb, {
      workspaceIds: [ids.wsA1],
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });

    const rollbackOutcome = await outerExplicit(async (outerTx) => {
      let innerError: unknown;
      try {
        await runScopedWorkInTransaction({
          tx: asTestRaw<Transaction>(outerTx),
          organizationId: ids.orgA,
          userId: ids.userAdmin,
          workspaceScope: {
            type: WORKSPACE_ACCESS_MODE.membership,
            serverValidatedWorkspaceIds: [ids.wsA2],
          },
          fn: async (innerTx) => {
            const inside = await readSessionSettings(innerTx);
            expect(inside.mode).toBe(WORKSPACE_ACCESS_MODE.membership);
            throw new Error("simulated nested savepoint rollback");
          },
        });
      } catch (error) {
        innerError = error;
      }

      return {
        caught: innerError instanceof Error,
        afterSettings: await readSessionSettings(outerTx),
        entityWorkspaceIds: (
          await outerTx
            .select({ workspaceId: entities.workspaceId })
            .from(entities)
        ).map((row) => row.workspaceId),
      };
    });

    expect(rollbackOutcome).toEqual({
      caught: true,
      afterSettings: {
        mode: WORKSPACE_ACCESS_MODE.explicit,
        workspaceIds: `{${ids.wsA1}}`,
      },
      entityWorkspaceIds: [ids.wsA1],
    });
  });
});

// ════════════════════════════════════════════════════════
// 3. Org-level & optional-workspace table contract under explicit mode
// ════════════════════════════════════════════════════════

describe("org-level and optional-workspace table contracts under explicit mode", () => {
  const readOrgScopedSnapshot = async (
    workspaceIds: readonly SafeId<"workspace">[],
  ) => {
    const explicitDb = createExplicitScopedDb(testDb, {
      workspaceIds,
      organizationId: ids.orgA,
      userId: ids.userA1,
    });

    return await explicitDb(async (tx) => ({
      contactIds: (
        await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(inArray(contacts.id, [ids.contactA, ids.contactB]))
      ).map((row) => row.id),
      clauseIds: (
        await tx
          .select({ id: clauses.id })
          .from(clauses)
          .where(inArray(clauses.id, [ids.clauseA, ids.clauseB]))
      ).map((row) => row.id),
      playbookIds: (
        await tx
          .select({ id: playbookDefinitions.id })
          .from(playbookDefinitions)
          .where(inArray(playbookDefinitions.id, [playbookOrgA, playbookOrgB]))
      ).map((row) => row.id),
      templateIds: (
        await tx
          .select({ id: templates.id })
          .from(templates)
          .where(inArray(templates.id, [ids.templateA, ids.templateB]))
      ).map((row) => row.id),
    }));
  };

  test("orgPolicies tables remain organization-scoped (org A visible, org B hidden) under explicit mode", async () => {
    const expected = {
      contactIds: [ids.contactA],
      clauseIds: [ids.clauseA],
      playbookIds: [playbookOrgA],
      templateIds: [ids.templateA],
    };
    expect(await readOrgScopedSnapshot([ids.wsA1])).toEqual(expected);
    expect(await readOrgScopedSnapshot([])).toEqual(expected);
  });

  test("organizationOptionalWorkspacePolicies (signals) exposes null-workspace org rows while filtering workspace-scoped rows by explicit ceiling", async () => {
    const probedSignalIds = [
      signalOrgANullWs,
      signalOrgAWsA1,
      signalOrgAWsA2,
      signalOrgBNullWs,
    ];

    const explicitWsA1 = createExplicitScopedDb(testDb, {
      workspaceIds: [ids.wsA1],
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });
    const visibleWithWsA1 = await explicitWsA1((tx) =>
      tx
        .select({ id: signals.id })
        .from(signals)
        .where(inArray(signals.id, probedSignalIds)),
    );
    expect(visibleWithWsA1.map((row) => row.id).toSorted()).toEqual(
      [signalOrgANullWs, signalOrgAWsA1].toSorted(),
    );

    const explicitEmpty = createExplicitScopedDb(testDb, {
      workspaceIds: [],
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });
    const visibleWithEmpty = await explicitEmpty((tx) =>
      tx
        .select({ id: signals.id })
        .from(signals)
        .where(inArray(signals.id, probedSignalIds)),
    );
    expect(visibleWithEmpty.map((row) => row.id)).toEqual([signalOrgANullWs]);
  });

  test("invoices with null workspace_id enforce explicit ceiling for owners and members (no owner bypass, no multi-matter leak)", async () => {
    const probedInvoiceIds = [
      emptyClientInvoiceInCeiling,
      emptyClientInvoiceOutOfCeiling,
      singleMatterClientInvoice,
      spanningClientInvoice,
    ];

    // Positive control: under membership mode, owner sees all four client invoices.
    const ownerMembership = createMembershipScopedDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId: ids.userAdmin,
    });
    const ownerMembershipRows = await ownerMembership((tx) =>
      tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.id, probedInvoiceIds)),
    );
    expect(ownerMembershipRows.map((row) => row.id).toSorted()).toEqual(
      probedInvoiceIds.toSorted(),
    );

    // Under explicit [wsClientInCeiling], owner sees only the in-ceiling empty
    // client invoice and the single-matter client invoice — never the out-of-ceiling
    // client invoice or the spanning multi-matter client invoice.
    const ownerExplicit = createExplicitScopedDb(testDb, {
      workspaceIds: [wsClientInCeiling],
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });
    const ownerExplicitRows = await ownerExplicit((tx) =>
      tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.id, probedInvoiceIds)),
    );
    expect(ownerExplicitRows.map((row) => row.id).toSorted()).toEqual(
      [emptyClientInvoiceInCeiling, singleMatterClientInvoice].toSorted(),
    );

    // Under explicit [], owner sees zero client invoices.
    const ownerExplicitEmpty = createExplicitScopedDb(testDb, {
      workspaceIds: [],
      organizationId: ids.orgA,
      userId: ids.userAdmin,
    });
    const ownerExplicitEmptyRows = await ownerExplicitEmpty((tx) =>
      tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.id, probedInvoiceIds)),
    );
    expect(ownerExplicitEmptyRows).toEqual([]);

    // Under explicit [wsClientInCeiling], a regular member sees only the
    // single-matter client invoice whose lines are all inside the ceiling.
    const memberExplicit = createExplicitScopedDb(testDb, {
      workspaceIds: [wsClientInCeiling],
      organizationId: ids.orgA,
      userId: ids.userA1,
    });
    const memberExplicitRows = await memberExplicit((tx) =>
      tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(inArray(invoices.id, probedInvoiceIds)),
    );
    expect(memberExplicitRows.map((row) => row.id)).toEqual([
      singleMatterClientInvoice,
    ]);
  });
});
