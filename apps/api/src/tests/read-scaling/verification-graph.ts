import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  legalListClaims,
  legalListItems,
  legalLists,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import exportVerificationChronology from "@/api/handlers/lists/verifications/chronology/export";
import readVerificationGraph from "@/api/handlers/lists/verifications/graph/get";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import type { VerificationEvidenceFact } from "@/api/lib/lists/verification/contract";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

/** Claims one page carries; each document has `CLAIMS_PER_DOCUMENT`, so a
 *  page holds the same documents however many the list has. */
const PAGE_SIZE = 10;
const CLAIMS_PER_DOCUMENT = 2;
const FACTS = 4;

type GraphTenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  listId: SafeId<"legalList">;
  /** The request's feature decisions, resolved once as the auth plugin does. */
  featureAccessSnapshot: FeatureAccessSnapshot;
};

export type VerificationGraphScalingFixture = {
  db: GatedTestDb;
  tenant: GraphTenant;
  cleanup: () => Promise<void>;
};

type SeedOptions = {
  db: GatedTestDb;
  /** Documents verified in the matter. */
  size: number;
  /** How many of them were verified against the list; the rest against
   *  another list of the matter. All of them when absent. */
  listDocuments?: number;
  /** Grants the verification feature to the seeded organization. */
  grantFeature: (organizationId: SafeId<"organization">) => void;
};

/** One matter whose list of four facts `size` documents were verified
 *  against, each with two claims citing them. */
export const seedVerificationGraphScaling = async ({
  db,
  size,
  listDocuments = size,
  grantFeature,
}: SeedOptions): Promise<VerificationGraphScalingFixture> => {
  const ids = {
    organizationId: toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`),
    userId: toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`),
    workspaceId: createSafeId<"workspace">(),
    listId: createSafeId<"legalList">(),
  };
  const otherListId = createSafeId<"legalList">();
  await db.insert(organization).values({
    id: ids.organizationId,
    name: "Verification graph scaling firm",
    slug: ids.organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: ids.userId,
    name: "Reader",
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
    name: "Verification graph scaling matter",
    reference: ids.workspaceId,
  });
  await db.insert(legalLists).values([
    {
      id: ids.listId,
      workspaceId: ids.workspaceId,
      name: "Chronology",
      createdBy: ids.userId,
    },
    {
      id: otherListId,
      workspaceId: ids.workspaceId,
      name: "Another chronology",
      createdBy: ids.userId,
    },
  ]);
  const factIds = Array.from({ length: FACTS }, () => createSafeId<"entity">());
  await db.insert(entities).values(
    factIds.map((id, index) => ({
      id,
      workspaceId: ids.workspaceId,
      kind: "task" as const,
      listItemType: LIST_ITEM_TYPE.FACT,
      name: `Fact ${String(index)}`,
      createdBy: ids.userId,
      agendaKind: "task" as const,
      status: "open" as const,
      priority: "none" as const,
      agendaSource: "manual" as const,
    })),
  );
  await db.insert(legalListItems).values(
    factIds.map((id, index) => ({
      entityId: id,
      workspaceId: ids.workspaceId,
      listId: ids.listId,
      position: String.fromCodePoint(97 + index),
      addedBy: ids.userId,
    })),
  );
  const pinned = factIds.map(
    (factEntityId, index): VerificationEvidenceFact => ({
      factEntityId,
      text: `Fact ${String(index)}`,
      occurredOn: null,
      occurredOnPrecision: null,
      evidenceKind: null,
      medium: null,
      confidence: "high",
      interpretationNote: null,
      sources: [],
    }),
  );
  const documentIds = Array.from({ length: size }, () =>
    createSafeId<"entity">(),
  );
  await db.insert(entities).values(
    documentIds.map((id, index) => ({
      id,
      workspaceId: ids.workspaceId,
      kind: "document" as const,
      name: `Statement ${String(index)}.docx`,
      createdBy: ids.userId,
    })),
  );
  const runIds = documentIds.map(() =>
    createSafeId<"legalListVerificationRun">(),
  );
  await db.insert(legalListVerificationRuns).values(
    documentIds.map((entityId, index) => ({
      id: runIds[index] ?? panic("A seeded document has no run"),
      organizationId: ids.organizationId,
      workspaceId: ids.workspaceId,
      entityId,
      fileFieldId: createSafeId<"field">(),
      entityVersionId: createSafeId<"entityVersion">(),
      contentSha256: "c".repeat(64),
      status: "completed" as const,
      evidence: {
        listId: index < listDocuments ? ids.listId : otherListId,
        facts: pinned,
      },
    })),
  );
  await createScopedDb(
    markRlsDatabase(db),
    [ids.workspaceId],
    ids.organizationId,
    ids.userId,
  )(async (tx) => {
    await tx.insert(legalListClaims).values(
      runIds.flatMap((runId) =>
        Array.from({ length: CLAIMS_PER_DOCUMENT }, (_, position) => ({
          id: createSafeId<"legalListClaim">(),
          runId,
          workspaceId: ids.workspaceId,
          position,
          type: "fact" as const,
          framing: "asserted" as const,
          state: "supported" as const,
          score: 90,
          text: `Claim ${String(position)}`,
          anchor: {
            type: "docx-block" as const,
            blockId: "p1",
            start: 0,
            end: 5,
          },
          refs: [
            {
              factEntityId:
                factIds[position % FACTS] ?? panic("No seeded fact"),
              rel: "supports" as const,
            },
          ],
        })),
      ),
    );
  });
  grantFeature(ids.organizationId);
  const tenant: GraphTenant = {
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
 * The list's verification graph, measured on the mounted handler: one page
 * of a fixed claim budget, which reads the same documents however many were
 * verified against the list.
 */
export const verificationGraphScalingScenarios = [
  {
    name: "list verification graph",
    expectedRows: PAGE_SIZE,
    definition: readVerificationGraph,
    measure: async ({ db, tenant }: VerificationGraphScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await readVerificationGraph.handler(
          createTestHandlerContext<
            Parameters<typeof readVerificationGraph.handler>[0]
          >({
            scopedDb: NO_DB,
            // The page is a delivery of its runs' claims, so it is audited.
            audit: createAuditRecorder({
              organizationId: tenant.organizationId,
              workspaceId: tenant.workspaceId,
              userId: tenant.userId,
              request: new Request("https://example.test/verifications/graph"),
              server: null,
            }),
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
            query: { listId: tenant.listId, limit: PAGE_SIZE },
          }),
        );
        if (!("claims" in response)) {
          return panic("Verification graph scaling requires a graph page");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: response.claims.length,
        };
      }),
  },
];

