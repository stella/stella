import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";
import {
  integer,
  pgTable,
  primaryKey,
  text,
  PgDialect,
} from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { timestamptz } from "@/api/db/columns";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  defineTransitions,
  defineKeyedTransitions,
  transitionBatch,
  permitsTransition,
  transition,
  defineScopedTransitions,
  transitionScopedBatch,
  transitionUpsertBatch,
} from "@/api/lib/db/transitions";
import type { ScopedTransitionDeclaration } from "@/api/lib/db/transitions";
import { SANCTIONS_MONITORING_TRANSITION_IDENTITIES } from "@/api/lib/lists/sanctions/monitoring-transition-identities";

const states = ["queued", "running", "completed", "failed"] as const;

test("state-column ownership covers every scoped runtime transition", () => {
  const registered = Object.entries(TRANSITIONS).flatMap(
    ([tableName, entry]) => {
      const project = ({
        key,
        scope,
        stateColumn,
      }: ScopedTransitionDeclaration) => ({
        tableName,
        key,
        scope,
        stateColumn,
      });
      if ("scoped" in entry) {
        return entry.scoped.map(project);
      }
      if ("stateColumn" in entry) {
        return [project(entry)];
      }
      return [];
    },
  );
  const order = (
    left: { stateColumn: string; tableName: string },
    right: { stateColumn: string; tableName: string },
  ) => {
    const leftKey = `${left.tableName}.${left.stateColumn}`;
    const rightKey = `${right.tableName}.${right.stateColumn}`;
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  };
  expect(registered.toSorted(order)).toEqual(
    Object.values(SANCTIONS_MONITORING_TRANSITION_IDENTITIES).toSorted(order),
  );
});
const jobs = pgTable("transition_test_jobs", {
  id: text().primaryKey(),
  status: text({ enum: states }).notNull(),
  attempt: integer().notNull(),
  leaseToken: text(),
  claimedAt: timestamptz("claimed_at"),
  description: text(),
});
const graph = {
  queued: ["running", "failed"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
} as const;
const spec = defineTransitions(jobs, graph, {
  terminal: ["completed", "failed"],
});
const fenced = defineTransitions(jobs, graph, {
  terminal: ["completed", "failed"],
  fence: "attempt",
});
const dialect = new PgDialect();
const noAudit = async () => await Promise.resolve();
const rollback = (): never => {
  throw new Error("unexpected transaction rollback");
};

const assertTransitionRejected = async (
  operation: Promise<unknown>,
  expected: string | Error,
) => {
  const result = await Result.tryPromise({
    try: async () => await operation,
    catch: (error) => error,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    if (typeof expected === "string") {
      expect(result.error).toHaveProperty(
        "message",
        expect.stringContaining(expected),
      );
    } else {
      expect(result.error).toBe(expected);
    }
  }
};

describe("conditional status transitions", () => {
  test("status transition graph pairs", () => {
    assertProperty(
      "status transition graph pairs",
      fc.property(
        fc.constantFrom(...states),
        fc.constantFrom(...states),
        (from, to) => {
          const expected =
            from === to || graph[from].some((target) => target === to);
          expect(permitsTransition(spec, from, to)).toBe(expected);
          if ((from === "completed" || from === "failed") && from !== to) {
            expect(permitsTransition(spec, from, to)).toBe(false);
          }
        },
      ),
    );
    expect(permitsTransition(spec, "unknown", "unknown")).toBe(false);
  });

  test("a zero-row update returns stale and binds every expected source", async () => {
    const captured: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const tx = {
      execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        captured.push(dialect.sqlToQuery(query));
        return [];
      },
      rollback,
    };
    let auditCalls = 0;
    expect(
      await transition({
        tx,
        spec,
        id: "job",
        options: {
          from: ["queued", "running"],
          to: "failed",
          set: { description: "Failure" },
        },
        recordTransitionAuditEvent: async () => {
          auditCalls += 1;
        },
      }),
    ).toEqual({ type: "stale" });
    expect(auditCalls).toBe(0);
    const query = captured.at(0);
    expect(query?.params).toEqual([
      "failed",
      "Failure",
      "job",
      "queued",
      "running",
    ]);
    expect(query?.sql).toContain('"status" IN');
    expect(query?.sql).toContain("RETURNING");
  });

  test("a declared fence is bound into the same mutation", async () => {
    const tx = {
      execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const built = dialect.sqlToQuery(query);
        expect(built.sql).toContain('"attempt" IS NOT DISTINCT FROM');
        expect(built.params).toEqual(["running", "job", "queued", 3]);
        return [];
      },
      rollback,
    };
    expect(
      await transition({
        tx,
        spec: fenced,
        id: "job",
        options: { from: ["queued"], to: "running", fence: 3 },
        recordTransitionAuditEvent: noAudit,
      }),
    ).toEqual({ type: "stale" });
  });

  test("untyped callers cannot bypass graph, metadata or fence validation", async () => {
    const tx = { execute: async () => [], rollback };
    const reopen = { from: ["completed"], to: "running" } as const;
    const mixed = { from: ["queued", "failed"], to: "running" } as const;
    const empty = { from: [], to: "running" } as const;
    const missingFence = { from: ["queued"], to: "running" } as const;
    const extraFence = { ...missingFence, fence: 3 } as const;
    const overrideStatus = {
      ...missingFence,
      set: { status: "failed", description: "metadata" },
    } as const;
    const overrideFence = {
      ...extraFence,
      set: { attempt: 4, description: "metadata" },
    } as const;
    const unknownColumn = { ...missingFence, set: { unknown: true } } as const;
    const overrideId = {
      ...missingFence,
      set: { id: "other", description: "metadata" },
    } as const;
    await assertTransitionRejected(
      transition({
        tx,
        spec,
        id: "job",
        // @ts-expect-error a terminal source cannot reopen
        options: reopen,
        recordTransitionAuditEvent: noAudit,
      }),
      "Illegal status transition",
    );
    await assertTransitionRejected(
      transition({
        tx,
        spec,
        id: "job",
        // @ts-expect-error every source must permit the target
        options: mixed,
        recordTransitionAuditEvent: noAudit,
      }),
      "Illegal status transition",
    );
    await assertTransitionRejected(
      transition({
        tx,
        spec,
        id: "job",
        // @ts-expect-error an empty source list cannot claim a transition
        options: empty,
        recordTransitionAuditEvent: noAudit,
      }),
      "Illegal status transition",
    );
    await assertTransitionRejected(
      transition({
        tx,
        spec: fenced,
        id: "job",
        // @ts-expect-error configured fences are required
        options: missingFence,
        recordTransitionAuditEvent: noAudit,
      }),
      "requires its declared fence",
    );
    await assertTransitionRejected(
      transition({
        tx,
        spec,
        id: "job",
        // @ts-expect-error unfenced tables reject unexpected fences
        options: extraFence,
        recordTransitionAuditEvent: noAudit,
      }),
      "has no fence",
    );
    await assertTransitionRejected(
      transition({
        tx,
        spec,
        id: "job",
        // @ts-expect-error metadata cannot override the owner's status
        options: overrideStatus,
        recordTransitionAuditEvent: noAudit,
      }),
      "cannot set status",
    );
    await assertTransitionRejected(
      transition({
        tx,
        spec: fenced,
        id: "job",
        // @ts-expect-error metadata cannot replace the fence
        options: overrideFence,
        recordTransitionAuditEvent: noAudit,
      }),
      "cannot set attempt",
    );
    await assertTransitionRejected(
      transition({
        tx,
        spec,
        id: "job",
        // @ts-expect-error metadata must be table columns
        options: unknownColumn,
        recordTransitionAuditEvent: noAudit,
      }),
      "cannot set unknown",
    );
    await assertTransitionRejected(
      transition({
        tx,
        spec,
        id: "job",
        // @ts-expect-error metadata cannot replace the primary key
        options: overrideId,
        recordTransitionAuditEvent: noAudit,
      }),
      "cannot set id",
    );
  });

  test("invalid definitions fail before any write", () => {
    expect(() =>
      defineTransitions(
        jobs,
        { ...graph, completed: ["running"] },
        { terminal: ["completed", "failed"] },
      ),
    ).toThrow("cannot have outgoing transitions");
    const incomplete = { queued: ["running"] } as const;
    const badTarget = { ...graph, queued: ["unknown"] } as const;
    const badTerminal = { terminal: ["unknown"] } as const;
    const badFence = { terminal: [], fence: "missing" } as const;
    expect(() =>
      // @ts-expect-error every persisted state requires a decision
      defineTransitions(jobs, incomplete, { terminal: [] }),
    ).toThrow("must cover");
    expect(() =>
      // @ts-expect-error targets must be in the persisted domain
      defineTransitions(jobs, badTarget, { terminal: [] }),
    ).toThrow("Unknown transition target");
    expect(() =>
      // @ts-expect-error terminal states must be in the persisted domain
      defineTransitions(jobs, graph, badTerminal),
    ).toThrow("Unknown terminal status");
    expect(() =>
      // @ts-expect-error fence names must be present declared columns
      defineTransitions(jobs, graph, badFence),
    ).toThrow("not a table column");
    expect(() =>
      defineKeyedTransitions({
        table: jobs,
        key: "status",
        edges: graph,
        options: { terminal: [] },
      }),
    ).toThrow("must be a primary-key column");
    const openDomain = pgTable("open_status", { id: text(), status: text() });
    expect(() => defineTransitions(openDomain, {}, { terminal: [] })).toThrow(
      "must cover",
    );
  });

  test("database failures propagate instead of returning a stale or successful result", async () => {
    const failure = new TypeError("transition database unavailable");
    const tx = {
      execute: async () => {
        throw failure;
      },
      rollback,
    };
    await assertTransitionRejected(
      transition({
        tx,
        spec,
        id: "job",
        options: { from: ["queued"], to: "running" },
        recordTransitionAuditEvent: noAudit,
      }),
      failure,
    );
  });

  test("transaction rollback and audit recording are required by the type", () => {
    const tx = { execute: async () => [], rollback };
    const noRollback = { execute: async () => [] };
    const missingRollback = async () =>
      await transition({
        // @ts-expect-error a transaction must expose rollback(): never
        tx: noRollback,
        spec,
        id: "job",
        options: { from: ["queued"], to: "running" },
        recordTransitionAuditEvent: noAudit,
      });
    expect(missingRollback).toBeFunction();
    const missingRecorder = async () =>
      // @ts-expect-error every transition requires an audit recorder
      await transition({
        tx,
        spec,
        id: "job",
        options: { from: ["queued"], to: "running" },
      });
    expect(missingRecorder).toBeFunction();
  });
});

