import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import { actionCostCalls, actionCostRecords } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";

import type { ActionCostObservation } from "./context";
import { actionCostReportQuery } from "./report-query";
import {
  ACTION_COST_RETENTION_BATCH_SIZE,
  actionCostRetentionQueries,
} from "./retention";
import { actionCostWriteQueries } from "./store";

const migration = readFileSync(
  new URL(
    "../../../../drizzle/20261003122900_action_cost_records/migration.sql",
    import.meta.url,
  ),
  "utf-8",
).replaceAll("--> statement-breakpoint", "");
const organizationId = toSafeId<"organization">("fixture-org");
const record = {
  organizationId,
  actionKind: "chat.improve-prompt" as const,
  logicalPhaseId: "fixture-phase",
  userId: toSafeId<"user">("fixture-user"),
  admittedAt: new Date("2021-03-04T10:00:00Z"),
  settledAt: null,
  estimatedMicroUnits: 13,
};
const admitted: ActionCostObservation = { type: "action", record };
const settled: ActionCostObservation = {
  type: "action",
  record: { ...record, settledAt: new Date("2021-03-04T10:01:00Z") },
};
const call: ActionCostObservation = {
  type: "call",
  record: {
    organizationId,
    actionKind: record.actionKind,
    logicalPhaseId: record.logicalPhaseId,
    callId: "fixture-call",
    kind: "fixture-provider",
    occurredAt: record.admittedAt,
    measuredMicroUnits: 7,
  },
};

const createDatabase = async () => {
  const db = new PGlite();
  await db.exec(`
    create role stella;
    create table organization (id text primary key);
    create table "user" (id text primary key);
    create table usage_events (organization_id text, raw_usage_micro_units bigint, created_at timestamptz);
    insert into organization values ('fixture-org'), ('other-org');
    insert into "user" values ('fixture-user');
  `);
  await db.exec(migration);
  const indexMigration = readFileSync(
    new URL(
      "../../../../drizzle/20261003123000_action_cost_usage_index/migration.sql",
      import.meta.url,
    ),
    "utf-8",
  );
  const indexStatement = /CREATE INDEX CONCURRENTLY[\s\S]*?;/u
    .exec(indexMigration)
    ?.at(0);
  if (indexStatement === undefined) {
    throw new TypeError("Missing event index statement");
  }
  await db.exec(indexStatement.replace("CONCURRENTLY ", ""));
  return db;
};
const apply = async (db: PGlite, batch: ActionCostObservation[]) => {
  for (const query of actionCostWriteQueries(drizzle.mock(), batch)) {
    const { sql, params } = query.toSQL();
    await db.query(sql, params);
  }
};

test("replays and reordered admission/settlement batches converge to one action and one call", async () => {
  const db = await createDatabase();
  try {
    for (const batch of [
      [settled, admitted, call],
      [admitted, settled, call],
      [call, settled, admitted],
    ]) {
      await apply(db, batch);
    }
    const actions = await db.query(
      "select organization_id, estimated_micro_units::text, settled_at from action_cost_records",
    );
    expect(actions.rows).toHaveLength(1);
    expect(actions.rows.at(0)).toMatchObject({
      estimated_micro_units: "13",
      settled_at: expect.any(Date),
    });
    const calls = await db.query("select * from action_cost_calls");
    expect(calls.rows).toHaveLength(1);
    await apply(db, [
      { type: "call", record: { ...call.record, callId: "another-attempt" } },
    ]);
    expect(
      (await db.query("select * from action_cost_calls")).rows,
    ).toHaveLength(2);
  } finally {
    await db.close();
  }
});