/** Documents verified against the exported list; the matter's other
 *  verified documents were checked against another list. */
export const CHRONOLOGY_LIST_DOCUMENTS = 3;

/**
 * The list's chronology export, measured on the mounted handler: a row per
 * fact of the list, read through every page of its graph. A list's own
 * verified documents are bounded by the export's page limit (past it the
 * export is refused); what must not grow its cost is everything else the
 * matter verified.
 */
export const verificationChronologyScalingScenarios = [
  {
    name: "list verification chronology export",
    expectedRows: FACTS,
    definition: exportVerificationChronology,
    measure: async ({ db, tenant }: VerificationGraphScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const recorder = createAuditRecorder({
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          userId: tenant.userId,
          request: new Request(
            "https://example.test/verifications/chronology/export",
          ),
          server: null,
        });
        // The download's audit names the rows the file holds.
        let rows = 0;
        const audit: AuditRecorder = async (tx, event) => {
          for (const entry of Array.isArray(event) ? event : [event]) {
            const rowCount = entry.metadata?.["rowCount"];
            if (typeof rowCount === "number") {
              rows = rowCount;
            }
          }
          await recorder(tx, event);
        };
        const response = await exportVerificationChronology.handler(
          createTestHandlerContext<
            Parameters<typeof exportVerificationChronology.handler>[0]
          >({
            scopedDb: NO_DB,
            audit,
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
            query: { listId: tenant.listId, format: "csv" },
          }),
        );
        if (!(response instanceof Response)) {
          return panic("Chronology export scaling requires a file");
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(await response.text()),
          rows,
        };
      }),
  },
];
