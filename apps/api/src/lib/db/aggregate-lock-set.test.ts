import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { legalListGenerationCandidateSources } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withAggregateRowQuery,
  withAggregateSetQuery,
} from "@/api/lib/db/aggregate-lock";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  listSetFixture,
  plantedUnorderedSetQuery,
  setQueryAdapter,
} from "./aggregate-lock-set.fixture";

test("a discovered source set preserves all parent membership in one ordered lock and consumes its rank", async () => {
  const fixture = listSetFixture();
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [{ id: "held" }] });
  const result = await withAggregateSetQuery({
    tx,
    aggregate: "listGenerationSource",
    scope: fixture.sourceScope,
    mode: "update",
    where: eq(
      legalListGenerationCandidateSources.candidateId,
      fixture.sourceScope.candidateId,
    ),
    select: () =>
      setQueryAdapter({
        query: fixture.sourceQuery(),
        rows: fixture.sourceRows,
        statements,
      }),
  });
  expect(result).toEqual({ status: "locked", rows: fixture.sourceRows });
  expect(statements).toHaveLength(1);
  expect(statements.at(0)?.sql).toContain("for update");
  expect(statements.at(0)?.sql).toContain(
    'order by "legal_list_generation_candidate_sources"."id" asc',
  );
  expect(statements.at(0)?.sql).not.toContain(" limit ");
  expect(statements.at(0)?.sql).not.toContain('"id" in');
  for (const value of Object.values(fixture.sourceScope)) {
    expect(statements.at(0)?.params).toContain(value);
  }
  expect(
    await rejectionOf(
      withAggregateLock({
        tx,
        aggregate: "listGenerationRun",
        id: {
          id: fixture.sourceScope.runId,
          workspaceId: fixture.sourceScope.workspaceId,
        },
        mode: "update",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
  expect(
    await rejectionOf(
      withAggregateLock({
        tx,
        aggregate: "listGenerationSource",
        id: {
          id: createSafeId<"legalListGenerationCandidateSource">(),
          workspaceId: fixture.sourceScope.workspaceId,
        },
        mode: "update",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
});

test("known claim sets deduplicate requests, lock in physical order, bound the query and retain missing reservations", async () => {
  const fixture = listSetFixture();
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [{ id: "held" }] });
  const ids = fixture.claimRows.map(({ id }) => id).toReversed();
  const first = ids.at(0);
  if (first === undefined) {
    panic("Missing claim fixture");
  }
  ids.push(first);
  const acquire = (rows: typeof fixture.claimRows) =>
    withAggregateSetQuery({
      tx,
      aggregate: "listVerificationClaim",
      scope: fixture.claimScope,
      ids,
      mode: "update",
      select: () =>
        setQueryAdapter({ query: fixture.claimQuery(), rows, statements }),
    });
  const acquired = await acquire(fixture.claimRows);
  expect(acquired.status).toBe("locked");
  expect(acquired.rows.map(({ id }) => id)).toEqual(
    [...new Set(ids)].toSorted(),
  );
  expect(statements).toHaveLength(1);
  expect(statements.at(0)?.sql).toContain("for update");
  expect(statements.at(0)?.sql).toContain(
    'order by "legal_list_claims"."id" asc',
  );
  expect(statements.at(0)?.sql).toContain(" limit ");
  expect(statements.at(0)?.params.at(-1)).toBe(ids.length);
  for (const value of Object.values(fixture.claimScope)) {
    expect(statements.at(0)?.params).toContain(value);
  }
  const reacquired = await acquire(fixture.claimRows);
  expect(reacquired.status).toBe("locked");
  expect(reacquired.rows.map(({ id }) => id)).toEqual(
    [...new Set(ids)].toSorted(),
  );
  expect(statements).toHaveLength(2);
  const missingTx = asTestRaw<Transaction>({
    execute: async () => [{ id: "held" }],
  });
  expect(
    await withAggregateSetQuery({
      tx: missingTx,
      aggregate: "listVerificationClaim",
      scope: fixture.claimScope,
      ids,
      mode: "update",
      select: () =>
        setQueryAdapter({ query: fixture.claimQuery(), rows: [], statements }),
    }),
  ).toEqual({ status: "missing", rows: [] });
  expect(
    await rejectionOf(
      withAggregateLock({
        tx: missingTx,
        aggregate: "listVerificationRun",
        id: {
          id: fixture.claimScope.runId,
          workspaceId: fixture.claimScope.workspaceId,
        },
        mode: "update",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
});

test("a planted unordered set query is rejected before issuing its lock", async () => {
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [] });
  expect(
    await rejectionOf(plantedUnorderedSetQuery(tx, statements)),
  ).toMatchObject({
    message: "Aggregate set query must lock in registered physical order",
  });
  expect(statements).toEqual([]);
});

test("returned source rows cannot claim another tenant or parent", async () => {
  const fixture = listSetFixture();
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [] });
  const rows = fixture.sourceRows.map((row) => ({
    ...row,
    candidateId: createSafeId<"legalListGenerationCandidate">(),
  }));
  expect(
    await rejectionOf(
      withAggregateSetQuery({
        tx,
        aggregate: "listGenerationSource",
        scope: fixture.sourceScope,
        mode: "update",
        select: () =>
          setQueryAdapter({ query: fixture.sourceQuery(), rows, statements }),
      }),
    ),
  ).toMatchObject({
    message: "Aggregate set query returned an undeclared tenant or parent",
  });
  expect(statements).toHaveLength(1);
});

test("known claim queries reject a returned physical order that differs from the declared order", async () => {
  const fixture = listSetFixture();
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [] });
  const rows = fixture.claimRows.toReversed();
  expect(rows).not.toEqual(fixture.claimRows);
  expect(
    await rejectionOf(
      withAggregateSetQuery({
        tx,
        aggregate: "listVerificationClaim",
        scope: fixture.claimScope,
        ids: fixture.claimRows.map(({ id }) => id),
        mode: "update",
        select: () =>
          setQueryAdapter({ query: fixture.claimQuery(), rows, statements }),
      }),
    ),
  ).toMatchObject({
    message:
      "Aggregate set query returned an undeclared or unordered physical row",
  });
  expect(statements).toHaveLength(1);
});

test("an empty discovered source set reserves the entire physical rank", async () => {
  const fixture = listSetFixture();
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [] });
  expect(
    await withAggregateSetQuery({
      tx,
      aggregate: "listGenerationSource",
      scope: fixture.sourceScope,
      mode: "update",
      select: () =>
        setQueryAdapter({ query: fixture.sourceQuery(), rows: [], statements }),
    }),
  ).toEqual({ status: "missing", rows: [] });
  expect(
    await rejectionOf(
      withAggregateLock({
        tx,
        aggregate: "listGenerationSource",
        id: {
          id: createSafeId<"legalListGenerationCandidateSource">(),
          workspaceId: fixture.sourceScope.workspaceId,
        },
        mode: "update",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
  expect(statements).toHaveLength(1);
});

test("UUID case aliases retain canonical claim ordering and same-row reacquisition coverage", async () => {
  const fixture = listSetFixture();
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [{ id: "held" }] });
  const workspaceId = toSafeId<"workspace">(
    "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  );
  const runId = toSafeId<"legalListVerificationRun">(
    "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  );
  const lowId = toSafeId<"legalListClaim">(
    "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  );
  const highId = toSafeId<"legalListClaim">(
    "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
  );
  const rows = [lowId, highId].map((id) => ({ id, workspaceId, runId }));
  const uppercaseScope = {
    workspaceId: toSafeId<"workspace">(workspaceId.toUpperCase()),
    runId: toSafeId<"legalListVerificationRun">(runId.toUpperCase()),
  };
  expect(uppercaseScope.workspaceId).not.toBe(workspaceId);
  const ids = [
    highId,
    toSafeId<"legalListClaim">(lowId.toUpperCase()),
    toSafeId<"legalListClaim">(highId.toUpperCase()),
  ];
  expect(
    await withAggregateSetQuery({
      tx,
      aggregate: "listVerificationClaim",
      scope: uppercaseScope,
      ids,
      mode: "update",
      select: () =>
        setQueryAdapter({ query: fixture.claimQuery(), rows, statements }),
    }),
  ).toEqual({ status: "locked", rows });
  expect(statements.at(0)?.params).toContain(workspaceId);
  expect(statements.at(0)?.params).toContain(runId);
  await withAggregateLock({
    tx,
    aggregate: "listFactDetails",
    id: { itemEntityId: createSafeId<"entity">(), workspaceId },
    mode: "update",
  });
  expect(
    await withAggregateSetQuery({
      tx,
      aggregate: "listVerificationClaim",
      scope: { workspaceId, runId },
      ids: [lowId, highId],
      mode: "update",
      select: () =>
        setQueryAdapter({ query: fixture.claimQuery(), rows, statements }),
    }),
  ).toEqual({ status: "locked", rows });
  expect(statements).toHaveLength(2);
});

test("uppercase source scope matches the canonical parent and tenant returned by PostgreSQL", async () => {
  const fixture = listSetFixture();
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [] });
  const canonical = {
    workspaceId: toSafeId<"workspace">("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"),
    listId: toSafeId<"legalList">("bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb"),
    runId: toSafeId<"legalListGenerationRun">(
      "cccccccc-cccc-7ccc-8ccc-cccccccccccc",
    ),
    candidateId: toSafeId<"legalListGenerationCandidate">(
      "dddddddd-dddd-7ddd-8ddd-dddddddddddd",
    ),
  };
  const scope = {
    workspaceId: toSafeId<"workspace">(canonical.workspaceId.toUpperCase()),
    listId: toSafeId<"legalList">(canonical.listId.toUpperCase()),
    runId: toSafeId<"legalListGenerationRun">(canonical.runId.toUpperCase()),
    candidateId: toSafeId<"legalListGenerationCandidate">(
      canonical.candidateId.toUpperCase(),
    ),
  };
  const rows = fixture.sourceRows.map(({ id }) => ({ id, ...canonical }));
  expect(scope).not.toEqual(canonical);
  expect(
    await withAggregateSetQuery({
      tx,
      aggregate: "listGenerationSource",
      scope,
      mode: "update",
      select: () =>
        setQueryAdapter({ query: fixture.sourceQuery(), rows, statements }),
    }),
  ).toEqual({ status: "locked", rows });
  for (const value of Object.values(canonical)) {
    expect(statements.at(0)?.params).toContain(value);
  }
  expect(statements).toHaveLength(1);
});

test("a UUID row-query case alias reuses canonical held coverage after advancing the rank", async () => {
  const fixture = listSetFixture();
  const statements: { sql: string; params: unknown[] }[] = [];
  const tx = asTestRaw<Transaction>({ execute: async () => [{ id: "held" }] });
  const workspaceId = toSafeId<"workspace">(
    "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
  );
  const id = toSafeId<"legalListClaim">("bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb");
  const rows = [{ id, workspaceId, runId: fixture.claimScope.runId }];
  const select = () => {
    const query = fixture.claimQuery();
    return {
      toSQL: () => query.toSQL(),
      as: (alias: string) => query.as(alias),
      where: (predicate: SQL) => {
        const scoped = query.where(predicate);
        return {
          toSQL: () => scoped.toSQL(),
          as: (alias: string) => scoped.as(alias),
          for: async (...args: Parameters<typeof scoped.for>) => {
            statements.push(scoped.for(...args).toSQL());
            return rows;
          },
        };
      },
    };
  };
  expect(
    await withAggregateRowQuery({
      tx,
      aggregate: "listVerificationClaim",
      id: { id, workspaceId },
      mode: "update",
      select,
    }),
  ).toEqual({ status: "locked", rows });
  await withAggregateLock({
    tx,
    aggregate: "listFactDetails",
    id: { itemEntityId: createSafeId<"entity">(), workspaceId },
    mode: "update",
  });
  const uppercase = {
    id: toSafeId<"legalListClaim">(id.toUpperCase()),
    workspaceId: toSafeId<"workspace">(workspaceId.toUpperCase()),
  };
  expect(uppercase.id).not.toBe(id);
  expect(
    await withAggregateRowQuery({
      tx,
      aggregate: "listVerificationClaim",
      id: uppercase,
      mode: "update",
      select,
    }),
  ).toEqual({ status: "locked", rows });
  expect(statements).toHaveLength(2);
  expect(statements.at(1)?.params).toEqual([id, workspaceId]);
});