test("a keyed batch binds every identifier and audits only changed rows once", async () => {
  const keyedJobs = pgTable("keyed_transition_jobs", {
    entityId: text("entity_id").primaryKey(),
    status: text({ enum: states }).notNull(),
    description: text(),
  });
  const keyed = defineKeyedTransitions({
    table: keyedJobs,
    key: "entityId",
    edges: graph,
    options: { terminal: ["completed", "failed"] },
  });
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      queries.push(dialect.sqlToQuery(query));
      return [{ id: "first", status: "failed" }];
    },
    rollback,
  };
  let audits = 0;
  const result = await transitionBatch({
    tx,
    spec: keyed,
    ids: ["first", "second"],
    options: {
      from: ["queued", "running"],
      to: "failed",
      set: { description: "Closed" },
    },
    recordTransitionAuditEvent: async (auditTx, rows) => {
      expect(auditTx).toBe(tx);
      expect(rows).toEqual([{ id: "first", status: "failed" }]);
      audits += 1;
    },
  });
  expect(result).toEqual([{ id: "first", status: "failed" }]);
  expect(audits).toBe(1);
  expect(queries).toHaveLength(1);
  expect(queries.at(0)?.sql).toContain(
    '"keyed_transition_jobs"."entity_id" IN',
  );
  expect(queries.at(0)?.params).toEqual([
    "failed",
    "Closed",
    "first",
    "second",
    "queued",
    "running",
  ]);
});

