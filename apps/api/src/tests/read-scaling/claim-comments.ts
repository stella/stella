import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  legalListClaims,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import createClaimComment from "@/api/handlers/lists/verifications/claim-comments/create";
import deleteClaimComment from "@/api/handlers/lists/verifications/claim-comments/delete";
import listClaimComments from "@/api/handlers/lists/verifications/claim-comments/list";
import updateClaimComment from "@/api/handlers/lists/verifications/claim-comments/update";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

/** The fixed page the list scenario reads, whatever the claim holds. */
const PAGE_SIZE = 10;
const COMMENT = "Check the meeting date against the minutes.";

type ClaimCommentTenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  claimId: SafeId<"legalListClaim">;
  /** The request's feature decisions, resolved once as the auth plugin does. */
  featureAccessSnapshot: FeatureAccessSnapshot;
};

export type ClaimCommentScalingFixture = {
  db: GatedTestDb;
  tenant: ClaimCommentTenant;
  /** Comments already on the claim, oldest first. */
  commentIds: readonly SafeId<"legalReaderAnnotation">[];
  cleanup: () => Promise<void>;
};

type SeedClaimCommentScalingOptions = {
  db: GatedTestDb;
  size: number;
  /** Grants the verification feature to the seeded organization. */
  grantFeature: (organizationId: SafeId<"organization">) => void;
};

const handlerContext = (db: GatedTestDb, tenant: ClaimCommentTenant) => ({
  scopedDb: NO_DB,
  workspaceId: tenant.workspaceId,
  session: { activeOrganizationId: tenant.organizationId },
  user: { id: tenant.userId },
  // An authenticated request's scope: membership walls, and the feature
  // decisions it was admitted with, so no transaction reads them again.
  featureAccessSnapshot: tenant.featureAccessSnapshot,
  safeDb: createMembershipSafeDb(markRlsDatabase(db), {
    organizationId: tenant.organizationId,
    serverValidatedWorkspaceIds: [tenant.workspaceId],
    userId: tenant.userId,
    featureAccessSnapshot: tenant.featureAccessSnapshot,
  }),
  audit: createAuditRecorder({
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    userId: tenant.userId,
    request: new Request("https://example.test/claim-comments"),
    server: null,
  }),
});

const createComment = async (db: GatedTestDb, tenant: ClaimCommentTenant) =>
  await createClaimComment.handler(
    createTestHandlerContext<Parameters<typeof createClaimComment.handler>[0]>({
      ...handlerContext(db, tenant),
      body: {
        runId: tenant.runId,
        claimId: tenant.claimId,
        body: COMMENT,
        visibility: "private",
      },
    }),
  );

const createdId = (result: unknown): SafeId<"legalReaderAnnotation"> => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string"
  ) {
    return panic("Claim comment scaling requires a created comment");
  }
  return toSafeId<"legalReaderAnnotation">(result.id);
};

const requireOk = (result: unknown, scenario: string): void => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== true
  ) {
    panic(`${scenario} scaling requires a successful handler response`);
  }
};

