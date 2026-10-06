import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  entities,
  legalListVerificationBlocks,
  legalListVerificationReadReceipts,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createAuditRecorder, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { CONTENT_DELIVERY_AUDIT_ACTION } from "@/api/lib/audited-download";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { VERIFICATION_RUN_STATUSES } from "@/api/lib/lists/verification/contract";
import { recordVerificationRead } from "@/api/lib/lists/verification/read-audit";
import { readVerificationRun } from "@/api/lib/lists/verification/read-run";
import type { McpRequestContext } from "@/api/mcp/context";
import { CAPABILITY_DISPATCH } from "@/api/mcp/generated/capability-dispatch/lists.verifications.get";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

import get from "./get";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const CANARY = "verification content sentinel Žluťoučký";

const seed = async (db: GatedTestDb) => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const actor = toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`);
  const otherActor = toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`);
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Read audit firm",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values(
    [actor, otherActor].map((id) => ({
      id,
      name: "Reader",
      email: `${id}@example.test`,
      emailVerified: true,
    })),
  );
  await db.insert(member).values(
    [actor, otherActor].map((userId) => ({
      id: Bun.randomUUIDv7(),
      userId,
      organizationId,
      role: "owner",
      createdAt: new Date(),
    })),
  );
  await db.insert(workspaces).values(
    [workspaceId, otherWorkspaceId].map((id) => ({
      id,
      organizationId,
      name: "Read audit matter",
      reference: id,
    })),
  );
  const rlsDb = markRlsDatabase(db);
  const scoped = (userId = actor) =>
    createScopedDb(
      rlsDb,
      [workspaceId, otherWorkspaceId],
      organizationId,
      userId,
    );
  const runIds = {
    completed: createSafeId<"legalListVerificationRun">(),
    failed: createSafeId<"legalListVerificationRun">(),
    queued: createSafeId<"legalListVerificationRun">(),
    running: createSafeId<"legalListVerificationRun">(),
  };
  for (const status of VERIFICATION_RUN_STATUSES) {
    const id = runIds[status];
    const entityId = createSafeId<"entity">();
    await db
      .insert(entities)
      .values({ id: entityId, workspaceId, name: "Verification document" });
    await db.insert(legalListVerificationRuns).values({
      id,
      organizationId,
      workspaceId,
      entityId,
      fileFieldId: createSafeId<"field">(),
      entityVersionId: createSafeId<"entityVersion">(),
      contentSha256: "a".repeat(64),
      status,
      errorCode: status === "failed" ? "internal" : null,
      evidence: {
        listId: createSafeId<"legalList">(),
        facts: [
          {
            factEntityId: createSafeId<"entity">(),
            text: CANARY,
            occurredOn: null,
            occurredOnPrecision: null,
            evidenceKind: null,
            medium: null,
            confidence: null,
            interpretationNote: CANARY,
            sources: [],
          },
        ],
      },
    });
    await db.insert(legalListVerificationBlocks).values({
      runId: id,
      workspaceId,
      ordinal: 0,
      blockId: "p1",
      kind: "docx-block",
      text: CANARY,
    });
  }
  const recorder = (userId = actor): AuditRecorder =>
    createAuditRecorder({
      organizationId,
      workspaceId,
      userId,
      request: new Request("https://example.test/verification"),
      server: null,
    });
  const read = async ({
    runId = runIds.completed,
    userId = actor,
    at = "2026-10-05T10:00:00Z",
    record = recorder(userId),
  } = {}) =>
    await scoped(userId)(async (tx) => {
      const run = await readVerificationRun({ tx, workspaceId, runId });
      if (run === null) {
        throw new TypeError("Fixture run required");
      }
      await recordVerificationRead({
        tx,
        run,
        workspaceId,
        organizationId,
        userId,
        observedAt: new Date(at),
        recordAuditEvent: record,
      });
      return run;
    });
  const events = async () =>
    await scoped()(
      async (tx) =>
        await tx
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, organizationId),
              eq(auditLogs.action, CONTENT_DELIVERY_AUDIT_ACTION.inline),
            ),
          )
          .limit(100),
    );
  const invoke = async ({
    runId = runIds.completed,
    matterId = workspaceId,
    userId = actor,
    record = recorder(userId),
  } = {}) =>
    await get.handler(
      createTestHandlerContext<Parameters<typeof get.handler>[0]>({
        workspaceId: matterId,
        session: { activeOrganizationId: organizationId },
        user: { id: userId },
        params: { runId },
        safeDb: createSafeDb(
          rlsDb,
          [workspaceId, otherWorkspaceId],
          organizationId,
          userId,
        ),
        recordAuditEvent: record,
        createAuditRecorder: () => record,
      }),
    );
  const receipts = async () =>
    await scoped()(
      async (tx) =>
        await tx
          .select()
          .from(legalListVerificationReadReceipts)
          .where(eq(legalListVerificationReadReceipts.workspaceId, workspaceId))
          .limit(10),
    );
  const capabilityRead = async () => {
    const scopedDb = scoped();
    const safeDb = createSafeDb(rlsDb, [workspaceId], organizationId, actor);
    const featureAccessSnapshot = await scopedDb(
      async (tx) =>
        await resolveFeatureAccessSnapshot({
          tx,
          organizationId,
          userId: actor,
        }),
    );
    const context = {
      organizationId,
      userId: actor,
      userEmail: `${actor}@example.test`,
      memberRole: "owner",
      accessibleWorkspaceIds: [workspaceId],
      accessibleWorkspaceIdSet: new Set([workspaceId]),
      accessibleWorkspaceStatusById: new Map([[workspaceId, "active"]]),
      accessibleWorkspaces: [{ id: workspaceId, status: "active" }],
      safeDb,
      scopedDb,
      recordAuditEvent: recorder(),
      featureAccessSnapshot,
      request: new Request("https://example.test/mcp"),
      grantedScopes: ["stella:read"],
      createOperationDatabaseScope: () => ({
        safeDb,
        scopedDb,
        pinServerValidatedWorkspaceId: (id) => id === workspaceId,
      }),
      testDependencies: {
        isCapabilityFeatureEnabled: () => true,
        consumeInvokeCapabilityRateLimit: async () =>
          await Promise.resolve({ ok: true, retryAfterSeconds: 60 }),
        loadOrgSettingsForAuth: async () =>
          await Promise.resolve({
            orgAIConfig: null,
            orgAIConfigStatus: "ok",
            promptCachingEnabled: false,
            managedAIResidency: "eu",
          }),
      },
    } satisfies McpRequestContext;
    return await handleMcpToolCall({
      context,
      toolName: "invoke_capability",
      args: {
        capability: "lists.verifications.get",
        input: { params: { matterId: workspaceId, runId: runIds.completed } },
      },
    });
  };
  return {
    capabilityRead,
    organizationId,
    actor,
    otherActor,
    workspaceId,
    otherWorkspaceId,
    runIds,
    scoped,
    read,
    events,
    receipts,
    invoke,
    recorder,
  };
};