test("empty and stale batches perform no audit", async () => {
  let queries = 0;
  let audits = 0;
  const tx = {
    execute: async () => {
      queries += 1;
      return [];
    },
    rollback,
  };
  const recordTransitionAuditEvent = async () => {
    audits += 1;
  };
  for (const ids of [[], ["job"]]) {
    expect(
      await transitionBatch({
        tx,
        spec,
        ids,
        options: { from: ["queued"], to: "running" },
        recordTransitionAuditEvent,
      }),
    ).toEqual([]);
  }
  expect(queries).toBe(1);
  expect(audits).toBe(0);
});

test("scoped state batches bind composite identities and audit only changed rows once", async () => {
  const scopedRows = pgTable(
    "scoped_transition_rows",
    {
      organizationId: text("organization_id").notNull(),
      sourceId: text("source_id").notNull(),
      state: text({ enum: ["active", "lapsed"] as const }).notNull(),
      note: text(),
    },
    (table) => [
      primaryKey({ columns: [table.organizationId, table.sourceId] }),
    ],
  );
  const scoped = defineScopedTransitions({
    table: scopedRows,
    key: "sourceId",
    scope: ["organizationId"],
    stateColumn: "state",
    edges: { active: ["lapsed"], lapsed: [] },
    initial: ["active"],
    sameStateUpsert: "ignore",
  });
  const captured: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      captured.push(dialect.sqlToQuery(query));
      return [
        {
          sourceId: "entry-1",
          organizationId: "org-1",
          status: "lapsed",
        },
      ];
    },
    rollback,
  };
  let auditCalls = 0;
  const changed = await transitionScopedBatch({
    tx,
    spec: scoped,
    identities: [
      { organizationId: "org-1", sourceId: "entry-1" },
      { organizationId: "org-2", sourceId: "entry-1" },
    ],
    options: { from: ["active"], to: "lapsed" },
    recordTransitionAuditEvent: async (_auditTx, rows) => {
      auditCalls += 1;
      expect(rows).toEqual([
        {
          identity: { sourceId: "entry-1", organizationId: "org-1" },
          status: "lapsed",
        },
      ]);
    },
  });
  expect(changed).toHaveLength(1);
  expect(auditCalls).toBe(1);
  expect(captured.at(0)?.sql).toContain('"state" IN');
  expect(captured.at(0)?.sql).toContain('"organization_id" =');
  expect(captured.at(0)?.params).toEqual([
    "lapsed",
    "entry-1",
    "org-1",
    "entry-1",
    "org-2",
    "active",
  ]);
});

