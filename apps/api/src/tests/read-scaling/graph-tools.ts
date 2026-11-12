import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  legalListClaims,
  legalListItems,
  legalListItemSources,
  legalLists,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createScopedDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import listGraphNeighbours from "@/api/handlers/lists/graph/neighbours/list";
import listGraphNodes from "@/api/handlers/lists/graph/nodes/list";
import listGraphPaths from "@/api/handlers/lists/graph/paths/list";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { writeGraphEdges } from "@/api/lib/lists/graph/edge-writer";
import { isRecord } from "@/api/lib/type-guards";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

/** The fixed page every scenario reads, however many claims cite the fact. */
const PAGE_SIZE = 10;
const FACT_NAME = "The cargo survey found water damage in hold 2";

type GraphTenant = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  factId: SafeId<"entity">;
  documentId: SafeId<"entity">;
  featureAccessSnapshot: FeatureAccessSnapshot;
};

export type GraphToolsScalingFixture = {
  db: GatedTestDb;
  tenant: GraphTenant;
  cleanup: () => Promise<void>;
};

const handlerContext = (db: GatedTestDb, tenant: GraphTenant) => ({
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
    request: new Request("https://example.test/graph"),
    server: null,
  }),
});

/**
 * One matter where `size` claims of one verified statement cite one fact,
 * sourced from one document passage, with the edges the writers derive.
 */