/** One matter with a completed run, one claim and `size` comments on it. */
export const seedClaimCommentScaling = async ({
  db,
  size,
  grantFeature,
}: SeedClaimCommentScalingOptions): Promise<ClaimCommentScalingFixture> => {
  const ids = {
    organizationId: toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`),
    userId: toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`),
    workspaceId: createSafeId<"workspace">(),
    runId: createSafeId<"legalListVerificationRun">(),
    claimId: createSafeId<"legalListClaim">(),
  };
  const entityId = createSafeId<"entity">();
  await db.insert(organization).values({
    id: ids.organizationId,
    name: "Claim comment scaling firm",
    slug: ids.organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: ids.userId,
    name: "Reviewer",
    email: `${ids.userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    userId: ids.userId,
    organizationId: ids.organizationId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: ids.workspaceId,
    organizationId: ids.organizationId,
    name: "Claim comment scaling matter",
    reference: ids.workspaceId,
  });
  await db.insert(entities).values({
    id: entityId,
    workspaceId: ids.workspaceId,
    name: "Verified document",
  });
  await db.insert(legalListVerificationRuns).values({
    id: ids.runId,
    organizationId: ids.organizationId,
    workspaceId: ids.workspaceId,
    entityId,
    fileFieldId: createSafeId<"field">(),
    entityVersionId: createSafeId<"entityVersion">(),
    contentSha256: "a".repeat(64),
    status: "completed",
    evidence: { listId: createSafeId<"legalList">(), facts: [] },
  });
  await createScopedDb(
    markRlsDatabase(db),
    [ids.workspaceId],
    ids.organizationId,
    ids.userId,
  )(
    async (tx) =>
      await tx.insert(legalListClaims).values({
        id: ids.claimId,
        runId: ids.runId,
        workspaceId: ids.workspaceId,
        position: 0,
        type: "fact",
        framing: "asserted",
        state: "nocover",
        text: "The parties met on 4 March.",
        anchor: { type: "docx-block", blockId: "p1", start: 0, end: 27 },
      }),
  );
  grantFeature(ids.organizationId);
  const tenant: ClaimCommentTenant = {
    ...ids,
    featureAccessSnapshot: await createScopedDb(
      markRlsDatabase(db),
      [ids.workspaceId],
      ids.organizationId,
      ids.userId,
    )(
      async (tx) =>
        await resolveFeatureAccessSnapshot({
          tx,
          organizationId: ids.organizationId,
          userId: ids.userId,
        }),
    ),
  };
  const commentIds: SafeId<"legalReaderAnnotation">[] = [];
  for (let index = 0; index < size; index += 1) {
    commentIds.push(createdId(await createComment(db, tenant)));
  }
  return {
    db,
    tenant,
    commentIds,
    cleanup: async () => {
      await db
        .delete(organization)
        .where(eq(organization.id, tenant.organizationId));
      await db.delete(user).where(eq(user.id, tenant.userId));
    },
  };
};

const commentAt = (
  fixture: ClaimCommentScalingFixture,
  index: number,
): SafeId<"legalReaderAnnotation"> =>
  fixture.commentIds.at(index) ??
  panic("Claim comment scaling requires seeded comments");

/**
 * The claim comment routes, measured on the mounted handlers. The list reads
 * one fixed page; each write touches one comment however many the claim holds.
 */
export const claimCommentScalingScenarios = [
  {
    name: "claim comment list",
    expectedRows: PAGE_SIZE,
    definition: listClaimComments,
    measure: async ({ db, tenant }: ClaimCommentScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listClaimComments.handler(
          createTestHandlerContext<
            Parameters<typeof listClaimComments.handler>[0]
          >({
            ...handlerContext(db, tenant),
            query: {
              runId: tenant.runId,
              claimId: tenant.claimId,
              limit: PAGE_SIZE,
            },
          }),
        );
        if (!("items" in response)) {
          return panic("Claim comment list scaling requires a comment page");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.items.length,
        };
      }),
  },
  {
    name: "claim comment create",
    expectedRows: 1,
    definition: createClaimComment,
    measure: async ({ db, tenant }: ClaimCommentScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await createComment(db, tenant);
        createdId(response);
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "claim comment update",
    expectedRows: 1,
    definition: updateClaimComment,
    measure: async (fixture: ClaimCommentScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await updateClaimComment.handler(
          createTestHandlerContext<
            Parameters<typeof updateClaimComment.handler>[0]
          >({
            ...handlerContext(fixture.db, fixture.tenant),
            params: {
              workspaceId: fixture.tenant.workspaceId,
              annotationId: commentAt(fixture, 0),
            },
            body: { change: "body", body: "Checked against the minutes." },
          }),
        );
        requireOk(response, "Claim comment update");
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
  {
    name: "claim comment delete",
    expectedRows: 1,
    definition: deleteClaimComment,
    measure: async (fixture: ClaimCommentScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await deleteClaimComment.handler(
          createTestHandlerContext<
            Parameters<typeof deleteClaimComment.handler>[0]
          >({
            ...handlerContext(fixture.db, fixture.tenant),
            params: {
              workspaceId: fixture.tenant.workspaceId,
              annotationId: commentAt(fixture, -1),
            },
          }),
        );
        requireOk(response, "Claim comment delete");
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      }),
  },
];