test("tenant role cannot read or write operator observations and schema indexes match migration", async () => {
  const db = await createDatabase();
  try {
    for (const table of [actionCostRecords, actionCostCalls]) {
      const config = getTableConfig(table);
      const actual = await db.query<{ indexname: string }>(
        "select indexname from pg_indexes where tablename = $1 and indexname not like '%_pkey'",
        [config.name],
      );
      expect(actual.rows.map((row) => row.indexname).toSorted()).toEqual(
        config.indexes
          .map((index) => {
            const name = index.config.name;
            if (name === undefined) {
              throw new TypeError("Fixture indexes must have explicit names");
            }
            return name;
          })
          .toSorted(),
      );
    }
    await apply(db, [admitted, call]);
    await db.exec(`
      create role fixture_observation_owner;
      alter table action_cost_records owner to fixture_observation_owner;
      alter table action_cost_calls owner to fixture_observation_owner;
      set role fixture_observation_owner;
    `);
    expect(
      (await db.query("select * from action_cost_records")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from action_cost_calls")).rows,
    ).toHaveLength(1);
    await db.exec("reset role;");
    await db.exec(
      "grant select, insert on action_cost_records, action_cost_calls to stella; set role stella;",
    );
    expect((await db.query("select * from action_cost_records")).rows).toEqual(
      [],
    );
    expect((await db.query("select * from action_cost_calls")).rows).toEqual(
      [],
    );
    const denied = await db
      .query(
        "insert into action_cost_calls (organization_id, action_kind, logical_phase_id, call_id, kind, occurred_at) values ('other-org','fixture','phase','call','fixture',now())",
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(denied).toMatchObject({
      message: expect.stringContaining("row-level security"),
    });
  } finally {
    await db.close();
  }
});

test("report separates unknown and parentless calls and model estimates without leaking another organization", async () => {
  const db = await createDatabase();
  try {
    await apply(db, [
      admitted,
      {
        type: "action",
        record: {
          ...record,
          organizationId: toSafeId<"organization">("other-org"),
          estimatedMicroUnits: 99,
        },
      },
      settled,
      call,
      {
        type: "call",
        record: { ...call.record, callId: "unknown", measuredMicroUnits: null },
      },
      {
        type: "call",
        record: {
          ...call.record,
          callId: "orphan",
          logicalPhaseId: "missing-parent",
          measuredMicroUnits: 11,
        },
      },
      {
        type: "call",
        record: {
          ...call.record,
          organizationId: toSafeId<"organization">("other-org"),
          callId: "other",
          measuredMicroUnits: 99,
        },
      },
    ]);
    await db.query(
      "insert into usage_events (organization_id, action_kind, logical_phase_id, raw_usage_micro_units, created_at) values ($1,$2,$3,$4,$5)",
      [
        organizationId,
        record.actionKind,
        record.logicalPhaseId,
        23,
        record.admittedAt,
      ],
    );
    const query = new PgDialect().sqlToQuery(
      actionCostReportQuery({
        organizationId,
        start: new Date("2021-03-04"),
        end: new Date("2021-03-05"),
      }).unwrap(),
    );
    const report = await db.query(query.sql, query.params);
    expect(report.rows).toEqual([
      expect.objectContaining({
        action_count: "1",
        call_count: "3",
        unknown_call_count: "1",
        parentless_call_count: "1",
        measured_external_total: "18",
        model_rate_estimate_total: "23",
        estimated_total: "13",
      }),
    ]);
  } finally {
    await db.close();
  }
});

test("retention deletes only the configured old period and bounds each pass", async () => {
  const db = await createDatabase();
  try {
    await apply(db, [
      admitted,
      call,
      {
        type: "call",
        record: {
          ...call.record,
          callId: "fresh",
          occurredAt: new Date("2021-03-06"),
        },
      },
    ]);
    await db.exec(`
      insert into action_cost_calls (organization_id, action_kind, logical_phase_id, call_id, kind, occurred_at)
      select 'fixture-org', 'fixture', 'fixture-phase', 'old-' || item, 'fixture-provider', '2021-03-04'::timestamptz
      from generate_series(1, ${ACTION_COST_RETENTION_BATCH_SIZE + 5}) item;
    `);
    for (const query of Object.values(
      actionCostRetentionQueries(new Date("2021-03-05")),
    )) {
      const compiled = new PgDialect().sqlToQuery(query);
      const deleted = await db.query(compiled.sql, compiled.params);
      expect(deleted.rows.length).toBeLessThanOrEqual(
        ACTION_COST_RETENTION_BATCH_SIZE,
      );
    }
    expect((await db.query("select * from action_cost_records")).rows).toEqual(
      [],
    );
    expect(
      (
        await db.query(
          "select * from action_cost_calls where call_id = 'fresh'",
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from action_cost_calls")).rows,
    ).toHaveLength(7);
  } finally {
    await db.close();
  }
});
