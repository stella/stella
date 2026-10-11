import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  withAggregateEntityBatch,
  withAggregateLock,
} from "@/api/lib/db/aggregate-lock";
import type { RowLockMode } from "@/api/lib/db/aggregate-lock";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const batchRecorder = () => {
  const predicates: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const ordering: string[] = [];
  const modes: RowLockMode[] = [];
  const limits: number[] = [];
  const query = {
    from: () => query,
    where: (predicate: SQL) => {
      predicates.push(new PgDialect().sqlToQuery(predicate));
      return query;
    },
    orderBy: (order: SQL) => {
      ordering.push(new PgDialect().sqlToQuery(order).sql);
      return query;
    },
    limit: (limit: number) => {
      limits.push(limit);
      return query;
    },
    for: async (mode: RowLockMode) => {
      modes.push(mode);
      return [];
    },
  };
  const tx = asTestRaw<Transaction>({
    select: () => query,
    execute: async () => [],
  });
  return { tx, predicates, ordering, modes, limits };
};

test("entity batches deduplicate and order scoped identities in one bounded acquisition", async () => {
  const workspaceId = createSafeId<"workspace">();
  const low = toSafeId<"entity">("00000000-0000-0000-0000-000000000001");
  const high = toSafeId<"entity">("00000000-0000-0000-0000-000000000002");
  const ids = [
    { id: high, workspaceId },
    { id: low, workspaceId },
    { id: high, workspaceId },
  ];
  const recorder = batchRecorder();
  expect(
    await withAggregateEntityBatch({
      tx: recorder.tx,
      ids,
      mode: "update",
      limit: 100,
    }),
  ).toEqual([]);
  expect(recorder.predicates.at(0)?.params).toEqual([
    low,
    workspaceId,
    high,
    workspaceId,
  ]);
  expect(recorder.ordering).toEqual(['"entities"."id"::text COLLATE "C"']);
  expect(recorder.modes).toEqual(["update"]);
  expect(recorder.limits).toEqual([100]);
  expect(
    await rejectionOf(
      withAggregateLock({
        tx: recorder.tx,
        aggregate: "workspace",
        id: {
          id: workspaceId,
          organizationId: mintAuthProviderId<"organization">(),
        },
        mode: "update",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
});

test("entity batches reject conflicting tenant identities before acquisition", async () => {
  const recorder = batchRecorder();
  const id = createSafeId<"entity">();
  expect(
    await rejectionOf(
      withAggregateEntityBatch({
        tx: recorder.tx,
        ids: [
          { id, workspaceId: createSafeId<"workspace">() },
          { id, workspaceId: createSafeId<"workspace">() },
        ],
        mode: "update",
        limit: 100,
      }),
    ),
  ).toMatchObject({
    message: "Aggregate entity batch declares conflicting tenant identities",
  });
  expect(recorder.modes).toEqual([]);
});