export const seedGraphToolsScaling = async ({
  db,
  size,
  grantFeature,
}: {
  db: GatedTestDb;
  size: number;
  grantFeature: (organizationId: SafeId<"organization">) => void;
}): Promise<GraphToolsScalingFixture> => {
  const ids = {
    organizationId: toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`),
    userId: toSafeId<"user">(`usr_${Bun.randomUUIDv7()}`),
    workspaceId: createSafeId<"workspace">(),
    factId: createSafeId<"entity">(),
    documentId: createSafeId<"entity">(),
  };
  const listId = createSafeId<"legalList">();
  const statementId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const sourceId = createSafeId<"legalListItemSource">();
  const runId = createSafeId<"legalListVerificationRun">();
  const seededAt = new Date("2026-11-01T09:00:00Z");
  await db.insert(organization).values({
    id: ids.organizationId,
    name: "Graph scaling firm",
    slug: ids.organizationId,
    createdAt: seededAt,
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
    createdAt: seededAt,
  });
  await db.insert(workspaces).values({
    id: ids.workspaceId,
    organizationId: ids.organizationId,
    name: "Graph scaling matter",
    reference: ids.workspaceId,
  });
  await db.insert(legalLists).values({
    id: listId,
    workspaceId: ids.workspaceId,
    name: "Chronology",
    createdBy: ids.userId,
  });
  await db.insert(entities).values([
    {
      id: ids.factId,
      workspaceId: ids.workspaceId,
      kind: "task",
      listItemType: LIST_ITEM_TYPE.FACT,
      name: FACT_NAME,
      createdBy: ids.userId,
      agendaKind: "task",
      status: "open",
      priority: "none",
      agendaSource: "manual",
    },
    {
      id: ids.documentId,
      workspaceId: ids.workspaceId,
      kind: "document",
      name: "Survey report.pdf",
      createdBy: ids.userId,
    },
    {
      id: statementId,
      workspaceId: ids.workspaceId,
      kind: "document",
      name: "Witness statement.docx",
      createdBy: ids.userId,
    },
  ]);
  await db.insert(entityVersions).values({
    id: versionId,
    workspaceId: ids.workspaceId,
    entityId: ids.documentId,
  });
  await db.insert(legalListItems).values({
    entityId: ids.factId,
    workspaceId: ids.workspaceId,
    listId,
    position: "a",
    addedBy: ids.userId,
  });
  await db.insert(legalListItemSources).values({
    id: sourceId,
    workspaceId: ids.workspaceId,
    listId,
    itemEntityId: ids.factId,
    sourceEntityId: ids.documentId,
    sourceEntityVersionId: versionId,
    locator: { type: "pdf-page", pageNumber: 3 },
    quote: "Hold 2: seawater ingress, 41 pallets wet.",
    createdBy: ids.userId,
  });
  await db.insert(legalListVerificationRuns).values({
    id: runId,
    organizationId: ids.organizationId,
    workspaceId: ids.workspaceId,
    entityId: statementId,
    fileFieldId: createSafeId<"field">(),
    entityVersionId: createSafeId<"entityVersion">(),
    contentSha256: "a".repeat(64),
    status: "completed",
    evidence: { listId, facts: [] },
  });
  const scoped = createScopedDb(
    markRlsDatabase(db),
    [ids.workspaceId],
    ids.organizationId,
    ids.userId,
  );
  grantFeature(ids.organizationId);
  await scoped(async (tx) => {
    await tx.insert(legalListClaims).values(
      Array.from({ length: size }, (_, position) => ({
        id: createSafeId<"legalListClaim">(),
        runId,
        workspaceId: ids.workspaceId,
        position,
        type: "fact" as const,
        state: "contradicted" as const,
        score: 10,
        text: `The cargo was sound at discharge (${String(position)}).`,
        anchor: {
          type: "docx-block" as const,
          blockId: `p${String(position)}`,
          start: 0,
          end: 10,
        },
        refs: [{ factEntityId: ids.factId, rel: "conflicts" as const }],
      })),
    );
    await writeGraphEdges(tx, ids.workspaceId, { type: "run", runId });
    await writeGraphEdges(tx, ids.workspaceId, {
      type: "fact-sources",
      sourceIds: [sourceId],
      producer: { type: "reviewer" },
    });
  });
  const tenant: GraphTenant = {
    ...ids,
    featureAccessSnapshot: await scoped(
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

const rowsOf = (response: unknown, field: string, scenario: string) => {
  const rows = isRecord(response) ? response[field] : undefined;
  return Array.isArray(rows)
    ? rows.length
    : panic(`${scenario} scaling requires a ${field} page`);
};

/**
 * The graph tools, measured on the mounted handlers: each reads one fixed
 * page however many claims cite the fact.
 */
export const graphToolsScalingScenarios = [
  {
    name: "graph node lookup",
    expectedRows: 1,
    definition: listGraphNodes,
    measure: async ({ db, tenant }: GraphToolsScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listGraphNodes.handler(
          createTestHandlerContext<
            Parameters<typeof listGraphNodes.handler>[0]
          >({
            ...handlerContext(db, tenant),
            query: { text: "water damage", limit: PAGE_SIZE },
          }),
        );
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: rowsOf(response, "nodes", "Graph node lookup"),
        };
      }),
  },
  {
    name: "graph neighbours",
    expectedRows: PAGE_SIZE,
    definition: listGraphNeighbours,
    measure: async ({ db, tenant }: GraphToolsScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listGraphNeighbours.handler(
          createTestHandlerContext<
            Parameters<typeof listGraphNeighbours.handler>[0]
          >({
            ...handlerContext(db, tenant),
            query: {
              nodeKind: "fact",
              nodeId: tenant.factId,
              limit: PAGE_SIZE,
            },
          }),
        );
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: rowsOf(response, "edges", "Graph neighbours"),
        };
      }),
  },
  {
    name: "graph paths",
    expectedRows: PAGE_SIZE,
    definition: listGraphPaths,
    measure: async ({ db, tenant }: GraphToolsScalingFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await listGraphPaths.handler(
          createTestHandlerContext<
            Parameters<typeof listGraphPaths.handler>[0]
          >({
            ...handlerContext(db, tenant),
            query: {
              nodeKind: "document",
              nodeId: tenant.documentId,
              depth: 2,
              limit: PAGE_SIZE,
            },
          }),
        );
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: rowsOf(response, "paths", "Graph paths"),
        };
      }),
  },
];
