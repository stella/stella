import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";

import {
  ROW_LOCK_MODES,
  withAggregateLock,
  withAggregateParentBatch,
} from "./aggregate-lock";

const organizationId = toSafeId<"organization">("org_a");
const workspaceId = toSafeId<"workspace">("workspace_a");
const otherOrganizationId = toSafeId<"organization">("org_z");

test("mixed-case parent IDs use the same byte order in SQL and history", async () => {
  const ids = ["a", "B", "b", "A"].map((id) => toSafeId<"organization">(id));
  const sorted = ids.toSorted(compareCodeUnit);
  expect(sorted).toEqual(
    ["A", "B", "a", "b"].map((id) => toSafeId<"organization">(id)),
  );
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const compiled = new PgDialect().sqlToQuery(query);
      queries.push(compiled);
      return [];
    },
  };
  await withAggregateParentBatch({
    tx,
    organizationIds: ids,
    mode: "key share",
  });
  expect(queries.at(0)?.params).toEqual(sorted);
  expect(queries.at(0)?.sql).toContain(
    'ORDER BY "organization"."id" COLLATE "C" FOR KEY SHARE',
  );
  const historyTx = { execute: async () => [{ id: "unused" }] };
  for (const id of sorted) {
    await withAggregateLock({
      tx: historyTx,
      aggregate: "organization",
      id,
      mode: "key share",
    });
  }
  expect(
    await rejectionOf(
      withAggregateLock({
        tx: historyTx,
        aggregate: "organization",
        id: toSafeId<"organization">("Z"),
        mode: "key share",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
});

test.each(["é", "a😀", 'a"b', "a\nb"])(
  "rejects batch IDs outside the ASCII alphabet before acquisition: %s",
  async (id) => {
    const { tx, queries } = recorder();
    const invalidId = toSafeId<"organization">(id);
    expect(
      await rejectionOf(
        withAggregateParentBatch({
          tx,
          organizationIds: [invalidId],
          mode: "key share",
        }),
      ),
    ).toMatchObject({
      message: "Aggregate parent batch IDs must use the ASCII ID alphabet",
    });
    expect(queries).toHaveLength(0);
  },
);

const recorder = (presence: "present" | "missing" = "present") => {
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const compiled = new PgDialect().sqlToQuery(query);
      queries.push(compiled);
      if (presence === "missing") {
        return [];
      }
      return compiled.sql.includes('"workspaces"')
        ? [{ id: workspaceId }]
        : [{ id: organizationId }];
    },
  };
  return { tx, queries };
};

test.each(ROW_LOCK_MODES)(
  "parent batches declare %s and retain the shared rank history",
  async (mode) => {
    const { tx, queries } = recorder();
    expect(
      await withAggregateParentBatch({
        tx,
        organizationIds: [organizationId],
        workspaceIds: [workspaceId],
        mode,
      }),
    ).toEqual({
      organizationIds: new Set([organizationId]),
      workspaceIds: new Set([workspaceId]),
    });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.sql).toContain(`FOR ${mode.toUpperCase()}`);
    }
    expect(
      await rejectionOf(
        withAggregateLock({
          tx,
          aggregate: "organization",
          id: otherOrganizationId,
          mode,
        }),
      ),
    ).toMatchObject({ message: "Aggregate lock rank inversion" });
    expect(queries).toHaveLength(2);
  },
);

