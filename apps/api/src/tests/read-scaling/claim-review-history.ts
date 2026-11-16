import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import listClaimReviews from "@/api/handlers/lists/verifications/claim-reviews/list";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

/** The fixed page the scenario reads, however long the history is. */
const PAGE_SIZE = 10;

type ReviewHistoryTenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  /** The request's feature decisions, resolved once as the auth plugin does. */
  featureAccessSnapshot: FeatureAccessSnapshot;
};

export type ReviewHistoryScalingFixture = {
  db: GatedTestDb;
  tenant: ReviewHistoryTenant;
  cleanup: () => Promise<void>;
};

type SeedReviewHistoryScalingOptions = {
  db: GatedTestDb;
  /** Claims on the run, each with one review action. */
  size: number;
  /** Grants the verification feature to the seeded organization. */
  grantFeature: (organizationId: SafeId<"organization">) => void;
};

/** One matter with a completed run of `size` claims, each reviewed once. */
export const seedReviewHistoryScaling = async ({
  db,
  size,
  grantFeature,
}: SeedReviewHistoryScalingOptions): Promise<ReviewHistoryScalingFixture> => {
  const ids = {
    organizationId: toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`),
    userId: toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`),
    workspaceId: createSafeId<"workspace">(),
    runId: createSafeId<"legalListVerificationRun">(),
  };
  const entityId = createSafeId<"entity">();
  await db.insert(organization).values({
    id: ids.organizationId,
    name: "Review history scaling firm",
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
    name: "Review history scaling matter",
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
    contentSha256: "b".repeat(64),
    status: "completed",
    evidence: { listId: createSafeId<"legalList">(), facts: [] },
  });
  const claimIds = Array.from({ length: size }, () =>
    createSafeId<"legalListClaim">(),
  );
  await createScopedDb(
    markRlsDatabase(db),
    [ids.workspaceId],
    ids.organizationId,
    ids.userId,
  )(async (tx) => {
    await tx.insert(legalListClaims).values(
      claimIds.map((id, position) => ({
        id,
        runId: ids.runId,
        workspaceId: ids.workspaceId,
        position,
        type: "fact" as const,
        framing: "asserted" as const,
        state: "nocover" as const,
        text: `Claim ${String(position)}`,
        anchor: {
          type: "docx-block" as const,
          blockId: "p1",
          start: 0,
          end: 5,
        },
      })),
    );
    await tx.insert(legalListClaimReviewEvents).values(
      claimIds.map((claimId) => ({
        id: createSafeId<"legalListClaimReviewEvent">(),
        workspaceId: ids.workspaceId,
        runId: ids.runId,
        claimId,
        kind: "status" as const,
        payload: {
          kind: "status" as const,
          status: "needs-evidence" as const,
          origin: "single" as const,
        },
        actorId: ids.userId,
      })),
    );
  });
  grantFeature(ids.organizationId);
  const tenant: ReviewHistoryTenant = {
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
  return {
    db,
    tenant,
    cleanup: async () => {
      await deleteOrganizationsForTest(db, [tenant.organizationId]);
      await db.delete(user).where(eq(user.id, tenant.userId));
    },
  };
};

/**
 * The run's review history, measured on the mounted handler: one fixed page,
 * whose fold reads only the claims on that page, however many the run has.
 */
export const reviewHistoryScalingScenarios = [
  {
    name: "claim review history",
    expectedRows: PAGE_SIZE,
    definition: listClaimReviews,
    measure: async ({ db, tenant }: ReviewHistoryScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listClaimReviews.handler(
          createTestHandlerContext<
            Parameters<typeof listClaimReviews.handler>[0]
          >({
            scopedDb: NO_DB,
            // A read records nothing.
            audit: NO_AUDIT,
            workspaceId: tenant.workspaceId,
            session: { activeOrganizationId: tenant.organizationId },
            user: { id: tenant.userId },
            featureAccessSnapshot: tenant.featureAccessSnapshot,
            safeDb: createMembershipSafeDb(markRlsDatabase(db), {
              organizationId: tenant.organizationId,
              serverValidatedWorkspaceIds: [tenant.workspaceId],
              userId: tenant.userId,
              featureAccessSnapshot: tenant.featureAccessSnapshot,
            }),
            query: { runId: tenant.runId, limit: PAGE_SIZE },
          }),
        );
        if (!("items" in response)) {
          return panic("Review history scaling requires a history page");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.items.length,
        };
      }),
  },
];
