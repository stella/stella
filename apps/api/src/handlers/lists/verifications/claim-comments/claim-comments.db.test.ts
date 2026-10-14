import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

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
import { DOCUMENT_ANNOTATION_REACH } from "@/api/handlers/legal-reader/annotations/target";
import { updateReaderAnnotationHandler } from "@/api/handlers/legal-reader/annotations/update";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
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

const withTenants = async (
  exercise: (scope: {
    db: GatedTestDb;
    tenant: Tenant;
    outsider: Tenant;
  }) => Promise<void>,
) => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const db = openClient({ max: 4 }).db;
    const tenant = await seedTenant(db);
    const outsider = await seedTenant(db);
    testState.setConfig(
      "API_FEATURE_ACCESS_GRANTS",
      organizationFeatureGrants(tenant.organizationId, [
        LIST_VERIFICATION_FEATURE_ID,
      ]),
    );
    try {
      await exercise({ db, tenant, outsider });
    } finally {
      for (const seeded of [tenant, outsider]) {
        await db
          .delete(organization)
          .where(eq(organization.id, seeded.organizationId));
        await db.delete(user).where(eq(user.id, seeded.author));
        await db.delete(user).where(eq(user.id, seeded.colleague));
      }
    }
  });
};

describe.skipIf(!enabled)("comments on verification claims", () => {
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

  test("another organization and another matter can neither read nor write a claim's comments", async () =>
    await withTenants(async ({ db, tenant, outsider }) => {
      const id = createdId(await create(db, tenant, { visibility: "shared" }));

      // Another matter of the same organization: the claim is not there.
      expect(
        await create(db, tenant, { workspaceId: tenant.otherWorkspaceId }),
      ).toMatchObject({ code: 404 });
      expect(
        listedIds(
          await list(db, tenant, { workspaceId: tenant.otherWorkspaceId }),
        ),
      ).toEqual([]);

      // Another organization naming this claim from its own matter.
      testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
        ...organizationFeatureGrants(tenant.organizationId, [
          LIST_VERIFICATION_FEATURE_ID,
        ]),
        ...organizationFeatureGrants(outsider.organizationId, [
          LIST_VERIFICATION_FEATURE_ID,
        ]),
      });
      const foreign = { ...outsider, runId: tenant.runId };
      expect(
        await create(db, foreign, { claimId: tenant.claimId }),
      ).toMatchObject({ code: 404 });
      expect(
        await deleteComment.handler(
          createTestHandlerContext<Parameters<typeof deleteComment.handler>[0]>(
            {
              ...contextFor(db, outsider),
              params: { workspaceId: outsider.workspaceId, annotationId: id },
            },
          ),
        ),
      ).toMatchObject({ code: 404 });

      // The row policy refuses a direct write that names a foreign claim.
      expect(
        await rejectionOf(
          scopedFor(
            db,
            outsider,
          )(
            async (tx) =>
              await tx.insert(legalReaderAnnotations).values({
                id: createSafeId<"legalReaderAnnotation">(),
                organizationId: outsider.organizationId,
                userId: outsider.author,
                targetType: "verification-claim",
                targetId: tenant.claimId,
                workspaceId: outsider.workspaceId,
                verificationRunId: tenant.runId,
                verificationClaimId: tenant.claimId,
                kind: "comment",
                visibility: "shared",
                blockAnchorId: "p1",
                startOffset: 0,
                endOffset: 27,
                quote: CLAIM_TEXT,
                body: COMMENT,
              }),
          ),
        ),
      ).toBeInstanceOf(Error);
      expect(
        await scopedFor(
          db,
          outsider,
        )(
          async (tx) =>
            await tx
              .select({ id: legalReaderAnnotations.id })
              .from(legalReaderAnnotations)
              .where(eq(legalReaderAnnotations.targetId, tenant.claimId))
              .limit(5),
        ),
      ).toEqual([]);

      // The public-law routes and agent tools never reach a claim comment.
      const authorContext = contextFor(db, tenant);
      const viaDocumentRoute = await Result.gen(() =>
        updateReaderAnnotationHandler({
          annotationId: id,
          change: { change: "body", body: "Overwritten." },
          organizationId: tenant.organizationId,
          reach: DOCUMENT_ANNOTATION_REACH,
          recordAuditEvent: authorContext.audit,
          safeDb: authorContext.safeDb,
          userId: tenant.author,
        }),
      );
      expect(Result.isError(viaDocumentRoute)).toBe(true);
      const [stored] = await storedComments(db, tenant);
      expect(stored?.body).toBe(COMMENT);
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