test("scoped upserts declare initial states and audit only inserted or transitioned rows", async () => {
  const scopedRows = pgTable(
    "scoped_upsert_rows",
    {
      organizationId: text("organization_id").notNull(),
      sourceId: text("source_id").notNull(),
      state: text({ enum: ["active", "lapsed"] as const }).notNull(),
      note: text(),
    },
    (table) => [
      primaryKey({ columns: [table.organizationId, table.sourceId] }),
    ],
  );
  const scoped = defineScopedTransitions({
    table: scopedRows,
    key: "sourceId",
    scope: ["organizationId"],
    stateColumn: "state",
    edges: { active: ["lapsed"], lapsed: ["active"] },
    initial: ["active"],
    sameStateUpsert: "update",
  });
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const compiled = dialect.sqlToQuery(query);
      queries.push(compiled);
      if (compiled.sql.includes("INSERT INTO")) {
        return [{ organizationId: "org-1", sourceId: "new", status: "active" }];
      }
      if (compiled.sql.includes("SELECT 1")) {
        return [{ value: 1 }, { value: 1 }];
      }
      if (compiled.sql.includes("RETURNING")) {
        return [{ organizationId: "org-1", sourceId: "old", status: "active" }];
      }
      return [];
    },
    rollback,
  };
  let auditCalls = 0;
  const changed = await transitionUpsertBatch({
    tx,
    spec: scoped,
    values: [
      {
        organizationId: "org-1",
        sourceId: "new",
        state: "active",
        note: "new",
      },
      {
        organizationId: "org-1",
        sourceId: "old",
        state: "active",
        note: "changed",
      },
    ],
    recordTransitionAuditEvent: async (_auditTx, rows) => {
      auditCalls += 1;
      expect(rows).toEqual([
        {
          identity: { sourceId: "new", organizationId: "org-1" },
          status: "active",
        },
        {
          identity: { sourceId: "old", organizationId: "org-1" },
          status: "active",
        },
      ]);
    },
  });
  expect(changed).toHaveLength(2);
  expect(auditCalls).toBe(1);
  expect(queries).toHaveLength(4);
  expect(queries.at(0)?.sql).toContain('incoming."state" IN');
  expect(queries.at(1)?.sql).toContain('current."state" <> incoming."state"');
  expect(queries.at(2)?.sql).toContain('current."state" = incoming."state"');
});

