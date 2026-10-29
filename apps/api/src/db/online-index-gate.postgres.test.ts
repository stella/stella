import { Panic, Result } from "better-result";
import type { ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";

import { defaultConfig, type Signal } from "@stll/db-load-gate/health";
import { waitForExternalState } from "@stll/property-testing/external-state";
import { waitFor } from "@stll/test-kit";

import type { OnlineIndexConfig } from "../env-online-index";
import { getPgErrorCode, PG_ERROR } from "../lib/pg-error";
import { isRecord } from "../lib/type-guards";
import { withGatedTestClients } from "../tests/gated-test-database";
import { runGatedTableWork, setRowLevelSecurity } from "./online-ddl";
import {
  createOnlineIndexGate,
  type OnlineIndexGateOptions,
} from "./online-index-gate";
import type {
  OnlineMigrationConnection,
  OnlineMigrationParam,
} from "./online-migration-connection";
import { ensureOnlineIndexValid, retireOnlineIndex } from "./online-migrations";
import { terminateReserved } from "./sql-close";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
// How long pg_locks may still report a lock wait after its timeout fired.
const LOCK_ROW_EDGE_MS = 50;
const connectionAdapter = (
  connection: ReservedSQL,
): OnlineMigrationConnection => ({
  query: async (statement, parameters = []) =>
    await connection.unsafe<unknown[]>(statement, [...parameters]),
  execute: async (statement, parameters = []) => {
    await connection.unsafe(statement, [...parameters]);
  },
  release: async () => {
    await connection.release();
  },
  terminate: async () => {
    await terminateReserved(connection);
  },
});

// Bounded catalog barriers synchronize faults with a server state, never an elapsed duration.
const waitForPhase = async (
  observer: ReservedSQL,
  pid: number,
  phase = "waiting for writers before build",
) => {
  await waitForExternalState({
    description: `CIC reaches ${phase}`,
    intervalMs: 5,
    read: async () =>
      (
        await observer<
          { phase: string }[]
        >`SELECT phase FROM pg_stat_progress_create_index WHERE pid = ${pid}`
      ).at(0)?.phase === phase,
  });
};

/** Resolves once backend `pid` has exited. */
const waitForBackendExit = async (
  observer: ReservedSQL,
  pid: number,
  description: string,
) => {
  await waitForExternalState({
    description,
    intervalMs: 5,
    read: async () =>
      (
        await observer<
          { alive: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ${pid}) AS alive`
      ).at(0)?.alive === false,
  });
};

/** Resolves once backend `pid` waits on a lock. */
const waitForLockWait = async (
  observer: ReservedSQL,
  pid: number,
  description: string,
) => {
  await waitForExternalState({
    description,
    intervalMs: 5,
    read: async () =>
      (
        await observer<
          { waiting: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock') AS waiting`
      ).at(0)?.waiting === true,
  });
};

const waitForAbort = async (_milliseconds: number, signal: AbortSignal) => {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
};

type Fixture = {
  owner: ReservedSQL;
  builder: ReservedSQL;
  observer: ReservedSQL;
  blocker: ReservedSQL;
  connection: OnlineMigrationConnection;
  observation: OnlineMigrationConnection;
  pid: number;
  table: string;
  name: string;
  index: Parameters<typeof ensureOnlineIndexValid>[0]["index"] & {
    createSql: string;
  };
  gate: OnlineIndexGateOptions & {
    clock: () => number;
    config: OnlineIndexConfig;
  };
  records: unknown[];
};
const withFixture = async (work: (fixture: Fixture) => Promise<void>) => {
  if (databaseUrl === undefined) {
    throw new TypeError("DATABASE_URL required");
  }
  await withGatedTestClients(
    databaseUrl,
    async ({ openClient }) => {
      const owner = await openClient().sql.reserve();
      const builder = await openClient().sql.reserve();
      const observer = await openClient().sql.reserve();
      const blocker = await openClient().sql.reserve();
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const table = `gate_fixture_${suffix}`;
      const name = `gate_index_${suffix}`;
      const pids = await builder<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      const pid = pids.at(0)?.pid;
      if (pid === undefined) {
        throw new TypeError("Missing backend pid");
      }
      const timestamps = await observer<
        { now: number }[]
      >`SELECT extract(epoch FROM clock_timestamp())::double precision * 1000 AS now`;
      const now = timestamps.at(0)?.now;
      if (now === undefined) {
        throw new TypeError("Missing database clock");
      }
      const clock = () => now + 60_000;
      const config = {
        health: {
          ...defaultConfig,
          busyWindows: [],
          longTxMaxAgeMs: 3_600_000,
        },
        pollMs: 1,
        retryMs: 2,
        maxSnapshotWaitMs: 600_000,
        clientConnectionCheckMs: 10,
        idleHolderMs: 3_600_000,
        longHolderMs: 3_600_000,
        parallelWorkers: 1,
        maintenanceWorkMemMb: 16,
      } satisfies OnlineIndexConfig;
      const records: unknown[] = [];
      const readEbs = async (): Promise<Signal> => ({
        indicator: "ebs_balance",
        kind: "normal",
        value: 100,
        threshold: 70,
        observedAt: new Date(clock()).toISOString(),
        reason: "injected healthy metric",
      });
      await owner.unsafe(
        `CREATE TABLE public.${table} (id integer, other integer)`,
      );
      await owner.unsafe(`INSERT INTO public.${table} VALUES (1, 2)`);
      const index = {
        introducedBy: "20261001123000_database_backfill_state",
        name,
        tableName: table,
        definitionBody: `ON public.${table} USING btree (id)`,
        isUnique: false,
        createSql: `CREATE INDEX CONCURRENTLY ${name} ON public.${table} USING btree (id)`,
      };
      try {
        const version = await owner<
          { version: string }[]
        >`SELECT current_setting('server_version') AS version`;
        expect(version.at(0)?.version).toMatch(/^18\./u);
        await work({
          owner,
          builder,
          observer,
          blocker,
          connection: connectionAdapter(builder),
          observation: connectionAdapter(observer),
          pid,
          table,
          name,
          index,
          records,
          gate: {
            config,
            clock,
            ebs: { type: "reader", read: readEbs },
            wait: waitForAbort,
            log: (record) => {
              records.push(record);
            },
          },
        });
      } finally {
        await blocker`ROLLBACK`;
        await owner`SELECT pg_cancel_backend(${pid})`;
        await owner.unsafe(`DROP TABLE public.${table} CASCADE`);
        await owner.release();
        await builder.release();
        await observer.release();
        await blocker.release();
      }
    },
    { closeMode: "force" },
  );
};

const indexState = async ({ observer, name }: Fixture) => {
  const states = await observer<
    { valid: boolean; ready: boolean; oid: number; definition: string }[]
  >`SELECT i.indisvalid AS valid, i.indisready AS ready, c.oid::integer AS oid, pg_get_indexdef(c.oid) AS definition FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ${name}`;
  return states.at(0);
};
const blockBuild = async ({ blocker, table }: Fixture) => {
  await blocker`BEGIN`;
  await blocker.unsafe(
    `UPDATE public.${table} SET other = other + 1 WHERE id = 1`,
  );
};
const repair = async (fixture: Fixture, connection = fixture.connection) => {
  expect(
    await ensureOnlineIndexValid({
      connection,
      reserveObserver: async () => ({
        ...fixture.observation,
        release: () => undefined,
      }),
      index: fixture.index,
      gate: fixture.gate,
    }),
  ).toEqual({ type: "complete" });
  expect(await indexState(fixture)).toMatchObject({ valid: true, ready: true });
  const invalid = await fixture.observer<
    { count: number }[]
  >`SELECT count(*)::integer AS count FROM pg_index WHERE indrelid = ${`public.${fixture.table}`}::regclass AND NOT indisvalid`;
  expect(invalid.at(0)?.count).toBe(0);
};

describe.skipIf(!enabled)("online index runner PostgreSQL 18 faults", () => {
  test("writer-blocking requests and readers stay bounded, defer, and complete after the writer commits", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      const lockRetry = {
        config: {
          lockTimeoutsMs: [100, 250, 500],
          pauseBaseMs: 20,
          pauseCapMs: 40,
          budgetMs: 2000,
        },
        runtime: {
          now: Date.now,
          sleep: async (ms: number) => {
            await Bun.sleep(ms);
          },
          random: () => 0.5,
        },
      };
      const run = async () =>
        await runGatedTableWork({
          connection: fixture.connection,
          gate: fixture.gate,
          reserveObserver: async () => ({
            ...fixture.observation,
            release: () => undefined,
          }),
          target: { tableName: fixture.table, name: "enable_rls" },
          kind: "index_repair",
          lockRetry,
          work: async (session) => {
            await session.run(setRowLevelSecurity(fixture.table, "enable"));
          },
        });
      let done = false;
      const work = Result.tryPromise({
        try: run,
        catch: (cause: unknown) => cause,
      }).finally(() => {
        done = true;
      });
      let reader: Promise<number> | undefined;
      let samples = 0;
      let activeSamples = 0;
      const isDone = () => done;
      try {
        // Samples the build's lock waits until the gated work settles.
        await waitForExternalState({
          description: "the gated work settles",
          intervalMs: 5,
          timeoutMs: 30_000,
          read: async () => {
            const waits = await fixture.observer<
              { waitMs: number; active: boolean | null }[]
            >`SELECT extract(epoch FROM clock_timestamp() - l.waitstart)::double precision * 1000 AS "waitMs",
                a.wait_event_type = 'Lock' AS active
              FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE l.pid = ${fixture.pid} AND l.locktype = 'relation'
                AND l.relation = ${`public.${fixture.table}`}::regclass
                AND l.mode = 'AccessExclusiveLock' AND NOT l.granted
                AND l.waitstart IS NOT NULL`;
            for (const wait of waits) {
              samples++;
              // The longest lock timeout bounds each wait. pg_locks can still
              // show the timed-out request's wait row for a moment after the
              // timeout fires (see below), so allow that observation edge.
              expect(wait.waitMs).toBeLessThanOrEqual(500 + LOCK_ROW_EDGE_MS);
              if (wait.active === true) {
                activeSamples++;
              }
              if (reader === undefined) {
                const started = Date.now();
                reader = fixture.owner
                  .unsafe(`SELECT * FROM public.${fixture.table}`)
                  .then(() => Date.now() - started);
              }
            }
            return isDone();
          },
        });
      } finally {
        if (!isDone()) {
          await fixture.blocker`ROLLBACK`;
        }
        await work;
        if (reader !== undefined) {
          await reader;
        }
      }
      const result = await work;
      if (result.isErr()) {
        throw result.error;
      }
      expect(result.value).toEqual({
        type: "deferred",
        step: "enable_rls",
        retryAfterMs: fixture.gate.config.retryMs,
      });
      expect(samples).toBeGreaterThan(0);
      // pg_locks and pg_stat_activity are separate observations. At a bounded
      // request's timeout edge, the former can still expose the old wait row
      // after the latter has cleared its wait event for the retry pause.
      expect(activeSamples).toBeGreaterThan(0);
      expect(reader).toBeDefined();
      if (reader !== undefined) {
        expect(await reader).toBeLessThanOrEqual(500);
      }
      const deferredState = await fixture.observer<
        { enabled: boolean; waiting: boolean }[]
      >`SELECT c.relrowsecurity AS enabled,
          EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = ${fixture.pid} AND NOT l.granted) AS waiting
        FROM pg_class c WHERE c.oid = ${`public.${fixture.table}`}::regclass`;
      expect(deferredState.at(0)).toEqual({ enabled: false, waiting: false });
      await fixture.blocker`COMMIT`;
      expect(await run()).toEqual({ type: "complete" });
      const completed = await fixture.observer<
        { enabled: boolean }[]
      >`SELECT relrowsecurity AS enabled FROM pg_class WHERE oid = ${`public.${fixture.table}`}::regclass`;
      expect(completed.at(0)?.enabled).toBe(true);
    });
  }, 20_000);

  test("two hard-floor readings cancel CIC, leave INVALID, and a healthy run repairs to VALID", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      let polls = 0;
      let readings = 0;
      const gate = createOnlineIndexGate({
        connection: fixture.connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_build",
        ...fixture.gate,
        ebs: {
          type: "reader",
          read: async () => {
            readings++;
            return {
              indicator: "ebs_balance",
              kind: readings === 1 ? "normal" : "stop",
              value: readings === 1 ? 100 : 1,
              threshold: readings === 1 ? 70 : 40,
              observedAt: new Date(fixture.gate.clock()).toISOString(),
              reason: "injected fault",
            };
          },
        },
        wait: async () => {
          await waitForPhase(fixture.observer, fixture.pid);
          polls++;
          expect(polls).toBeLessThanOrEqual(2);
          expect(await indexState(fixture)).toMatchObject({ valid: false });
        },
      });
      try {
        expect(await gate.attempt(fixture.index.createSql)).toBe("retry");
        expect(polls).toBe(2);
        expect(await indexState(fixture)).toMatchObject({ valid: false });
      } finally {
        await gate.close();
        await fixture.blocker`ROLLBACK`;
      }
      await repair(fixture);
      expect(
        fixture.records
          .map((record) => JSON.stringify(record))
          .some(
            (record) =>
              record.includes('"decision":"cancel"') &&
              record.includes('"value":1'),
          ),
      ).toBe(true);
      expect(
        fixture.records
          .map((record) => JSON.stringify(record))
          .some((record) => record.includes('"decision":"done"')),
      ).toBe(true);
    });
  });

  test("a cancelled build defers its run, and the next run repairs it with repair priority", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      const priorities: (readonly OnlineMigrationParam[])[] = [];
      let readings = 0;
      let retryReached = false;
      let polls = 0;
      const connection: OnlineMigrationConnection = {
        ...fixture.connection,
        query: async (statement, parameters = []) => {
          if (statement.includes("pg_try_advisory_lock_shared")) {
            priorities.push([...parameters]);
          }
          return await fixture.connection.query(statement, parameters);
        },
      };
      const run = async () =>
        await ensureOnlineIndexValid({
          connection,
          index: fixture.index,
          reserveObserver: async () => ({
            ...fixture.observation,
            release: () => undefined,
          }),
          gate: {
            ...fixture.gate,
            ebs: {
              type: "reader",
              read: async () => {
                readings++;
                const unhealthy = readings === 2 || readings === 3;
                return {
                  indicator: "ebs_balance",
                  kind: unhealthy ? "stop" : "normal",
                  value: unhealthy ? 1 : 100,
                  threshold: unhealthy ? 40 : 70,
                  observedAt: new Date(fixture.gate.clock()).toISOString(),
                  reason: "injected retry sequence",
                };
              },
            },
            wait: async (milliseconds, signal) => {
              expect(milliseconds).toBe(fixture.gate.config.pollMs);
              if (retryReached) {
                await waitForAbort(milliseconds, signal);
                return;
              }
              polls++;
              expect(polls).toBeLessThanOrEqual(2);
              await waitForPhase(fixture.observer, fixture.pid);
            },
          },
        });
      // The cancelled run returns instead of sleeping, so a migrator can
      // re-read its ledger before the retry.
      expect(await run()).toEqual({
        type: "deferred",
        step: fixture.name,
        retryAfterMs: fixture.gate.config.retryMs,
      });
      expect(await indexState(fixture)).toMatchObject({ valid: false });
      retryReached = true;
      await fixture.blocker`ROLLBACK`;
      expect(await run()).toEqual({ type: "complete" });
      expect(priorities).toHaveLength(2);
      const namespace = priorities.at(0)?.at(0);
      if (typeof namespace !== "number") {
        throw new TypeError("Missing advisory lock namespace");
      }
      expect(priorities).toEqual([
        [namespace, 2],
        [namespace, 1],
      ]);
      expect(await indexState(fixture)).toMatchObject({
        valid: true,
        ready: true,
      });
      const invalid = await fixture.observer<
        { count: number }[]
      >`SELECT count(*)::integer AS count FROM pg_index WHERE indrelid = ${`public.${fixture.table}`}::regclass AND NOT indisvalid`;
      expect(invalid.at(0)?.count).toBe(0);
      for (const record of fixture.records) {
        if (!isRecord(record) || !isRecord(record["record"])) {
          throw new TypeError("Missing logged decision");
        }
        expect(record["event"]).toBe("online_index_decision");
        const decision = record["record"];
        if (
          !isRecord(decision["config"]) ||
          !isRecord(decision["verdict"]) ||
          !Array.isArray(decision["verdict"]["signals"])
        ) {
          throw new TypeError("Missing decision metrics");
        }
        expect(typeof decision["config"]["startFloor"]).toBe("number");
        expect(typeof decision["config"]["hardFloor"]).toBe("number");
        const signal = decision["verdict"]["signals"].at(0);
        if (!isRecord(signal)) {
          throw new TypeError("Missing logged EBS signal");
        }
        expect(signal["indicator"]).toBe("ebs_balance");
        expect(typeof signal["value"]).toBe("number");
        expect(typeof signal["threshold"]).toBe("number");
      }
      expect(
        fixture.records
          .map((record) => JSON.stringify(record))
          .filter((record) => record.includes('"decision":"cancel"')),
      ).toHaveLength(1);
      expect(
        fixture.records
          .map((record) => JSON.stringify(record))
          .filter((record) => record.includes('"decision":"done"')),
      ).toHaveLength(1);
    });
  });

  test("closing a reserved runner connection stops its blocked CIC and preserves INVALID", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      const gate = createOnlineIndexGate({
        connection: fixture.connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_build",
        ...fixture.gate,
        wait: async () => {
          await waitForPhase(fixture.observer, fixture.pid);
          await terminateReserved(fixture.builder);
        },
      });
      const outcome = await Result.tryPromise(
        async () => await gate.attempt(fixture.index.createSql),
      );
      expect(outcome.isErr()).toBe(true);
      await waitForBackendExit(
        fixture.observer,
        fixture.pid,
        "the closed runner backend exits",
      );
      expect(await indexState(fixture)).toMatchObject({ valid: false });
      await fixture.blocker`ROLLBACK`;
      await repair(fixture, connectionAdapter(fixture.owner));
    });
  });

  test("termination during CIC preserves an INVALID index that another runner repairs", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      const gate = createOnlineIndexGate({
        connection: fixture.connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_build",
        ...fixture.gate,
        wait: async () => {
          await waitForPhase(fixture.observer, fixture.pid);
          expect(await indexState(fixture)).toMatchObject({ valid: false });
          const result = await fixture.observer<
            { terminated: boolean }[]
          >`SELECT pg_terminate_backend(${fixture.pid}) AS terminated`;
          expect(result.at(0)?.terminated).toBe(true);
        },
      });
      const outcome = await Result.tryPromise(
        async () => await gate.attempt(fixture.index.createSql),
      );
      expect(outcome.isErr()).toBe(true);
      expect(await indexState(fixture)).toMatchObject({ valid: false });
      await fixture.blocker`ROLLBACK`;
      await repair(fixture, connectionAdapter(fixture.owner));
    });
  });

  test("repairs a ready INVALID unique index while it keeps rejecting duplicates", async () => {
    await withFixture(async (fixture) => {
      fixture.index.isUnique = true;
      fixture.index.createSql = `CREATE UNIQUE INDEX CONCURRENTLY ${fixture.name} ON public.${fixture.table} USING btree (id)`;
      // An older snapshot holds the build after PostgreSQL marks the index
      // ready and before it is valid; cancelling there leaves it maintained.
      await fixture.blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
      await fixture.blocker`SELECT 1 FROM pg_class LIMIT 1`;
      const build = Result.tryPromise({
        try: async () => await fixture.builder.unsafe(fixture.index.createSql),
        catch: (cause: unknown) => cause,
      });
      await waitForPhase(
        fixture.observer,
        fixture.pid,
        "waiting for old snapshots",
      );
      await fixture.owner`SELECT pg_cancel_backend(${fixture.pid})`;
      const cancelled = await build;
      expect(cancelled.isErr()).toBe(true);
      if (cancelled.isErr()) {
        expect(getPgErrorCode(cancelled.error)).toBe(PG_ERROR.QUERY_CANCELED);
      }
      await fixture.blocker`ROLLBACK`;
      expect(await indexState(fixture)).toMatchObject({
        valid: false,
        ready: true,
      });
      const assertDuplicateRejected = async () => {
        const insert = await Result.tryPromise({
          try: async () =>
            await fixture.owner.unsafe(
              `INSERT INTO public.${fixture.table} VALUES (1, 3)`,
            ),
          catch: (cause: unknown) => cause,
        });
        expect(insert.isErr()).toBe(true);
        if (insert.isErr()) {
          expect(getPgErrorCode(insert.error)).toBe(PG_ERROR.UNIQUE_VIOLATION);
        }
      };
      // The INVALID index is what enforces uniqueness before the repair.
      await assertDuplicateRejected();

      const statements: string[] = [];
      const connection: OnlineMigrationConnection = {
        ...fixture.connection,
        execute: async (statement, parameters) => {
          await fixture.connection.execute(statement, parameters);
          statements.push(statement);
          await assertDuplicateRejected();
        },
      };
      fixture.gate.wait = async (milliseconds, signal) => {
        await assertDuplicateRejected();
        await waitForAbort(milliseconds, signal);
      };
      await repair(fixture, connection);

      expect(statements).toContain(
        `REINDEX INDEX CONCURRENTLY public."${fixture.name}"`,
      );
      expect(
        statements.filter((statement) =>
          statement.startsWith(
            `DROP INDEX CONCURRENTLY public."${fixture.name}"`,
          ),
        ),
      ).toEqual([]);
      await assertDuplicateRejected();
      const rows = await fixture.observer.unsafe<{ count: number }[]>(
        `SELECT count(*)::integer AS count FROM public.${fixture.table} WHERE id = 1`,
      );
      expect(rows.at(0)?.count).toBe(1);
    });
  });

  test("a second runner yields the database-wide slot while the first CIC is blocked", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      let contenderMustYield = true;
      const second = createOnlineIndexGate({
        connection: connectionAdapter(fixture.owner),
        observer: fixture.observation,
        tableName: fixture.table,
        name: `${fixture.name}_second`,
        kind: "index_build",
        ...fixture.gate,
        cancelBackend: async (pid) => {
          const rows = await fixture.observer<
            { cancelled: boolean }[]
          >`SELECT pg_cancel_backend(${pid}) AS cancelled`;
          return rows.at(0)?.cancelled === true;
        },
        wait: async (milliseconds, signal) => {
          if (contenderMustYield) {
            throw new TypeError("Contender started while heavy-work slot held");
          }
          await waitForAbort(milliseconds, signal);
        },
      });
      let barrierReached = false;
      const first = createOnlineIndexGate({
        connection: fixture.connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_build",
        ...fixture.gate,
        wait: async (_milliseconds, signal) => {
          await waitForPhase(fixture.observer, fixture.pid);
          expect(
            await second.attempt(
              `CREATE INDEX CONCURRENTLY ${fixture.name}_second ON public.${fixture.table} (other)`,
            ),
          ).toBe("wait");
          barrierReached = true;
          await fixture.blocker`ROLLBACK`;
          await waitForAbort(0, signal);
        },
      });
      try {
        expect(await first.attempt(fixture.index.createSql)).toBe("done");
        expect(barrierReached).toBe(true);
        contenderMustYield = false;
        expect(
          await second.attempt(
            `CREATE INDEX CONCURRENTLY ${fixture.name}_second ON public.${fixture.table} (other)`,
          ),
        ).toBe("done");
        expect(await indexState(fixture)).toMatchObject({ valid: true });
        expect(
          fixture.records
            .map((record) => JSON.stringify(record))
            .some((record) => record.includes("Heavy-work slot unavailable")),
        ).toBe(true);
      } finally {
        await first.close();
        await second.close();
      }
    });
  });

  test("an old transaction touching only another table refuses index start", async () => {
    await withFixture(async (fixture) => {
      const unrelated = `${fixture.table}_unrelated`;
      await fixture.owner.unsafe(
        `CREATE TABLE public.${unrelated} (id integer)`,
      );
      try {
        await fixture.blocker`BEGIN`;
        await fixture.blocker.unsafe(`SELECT * FROM public.${unrelated}`);
        const rows = await fixture.observer<
          { age: number }[]
        >`SELECT extract(epoch FROM (clock_timestamp() - xact_start))::double precision * 1000 AS age FROM pg_stat_activity WHERE pid = (SELECT pid FROM pg_locks WHERE relation = ${`public.${unrelated}`}::regclass AND granted LIMIT 1)`;
        expect(rows.at(0)?.age).toBeGreaterThan(0);
        const config = fixture.gate.config;
        const gate = createOnlineIndexGate({
          connection: fixture.connection,
          observer: fixture.observation,
          tableName: fixture.table,
          name: fixture.name,
          kind: "index_build",
          ...fixture.gate,
          config: {
            ...config,
            health: { ...config.health, longTxMaxAgeMs: 0.001 },
          },
        });
        try {
          expect(await gate.attempt(fixture.index.createSql)).toBe("wait");
          expect(await indexState(fixture)).toBeUndefined();
        } finally {
          await gate.close();
        }
        await fixture.blocker`ROLLBACK`;
        await repair(fixture);
      } finally {
        await fixture.blocker`ROLLBACK`;
        await fixture.owner.unsafe(`DROP TABLE public.${unrelated}`);
      }
    });
  });

  test("CIC waits with unlimited lock and statement budgets, then restores the DDL budget", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      let settingsObserved = false;
      const connection: OnlineMigrationConnection = {
        ...fixture.connection,
        execute: async (statement, parameters) => {
          if (statement === fixture.index.createSql) {
            const rows = await fixture.builder<
              {
                lock: string;
                statement: string;
                workers: string;
                memory: string;
                clientCheck: string;
              }[]
            >`SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement, current_setting('max_parallel_maintenance_workers') AS workers, current_setting('maintenance_work_mem') AS memory, current_setting('client_connection_check_interval') AS "clientCheck"`;
            expect(rows.at(0)).toEqual({
              lock: "0",
              statement: "0",
              workers: "1",
              memory: "16MB",
              clientCheck: "10ms",
            });
            settingsObserved = true;
          }
          await fixture.connection.execute(statement, parameters);
        },
      };
      const gate = createOnlineIndexGate({
        connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_build",
        ...fixture.gate,
        wait: async (_milliseconds, signal) => {
          await waitForPhase(fixture.observer, fixture.pid);
          await fixture.blocker`ROLLBACK`;
          await waitForAbort(0, signal);
        },
      });
      try {
        expect(await gate.attempt(fixture.index.createSql)).toBe("done");
        expect(settingsObserved).toBe(true);
        const settings = await fixture.builder<
          { lock_timeout: string }[]
        >`SHOW lock_timeout`;
        expect(settings.at(0)?.lock_timeout).toBe("1s");
        expect(await indexState(fixture)).toMatchObject({ valid: true });
      } finally {
        await gate.close();
      }
    });
  });

  test("a positive lock timeout cancels CIC waiting for a writer and leaves INVALID", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      await fixture.builder`SET lock_timeout = '1ms'`;
      const outcome = await Result.tryPromise(
        async () => await fixture.connection.execute(fixture.index.createSql),
      );
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(getPgErrorCode(outcome.error)).toBe(PG_ERROR.LOCK_NOT_AVAILABLE);
      }
      expect(await indexState(fixture)).toMatchObject({ valid: false });
      await fixture.blocker`ROLLBACK`;
      await repair(fixture);
    });
  });

  for (const phase of [
    "waiting for writers before build",
    "waiting for writers before validation",
    "waiting for old snapshots",
  ] as const) {
    test(`watchdog cancels ${phase} and the next healthy run repairs VALID`, async () => {
      await withFixture(async (fixture) => {
        const fn = `${fixture.table}_barrier`;
        const key = 741_236;
        const needsScanBarrier = phase !== "waiting for writers before build";
        let clock = fixture.gate.clock();
        let polls = 0;
        if (needsScanBarrier) {
          // IMMUTABLE is intentional fault injection: the advisory lock freezes the first scan.
          await fixture.owner.unsafe(
            `CREATE FUNCTION public.${fn}(value integer) RETURNS integer LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE AS 'BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN value; END'`,
          );
          await fixture.owner`SELECT pg_advisory_lock(${key})`;
          fixture.index.createSql = `CREATE INDEX CONCURRENTLY ${fixture.name} ON public.${fixture.table} (public.${fn}(id))`;
          fixture.index.definitionBody = `ON public.${fixture.table} USING btree (${fn}(id))`;
        } else {
          await blockBuild(fixture);
        }
        const gate = createOnlineIndexGate({
          connection: fixture.connection,
          observer: fixture.observation,
          tableName: fixture.table,
          name: fixture.name,
          kind: "index_build",
          ...fixture.gate,
          clock: () => clock,
          wait: async () => {
            if (polls === 0 && needsScanBarrier) {
              await waitForExternalState({
                description: "the index scan reaches the advisory barrier",
                intervalMs: 5,
                read: async () =>
                  (
                    await fixture.observer<
                      { waiting: boolean }[]
                    >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${fixture.pid} AND locktype = 'advisory' AND NOT granted) AS waiting`
                  ).at(0)?.waiting === true,
              });
              if (phase === "waiting for writers before validation") {
                await blockBuild(fixture);
              } else {
                await fixture.blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
                await fixture.blocker`SELECT 1 FROM pg_class LIMIT 1`;
              }
              await fixture.owner`SELECT pg_advisory_unlock(${key})`;
            }
            await waitForPhase(fixture.observer, fixture.pid, phase);
            expect(await indexState(fixture)).toMatchObject({ valid: false });
            polls++;
            expect(polls).toBeLessThanOrEqual(2);
            if (polls === 2) {
              clock += fixture.gate.config.maxSnapshotWaitMs;
            }
          },
        });
        try {
          expect(await gate.attempt(fixture.index.createSql)).toBe("retry");
          expect(polls).toBe(2);
          expect(
            fixture.records
              .map((record) => JSON.stringify(record))
              .some(
                (record) =>
                  record.includes("Snapshot wait watchdog") &&
                  record.includes('"waitingMs":600000'),
              ),
          ).toBe(true);
          await gate.close();
          await fixture.blocker`ROLLBACK`;
          await repair(fixture);
        } finally {
          await gate.close();
          await fixture.blocker`ROLLBACK`;
          if (needsScanBarrier) {
            await fixture.owner`SELECT pg_advisory_unlock(${key})`;
            await fixture.owner.unsafe(
              `DROP FUNCTION public.${fn}(integer) CASCADE`,
            );
          }
        }
      });
    });
  }

  test("killing the runner process leaves an INVALID index recoverable by a new runner", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "test",
          "--preload",
          "./src/tests/setup-env.ts",
          "./src/db/online-index-gate-process.fixture.test.ts",
        ],
        cwd: new URL("../../", import.meta.url).pathname,
        env: {
          ...process.env,
          ONLINE_INDEX_TEST_TABLE: fixture.table,
          ONLINE_INDEX_TEST_NAME: fixture.name,
          ONLINE_INDEX_TEST_NOW: String(fixture.gate.clock()),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const reader = child.stdout.getReader();
        let output = "";
        let pid: number | undefined;
        while (pid === undefined) {
          const chunk = await reader.read();
          if (chunk.done) {
            throw new TypeError(
              "Child runner exited before reporting its backend",
            );
          }
          output += new TextDecoder().decode(chunk.value);
          const match = /runner-pid:(\d+)\n/u.exec(output);
          if (match) {
            pid = Number(match.at(1));
          }
        }
        reader.releaseLock();
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        await waitForPhase(fixture.observer, pid);
        expect(await indexState(fixture)).toMatchObject({ valid: false });
        child.kill("SIGKILL");
        expect(await child.exited).not.toBe(0);
        await waitFor(
          async () => {
            const rows = await fixture.observer<
              { alive: boolean }[]
            >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ${pid}) AS alive`;
            return rows.at(0)?.alive === false ? true : undefined;
          },
          { description: "the killed runner backend to exit" },
        );
        expect(await indexState(fixture)).toMatchObject({ valid: false });
        await fixture.blocker`ROLLBACK`;
        await repair(fixture);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    });
  });

  test("DROP CONCURRENTLY lock waiting is cancelled by the watchdog before rebuilding", async () => {
    await withFixture(async (fixture) => {
      await fixture.owner.unsafe(
        `CREATE INDEX ${fixture.name} ON public.${fixture.table} (id)`,
      );
      await fixture.blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
      await fixture.blocker.unsafe(`SELECT * FROM public.${fixture.table}`);
      let clock = fixture.gate.clock();
      let polls = 0;
      const gate = createOnlineIndexGate({
        connection: fixture.connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_repair",
        ...fixture.gate,
        clock: () => clock,
        wait: async () => {
          await waitForLockWait(
            fixture.observer,
            fixture.pid,
            "the DROP reaches the reader lock barrier",
          );
          polls++;
          expect(polls).toBeLessThanOrEqual(2);
          if (polls === 2) {
            clock += fixture.gate.config.maxSnapshotWaitMs;
          }
        },
      });
      try {
        expect(
          await gate.attempt(`DROP INDEX CONCURRENTLY public.${fixture.name}`),
        ).toBe("retry");
        expect(polls).toBe(2);
        expect(
          fixture.records
            .map((record) => JSON.stringify(record))
            .some(
              (record) =>
                record.includes("Snapshot wait watchdog") &&
                record.includes("waiting for concurrent index lock"),
            ),
        ).toBe(true);
      } finally {
        await gate.close();
        await fixture.blocker`ROLLBACK`;
      }
      await repair(fixture);
    });
  });

  test("an idle writer on the table holds the work before it joins the lock queue", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      const blockerPid = (
        await fixture.blocker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      ).at(0)?.pid;
      await waitForExternalState({
        description: "the writer is idle in its transaction",
        intervalMs: 5,
        read: async () =>
          (
            await fixture.observer<
              { idle: boolean }[]
            >`SELECT state = 'idle in transaction' AS idle FROM pg_stat_activity WHERE pid = ${blockerPid ?? 0}`
          ).at(0)?.idle === true,
      });
      const gate = createOnlineIndexGate({
        connection: fixture.connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_build",
        ...fixture.gate,
        config: { ...fixture.gate.config, idleHolderMs: 0 },
      });
      try {
        expect(await gate.attempt(fixture.index.createSql)).toBe("wait");
      } finally {
        await gate.close();
      }
      // Never started: no index, and no lock request left behind the writer.
      expect(await indexState(fixture)).toBeUndefined();
      expect(
        fixture.records
          .map((record) => JSON.stringify(record))
          .some(
            (record) =>
              record.includes("Table lock holders") &&
              record.includes(`"pid":${String(blockerPid)}`) &&
              record.includes('"kind":"idle_in_transaction"'),
          ),
      ).toBe(true);
      await fixture.blocker`COMMIT`;
      await repair(fixture);
    });
  });

  test("a lock request already queued on the table holds the work", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      await fixture.owner`BEGIN`;
      const queued = fixture.owner
        .unsafe(`LOCK TABLE public.${fixture.table} IN ACCESS EXCLUSIVE MODE`)
        .execute();
      const queuedRequests = async () =>
        await fixture.observer<
          { pid: number }[]
        >`SELECT pid FROM pg_locks WHERE locktype = 'relation' AND relation = ${`public.${fixture.table}`}::regclass AND NOT granted`;
      await waitForExternalState({
        description: "a lock request queues on the table",
        intervalMs: 5,
        read: async () => (await queuedRequests()).length > 0,
      });
      expect(await queuedRequests()).toHaveLength(1);
      const gate = createOnlineIndexGate({
        connection: fixture.connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_build",
        ...fixture.gate,
      });
      try {
        expect(await gate.attempt(fixture.index.createSql)).toBe("wait");
      } finally {
        await gate.close();
      }
      expect(await indexState(fixture)).toBeUndefined();
      expect(
        fixture.records
          .map((record) => JSON.stringify(record))
          .some(
            (record) =>
              record.includes("Table lock holders") &&
              record.includes('"kind":"queued"'),
          ),
      ).toBe(true);
      await fixture.blocker`ROLLBACK`;
      await queued;
      await fixture.owner`ROLLBACK`;
      await repair(fixture);
    });
  });

  test("the phase's lock budget alone cannot retire an index under a writer", async () => {
    await withFixture(async (fixture) => {
      await fixture.owner.unsafe(
        `CREATE INDEX ${fixture.name} ON public.${fixture.table} (id)`,
      );
      await blockBuild(fixture);
      await fixture.connection.execute("SET lock_timeout = '1s'");
      const bare = await Result.tryPromise({
        try: async () =>
          await fixture.connection.execute(
            `DROP INDEX CONCURRENTLY IF EXISTS public.${fixture.name}`,
          ),
        catch: (cause: unknown) => cause,
      });
      expect(bare.isErr() && getPgErrorCode(bare.error)).toBe(
        PG_ERROR.LOCK_NOT_AVAILABLE,
      );
    });
  });

  test("a replaced index under a writer defers, then retires once the writer commits", async () => {
    await withFixture(async (fixture) => {
      await fixture.owner.unsafe(
        `CREATE INDEX ${fixture.name} ON public.${fixture.table} (id)`,
      );
      await blockBuild(fixture);
      // The phase's own budget: the drop the previous test shows failing.
      await fixture.connection.execute("SET lock_timeout = '1s'");
      const drops: string[] = [];
      const connection: OnlineMigrationConnection = {
        ...fixture.connection,
        execute: async (statement, parameters) => {
          if (statement.includes("DROP INDEX")) {
            drops.push(statement);
          }
          await fixture.connection.execute(statement, parameters);
        },
      };
      let clock = fixture.gate.clock();
      let polls = 0;
      const retire = async (
        wait: NonNullable<OnlineIndexGateOptions["wait"]>,
      ) =>
        await retireOnlineIndex({
          connection,
          index: { name: fixture.name, tableName: fixture.table },
          reserveObserver: async () => ({
            ...fixture.observation,
            release: () => undefined,
          }),
          gate: { ...fixture.gate, clock: () => clock, wait },
        });

      expect(
        await retire(async () => {
          await waitForLockWait(
            fixture.observer,
            fixture.pid,
            "the DROP reaches the writer lock barrier",
          );
          polls++;
          expect(polls).toBeLessThanOrEqual(2);
          if (polls === 2) {
            clock += fixture.gate.config.maxSnapshotWaitMs;
          }
        }),
      ).toEqual({
        type: "deferred",
        step: fixture.name,
        retryAfterMs: fixture.gate.config.retryMs,
      });
      expect(
        fixture.records
          .map((record) => JSON.stringify(record))
          .some((record) => record.includes("Snapshot wait watchdog")),
      ).toBe(true);
      // Cancelled after PostgreSQL marked it invalid: the leftover the next
      // run has to find and drop.
      expect(await indexState(fixture)).toMatchObject({ valid: false });
      // The gate lifted the budget for the drop and restored it after.
      const budget = await fixture.builder<
        { timeout: string }[]
      >`SELECT current_setting('lock_timeout') AS timeout`;
      expect(budget.at(0)?.timeout).toBe("1s");

      // Later runs read health at the fixture's own time again.
      clock = fixture.gate.clock();
      await fixture.blocker`COMMIT`;
      expect(await retire(waitForAbort)).toEqual({ type: "complete" });
      expect(await indexState(fixture)).toBeUndefined();
      expect(drops).toHaveLength(2);

      expect(await retire(waitForAbort)).toEqual({ type: "complete" });
      expect(drops).toHaveLength(2);
    });
  });

  test.each([
    "injected independent session",
    "default independent session",
  ] as const)(
    "a failed observer cancels its blocked builder through %s",
    async (mode) => {
      await withFixture(async (fixture) => {
        await blockBuild(fixture);
        const rows = await fixture.observer<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const observerPid = rows.at(0)?.pid;
        if (observerPid === undefined) {
          throw new TypeError("Missing observer pid");
        }
        let cancelled = false;
        let observerFailure: unknown;
        const observation: OnlineMigrationConnection = {
          ...fixture.observation,
          query: async (statement, parameters) => {
            const result = await Result.tryPromise(
              async () =>
                await fixture.observation.query(statement, parameters),
            );
            if (result.isErr()) {
              observerFailure = result.error;
              throw result.error;
            }
            return result.value;
          },
        };
        const gate = createOnlineIndexGate({
          connection: fixture.connection,
          observer: observation,
          tableName: fixture.table,
          name: fixture.name,
          kind: "index_build",
          ...fixture.gate,
          ...(mode === "injected independent session"
            ? {
                cancelBackend: async (pid: number) => {
                  const results = await fixture.owner<
                    { cancelled: boolean }[]
                  >`SELECT pg_cancel_backend(${pid}) AS cancelled`;
                  cancelled = results.at(0)?.cancelled === true;
                  return cancelled;
                },
              }
            : {}),
          wait: async () => {
            await waitForPhase(fixture.observer, fixture.pid);
            const terminated = await fixture.owner<
              { killed: boolean }[]
            >`SELECT pg_terminate_backend(${observerPid}) AS killed`;
            expect(terminated.at(0)?.killed).toBe(true);
          },
        });
        const outcome = await Result.tryPromise({
          try: async () => await gate.attempt(fixture.index.createSql),
          catch: (cause: unknown) => cause,
        });
        expect(outcome.isErr()).toBe(true);
        expect(observerFailure).toBeDefined();
        if (outcome.isErr()) {
          expect(outcome.error).toBe(observerFailure);
        }
        expect(cancelled).toBe(mode === "injected independent session");
        const active = await fixture.owner<
          { active: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ${fixture.pid} AND state = 'active') AS active`;
        expect(active.at(0)?.active).toBe(false);
        await gate.close();
        await fixture.blocker`ROLLBACK`;
        fixture.observer = fixture.owner;
        fixture.observation = connectionAdapter(fixture.owner);
        expect(await indexState(fixture)).toMatchObject({ valid: false });
        await repair(fixture);
      });
    },
  );

  test("losing both observer and independent canceller disposes the runner session", async () => {
    await withFixture(async (fixture) => {
      await blockBuild(fixture);
      const observerRows = await fixture.observer<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      const observerPid = observerRows.at(0)?.pid;
      if (observerPid === undefined) {
        throw new TypeError("Missing observer pid");
      }
      let independentCancellationAttempted = false;
      let terminated = false;
      const connection = {
        ...fixture.connection,
        terminate: async () => {
          terminated = true;
          await terminateReserved(fixture.builder);
        },
      };
      const gate = createOnlineIndexGate({
        connection,
        observer: fixture.observation,
        tableName: fixture.table,
        name: fixture.name,
        kind: "index_build",
        ...fixture.gate,
        cancelBackend: async () => {
          independentCancellationAttempted = true;
          throw new TypeError("Independent cancellation unavailable");
        },
        wait: async () => {
          await waitForPhase(fixture.observer, fixture.pid);
          const rows = await fixture.owner<
            { killed: boolean }[]
          >`SELECT pg_terminate_backend(${observerPid}) AS killed`;
          expect(rows.at(0)?.killed).toBe(true);
        },
      });
      const outcome = await Result.tryPromise({
        try: async () => await gate.attempt(fixture.index.createSql),
        catch: (cause: unknown) => cause,
      });
      expect(outcome.isErr()).toBe(true);
      if (outcome.isErr()) {
        expect(outcome.error).toMatchObject({
          message:
            "Online index monitoring and independent cancellation failed; build session terminated",
        });
      }
      expect(independentCancellationAttempted).toBe(true);
      expect(terminated).toBe(true);
      await waitForBackendExit(
        fixture.owner,
        fixture.pid,
        "the disposed runner backend exits",
      );
      await fixture.blocker`ROLLBACK`;
      fixture.observer = fixture.blocker;
      fixture.observation = connectionAdapter(fixture.blocker);
      expect(await indexState(fixture)).toMatchObject({ valid: false });
      await repair(fixture, connectionAdapter(fixture.owner));
    });
  });

  test.each(["valid", "invalid"] as const)(
    "same-name %s indexes with another definition retain their identity and contents",
    async (state) => {
      await withFixture(async (fixture) => {
        if (state === "invalid") {
          await fixture.owner.unsafe(
            `INSERT INTO public.${fixture.table} VALUES (2, 2)`,
          );
          const outcome = await Result.tryPromise(
            async () =>
              await fixture.connection.execute(
                `CREATE UNIQUE INDEX CONCURRENTLY ${fixture.name} ON public.${fixture.table} (other)`,
              ),
          );
          expect(outcome.isErr()).toBe(true);
          if (outcome.isErr()) {
            expect(getPgErrorCode(outcome.error)).toBe(
              PG_ERROR.UNIQUE_VIOLATION,
            );
          }
        } else {
          await fixture.owner.unsafe(
            `CREATE INDEX ${fixture.name} ON public.${fixture.table} (other)`,
          );
        }
        const before = await indexState(fixture);
        expect(before).toMatchObject({ valid: state === "valid" });
        expect(before?.definition).toContain("(other)");
        const rejected = await Result.tryPromise({
          try: async () => await repair(fixture),
          catch: (cause: unknown) => cause,
        });
        expect(rejected.isErr()).toBe(true);
        if (rejected.isErr()) {
          expect(rejected.error).toBeInstanceOf(Panic);
          if (rejected.error instanceof Panic) {
            expect(rejected.error.message).toContain("unexpected definition");
          }
        }
        expect(await indexState(fixture)).toEqual(before);
      });
    },
  );
});
