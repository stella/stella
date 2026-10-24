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
import { readAccountExportAnnotationPage } from "@/api/lib/account-export/owner-read";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { organizationFeatureGrants } from "@/api/tests/helpers/feature-grants";
import {
  createTestHandlerContext,
  NO_DB,
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

// Export owner reads still reveal stored rows after the referenced claim is gone.
const storedComments = async (db: GatedTestDb, tenant: Tenant) =>
  (
    await Promise.all(
      [tenant.author, tenant.colleague].map(
        async (userId) =>
          await readAccountExportAnnotationPage({
            database: db,
            organizationId: tenant.organizationId,
            userId,
            extraWhere: eq(
              legalReaderAnnotations.verificationClaimId,
              tenant.claimId,
            ),
            limit: 20,
          }),
      ),
    )
  ).flat();

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

  test("another organization neither reads nor writes a claim's comments, even naming its matter", async () =>
    await withTenants(async ({ db, tenant }) => {
      const shared = createdId(
        await create(db, tenant, { visibility: "shared" }),
      );
      const outsider = await seedTenant(db);
      try {
        const readAs = async (
          organizationId: SafeId<"organization">,
          userId: SafeId<"user">,
        ) =>
          await createScopedDb(
            markRlsDatabase(db),
            [tenant.workspaceId],
            organizationId,
            userId,
          )(
            async (tx) =>
              await tx
                .select({ id: legalReaderAnnotations.id })
                .from(legalReaderAnnotations)
                .where(
                  eq(
                    legalReaderAnnotations.verificationClaimId,
                    tenant.claimId,
                  ),
                ),
          );
        // The same matter scope reads the comment inside its organization...
        expect(await readAs(tenant.organizationId, tenant.colleague)).toEqual([
          { id: shared },
        ]);
        // ...and nothing from another organization.
        expect(await readAs(outsider.organizationId, outsider.author)).toEqual(
          [],
        );

        // A comment aimed at this claim from the other organization is refused
        // and leaves no row under either organization.
        expect(
          await create(db, {
            ...outsider,
            workspaceId: tenant.workspaceId,
            otherWorkspaceId: tenant.otherWorkspaceId,
            runId: tenant.runId,
            claimId: tenant.claimId,
          }),
        ).toMatchObject({ code: 404 });
        expect(
          await readAccountExportAnnotationPage({
            database: db,
            organizationId: outsider.organizationId,
            userId: outsider.author,
            extraWhere: eq(
              legalReaderAnnotations.verificationClaimId,
              tenant.claimId,
            ),
            limit: 20,
          }),
        ).toEqual([]);
        expect((await storedComments(db, tenant)).map(({ id }) => id)).toEqual([
          shared,
        ]);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, outsider.organizationId));
        await db.delete(user).where(eq(user.id, outsider.author));
        await db.delete(user).where(eq(user.id, outsider.colleague));
      }
    }));

  test("concurrent updates of one comment serialize", async () =>
    await withTenants(async ({ db, tenant }) => {
      const id = createdId(await create(db, tenant));
      let markFirstUpdateLocked = () => {};
      const firstUpdateLocked = new Promise<void>((resolve) => {
        markFirstUpdateLocked = resolve;
      });
      let releaseFirstUpdate = () => {};
      const firstUpdateReleased = new Promise<void>((resolve) => {
        releaseFirstUpdate = resolve;
      });
      const firstContext = contextFor(db, tenant);
      const firstUpdate = updateComment.handler(
        createTestHandlerContext<Parameters<typeof updateComment.handler>[0]>({
          ...firstContext,
          params: { workspaceId: tenant.workspaceId, annotationId: id },
          body: { change: "body", body: "First update." },
          audit: async (...args) => {
            await firstContext.audit(...args);
            markFirstUpdateLocked();
            await firstUpdateReleased;
          },
        }),
      );
      await firstUpdateLocked;

      const secondUpdate = updateComment.handler(
        createTestHandlerContext<Parameters<typeof updateComment.handler>[0]>({
          ...contextFor(db, tenant),
          params: { workspaceId: tenant.workspaceId, annotationId: id },
          body: { change: "body", body: "Second update." },
        }),
      );
      for (let attempt = 0; ; attempt += 1) {
        const waiting = await db.execute<{ waiting: number }>(
          sql`SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if ((waiting.at(0)?.waiting ?? 0) > 0) {
          break;
        }
        if (attempt > 200) {
          throw new TypeError("The second comment update never waited");
        }
        await Bun.sleep(10);
      }

      releaseFirstUpdate();
      expect(await firstUpdate).toEqual({ ok: true });
      expect(await secondUpdate).toEqual({ ok: true });
      expect((await storedComments(db, tenant)).at(0)?.body).toBe(
        "Second update.",
      );
    }));

  test("a comment written while its claim is being deleted does not outlive the claim", async () =>
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
      for (let attempt = 0; ; attempt += 1) {
        const waiting = await db.execute<{ waiting: number }>(
          sql`SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if ((waiting.at(0)?.waiting ?? 0) > 0) {
          break;
        }
        if (attempt > 200) {
          throw new TypeError("The comment write never waited on the claim");
        }
        await Bun.sleep(10);
      }
      release();
      await deletion;
      // The held claim is gone once the write resumes, so the row policy
      // refuses the comment instead of storing one the trigger never saw.
      expect(await creation).toMatchObject({ code: expect.any(Number) });
      expect(await storedComments(db, tenant)).toHaveLength(0);
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