const withFixture = async (
  exercise: (fixture: Awaited<ReturnType<typeof seed>>) => Promise<void>,
) => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const db = openClient({ max: 4 }).db;
    const fixture = await seed(db);
    const previous = env.API_FEATURE_ACCESS_GRANTS;
    env.API_FEATURE_ACCESS_GRANTS = {
      "list-verification": [
        { type: "organization", organizationId: fixture.organizationId },
      ],
    };
    try {
      await exercise(fixture);
    } finally {
      env.API_FEATURE_ACCESS_GRANTS = previous;
      await db
        .delete(organization)
        .where(eq(organization.id, fixture.organizationId));
      await db.delete(user).where(eq(user.id, fixture.actor));
      await db.delete(user).where(eq(user.id, fixture.otherActor));
    }
  });
};

describe.skipIf(!enabled)("verification point-read audit", () => {
  test("terminal reads dedupe per actor and Prague day, including concurrent reads", async () =>
    await withFixture(async (f) => {
      await Promise.all(Array.from({ length: 4 }, async () => await f.read()));
      expect(await f.events()).toHaveLength(1);
      await f.read({ at: "2026-10-05T21:59:59Z" });
      expect(await f.events()).toHaveLength(1);
      await f.read({ at: "2026-10-05T22:00:00Z" });
      expect(await f.events()).toHaveLength(2);
      await f.read({ userId: f.otherActor });
      await f.read({ runId: f.runIds.failed });
      expect(await f.events()).toHaveLength(4);
      await f.read({ runId: f.runIds.queued });
      await f.read({ runId: f.runIds.running });
      expect(await f.events()).toHaveLength(4);
    }));

  test.each([
    ["2026-03-28T22:59:59Z", "2026-03-28T23:00:00Z"],
    ["2026-03-29T21:59:59Z", "2026-03-29T22:00:00Z"],
    ["2026-10-25T22:59:59Z", "2026-10-25T23:00:00Z"],
  ])(
    "Prague midnight follows DST: %s to %s",
    async (before, after) =>
      await withFixture(async (f) => {
        await f.read({ at: before });
        await f.read({ at: after });
        expect(await f.events()).toHaveLength(2);
      }),
  );

  test("event identifies the entity and pin without document or fact content", async () =>
    await withFixture(async (f) => {
      const run = await f.read();
      expect(run.blocks.at(0)?.text).toBe(CANARY);
      expect(run.evidence.facts.at(0)?.text).toBe(CANARY);
      const event = (await f.events()).at(0);
      expect(event).toMatchObject({
        resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
        resourceId: run.entityId,
        workspaceId: f.workspaceId,
        userId: f.actor,
        metadata: {
          disposition: "inline",
          format: "verification-run",
          runId: run.id,
          listId: run.evidence.listId,
          fileFieldId: run.fileFieldId,
          entityVersionId: run.entityVersionId,
          status: run.status,
        },
      });
      expect(JSON.stringify(event)).not.toContain(CANARY);
      expect(JSON.stringify(event)).not.toContain("a".repeat(64));
    }));

  test("denied grants and another matter produce no access event", async () =>
    await withFixture(async (f) => {
      env.API_FEATURE_ACCESS_GRANTS = {};
      expect(await f.invoke()).toMatchObject({ code: 404 });
      env.API_FEATURE_ACCESS_GRANTS = {
        "list-verification": [
          { type: "organization", organizationId: f.organizationId },
        ],
      };
      expect(await f.invoke({ matterId: f.otherWorkspaceId })).toMatchObject({
        code: 404,
      });
      expect(await f.events()).toHaveLength(0);
    }));

  test("MCP and CLI capability reads use the point handler and share its daily audit", async () =>
    await withFixture(async (f) => {
      const dispatch =
        await CAPABILITY_DISPATCH["lists.verifications.get"].load();
      expect(dispatch.default).toBe(get);
      const rest = await f.invoke();
      // Generated CLI capability commands call the same invoke_capability tool.
      for (const surface of ["MCP", "CLI"]) {
        const response = await f.capabilityRead();
        expect(response.isError, surface).not.toBe(true);
        expect(response.structuredContent, surface).toEqual({ result: rest });
        expect(await f.events(), surface).toHaveLength(1);
      }
    }));

  test.each(["MCP", "REST"])(
    "the first MCP capability read records an audit and receipt, deduping a subsequent %s read",
    async (nextReader) =>
      await withFixture(async (f) => {
        expect(await f.events()).toHaveLength(0);
        expect(await f.receipts()).toHaveLength(0);

        const first = await f.capabilityRead();
        expect(first.isError).not.toBe(true);
        expect(first.structuredContent).toMatchObject({
          result: { id: f.runIds.completed, status: "completed" },
        });
        const events = await f.events();
        expect(events).toHaveLength(1);
        expect(events.at(0)).toMatchObject({
          userId: f.actor,
          workspaceId: f.workspaceId,
          metadata: { runId: f.runIds.completed },
        });
        const receipts = await f.receipts();
        expect(receipts).toHaveLength(1);
        expect(receipts.at(0)).toMatchObject({
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          runId: f.runIds.completed,
          userId: f.actor,
        });

        if (nextReader === "REST") {
          expect(first.structuredContent).toEqual({ result: await f.invoke() });
        } else {
          const second = await f.capabilityRead();
          expect(second.isError).not.toBe(true);
          expect(second.structuredContent).toEqual(first.structuredContent);
        }
        expect(await f.events()).toEqual(events);
        expect(await f.receipts()).toEqual(receipts);
      }),
  );

  test("audit failure returns no content and rolls back the receipt", async () =>
    await withFixture(async (f) => {
      const broken: AuditRecorder = async (tx, event) => {
        await f.recorder()(tx, event);
        await tx.insert(legalListVerificationReadReceipts).values({
          organizationId: f.organizationId,
          workspaceId: f.workspaceId,
          runId: f.runIds.completed,
          userId: f.actor,
          auditedDay: "2026-10-05",
        });
      };
      const result = await f.invoke({ record: broken });
      expect(result).toMatchObject({ code: 500 });
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(await f.events()).toHaveLength(0);
      expect(await f.receipts()).toHaveLength(0);
      expect(await f.invoke()).toHaveProperty("blocks");
      expect(await f.events()).toHaveLength(1);
    }));
});