test("single acquisitions constrain batches before any query executes", async () => {
  const { tx, queries } = recorder();
  await withAggregateLock({
    tx,
    aggregate: "workspace",
    id: { id: workspaceId, organizationId },
    mode: "key share",
  });
  expect(
    await rejectionOf(
      withAggregateParentBatch({
        tx,
        organizationIds: [organizationId],
        mode: "key share",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
  expect(queries).toHaveLength(1);
});

test("batch identities allow covered reacquisition but reject a blocking upgrade", async () => {
  const { tx, queries } = recorder();
  await withAggregateParentBatch({
    tx,
    organizationIds: [organizationId],
    workspaceIds: [workspaceId],
    mode: "key share",
  });
  expect(
    await withAggregateLock({
      tx,
      aggregate: "organization",
      id: organizationId,
      mode: "key share",
    }),
  ).toEqual({ status: "locked" });
  expect(
    await withAggregateLock({
      tx,
      aggregate: "workspace",
      id: { id: workspaceId, organizationId },
      mode: "key share",
    }),
  ).toEqual({ status: "locked" });
  expect(
    await rejectionOf(
      withAggregateParentBatch({
        tx,
        organizationIds: [organizationId],
        mode: "update",
      }),
    ),
  ).toMatchObject({
    message:
      "Take the strongest aggregate row mode first; use NOWAIT for upgrades",
  });
  expect(queries).toHaveLength(4);
});

test("stronger single locks cover weaker batches without lowering held modes", async () => {
  const { tx, queries } = recorder();
  await withAggregateLock({
    tx,
    aggregate: "organization",
    id: organizationId,
    mode: "update",
  });
  await withAggregateParentBatch({
    tx,
    organizationIds: [organizationId],
    workspaceIds: [workspaceId],
    mode: "key share",
  });
  expect(
    await withAggregateLock({
      tx,
      aggregate: "organization",
      id: organizationId,
      mode: "update",
    }),
  ).toEqual({ status: "locked" });
  expect(queries).toHaveLength(4);
});

test("overlapping parent acquisitions fail before a second query executes", async () => {
  const gate = Promise.withResolvers<unknown[]>();
  let executions = 0;
  const tx = {
    execute: async () => {
      executions += 1;
      return await gate.promise;
    },
  };
  const pending = withAggregateParentBatch({
    tx,
    organizationIds: [organizationId],
    mode: "key share",
  });
  expect(
    await rejectionOf(
      withAggregateLock({
        tx,
        aggregate: "organization",
        id: organizationId,
        mode: "key share",
      }),
    ),
  ).toMatchObject({
    message: "Await each aggregate lock acquisition before starting another",
  });
  expect(executions).toBe(1);
  gate.resolve([{ id: organizationId }]);
  await pending;
});

test("missing batch rows consume no rank or mode coverage", async () => {
  const { tx, queries } = recorder("missing");
  await withAggregateParentBatch({
    tx,
    organizationIds: [],
    workspaceIds: [workspaceId],
    mode: "key share",
  });
  expect(
    await withAggregateLock({
      tx,
      aggregate: "organization",
      id: organizationId,
      mode: "update",
    }),
  ).toEqual({ status: "missing" });
  expect(queries).toHaveLength(2);
});

test("batch high water includes the last sorted identity", async () => {
  const queries: SQL[] = [];
  const tx = {
    execute: async (query: SQL) => {
      queries.push(query);
      return [{ id: otherOrganizationId }];
    },
  };
  await withAggregateParentBatch({
    tx,
    organizationIds: [otherOrganizationId, organizationId, otherOrganizationId],
    mode: "key share",
  });
  expect(
    await rejectionOf(
      withAggregateLock({
        tx,
        aggregate: "organization",
        id: organizationId,
        mode: "key share",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
  expect(queries).toHaveLength(1);
});

test("workspace UUIDs match their canonical lowercase rows", async () => {
  const canonical = "0f8d6a3e-5b1c-4c2a-9e7d-3a1b2c3d4e5f";
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    execute: async (query: SQL) => {
      queries.push(new PgDialect().sqlToQuery(query));
      return [{ id: canonical }];
    },
  };
  await withAggregateParentBatch({
    tx,
    organizationIds: [],
    workspaceIds: [
      toSafeId<"workspace">(canonical.toUpperCase()),
      toSafeId<"workspace">(canonical),
    ],
    mode: "key share",
  });
  expect(queries).toHaveLength(1);
  expect(queries.at(0)?.params).toEqual([canonical]);
});
