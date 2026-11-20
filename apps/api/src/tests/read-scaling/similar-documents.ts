import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import readSimilarDocuments from "@/api/handlers/entities/similar/list";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { recordNearDuplicateSignature } from "@/api/lib/uploads/near-duplicates/record-signature";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const CONTRACT = Array.from(
  { length: 12 },
  (_, clause) =>
    `Clause ${clause}: the Supplier shall deliver the Goods to the Customer at the agreed address and the Customer shall pay the price within thirty days.`,
).join("\n");

/** Copies of the contract, each with one changed word: always reported. */
const NEAR_DUPLICATES = ["sixty", "forty", "ninety"].map((days) =>
  CONTRACT.replace("thirty days.\nClause 5", () => `${days} days.\nClause 5`),
);

/** A document that shares no shingle with the contract or another filler. */
const unrelatedText = (index: number) =>
  Array.from({ length: 60 }, (_, word) => `filler${index}w${word}`).join(" ");

type SimilarDocumentsTenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  /** The request's feature decisions, resolved once as the auth plugin does. */
  featureAccessSnapshot: FeatureAccessSnapshot;
};

export type SimilarDocumentsScalingFixture = {
  db: GatedTestDb;
  tenant: SimilarDocumentsTenant;
  cleanup: () => Promise<void>;
};

const seedDocument = async (
  db: GatedTestDb,
  tenant: Omit<SimilarDocumentsTenant, "entityId" | "featureAccessSnapshot">,
  docSequence: number,
  text: string,
): Promise<SafeId<"entity">> => {
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  await db.insert(entities).values({
    id: entityId,
    workspaceId: tenant.workspaceId,
    name: `Document ${docSequence}`,
    docSequence,
  });
  await db.insert(entityVersions).values({
    id: entityVersionId,
    entityId,
    workspaceId: tenant.workspaceId,
  });
  await recordNearDuplicateSignature(
    asTestRaw<Parameters<typeof recordNearDuplicateSignature>[0]>(db),
    {
      entityId,
      entityVersionId,
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      text,
    },
  );
  await db
    .update(entities)
    .set({ currentVersionId: entityVersionId })
    .where(eq(entities.id, entityId));
  return entityId;
};

type SeedSimilarDocumentsScalingOptions = {
  db: GatedTestDb;
  size: number;
};

/** One matter: a contract, three near copies of it, and `size` unrelated documents. */
export const seedSimilarDocumentsScaling = async ({
  db,
  size,
}: SeedSimilarDocumentsScalingOptions): Promise<SimilarDocumentsScalingFixture> => {
  const ids = {
    organizationId: toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`),
    userId: toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`),
    workspaceId: createSafeId<"workspace">(),
  };
  await db.insert(organization).values({
    id: ids.organizationId,
    name: "Similar documents scaling firm",
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
    name: "Similar documents scaling matter",
    reference: ids.workspaceId,
  });
  let docSequence = 0;
  const entityId = await seedDocument(db, ids, ++docSequence, CONTRACT);
  for (const text of NEAR_DUPLICATES) {
    await seedDocument(db, ids, ++docSequence, text);
  }
  for (let index = 0; index < size; index += 1) {
    await seedDocument(db, ids, ++docSequence, unrelatedText(index));
  }
  const featureAccessSnapshot = await createScopedDb(
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
  );
  return {
    db,
    tenant: { ...ids, entityId, featureAccessSnapshot },
    cleanup: async () => {
      await deleteOrganizationsForTest(db, [ids.organizationId]);
      await db.delete(user).where(eq(user.id, ids.userId));
    },
  };
};

/**
 * The similar-documents read: the document's own signature, then one bounded
 * band-key lookup, however many documents the matter holds.
 */
export const similarDocumentsScalingScenarios = [
  {
    name: "similar documents list",
    expectedRows: NEAR_DUPLICATES.length,
    definition: readSimilarDocuments,
    measure: async ({ db, tenant }: SimilarDocumentsScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readSimilarDocuments.handler(
          createTestHandlerContext<
            Parameters<typeof readSimilarDocuments.handler>[0]
          >({
            scopedDb: NO_DB,
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
            audit: createAuditRecorder({
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              userId: tenant.userId,
              request: new Request("https://example.test/similar-documents"),
              server: null,
            }),
            params: {
              workspaceId: tenant.workspaceId,
              entityId: tenant.entityId,
            },
          }),
        );
        if (!("documents" in response)) {
          return panic("Similar documents scaling requires a document list");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.documents.length,
        };
      }),
  },
];
