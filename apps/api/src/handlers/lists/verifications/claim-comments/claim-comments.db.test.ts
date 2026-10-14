import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  entities,
  legalListClaims,
  legalListVerificationRuns,
  legalReaderAnnotations,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";

import createComment from "./create";
import deleteComment from "./delete";
import listComments from "./list";
import updateComment from "./update";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const testState = createTestState({ file: import.meta.path, config: env });
const COMMENT = "Check the meeting date against the minutes.";
const CLAIM_TEXT = "The parties met on 4 March.";

type Tenant = {
  organizationId: SafeId<"organization">;
  author: SafeId<"user">;
  colleague: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  otherWorkspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  claimId: SafeId<"legalListClaim">;
};

const seedTenant = async (db: GatedTestDb): Promise<Tenant> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const author = toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`);
  const colleague = toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`);
  const workspaceId = createSafeId<"workspace">();
  const otherWorkspaceId = createSafeId<"workspace">();
  const runId = createSafeId<"legalListVerificationRun">();
  const claimId = createSafeId<"legalListClaim">();
  const entityId = createSafeId<"entity">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Claim comment firm",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values(
    [author, colleague].map((id) => ({
      id,
      name: "Reviewer",
      email: `${id}@example.test`,
      emailVerified: true,
    })),
  );
  await db.insert(member).values(
    [author, colleague].map((userId) => ({
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
      name: "Claim comment matter",
      reference: id,
    })),
  );
  await db
    .insert(entities)
    .values({ id: entityId, workspaceId, name: "Verified document" });
  await db.insert(legalListVerificationRuns).values({
    id: runId,
    organizationId,
    workspaceId,
    entityId,
    fileFieldId: createSafeId<"field">(),
    entityVersionId: createSafeId<"entityVersion">(),
    contentSha256: "a".repeat(64),
    status: "completed",
    evidence: { listId: createSafeId<"legalList">(), facts: [] },
  });
  const tenant = {
    organizationId,
    author,
    colleague,
    workspaceId,
    otherWorkspaceId,
    runId,
    claimId,
  };
  await scopedFor(
    db,
    tenant,
  )(
    async (tx) =>
      await tx.insert(legalListClaims).values({
        id: claimId,
        runId,
        workspaceId,
        position: 0,
        type: "fact",
        framing: "asserted",
        state: "nocover",
        text: CLAIM_TEXT,
        anchor: { type: "docx-block", blockId: "p1", start: 0, end: 27 },
      }),
  );
  return tenant;
};

const scopedFor = (db: GatedTestDb, tenant: Tenant, userId = tenant.author) =>
  createScopedDb(
    markRlsDatabase(db),
    [tenant.workspaceId, tenant.otherWorkspaceId],
    tenant.organizationId,
    userId,
  );

const contextFor = (
  db: GatedTestDb,
  tenant: Tenant,
  {
    userId = tenant.author,
    workspaceId = tenant.workspaceId,
  }: { userId?: SafeId<"user">; workspaceId?: SafeId<"workspace"> } = {},
) => ({
  scopedDb: NO_DB,
  workspaceId,
  session: { activeOrganizationId: tenant.organizationId },
  user: { id: userId },
  safeDb: createSafeDb(
    markRlsDatabase(db),
    [tenant.workspaceId, tenant.otherWorkspaceId],
    tenant.organizationId,
    userId,
  ),
  audit: createAuditRecorder({
    organizationId: tenant.organizationId,
    workspaceId,
    userId,
    request: new Request("https://example.test/claim-comments"),
    server: null,
  }),
});

const create = async (
  db: GatedTestDb,
  tenant: Tenant,
  {
    claimId = tenant.claimId,
    userId = tenant.author,
    visibility = "private",
    workspaceId = tenant.workspaceId,
  }: {
    claimId?: SafeId<"legalListClaim">;
    userId?: SafeId<"user">;
    visibility?: "private" | "shared";
    workspaceId?: SafeId<"workspace">;
  } = {},
) =>
  await createComment.handler(
    createTestHandlerContext<Parameters<typeof createComment.handler>[0]>({
      ...contextFor(db, tenant, { userId, workspaceId }),
      body: { runId: tenant.runId, claimId, body: COMMENT, visibility },
    }),
  );

