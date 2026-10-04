import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
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
import { transition } from "@/api/lib/db/transitions";
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