test("same-state upserts need a declared policy and ignored rows do not audit", async () => {
  const scopedRows = pgTable(
    "same_state_upsert_rows",
    {
      organizationId: text("organization_id").notNull(),
      sourceId: text("source_id").notNull(),
      state: text({ enum: ["active", "lapsed"] as const }).notNull(),
    },
    (table) => [
      primaryKey({ columns: [table.organizationId, table.sourceId] }),
    ],
  );
  const base = {
    table: scopedRows,
    key: "sourceId",
    scope: ["organizationId"],
    stateColumn: "state",
    edges: { active: ["lapsed"], lapsed: ["active"] },
    initial: ["active"],
  } as const;
  const value = {
    organizationId: "org-1",
    sourceId: "existing",
    state: "active",
  } as const;
  const existingStateTx = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const compiled = dialect.sqlToQuery(query);
      if (compiled.sql.includes("SELECT 1")) {
        return [{ value: 1 }];
      }
      return [];
    },
    rollback,
  };
  let auditCalls = 0;
  const recordTransitionAuditEvent = async () => {
    auditCalls += 1;
  };

  await assertTransitionRejected(
    transitionUpsertBatch({
      tx: existingStateTx,
      spec: defineScopedTransitions(base),
      values: [value],
      recordTransitionAuditEvent,
    }),
    "same-state upsert requires an explicit policy",
  );
  expect(auditCalls).toBe(0);

  const changed = await transitionUpsertBatch({
    tx: existingStateTx,
    spec: defineScopedTransitions({ ...base, sameStateUpsert: "ignore" }),
    values: [value],
    recordTransitionAuditEvent,
  });
  expect(changed).toEqual([]);
  expect(auditCalls).toBe(0);
});

test("scoped identities accept only schema-declared non-null primary or unique columns", () => {
  const rows = pgTable("declared_transition_identity", {
    id: text().primaryKey(),
    organizationId: text("organization_id").notNull().unique(),
    state: text({ enum: ["active", "lapsed"] }).notNull(),
    note: text().notNull(),
    optionalKey: text("optional_key").unique(),
  });
  const columns = getColumns(rows);
  const keys = Object.keys(columns).filter((key): key is keyof typeof columns =>
    Object.hasOwn(columns, key),
  );
  for (const key of keys) {
    const outcome = Result.try(() =>
      defineScopedTransitions({
        table: rows,
        key,
        scope: [],
        stateColumn: "state",
        edges: { active: ["lapsed"], lapsed: [] },
        initial: ["active"],
      }),
    );
    const column = columns[key];
    expect(outcome.isOk()).toBe(
      column.notNull && (column.primary || column.isUnique),
    );
  }
});