const list = async (
  db: GatedTestDb,
  tenant: Tenant,
  {
    userId = tenant.author,
    workspaceId = tenant.workspaceId,
  }: { userId?: SafeId<"user">; workspaceId?: SafeId<"workspace"> } = {},
) =>
  await listComments.handler(
    createTestHandlerContext<Parameters<typeof listComments.handler>[0]>({
      ...contextFor(db, tenant, { userId, workspaceId }),
      query: { runId: tenant.runId, claimId: tenant.claimId },
    }),
  );

const listedIds = (result: unknown): string[] => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("items" in result) ||
    !Array.isArray(result.items)
  ) {
    throw new TypeError("A comment page was expected");
  }
  return result.items.map((item: { id: string }) => item.id);
};

const createdId = (result: unknown): SafeId<"legalReaderAnnotation"> => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string"
  ) {
    throw new TypeError("A created comment was expected");
  }
  return toSafeId<"legalReaderAnnotation">(result.id);
};

const auditEvents = async (db: GatedTestDb, tenant: Tenant) =>
  await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, tenant.organizationId),
        eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION),
      ),
    )
    .limit(20);

const storedComments = async (db: GatedTestDb, tenant: Tenant) =>
  await db
    .select()
    .from(legalReaderAnnotations)
    .where(eq(legalReaderAnnotations.organizationId, tenant.organizationId))
    .limit(20);

