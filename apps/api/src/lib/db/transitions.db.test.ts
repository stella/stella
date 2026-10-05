import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { pgTable, text, integer, primaryKey } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization } from "@/api/db/auth-schema";
import { auditLogs, flowRuns, workspaces } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  defineKeyedTransitions,
  transition,
  transitionBatch,
} from "@/api/lib/db/transitions";
import { isPgError } from "@/api/lib/pg-error";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const organizationId = mintAuthProviderId<"organization">();
const workspaceId = createSafeId<"workspace">();
const runId = createSafeId<"flowRun">();
const actor = "transition-audit-test";
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

type PGliteTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
// The production Bun driver returns rows directly; PGlite wraps them in `rows`.
const withBunRows = (tx: PGliteTransaction) => ({
  execute: async (query: SQL) => (await tx.execute(query)).rows,
  rollback: () => tx.rollback(),
  insert: tx.insert.bind(tx),
  select: tx.select.bind(tx),
});

const recorderFor = (auditOrganizationId: typeof organizationId) =>
  createBackgroundAuditRecorder({
    organizationId: auditOrganizationId,
    workspaceId,
    userId: actor,
    execution: {
      performer: { type: "service", id: actor, name: "Transition audit test" },
      trigger: { type: "system", source: actor },
    },
  });

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(organization).values({
    id: organizationId,
    name: "Transition audit fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Transition audit matter",
    reference: workspaceId,
  });
});

beforeEach(async () => {
  await db
    .delete(auditLogs)
    .where(eq(auditLogs.organizationId, organizationId));
  await db.delete(flowRuns).where(eq(flowRuns.id, runId));
  await db.insert(flowRuns).values({
    id: runId,
    workspaceId,
    status: "pending",
    definitionSnapshot: { name: "Transition audit", steps: [] },
    triggerSource: { type: "schedule" },
  });
});

afterAll(async () => {
  await client.close();
});

test("a successful transition commits one system audit; a stale transition records none", async () => {
  const recordAuditEvent = recorderFor(organizationId);
  for (const expected of ["transitioned", "stale"] as const) {
    const outcome = await db.transaction(async (tx) => {
      const transactional = withBunRows(tx);
      return await transition({
        tx: transactional,
        spec: TRANSITIONS.flowRuns,
        id: runId,
        options: { from: ["pending"], to: "running" },
        recordTransitionAuditEvent: async (auditTx, row) => {
          expect(auditTx).toBe(transactional);
          await recordAuditEvent(auditTx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
            resourceId: row.id,
            changes: { status: { old: "pending", new: row.status } },
          });
        },
      });
    });
    expect(outcome.type).toBe(expected);
  }
  expect((await db.select().from(flowRuns)).at(0)?.status).toBe("running");
  const audits = await db.select().from(auditLogs);
  expect(audits).toHaveLength(1);
  expect(audits.at(0)).toMatchObject({
    organizationId,
    workspaceId,
    resourceId: runId,
    resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
    performerType: "service",
    performerId: actor,
    triggerType: "system",
    changes: { status: { old: "pending", new: "running" } },
  });
});

test("a real audit insert failure rolls back the already applied transition", async () => {
  const recordAuditEvent = recorderFor(mintAuthProviderId<"organization">());
  const error = await rejectionOf(
    db.transaction(async (tx) => {
      const transactional = withBunRows(tx);
      return await transition({
        tx: transactional,
        spec: TRANSITIONS.flowRuns,
        id: runId,
        options: { from: ["pending"], to: "running" },
        recordTransitionAuditEvent: async (auditTx, row) => {
          expect(auditTx).toBe(transactional);
          expect((await auditTx.select().from(flowRuns)).at(0)?.status).toBe(
            "running",
          );
          // The real recorder's organization FK rejects this insert.
          await recordAuditEvent(auditTx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
            resourceId: row.id,
          });
        },
      });
    }),
  );
  expect(isPgError(error, "23503")).toBe(true);
  expect((await db.select().from(flowRuns)).at(0)?.status).toBe("pending");
  expect(await db.select().from(auditLogs)).toEqual([]);
});

test("a batch records exactly its successful rows in one audit call", async () => {
  const missingId = createSafeId<"flowRun">();
  const recordAuditEvent = recorderFor(organizationId);
  let auditCalls = 0;
  const changed = await db.transaction(async (tx) => {
    const transactional = withBunRows(tx);
    return await transitionBatch({
      tx: transactional,
      spec: TRANSITIONS.flowRuns,
      ids: [runId, missingId],
      options: {
        from: ["pending"],
        to: "cancelled",
        set: { finishedAt: new Date() },
      },
      recordTransitionAuditEvent: async (auditTx, rows) => {
        expect(auditTx).toBe(transactional);
        expect(rows).toEqual([{ id: runId, status: "cancelled" }]);
        auditCalls += 1;
        await recordAuditEvent(
          auditTx,
          rows.map((row) => ({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
            resourceId: row.id,
            changes: { status: { old: "pending", new: row.status } },
          })),
        );
      },
    });
  });
  expect(changed).toEqual([{ id: runId, status: "cancelled" }]);
  expect(auditCalls).toBe(1);
  expect(await db.$count(auditLogs)).toBe(1);
  expect((await db.select().from(flowRuns)).at(0)?.finishedAt).toBeInstanceOf(
    Date,
  );
});

