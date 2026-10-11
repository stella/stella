import type { SQL, Subquery } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import type { Transaction } from "@/api/db/root";
import {
  legalListClaims,
  legalListGenerationCandidateSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateSetQuery } from "@/api/lib/db/aggregate-lock";
import type { RowLockMode } from "@/api/lib/db/aggregate-lock";

type FixtureStatement = {
  toSQL: () => { sql: string; params: unknown[] };
  as: (alias: string) => Subquery;
  for: (mode: RowLockMode) => {
    toSQL: () => { sql: string; params: unknown[] };
  };
};

type FixtureQuery = {
  toSQL: () => { sql: string; params: unknown[] };
  as: (alias: string) => Subquery;
  where: (predicate: SQL) => {
    orderBy: (
      order: SQL,
    ) => FixtureStatement & { limit: (limit: number) => FixtureStatement };
  };
};

/** Keep genuine SDK SQL and projection metadata; replace only the execution boundary. */
type SetQueryAdapterOptions<Row> = {
  query: FixtureQuery;
  rows: Row[];
  statements: { sql: string; params: unknown[] }[];
  ordering?: "ordered" | "unordered";
};
export const setQueryAdapter = <Row>({
  query,
  rows,
  statements,
  ordering = "ordered",
}: SetQueryAdapterOptions<Row>) => ({
  execute: () => Promise.resolve(rows),
  toSQL: () => query.toSQL(),
  as: (alias: string) => query.as(alias),
  where: (predicate: SQL) => ({
    orderBy: (order: SQL) => {
      const ordered = query.where(predicate).orderBy(order);
      const adapt = (scoped: FixtureStatement) => ({
        toSQL: () => {
          const statement = scoped.toSQL();
          return ordering === "unordered"
            ? {
                ...statement,
                sql: statement.sql.replace(/ order by .*?(?= limit |$)/u, ""),
              }
            : statement;
        },
        as: (alias: string) => scoped.as(alias),
        for: async (mode: RowLockMode) => {
          statements.push(scoped.for(mode).toSQL());
          return await Promise.resolve(rows);
        },
      });
      return {
        ...adapt(ordered),
        limit: (limit: number) => adapt(ordered.limit(limit)),
      };
    },
  }),
});

export const listSetFixture = () => {
  const workspaceId = createSafeId<"workspace">();
  const listId = createSafeId<"legalList">();
  const runId = createSafeId<"legalListGenerationRun">();
  const candidateId = createSafeId<"legalListGenerationCandidate">();
  const verificationRunId = createSafeId<"legalListVerificationRun">();
  const sourceScope = { workspaceId, listId, runId, candidateId };
  const claimScope = { workspaceId, runId: verificationRunId };
  const sourceRows = [
    createSafeId<"legalListGenerationCandidateSource">(),
    createSafeId<"legalListGenerationCandidateSource">(),
  ]
    .toSorted()
    .map((id) => ({ id, ...sourceScope }));
  const claimRows = [
    createSafeId<"legalListClaim">(),
    createSafeId<"legalListClaim">(),
  ]
    .toSorted()
    .map((id) => ({ id, ...claimScope }));
  const sourceQuery = () =>
    drizzle
      .mock()
      .select({
        id: legalListGenerationCandidateSources.id,
        workspaceId: legalListGenerationCandidateSources.workspaceId,
        listId: legalListGenerationCandidateSources.listId,
        runId: legalListGenerationCandidateSources.runId,
        candidateId: legalListGenerationCandidateSources.candidateId,
      })
      .from(legalListGenerationCandidateSources);
  const claimQuery = () =>
    drizzle
      .mock()
      .select({
        id: legalListClaims.id,
        workspaceId: legalListClaims.workspaceId,
        runId: legalListClaims.runId,
      })
      .from(legalListClaims);
  return {
    sourceScope,
    claimScope,
    sourceRows,
    claimRows,
    sourceQuery,
    claimQuery,
  };
};

export const plantedUnorderedSetQuery = async (
  tx: Transaction,
  statements: { sql: string; params: unknown[] }[],
) => {
  const fixture = listSetFixture();
  return await withAggregateSetQuery({
    tx,
    aggregate: "listGenerationSource",
    scope: fixture.sourceScope,
    mode: "update",
    select: () =>
      setQueryAdapter({
        query: fixture.sourceQuery(),
        rows: fixture.sourceRows,
        statements,
        ordering: "unordered",
      }),
  });
};
