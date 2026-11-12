/**
 * Seeds the graph tools' synthetic case (`evals/lib/graph-tools-case.ts`)
 * into one matter and derives its edges through the production writers, so
 * the handler tests and the eval read the same graph.
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
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
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { writeGraphEdges } from "@/api/lib/lists/graph/edge-writer";
import { writeFactSourceEdges } from "@/api/lib/lists/graph/fact-source-edges";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedQuery } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { GRAPH_CASE } from "../../../evals/lib/graph-tools-case";

const FIXTURE_TIME = new Date("2026-11-01T09:00:00Z");

const asOwner = async <T>(
  db: TestDatabase,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx: TestDatabaseTransaction) => {
    await tx.execute(sql.raw("RESET ROLE"));
    return await fn(asTestRaw<Transaction>(tx));
  });

/** The organization and its one verified member every case is read by. */
export const seedGraphReviewer = async ({
  db,
  organizationId,
  userId,
}: {
  db: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}): Promise<void> => {
  await asOwner(db, async (tx) => {
    await tx.insert(organization).values({
      id: organizationId,
      name: "Graph case firm",
      slug: `graph-case-${Bun.randomUUIDv7()}`,
      createdAt: FIXTURE_TIME,
    });
    await tx.insert(user).values({
      id: userId,
      name: "Graph Case Reviewer",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    // Feature access reads the reviewer's membership.
    await tx.insert(member).values({
      id: `member_${Bun.randomUUIDv7()}`,
      organizationId,
      userId,
      role: "owner",
      createdAt: FIXTURE_TIME,
    });
  });
};

export type SeededGraphCase = {
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
  statementId: SafeId<"entity">;
  facts: Record<(typeof GRAPH_CASE.facts)[number]["key"], SafeId<"entity">>;
  claims: Record<
    (typeof GRAPH_CASE.claims)[number]["key"],
    SafeId<"legalListClaim">
  >;
  documents: Record<(typeof GRAPH_CASE.facts)[number]["key"], SafeId<"entity">>;
};

/**
 * Writes the rows as the owner, then runs the edge writers as the
 * application role in the seeded matter, as production writes them.
 */
export const seedGraphCase = async ({
  db,
  organizationId,
  userId,
  workspaceId,
  reference,
}: {
  db: TestDatabase;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  reference: string;
}): Promise<SeededGraphCase> => {
  const root = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    await asOwner(db, fn);
  const scoped = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    await createScopedQuery(db)(
      [workspaceId],
      organizationId,
      async (tx) => await fn(asTestRaw<Transaction>(tx)),
      userId,
    );
  const listId = createSafeId<"legalList">();
  const runId = createSafeId<"legalListVerificationRun">();
  const statementId = createSafeId<"entity">();
  const statementVersionId = createSafeId<"entityVersion">();
  const facts = GRAPH_CASE.facts.map((fact) => ({
    ...fact,
    id: createSafeId<"entity">(),
    documentId: createSafeId<"entity">(),
    versionId: createSafeId<"entityVersion">(),
    sourceId: createSafeId<"legalListItemSource">(),
  }));
  const factIds = new Map(facts.map((fact) => [fact.key, fact.id] as const));
  const claims = GRAPH_CASE.claims.map((claim) => ({
    ...claim,
    id: createSafeId<"legalListClaim">(),
  }));
  await root(async (tx) => {
    await tx.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Harbourline v Larkspur Trading",
      reference,
    });
    await tx.insert(legalLists).values({
      id: listId,
      workspaceId,
      name: "Chronology",
      createdBy: userId,
    });
    await tx.insert(entities).values([
      ...facts.map((fact) => ({
        id: fact.id,
        workspaceId,
        kind: "task" as const,
        listItemType: LIST_ITEM_TYPE.FACT,
        name: fact.name,
        createdBy: userId,
        agendaKind: "task" as const,
        status: "open" as const,
        priority: "none" as const,
        agendaSource: "manual" as const,
      })),
      ...facts.map((fact) => ({
        id: fact.documentId,
        workspaceId,
        kind: "document" as const,
        name: fact.document,
        createdBy: userId,
      })),
      {
        id: statementId,
        workspaceId,
        kind: "document" as const,
        name: GRAPH_CASE.statement,
        createdBy: userId,
      },
    ]);
    await tx.insert(entityVersions).values([
      ...facts.map((fact) => ({
        id: fact.versionId,
        workspaceId,
        entityId: fact.documentId,
      })),
      { id: statementVersionId, workspaceId, entityId: statementId },
    ]);
    await tx.insert(legalListItems).values(
      facts.map((fact, index) => ({
        entityId: fact.id,
        workspaceId,
        listId,
        position: String.fromCodePoint(97 + index),
        addedBy: userId,
      })),
    );
    await tx.insert(legalListItemSources).values(
      facts.map((fact) => ({
        id: fact.sourceId,
        workspaceId,
        listId,
        itemEntityId: fact.id,
        sourceEntityId: fact.documentId,
        sourceEntityVersionId: fact.versionId,
        locator: { type: "pdf-page" as const, pageNumber: 1 },
        quote: fact.quote,
        createdBy: userId,
      })),
    );
    await tx.insert(legalListVerificationRuns).values({
      id: runId,
      organizationId,
      workspaceId,
      entityId: statementId,
      fileFieldId: createSafeId<"field">(),
      entityVersionId: statementVersionId,
      contentSha256: "c".repeat(64),
      evidence: { listId, facts: [] },
      status: "completed",
      pipelineVersion: 3,
    });
    await tx.insert(legalListClaims).values(
      claims.map((claim, position) => {
        const supported = claim.cites.every((cite) => cite.rel !== "conflicts");
        return {
          id: claim.id,
          runId,
          workspaceId,
          position,
          type: "fact" as const,
          state: supported ? ("supported" as const) : ("contradicted" as const),
          score: supported ? 90 : 10,
          text: claim.text,
          anchor: {
            type: "docx-block" as const,
            blockId: `p${String(position)}`,
            start: 0,
            end: claim.text.length,
          },
          refs: claim.cites.map((cite) => ({
            factEntityId: factIds.get(cite.fact) ?? createSafeId<"entity">(),
            rel: cite.rel,
          })),
        };
      }),
    );
  });
  await scoped(async (tx) => {
    await writeGraphEdges(tx, workspaceId, { type: "run", runId });
    await writeFactSourceEdges(tx, workspaceId, {
      type: "fact-sources",
      sourceIds: facts.map((fact) => fact.sourceId),
      producer: { type: "reviewer" },
    });
  });
  const fact = (key: string) =>
    facts.find((seeded) => seeded.key === key) ?? panic(`fact ${key}`);
  const claim = (key: string) =>
    claims.find((seeded) => seeded.key === key)?.id ?? panic(`claim ${key}`);
  return {
    workspaceId,
    runId,
    statementId,
    facts: {
      arrival: fact("arrival").id,
      damage: fact("damage").id,
      payment: fact("payment").id,
    },
    claims: {
      arrived: claim("arrived"),
      undamaged: claim("undamaged"),
      paid: claim("paid"),
    },
    documents: {
      arrival: fact("arrival").documentId,
      damage: fact("damage").documentId,
      payment: fact("payment").documentId,
    },
  };
};