test("an audit failure rolls back every row in a batch", async () => {
  const secondId = createSafeId<"flowRun">();
  await db.insert(flowRuns).values({
    id: secondId,
    workspaceId,
    status: "pending",
    definitionSnapshot: { name: "Second transition", steps: [] },
    triggerSource: { type: "schedule" },
  });
  const recordAuditEvent = recorderFor(mintAuthProviderId<"organization">());
  const error = await rejectionOf(
    db.transaction(async (tx) => {
      const transactional = withBunRows(tx);
      await transitionBatch({
        tx: transactional,
        spec: TRANSITIONS.flowRuns,
        ids: [runId, secondId],
        options: { from: ["pending"], to: "cancelled" },
        recordTransitionAuditEvent: async (auditTx, rows) => {
          expect(rows).toHaveLength(2);
          await recordAuditEvent(
            auditTx,
            rows.map((row) => ({
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
              resourceId: row.id,
            })),
          );
        },
      });
    }),
  );
  expect(isPgError(error, "23503")).toBe(true);
  expect(
    await db
      .select({ status: flowRuns.status })
      .from(flowRuns)
      .where(inArray(flowRuns.id, [runId, secondId])),
  ).toEqual([{ status: "pending" }, { status: "pending" }]);
  expect(await db.$count(auditLogs)).toBe(0);
  await db.delete(flowRuns).where(eq(flowRuns.id, secondId));
});

test("a domain primary key changes ownership metadata and its status together", async () => {
  const keyed = pgTable("transition_keyed_fixture", {
    entityId: text("entity_id").primaryKey(),
    status: text({ enum: ["owned", "unassigned"] }).notNull(),
    owner: text(),
  });
  const spec = defineKeyedTransitions({
    table: keyed,
    key: "entityId",
    edges: { owned: ["unassigned"], unassigned: [] },
    options: { terminal: ["unassigned"] },
  });
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`CREATE TEMP TABLE transition_keyed_fixture (entity_id text PRIMARY KEY, status text NOT NULL, owner text)`,
    );
    await tx.insert(keyed).values([
      { entityId: "task", status: "owned", owner: actor },
      { entityId: "closed", status: "unassigned", owner: "historical" },
    ]);
    const transactional = withBunRows(tx);
    const changed = await transitionBatch({
      tx: transactional,
      spec,
      ids: ["task", "closed"],
      options: { from: ["owned"], to: "unassigned", set: { owner: null } },
      recordTransitionAuditEvent: async (auditTx, rows) => {
        expect(
          await auditTx.select().from(keyed).orderBy(keyed.entityId),
        ).toEqual([
          { entityId: "closed", status: "unassigned", owner: "historical" },
          { entityId: "task", status: "unassigned", owner: null },
        ]);
        await recorderFor(organizationId)(
          auditTx,
          rows.map((row) => ({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
            resourceId: row.id,
            changes: { status: { old: "owned", new: row.status } },
          })),
        );
      },
    });
    expect(changed).toEqual([{ id: "task", status: "unassigned" }]);
    await tx.execute(sql`DROP TABLE transition_keyed_fixture`);
  });
  expect(await db.$count(auditLogs)).toBe(1);
});

test("scoped composite transitions fence the generation and preserve another organization's same key", async () => {
  const keyed = pgTable(
    "transition_scoped_fixture",
    {
      organizationId: text("organization_id").notNull(),
      sourceId: text("source_id").notNull(),
      status: text({ enum: ["pending", "complete"] }).notNull(),
      generation: integer().notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.organizationId, table.sourceId] }),
    ],
  );
  const spec = defineKeyedTransitions({
    table: keyed,
    key: "sourceId",
    scope: ["organizationId"],
    edges: { pending: ["complete"], complete: [] },
    options: { terminal: ["complete"], fence: "generation" },
  });
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`CREATE TEMP TABLE transition_scoped_fixture (organization_id text, source_id text, status text NOT NULL, generation integer NOT NULL, PRIMARY KEY (organization_id, source_id))`,
    );
    await tx.insert(keyed).values([
      {
        organizationId: "first",
        sourceId: "eu",
        status: "pending",
        generation: 2,
      },
      {
        organizationId: "second",
        sourceId: "eu",
        status: "pending",
        generation: 2,
      },
    ]);
    const transactional = withBunRows(tx);
    const recordTransitionAuditEvent = async (
      auditTx: typeof transactional,
      rows: readonly { id: string; status: string }[],
    ) => {
      await recorderFor(organizationId)(
        auditTx,
        rows.map((row) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORK_OBLIGATION,
          resourceId: row.id,
        })),
      );
    };
    expect(
      await transitionBatch({
        tx: transactional,
        spec,
        ids: ["eu"],
        scope: { organizationId: "first" },
        options: { from: ["pending"], to: "complete", fence: 1 },
        recordTransitionAuditEvent,
      }),
    ).toEqual([]);
    expect(await tx.select().from(auditLogs)).toHaveLength(0);
    expect(
      await transitionBatch({
        tx: transactional,
        spec,
        ids: ["eu"],
        scope: { organizationId: "first" },
        options: { from: ["pending"], to: "complete", fence: 2, nextFence: 3 },
        recordTransitionAuditEvent,
      }),
    ).toEqual([{ id: "eu", status: "complete" }]);
    expect(await tx.select().from(keyed).orderBy(keyed.organizationId)).toEqual(
      [
        {
          organizationId: "first",
          sourceId: "eu",
          status: "complete",
          generation: 3,
        },
        {
          organizationId: "second",
          sourceId: "eu",
          status: "pending",
          generation: 2,
        },
      ],
    );
    await tx.execute(sql`DROP TABLE transition_scoped_fixture`);
  });
  expect(await db.$count(auditLogs)).toBe(1);
});