/** Resolves once some session of the database waits on a lock. */
const lockWaitStarted = async (db: GatedTestDb, failure: string) => {
  for (let attempt = 0; ; attempt += 1) {
    const waiting = await db.execute<{ waiting: number }>(
      sql`SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((waiting.at(0)?.waiting ?? 0) > 0) {
      return;
    }
    if (attempt > 200) {
      throw new TypeError(failure);
    }
    await Bun.sleep(10);
  }
};

/** A shared claim comment row, as the create handler writes one. */
const commentRow = (tenant: Tenant) => ({
  id: createSafeId<"legalReaderAnnotation">(),
  organizationId: tenant.organizationId,
  userId: tenant.author,
  targetType: "verification-claim" as const,
  targetId: tenant.claimId,
  workspaceId: tenant.workspaceId,
  verificationRunId: tenant.runId,
  verificationClaimId: tenant.claimId,
  kind: "comment" as const,
  visibility: "shared" as const,
  blockAnchorId: "p1",
  startOffset: 0,
  endOffset: 27,
  quote: CLAIM_TEXT,
  body: COMMENT,
});

const withTenants = async (
  exercise: (scope: { db: GatedTestDb; tenant: Tenant }) => Promise<void>,
) => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const db = openClient({ max: 4 }).db;
    const tenant = await seedTenant(db);
    testState.setConfig(
      "API_FEATURE_ACCESS_GRANTS",
      organizationFeatureGrants(tenant.organizationId, [
        LIST_VERIFICATION_FEATURE_ID,
      ]),
    );
    try {
      await exercise({ db, tenant });
    } finally {
      await db
        .delete(organization)
        .where(eq(organization.id, tenant.organizationId));
      await db.delete(user).where(eq(user.id, tenant.author));
      await db.delete(user).where(eq(user.id, tenant.colleague));
    }
  });
};

/** An agent's session in the tenant's matter, as the capability path sees it. */
const capabilityContext = async (
  db: GatedTestDb,
  tenant: Tenant,
): Promise<McpRequestContext> => {
  const scopedDb = scopedFor(db, tenant);
  const safeDb = createSafeDb(
    markRlsDatabase(db),
    [tenant.workspaceId],
    tenant.organizationId,
    tenant.author,
  );
  const featureAccessSnapshot = await scopedDb(
    async (tx) =>
      await resolveFeatureAccessSnapshot({
        tx,
        organizationId: tenant.organizationId,
        userId: tenant.author,
      }),
  );
  return {
    organizationId: tenant.organizationId,
    userId: tenant.author,
    userEmail: `${tenant.author}@example.test`,
    memberRole: "owner",
    accessibleWorkspaceIds: [tenant.workspaceId],
    accessibleWorkspaceIdSet: new Set([tenant.workspaceId]),
    accessibleWorkspaceStatusById: new Map([[tenant.workspaceId, "active"]]),
    accessibleWorkspaces: [{ id: tenant.workspaceId, status: "active" }],
    safeDb,
    scopedDb,
    recordAuditEvent: contextFor(db, tenant).audit,
    featureAccessSnapshot,
    request: new Request("https://example.test/mcp"),
    grantedScopes: ["stella:read", "stella:matters_write"],
    createOperationDatabaseScope: () => ({
      safeDb,
      scopedDb,
      pinServerValidatedWorkspaceId: (id) => id === tenant.workspaceId,
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
  };
};

describe.skipIf(!enabled)("comments on verification claims", () => {
  test("the create capability writes a comment in the matter it names", async () =>
    await withTenants(async ({ db, tenant }) => {
      const result = await handleMcpToolCall({
        mode: "advanced",
        context: await capabilityContext(db, tenant),
        toolName: "write_capability",
        args: {
          capability: "lists.verifications.claim-comments.create",
          input: {
            params: { matterId: tenant.workspaceId },
            body: {
              runId: tenant.runId,
              claimId: tenant.claimId,
              body: COMMENT,
            },
          },
        },
      });
      expect(result.isError).not.toBe(true);
      const [stored] = await storedComments(db, tenant);
      expect(stored).toMatchObject({
        workspaceId: tenant.workspaceId,
        verificationClaimId: tenant.claimId,
        userId: tenant.author,
        body: COMMENT,
      });
    }));

  test("an author creates, lists, edits, shares and deletes a claim comment, each audited", async () =>
    await withTenants(async ({ db, tenant }) => {
      const id = createdId(await create(db, tenant));
      const [stored] = await storedComments(db, tenant);
      expect(stored).toMatchObject({
        id,
        targetType: "verification-claim",
        targetId: tenant.claimId,
        workspaceId: tenant.workspaceId,
        verificationRunId: tenant.runId,
        verificationClaimId: tenant.claimId,
        kind: "comment",
        body: COMMENT,
        visibility: "private",
        blockAnchorId: "p1",
        startOffset: 0,
        endOffset: 27,
        quote: CLAIM_TEXT,
      });

      expect(listedIds(await list(db, tenant))).toEqual([id]);
      // Private until shared: a colleague on the matter does not see it.
      expect(
        listedIds(await list(db, tenant, { userId: tenant.colleague })),
      ).toEqual([]);

      const update = async (
        body:
          | { change: "body"; body: string }
          | { change: "visibility"; visibility: "private" | "shared" },
        userId = tenant.author,
      ) =>
        await updateComment.handler(
          createTestHandlerContext<Parameters<typeof updateComment.handler>[0]>(
            {
              ...contextFor(db, tenant, { userId }),
              params: { workspaceId: tenant.workspaceId, annotationId: id },
              body,
            },
          ),
        );
      expect(await update({ change: "body", body: "Revised." })).toEqual({
        ok: true,
      });
      expect(
        await update({ change: "visibility", visibility: "shared" }),
      ).toEqual({ ok: true });
      expect(
        listedIds(await list(db, tenant, { userId: tenant.colleague })),
      ).toEqual([id]);
      // Only the author changes a comment, shared or not.
      expect(
        await update(
          { change: "body", body: "Overwritten." },
          tenant.colleague,
        ),
      ).toMatchObject({ code: 404 });

      const removed = await deleteComment.handler(
        createTestHandlerContext<Parameters<typeof deleteComment.handler>[0]>({
          ...contextFor(db, tenant),
          params: { workspaceId: tenant.workspaceId, annotationId: id },
        }),
      );
      expect(removed).toEqual({ ok: true });
      expect(await storedComments(db, tenant)).toHaveLength(0);

      const events = await auditEvents(db, tenant);
      expect(events.map((event) => event.action).toSorted()).toEqual(
        [
          AUDIT_ACTION.CREATE,
          AUDIT_ACTION.DELETE,
          AUDIT_ACTION.UPDATE,
          AUDIT_ACTION.UPDATE,
        ].toSorted(),
      );
      for (const event of events) {
        expect(event).toMatchObject({
          resourceId: tenant.runId,
          workspaceId: tenant.workspaceId,
          userId: tenant.author,
          metadata: expect.objectContaining({
            annotationId: id,
            claimId: tenant.claimId,
          }),
        });
        // The trail names the comment, never its words.
        expect(JSON.stringify(event)).not.toContain(COMMENT);
        expect(JSON.stringify(event)).not.toContain("Revised.");
      }
    }));

  test("a claim's comments are listed only in the claim's own matter", async () =>
    await withTenants(async ({ db, tenant }) => {
      const id = createdId(await create(db, tenant, { visibility: "shared" }));
      expect(listedIds(await list(db, tenant))).toEqual([id]);
      expect(
        listedIds(
          await list(db, tenant, { workspaceId: tenant.otherWorkspaceId }),
        ),
      ).toEqual([]);
    }));

  test("a comment written while its claim is being deleted (deletion first) does not outlive the claim", async () =>
    await withTenants(async ({ db, tenant }) => {
      let markDeleted = () => {};
      const deletedInTransaction = new Promise<void>((resolve) => {
        markDeleted = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The run's deletion (and with it the claim's) is held open: its
      // trigger has already run and could not see a comment written now.
      const deletion = db.transaction(async (tx) => {
        await tx
          .delete(legalListVerificationRuns)
          .where(eq(legalListVerificationRuns.id, tenant.runId));
        markDeleted();
        await released;
      });
      await deletedInTransaction;
      const creation = create(db, tenant);
      // The comment's write waits on the claim the deletion holds.
      await lockWaitStarted(db, "The comment write never waited on the claim");
      release();
      await deletion;
      // The held claim is gone once the write resumes, so the row policy
      // refuses the comment instead of storing one the trigger never saw.
      expect(await creation).toMatchObject({ code: expect.any(Number) });
      expect(await storedComments(db, tenant)).toHaveLength(0);
    }));

  test("a claim deleted while a comment on it is being written (write first) takes the comment with it", async () =>
    await withTenants(async ({ db, tenant }) => {
      let markWritten = () => {};
      const writtenInTransaction = new Promise<void>((resolve) => {
        markWritten = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The comment's transaction is held open after its insert, still
      // holding the claim its insert check locked.
      const writing = scopedFor(
        db,
        tenant,
      )(async (tx) => {
        await tx.insert(legalReaderAnnotations).values(commentRow(tenant));
        markWritten();
        await released;
      });
      await writtenInTransaction;
      const deletion = db
        .delete(legalListVerificationRuns)
        .where(eq(legalListVerificationRuns.id, tenant.runId))
        .execute();
      // The claim's deletion waits on the comment's transaction.
      await lockWaitStarted(
        db,
        "The claim deletion never waited on the comment",
      );
      release();
      await writing;
      await deletion;
      // The cleanup that follows the claim's deletion sees the committed
      // comment and removes it.
      expect(await storedComments(db, tenant)).toHaveLength(0);
    }));

  test("a claim's comments need the verification feature in the database too", async () =>
    await withTenants(async ({ db, tenant }) => {
      const id = createdId(await create(db, tenant, { visibility: "shared" }));
      testState.setConfig(
        "API_FEATURE_ACCESS_GRANTS",
        organizationFeatureGrants(tenant.organizationId, [
          LEGAL_LISTS_FEATURE_ID,
        ]),
      );
      const { claims, comments } = await scopedFor(
        db,
        tenant,
      )(async (tx) => ({
        claims: await tx
          .select({ id: legalListClaims.id })
          .from(legalListClaims)
          .where(eq(legalListClaims.id, tenant.claimId)),
        comments: await tx
          .select({ id: legalReaderAnnotations.id })
          .from(legalReaderAnnotations)
          .where(eq(legalReaderAnnotations.id, id)),
      }));
      // The lists feature alone shows the claim, never the comment on it.
      expect(claims).toHaveLength(1);
      expect(comments).toEqual([]);
    }));

  test("the table owner reaches claim comments only through the claim cleanup", async () =>
    await withTenants(async ({ db, tenant }) => {
      createdId(await create(db, tenant));
      const ownerRole = `claim_cleanup_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const rolledBack = new Error("Rolled back on purpose");
      let observed: { reachable: number; remaining: number } | undefined;
      // Every change here, the owner role included, is rolled back.
      await db
        .transaction(async (tx) => {
          await tx.execute(
            sql.raw(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`),
          );
          await tx.execute(
            sql.raw(
              `ALTER TABLE public.legal_reader_annotations OWNER TO ${ownerRole}`,
            ),
          );
          await tx.execute(
            sql.raw(
              `ALTER FUNCTION public.legal_reader_annotations_drop_claim_comments() OWNER TO ${ownerRole}`,
            ),
          );
          await tx.execute(sql.raw(`SET LOCAL ROLE ${ownerRole}`));
          const reachable = await tx.execute<{ reachable: number }>(
            sql`SELECT count(*)::int AS reachable FROM public.legal_reader_annotations
              WHERE organization_id = ${tenant.organizationId}`,
          );
          await tx.execute(sql`RESET ROLE`);
          // The cleanup trigger now runs as the restricted owner.
          await tx
            .delete(legalListVerificationRuns)
            .where(eq(legalListVerificationRuns.id, tenant.runId));
          const remaining = await tx
            .select({ id: legalReaderAnnotations.id })
            .from(legalReaderAnnotations)
            .where(
              eq(legalReaderAnnotations.organizationId, tenant.organizationId),
            );
          observed = {
            reachable: reachable.at(0)?.reachable ?? -1,
            remaining: remaining.length,
          };
          throw rolledBack;
        })
        .catch((error: unknown) => {
          if (error !== rolledBack) {
            throw error;
          }
        });
      expect(observed).toEqual({ reachable: 0, remaining: 0 });
      expect(await storedComments(db, tenant)).toHaveLength(1);
    }));

  test("without the verification feature nothing is read or written", async () =>
    await withTenants(async ({ db, tenant }) => {
      testState.setConfig("API_FEATURE_ACCESS_GRANTS", {});
      expect(await create(db, tenant)).toMatchObject({ code: 404 });
      expect(await list(db, tenant)).toMatchObject({ code: 404 });
      expect(await storedComments(db, tenant)).toHaveLength(0);
      expect(await auditEvents(db, tenant)).toHaveLength(0);
    }));

  test("deleting the run removes every author's comments on its claims", async () =>
    await withTenants(async ({ db, tenant }) => {
      createdId(await create(db, tenant));
      createdId(
        await create(db, tenant, {
          userId: tenant.colleague,
          visibility: "private",
        }),
      );
      expect(await storedComments(db, tenant)).toHaveLength(2);
      await db
        .delete(legalListVerificationRuns)
        .where(eq(legalListVerificationRuns.id, tenant.runId));
      expect(await storedComments(db, tenant)).toHaveLength(0);
    }));
});
