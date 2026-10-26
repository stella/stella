import type { SQL } from "bun";
import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { withTimeout } from "@stll/concurrency/with-timeout";
import { waitForExternalState } from "@stll/property-testing/external-state";

import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

import migrationAliasInventory from "../lib/db/migration-alias-inventory.json";
import { assertMigrationHistory } from "../lib/db/migration-history";
import { isPgError, PG_ERROR } from "../lib/pg-error";
import { withGatedTestClients } from "../tests/gated-test-database";
import {
  CORPUS_SCHEMA_LANE,
  CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL,
  isCorpusSchemaLaneGranted,
} from "./corpus-schema-lane";
import {
  MIGRATION_LOCK_WAIT_FAILURE,
  MIGRATION_LOCK_WAIT_RETRY_BUDGET_MS,
  MigrationLockWaitError,
  runMigrations,
  runMigrationsUntilSettled,
} from "./migration-runner";
import type {
  MigrationTiming,
  MigrationTimingRecord,
} from "./migration-timing";
import type { OnlineMigrationOutcome } from "./online-migration-connection";
import { ONLINE_MIGRATION_INDEXES } from "./online-migrations";

const databaseUrl = process.env["DATABASE_URL"];
// Scratch databases are not RDS; the migrator requires an explicit choice.
const DISABLED_EBS = { type: "disabled" } as const;
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const A = "20260929000000_runner_a";
const B = "20260929000100_runner_b";
const C = "20260929000200_runner_c";
const CREATE_PROBE =
  "CREATE TABLE migration_probe (event text NOT NULL);--> statement-breakpoint\n" +
  "INSERT INTO migration_probe (event) VALUES ('A');";
const REWRITTEN_CREATE_PROBE = `-- alias rewrite in a newer bundle\n${CREATE_PROBE}`;
const INSERT_B = "INSERT INTO migration_probe (event) VALUES ('B');";
const INSERT_C = "INSERT INTO migration_probe (event) VALUES ('C');";
const CREATE_PROBE_B = `CREATE TABLE migration_probe (event text NOT NULL);--> statement-breakpoint\n${INSERT_B}`;
const CREATE_LOCK_PROBE = "CREATE TABLE lock_probe (id integer)";
// An embedded timeout must yield to the attempt's configured queue bound.
const ALTER_LOCK_PROBE =
  "SET lock_timeout = '100ms';--> statement-breakpoint\n" +
  "ALTER TABLE lock_probe ADD COLUMN reissued boolean;";
const CORPUS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const SCRATCH_TEARDOWN_TIMEOUT_MS = 30_000;
const ONLINE_COMPLETE = {
  type: "complete",
} as const satisfies OnlineMigrationOutcome;

setDefaultTimeout(120_000);

type MigrationFile = { name: string; sql: string };

const withBundle = async <T>(
  files: readonly MigrationFile[],
  work: (folder: string) => Promise<T>,
): Promise<T> => {
  const folder = mkdtempSync(
    nodePath.join(tmpdir(), "stella-migration-runner-"),
  );
  try {
    for (const file of files) {
      const migrationDir = nodePath.join(folder, file.name);
      mkdirSync(migrationDir);
      writeFileSync(nodePath.join(migrationDir, "migration.sql"), file.sql);
    }
    return await work(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

const withCorpusBundle = async (work: (folder: string) => Promise<void>) => {
  const folder = mkdtempSync(
    nodePath.join(tmpdir(), "stella-corpus-migrations-"),
  );
  const roleCreation = /CREATE ROLE ([a-z_][a-z0-9_]*) NOLOGIN;/gu;
  let guardedRoleCreations = 0;
  try {
    for (const name of readdirSync(CORPUS_DIR)) {
      const source = nodePath.join(CORPUS_DIR, name, "migration.sql");
      if (!existsSync(source)) {
        continue;
      }
      const sql = readFileSync(source, "utf-8");
      guardedRoleCreations += [...sql.matchAll(roleCreation)].length;
      // Cluster roles outlive scratch databases. Guard only their creation in
      // this temporary copy; every inventoried migration stays byte-identical.
      const testSql = sql.replace(
        roleCreation,
        (_statement, role: string) =>
          `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$;`,
      );
      if (migrationAliasInventory.some(({ fileName }) => fileName === name)) {
        expect(testSql).toBe(sql);
      }
      const target = nodePath.join(folder, name);
      mkdirSync(target);
      writeFileSync(nodePath.join(target, "migration.sql"), testSql);
    }
    expect(guardedRoleCreations).toBe(7);
    await work(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

type Scratch = {
  /** The scratch database, which a real online phase observes. */
  scratchUrl: string;
  observer: SQL;
  openClient: () => SQL;
  run: (
    folder: string,
    onOnline?: () => Promise<void>,
  ) => ReturnType<typeof runMigrations>;
};

const withScratch = async <T>(
  work: (scratch: Scratch) => Promise<T>,
  adminClient?: SQL,
) => {
  if (databaseUrl === undefined) {
    throw new Error(
      "DATABASE_URL is required for migration runner database tests",
    );
  }
  return await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const admin = adminClient ?? openClient().sql;
    const name = `stella_runner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    try {
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      const scratchUrl = url.toString();
      return await withGatedTestClients(
        scratchUrl,
        async ({ openClient: openScratchClient }) => {
          const observer = openScratchClient().sql;
          return await work({
            scratchUrl,
            observer,
            openClient: () => openScratchClient().sql,
            run: async (folder, onOnline) => {
              const connection = await openScratchClient().sql.reserve();
              try {
                return await runMigrations({
                  connection,
                  migrationsFolder: folder,
                  ebs: DISABLED_EBS,
                  databaseUrl: scratchUrl,
                  runOnline: async () => {
                    await onOnline?.();
                    return ONLINE_COMPLETE;
                  },
                });
              } finally {
                await connection.release();
              }
            },
          });
        },
      );
    } finally {
      // Normal DROP waits for owned sessions to exit without requiring signal privileges.
      await admin.unsafe(`DROP DATABASE "${name}"`);
    }
  });
};

const ledgerRows = async (observer: SQL) =>
  await observer.unsafe<
    { id: number; name: string; hash: string; created_at: bigint }[]
  >(
    "SELECT id, name, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
  );

const probeEvents = async (observer: SQL) =>
  (
    await observer.unsafe<{ event: string }[]>(
      "SELECT event FROM migration_probe ORDER BY event",
    )
  ).map(({ event }) => event);

const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> =>
  await run().then(
    () => null,
    (error: unknown) => error,
  );

/** A key only these tests take; schema SQL that awaits it parks under the lane. */
const SCHEMA_GATE_KEY = 74_221_903;
const AWAIT_SCHEMA_GATE = `SELECT pg_advisory_xact_lock(${String(SCHEMA_GATE_KEY)});`;
const HOLD_SCHEMA_GATE = `SELECT pg_advisory_lock(${String(SCHEMA_GATE_KEY)})`;
const RELEASE_SCHEMA_GATE = `SELECT pg_advisory_unlock_all()`;

const backendPid = async (connection: SQL) => {
  const [row] = await connection.unsafe<{ pid: number }[]>(
    "SELECT pg_backend_pid() AS pid",
  );
  if (row === undefined) {
    throw new Error("Expected backend pid");
  }
  return row.pid;
};

const appliedResult = (result: Awaited<ReturnType<typeof runMigrations>>) => {
  if (result.status !== "applied") {
    throw new Error(`Expected migrations to apply, got ${result.status}`);
  }
  return result;
};

const waitUntilBlocked = async (observer: SQL, pid: number) => {
  await waitForExternalState({
    description: `migration backend ${String(pid)} waits on the lane`,
    read: async () => {
      const [row] = await observer.unsafe<{ blocked: boolean }[]>(
        "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked",
        [pid],
      );
      return row?.blocked === true;
    },
  });
};

type LockProbeHolder = {
  held: Promise<undefined>;
  /** Ends the holding transaction; resolves once it has committed. */
  release: () => Promise<void>;
};

/** A second session holding a lock the ALTER in `ALTER_LOCK_PROBE` conflicts with. */
const holdLockProbe = (client: SQL): LockProbeHolder => {
  const held = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const done = client.begin(async (tx) => {
    await tx.unsafe("LOCK TABLE lock_probe IN ACCESS SHARE MODE");
    held.resolve(undefined);
    await release.promise;
  });
  // A holder that fails before locking fails the test waiting on `held`;
  // `release` awaits `done` and rethrows any later failure.
  void done.catch((error: unknown) => {
    held.reject(error);
  });
  return {
    held: held.promise,
    release: async () => {
      release.resolve(undefined);
      await done;
    },
  };
};

const lockProbeColumns = async (observer: SQL) =>
  (
    await observer.unsafe<{ name: string }[]>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'lock_probe' ORDER BY ordinal_position",
    )
  ).map(({ name }) => name);

/** Sessions holding this database's corpus schema lane exclusive. */
const laneHolders = async (observer: SQL) => {
  const [row] = await observer.unsafe<{ holders: number }[]>(
    `SELECT count(*)::int AS holders FROM pg_locks
     WHERE locktype = 'advisory' AND mode = 'ExclusiveLock' AND granted
       AND objsubid = 2
       AND classid = hashtext($1)::oid AND objid = hashtext($2)::oid
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [CORPUS_SCHEMA_LANE.domain, CORPUS_SCHEMA_LANE.lane],
  );
  return row?.holders ?? Number.NaN;
};

if (!runPostgresTests || databaseUrl === undefined) {
  describe.skip("migration runner PostgreSQL contract", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && databaseUrl !== undefined).toBe(false);
    });
  });
} else {
  describe("migration runner PostgreSQL contract", () => {
    test(
      "scratch teardown waits for backend exit without signal privileges",
      async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const admin = openClient().sql;
          const monitor = openClient().sql;
          const ownerRole = `runner_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
          const databases: string[] = [];
          const releases: Promise<unknown>[] = [];
          await admin.unsafe(
            `CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT CREATEDB`,
          );
          try {
            await admin.unsafe(
              `GRANT ${ownerRole} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
            );
            await admin.unsafe(`SET ROLE ${ownerRole}`);
            const authority = (
              await admin.unsafe(
                `SELECT current_user AS caller,
                      pg_has_role(current_user, session_user, 'USAGE') AS "maySignalLogin",
                      pg_has_role(current_user, 'pg_signal_backend', 'USAGE') AS "maySignalAny"`,
              )
            ).at(0);
            expect(authority).toMatchObject({
              caller: ownerRole,
              maySignalLogin: false,
              maySignalAny: false,
            });
            const pid = (
              await admin.unsafe<{ pid: number }[]>(
                "SELECT pg_backend_pid() AS pid",
              )
            ).at(0)?.pid;
            if (pid === undefined) {
              throw new Error("Expected restricted owner's backend pid");
            }
            const dropped = await withScratch(async ({ scratchUrl }) => {
              const name = new URL(scratchUrl).pathname.slice(1);
              databases.push(name);
              // This pool belongs to the outer scope, so teardown must await its exit.
              const foreign = openClient({ databaseUrl: scratchUrl }).sql;
              await foreign.unsafe("SELECT 1");
              releases.push(
                rejectionOf(async () => {
                  try {
                    await waitForExternalState({
                      description:
                        "scratch teardown waits for the backend to exit",
                      read: async () =>
                        (
                          await monitor.unsafe<{ executing: boolean }[]>(
                            `SELECT EXISTS (
                             SELECT 1 FROM pg_stat_activity
                             WHERE pid = $1 AND state = 'active' AND query = $2
                           ) AS executing`,
                            [pid, `DROP DATABASE "${name}"`],
                          )
                        ).at(0)?.executing === true,
                    });
                  } finally {
                    await foreign.close();
                  }
                }),
              );
              return name;
            }, admin);
            expect(releases).toHaveLength(1);
            expect(await releases.at(0)).toBeNull();
            expect(
              (
                await admin.unsafe<{ absent: boolean }[]>(
                  "SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS absent",
                  [dropped],
                )
              ).at(0)?.absent,
            ).toBe(true);
          } finally {
            await Promise.all(releases);
            await admin.unsafe("RESET ROLE");
            for (const name of databases) {
              await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
            }
            await admin.unsafe(`DROP ROLE ${ownerRole}`);
          }
        });
      },
      SCRATCH_TEARDOWN_TIMEOUT_MS,
    );

    test("rejects corrupted history before a pending statement runs", async () => {
      await withBundle(
        [{ name: A, sql: CREATE_PROBE }],
        async (firstFolder) => {
          await withBundle(
            [
              { name: A, sql: CREATE_PROBE },
              { name: B, sql: INSERT_B },
            ],
            async (secondFolder) => {
              await withScratch(async ({ observer, run }) => {
                await run(firstFolder);
                await observer.unsafe(
                  "UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE name = $2",
                  ["0".repeat(64), A],
                );

                const rejection = await rejectionOf(
                  async () => await run(secondFolder),
                );
                expect(rejection).toMatchObject({
                  message: expect.stringContaining("hash-mismatch"),
                });
                expect(await probeEvents(observer)).toEqual(["A"]);
                expect(
                  (await ledgerRows(observer)).map(({ name }) => name),
                ).toEqual([A]);
              });
            },
          );
        },
      );
    });

    test("adopts a v0 receipt by hash and does not replay its SQL", async () => {
      await withBundle(
        [
          { name: A, sql: CREATE_PROBE },
          { name: B, sql: INSERT_B },
        ],
        async (folder) => {
          await withScratch(async ({ observer, run }) => {
            const [migrationA, migrationB] = readMigrationFiles({
              migrationsFolder: folder,
            });
            if (migrationA === undefined || migrationB === undefined) {
              throw new Error("Expected migrations A and B");
            }
            expect(migrationA.hash).not.toBe(migrationB.hash);
            expect(migrationA.folderMillis).not.toBe(migrationB.folderMillis);
            await observer.unsafe("CREATE SCHEMA drizzle");
            await observer.unsafe(
              "CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
            );
            await observer.unsafe(
              "CREATE TABLE migration_probe (event text NOT NULL)",
            );
            await observer.unsafe(
              "INSERT INTO migration_probe (event) VALUES ('A')",
            );
            await observer.unsafe(
              "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
              [migrationA.hash, migrationB.folderMillis],
            );
            const result = await run(folder);
            expect(result).toMatchObject({
              status: "applied",
              predictedNames: [B],
              insertedNames: [B],
            });
            expect(await probeEvents(observer)).toEqual(["A", "B"]);
            const rows = await ledgerRows(observer);
            expect(rows.map(({ name }) => name)).toEqual([A, B]);
            expect(rows.at(0)).toMatchObject({
              id: 1,
              hash: migrationA.hash,
              created_at: BigInt(migrationB.folderMillis),
            });
            const [adopted] = await observer.unsafe<
              { applied_at: Date | null }[]
            >(
              "SELECT applied_at FROM drizzle.__drizzle_migrations WHERE id = 1",
            );
            expect(adopted?.applied_at).toBeNull();
          });
        },
      );
    });

    test("constrains a nullable-name ledger and reaches a fixed point", async () => {
      await withBundle([{ name: A, sql: CREATE_PROBE }], async (folder) => {
        await withScratch(async ({ observer, run }) => {
          const migrationA = readMigrationFiles({
            migrationsFolder: folder,
          }).at(0);
          if (migrationA === undefined) {
            throw new Error("Expected migration A");
          }
          await observer.unsafe("CREATE SCHEMA drizzle");
          await observer.unsafe(
            "CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text, applied_at timestamptz DEFAULT now())",
          );
          await observer.unsafe(
            "CREATE TABLE migration_probe (event text NOT NULL)",
          );
          await observer.unsafe(
            "INSERT INTO migration_probe (event) VALUES ('A')",
          );
          await observer.unsafe(
            "INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ($1, $2, $3)",
            [migrationA.hash, migrationA.folderMillis, A],
          );

          expect(appliedResult(await run(folder)).insertedNames).toEqual([]);
          const [shape] = await observer.unsafe<
            {
              notNull: boolean;
              uniqueNames: number;
            }[]
          >(`
            SELECT attribute.attnotnull AS "notNull",
              (SELECT count(*)::int FROM pg_constraint migration_constraint
               WHERE migration_constraint.conrelid = 'drizzle.__drizzle_migrations'::regclass
                 AND migration_constraint.contype = 'u') AS "uniqueNames"
            FROM pg_attribute attribute
            WHERE attribute.attrelid = 'drizzle.__drizzle_migrations'::regclass
              AND attribute.attname = 'name'
          `);
          expect(shape).toEqual({ notNull: true, uniqueNames: 1 });
          const firstRows = await ledgerRows(observer);
          expect(appliedResult(await run(folder)).insertedNames).toEqual([]);
          expect(await ledgerRows(observer)).toEqual(firstRows);
          expect(await probeEvents(observer)).toEqual(["A"]);
        });
      });
    });

    test("applies an older pending migration exactly once after a newer receipt", async () => {
      await withBundle(
        [{ name: B, sql: CREATE_PROBE_B }],
        async (newerFolder) => {
          await withBundle(
            [
              {
                name: A,
                sql: "INSERT INTO migration_probe (event) VALUES ('A');",
              },
              { name: B, sql: CREATE_PROBE_B },
            ],
            async (fullFolder) => {
              await withScratch(async ({ observer, run }) => {
                expect(
                  appliedResult(await run(newerFolder)).insertedNames,
                ).toEqual([B]);
                const first = await run(fullFolder);
                expect(first).toMatchObject({
                  predictedNames: [A],
                  insertedNames: [A],
                });
                expect(
                  appliedResult(await run(fullFolder)).insertedNames,
                ).toEqual([]);
                expect(await probeEvents(observer)).toEqual(["A", "B"]);
                expect(
                  (await ledgerRows(observer)).map(({ name }) => name),
                ).toEqual([B, A]);
              });
            },
          );
        },
      );
    });

    test("a second session waits on the lane and applies no duplicate SQL", async () => {
      await withBundle(
        [
          {
            name: A,
            sql: `${CREATE_PROBE}--> statement-breakpoint\n${AWAIT_SCHEMA_GATE}`,
          },
        ],
        async (folder) => {
          await withScratch(async ({ scratchUrl, observer, openClient }) => {
            const gate = await openClient().reserve();
            const first = await openClient().reserve();
            const second = await openClient().reserve();
            const firstPid = await backendPid(first);
            const secondPid = await backendPid(second);
            await gate.unsafe(HOLD_SCHEMA_GATE);
            const firstRun = runMigrations({
              connection: first,
              migrationsFolder: folder,
              ebs: DISABLED_EBS,
              databaseUrl: scratchUrl,
              runOnline: async () => ONLINE_COMPLETE,
            });
            try {
              // The first run holds the lane while its schema SQL waits.
              await waitUntilBlocked(observer, firstPid);
              const secondRun = runMigrations({
                connection: second,
                migrationsFolder: folder,
                ebs: DISABLED_EBS,
                databaseUrl: scratchUrl,
                runOnline: async () => ONLINE_COMPLETE,
              });
              await waitUntilBlocked(observer, secondPid);
              await gate.unsafe(RELEASE_SCHEMA_GATE);
              expect(appliedResult(await firstRun).insertedNames).toEqual([A]);
              expect(appliedResult(await secondRun).insertedNames).toEqual([]);
              expect(await probeEvents(observer)).toEqual(["A"]);
              expect(
                (await ledgerRows(observer)).map(({ name }) => name),
              ).toEqual([A]);
            } finally {
              await gate.unsafe(RELEASE_SCHEMA_GATE);
              // swallow-ok: finally drains the first migration runner after its applied result has been asserted
              await firstRun.catch(() => undefined);
              await gate.release();
              await first.release();
              await second.release();
            }
          });
        },
      );
    });

    /**
     * An index build on a corpus-sized table runs for many minutes. The
     * schema SQL needs the lane; the online phase must not keep corpus
     * writers out while it builds.
     */
    test("the online phase runs with the lane open to corpus writers", async () => {
      await withBundle([{ name: A, sql: CREATE_PROBE }], async (folder) => {
        await withScratch(async ({ observer, run }) => {
          const result = await run(folder, async () => {
            expect(await laneHolders(observer)).toBe(0);
            expect(
              await observer.begin(async (tx) =>
                isCorpusSchemaLaneGranted(
                  await tx.unsafe(CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL),
                ),
              ),
            ).toBe(true);
          });
          expect(appliedResult(result).insertedNames).toEqual([A]);
          expect(await laneHolders(observer)).toBe(0);
        });
      });
    });

    test("every run reports how long its schema and online phases took, a failed phase included", async () => {
      await withBundle([{ name: A, sql: CREATE_PROBE }], async (folder) => {
        await withScratch(async ({ scratchUrl, openClient }) => {
          const records: MigrationTimingRecord[] = [];
          let now = 0;
          const timing: MigrationTiming = {
            // Each reading advances 10 ms, so every duration is non-zero and exact.
            clock: () => (now += 10),
            emit: (record) => {
              records.push(record);
            },
          };
          const connection = await openClient().reserve();
          try {
            await runMigrations({
              connection,
              migrationsFolder: folder,
              ebs: DISABLED_EBS,
              databaseUrl: scratchUrl,
              timing,
              runOnline: async () => ONLINE_COMPLETE,
            });
            expect(records).toEqual([
              {
                event: "migrate.phase_duration",
                phase: "schema",
                durationMs: 20,
                retriesSpent: 0,
                outcome: "applied",
                laneWaitMs: 10,
                appliedCount: 1,
              },
              {
                event: "migrate.phase_duration",
                phase: "online",
                durationMs: 10,
                retriesSpent: 0,
                outcome: "complete",
              },
            ]);

            records.length = 0;
            const failure = new Error("online step failed");
            expect(
              await rejectionOf(
                async () =>
                  await runMigrations({
                    connection,
                    migrationsFolder: folder,
                    ebs: DISABLED_EBS,
                    databaseUrl: scratchUrl,
                    timing,
                    runOnline: async () => {
                      throw failure;
                    },
                  }),
              ),
            ).toBe(failure);
            expect(records).toMatchObject([
              { phase: "schema", outcome: "applied", appliedCount: 0 },
              { phase: "online", outcome: "failed" },
            ]);
          } finally {
            await connection.release();
          }
        });
      });
    });

    /**
     * A held index build reports no completion, keeps the lane open while it
     * waits, and a later run resumes it.
     */
    test("a deferred online phase leaves the lane open while it waits and settles on a later run", async () => {
      await withBundle([{ name: A, sql: CREATE_PROBE }], async (folder) => {
        await withScratch(async ({ scratchUrl, observer, openClient }) => {
          const laneOpenToWriters = async () =>
            await observer.begin(async (tx) =>
              isCorpusSchemaLaneGranted(
                await tx.unsafe(CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL),
              ),
            );
          const deferred = {
            type: "deferred",
            step: "probe_idx",
            retryAfterMs: 7,
          } as const satisfies OnlineMigrationOutcome;
          const connection = await openClient().reserve();
          const timings: MigrationTimingRecord[] = [];
          try {
            const single = await runMigrations({
              connection,
              migrationsFolder: folder,
              ebs: DISABLED_EBS,
              databaseUrl: scratchUrl,
              timing: {
                clock: () => performance.now(),
                emit: (record) => {
                  timings.push(record);
                },
              },
              runOnline: async () => {
                expect(await laneOpenToWriters()).toBe(true);
                return deferred;
              },
            });
            const onlineTerminals = timings.filter(
              (record) =>
                record.event === "migrate.phase_duration" &&
                record.phase === "online",
            );
            expect(onlineTerminals).toHaveLength(1);
            expect(onlineTerminals.at(0)).toMatchObject({
              outcome: "deferred",
              retriesSpent: 0,
            });
            expect(single).toMatchObject({
              status: "online_deferred",
              step: deferred.step,
              insertedNames: [A],
            });
            expect(await laneOpenToWriters()).toBe(true);

            const outcomes: OnlineMigrationOutcome[] = [
              deferred,
              deferred,
              ONLINE_COMPLETE,
            ];
            const holds = new Set<unknown>();
            const sleeps: number[] = [];
            const settled = await runMigrationsUntilSettled({
              connection,
              migrationsFolder: folder,
              ebs: DISABLED_EBS,
              databaseUrl: scratchUrl,
              runOnline: async (_pool, options) => {
                holds.add(options.indexGate.hold);
                expect(await laneOpenToWriters()).toBe(true);
                const outcome = outcomes.shift();
                if (outcome === undefined) {
                  throw new Error("Online phase ran after it completed");
                }
                return outcome;
              },
              sleep: async (milliseconds) => {
                sleeps.push(milliseconds);
                expect(await laneOpenToWriters()).toBe(true);
              },
            });
            expect(appliedResult(settled).insertedNames).toEqual([]);
            expect(outcomes).toEqual([]);
            expect(sleeps).toEqual([7, 7]);
            expect(holds.size).toBe(1);
            expect(await laneOpenToWriters()).toBe(true);
            expect(await probeEvents(observer)).toEqual(["A"]);
            expect(
              (await ledgerRows(observer)).map(({ name }) => name),
            ).toEqual([A]);
          } finally {
            await connection.release();
          }
        });
      });
    });

    /**
     * The index gate terminates the migrator session when it can neither
     * monitor nor cancel a build. Its error must reach the caller, and the
     * lane must be free because the backend exited.
     */
    test("a terminated online session surfaces the online error and frees the lane", async () => {
      await withBundle([{ name: A, sql: CREATE_PROBE }], async (folder) => {
        await withScratch(async ({ scratchUrl, observer, openClient }) => {
          const laneOpenToWriters = async () =>
            await observer.begin(async (tx) =>
              isCorpusSchemaLaneGranted(
                await tx.unsafe(CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL),
              ),
            );
          const onlineError = new Error("online monitoring and cancel failed");
          const connection = await openClient().reserve();
          try {
            const run = runMigrations({
              connection,
              migrationsFolder: folder,
              ebs: DISABLED_EBS,
              databaseUrl: scratchUrl,
              runOnline: async (pool) => {
                const { terminate } = await pool.reserve();
                if (terminate === undefined) {
                  throw new Error(
                    "Expected the migrator session to be terminable",
                  );
                }
                await withTimeout(async () => await terminate(), {
                  label: "migration session termination",
                  timeoutMs: HAPPY_PATH_TIMEOUT_MS,
                });
                throw onlineError;
              },
            });
            expect(await rejectionOf(async () => await run)).toBe(onlineError);
            // The server drops the advisory lock when the closed backend exits,
            // which can trail the client-side close by a moment.
            await waitForExternalState({
              description: "the migration lane is open to writers",
              intervalMs: 100,
              read: laneOpenToWriters,
            });
            expect(
              (await ledgerRows(observer)).map(({ name }) => name),
            ).toEqual([A]);
          } finally {
            await connection.release();
          }
        });
      });
    });

    test("the migrate CLI retries a held online phase instead of exiting after one run", async () => {
      await withScratch(async ({ scratchUrl, observer, openClient }) => {
        // No schema SQL is pending. The first absent online index must defer
        // before DDL, so this fixture needs the real ledger and health probes.
        const migrations = readMigrationFiles({ migrationsFolder: CORPUS_DIR });
        expect(migrations.length).toBeGreaterThan(0);
        const firstIndex = ONLINE_MIGRATION_INDEXES.at(0);
        if (firstIndex === undefined) {
          throw new TypeError("Expected an online index");
        }
        await observer.unsafe("CREATE SCHEMA drizzle");
        await observer.unsafe(`CREATE TABLE drizzle.__drizzle_migrations (
          id serial PRIMARY KEY, hash text NOT NULL, created_at bigint,
          name text NOT NULL UNIQUE, applied_at timestamptz DEFAULT now()
        )`);
        await observer.unsafe(
          `INSERT INTO drizzle.__drizzle_migrations (name, hash, created_at) VALUES ${migrations.map((_migration, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`).join(", ")}`,
          migrations.flatMap(({ name, hash, folderMillis }) => [
            name,
            hash,
            folderMillis,
          ]),
        );
        await observer.unsafe("CREATE TABLE transaction_probe (id int)");
        const blocker = await openClient().reserve();
        const environmentDirectory = mkdtempSync(
          nodePath.join(tmpdir(), "stella-migrate-cli-"),
        );
        try {
          await blocker.unsafe("BEGIN");
          await blocker.unsafe("SELECT * FROM transaction_probe");
          const emptyEnvironment = nodePath.join(
            environmentDirectory,
            "empty.env",
          );
          writeFileSync(emptyEnvironment, "");
          const child = Bun.spawn({
            cmd: [
              "bun",
              "run",
              `--env-file=${emptyEnvironment}`,
              nodePath.join(import.meta.dir, "migrate.ts"),
            ],
            env: {
              DATABASE_URL: scratchUrl,
              DB_LOAD_GATE_EBS_SIGNAL: "disabled",
              DB_LOAD_GATE_BUSY_WINDOWS: "[]",
              DB_LOAD_GATE_LONG_TX_MAX_AGE_MS: "1",
              ONLINE_INDEX_RETRY_MS: "13",
              HOME: environmentDirectory,
              NODE_ENV: "test",
              PATH: process.env["PATH"] ?? "",
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          let output = "";
          const decisions: { step: string; retryAfterMs: number }[] = [];
          const deadline = setTimeout(() => child.kill(), 30_000);
          try {
            const readOutput = async () => {
              const decoder = new TextDecoder();
              let pending = "";
              for await (const chunk of child.stdout) {
                const text = decoder.decode(chunk, { stream: true });
                output += text;
                pending += text;
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                for (const line of lines) {
                  if (!line.includes('"event":"migrate.online_deferred"')) {
                    continue;
                  }
                  const record: unknown = JSON.parse(line);
                  if (
                    typeof record !== "object" ||
                    record === null ||
                    !("step" in record) ||
                    typeof record.step !== "string" ||
                    !("retryAfterMs" in record) ||
                    typeof record.retryAfterMs !== "number"
                  ) {
                    throw new TypeError("Invalid migrate deferral event");
                  }
                  decisions.push({
                    step: record.step,
                    retryAfterMs: record.retryAfterMs,
                  });
                  if (decisions.length === 2) {
                    child.kill();
                  }
                }
              }
            };
            const [stderr] = await Promise.all([
              new Response(child.stderr).text(),
              readOutput(),
              child.exited,
            ]);
            expect(
              decisions.length,
              `${output}\n${stderr}`,
            ).toBeGreaterThanOrEqual(2);
            const first = decisions.at(0);
            expect(first).toMatchObject({
              step: firstIndex.name,
              retryAfterMs: 13,
            });
            expect(decisions.at(1)).toEqual(first);
            expect(output).not.toContain("[migrate] migrations applied");
            expect(stderr).not.toContain("[migrate] failed:");
            expect(stderr).toContain('"indicator":"long_transaction"');
          } finally {
            clearTimeout(deadline);
            child.kill();
            await child.exited;
          }
        } finally {
          await blocker.unsafe("ROLLBACK");
          await blocker.release();
          rmSync(environmentDirectory, { recursive: true, force: true });
        }
      });
    });

    test("rollback across an alias rewrite and a newer migration no-ops, starts, or refuses pending SQL", async () => {
      await withBundle(
        [{ name: A, sql: CREATE_PROBE }],
        async (olderFolder) => {
          await withBundle(
            [
              { name: A, sql: REWRITTEN_CREATE_PROBE },
              { name: B, sql: INSERT_B },
            ],
            async (newerFolder) => {
              await withBundle(
                [
                  { name: A, sql: CREATE_PROBE },
                  { name: C, sql: INSERT_C },
                ],
                async (pendingFolder) => {
                  await withScratch(async ({ observer, run }) => {
                    expect(
                      appliedResult(await run(newerFolder)).insertedNames,
                    ).toEqual([A, B]);
                    let onlineRuns = 0;
                    const stdout = spyOn(
                      process.stdout,
                      "write",
                    ).mockImplementation(() => true);
                    try {
                      const stale = await run(olderFolder, async () => {
                        onlineRuns += 1;
                      });
                      expect(stale).toMatchObject({
                        status: "stale_bundle_noop",
                        unknownCount: 1,
                        newestUnknownName: B,
                        mismatchCount: 1,
                        mismatchedNames: [A],
                      });
                      // The no-op event, then the schema phase's duration.
                      const phaseCalls = stdout.mock.calls.filter(
                        (call) =>
                          !String(call.at(0)).includes(
                            '"event":"migrate.lock_attempt"',
                          ),
                      );
                      expect(phaseCalls).toHaveLength(2);
                      expect(
                        JSON.parse(String(phaseCalls.at(1)?.at(0))),
                      ).toMatchObject({
                        event: "migrate.phase_duration",
                        phase: "schema",
                        outcome: "stale_bundle_noop",
                        appliedCount: 0,
                      });
                      const noopLine = String(phaseCalls.at(0)?.at(0));
                      expect(noopLine.endsWith("\n")).toBe(true);
                      expect(JSON.parse(noopLine)).toEqual({
                        event: "migrate.stale_bundle_noop",
                        level: "warn",
                        unknownCount: 1,
                        newestUnknownName: B,
                        unknownNames: [B],
                        mismatchCount: 1,
                        mismatchedNames: [A],
                      });
                    } finally {
                      stdout.mockRestore();
                    }
                    expect(onlineRuns).toBe(0);
                    const startupStdout = spyOn(
                      process.stdout,
                      "write",
                    ).mockImplementation(() => true);
                    try {
                      await assertMigrationHistory({
                        context: "startup",
                        migrationsDir: olderFolder,
                        queryAppliedRows: async () =>
                          (await ledgerRows(observer)).map(
                            ({ name, hash }) => ({
                              name,
                              hash,
                            }),
                          ),
                        remedy: "Run migrations",
                      });
                      expect(startupStdout.mock.calls).toHaveLength(1);
                      expect(
                        JSON.parse(
                          String(startupStdout.mock.calls.at(0)?.at(0)),
                        ),
                      ).toEqual({
                        event: "migrate.ledger_ahead",
                        level: "warn",
                        unknownCount: 1,
                        newestUnknownName: B,
                        unknownNames: [B],
                        mismatchCount: 1,
                        mismatchedNames: [A],
                      });
                    } finally {
                      startupStdout.mockRestore();
                    }

                    const stderr = spyOn(
                      process.stderr,
                      "write",
                    ).mockImplementation(() => true);
                    try {
                      const rejection = await rejectionOf(
                        async () => await run(pendingFolder),
                      );
                      expect(rejection).toMatchObject({
                        message: expect.stringContaining(
                          "stale bundle has pending SQL",
                        ),
                      });
                      expect(stderr.mock.calls).toHaveLength(1);
                      const refusedLine = String(
                        stderr.mock.calls.at(0)?.at(0),
                      );
                      expect(refusedLine.endsWith("\n")).toBe(true);
                      expect(JSON.parse(refusedLine)).toEqual({
                        event: "migrate.stale_bundle_refused",
                        level: "error",
                        unknownCount: 1,
                        newestUnknownName: B,
                        unknownNames: [B],
                        mismatchCount: 1,
                        mismatchedNames: [A],
                      });
                    } finally {
                      stderr.mockRestore();
                    }
                    expect(await probeEvents(observer)).toEqual(["A", "B"]);
                    expect(
                      (await ledgerRows(observer)).map(({ name }) => name),
                    ).toEqual([A, B]);
                  });
                },
              );
            },
          );
        },
      );
    });

    test("a split migration retries after committing this run's earlier receipt", async () => {
      await withBundle(
        [
          { name: A, sql: CREATE_PROBE },
          {
            name: B,
            sql: `COMMIT;--> statement-breakpoint\n${ALTER_LOCK_PROBE}--> statement-breakpoint\nINSERT INTO migration_probe (event) VALUES (current_setting('lock_timeout'));`,
          },
        ],
        async (folder) => {
          await withScratch(async ({ observer, openClient, scratchUrl }) => {
            await observer.unsafe(CREATE_LOCK_PROBE);
            const holder = holdLockProbe(openClient());
            const connection = await openClient().reserve();
            const sleeps: number[] = [];
            let onlineLockTimeout: unknown;
            const stdout = spyOn(process.stdout, "write").mockImplementation(
              () => true,
            );
            try {
              await holder.held;
              const result = await runMigrations({
                connection,
                databaseUrl: scratchUrl,
                ebs: DISABLED_EBS,
                migrationsFolder: folder,
                runOnline: async (pool) => {
                  const onlineConnection = await pool.reserve();
                  onlineLockTimeout = await onlineConnection.query(
                    "SELECT current_setting('lock_timeout') AS lock_timeout",
                  );
                  return ONLINE_COMPLETE;
                },
                lockWaitRetry: {
                  lockTimeoutsMs: [10, 20, 30, 40],
                  pauseBaseMs: 10,
                  pauseCapMs: 10,
                  random: () => 1,
                  budgetMs: MIGRATION_LOCK_WAIT_RETRY_BUDGET_MS,
                  now: () => performance.now(),
                  sleep: async (ms) => {
                    sleeps.push(ms);
                    // The lane is still this connection's while it pauses.
                    expect(await laneHolders(observer)).toBe(1);
                    await holder.release();
                  },
                },
              });
              expect(sleeps).toEqual([10]);
              expect(result).toMatchObject({
                status: "applied",
                predictedNames: [A, B],
                insertedNames: [A, B],
              });
              expect(onlineLockTimeout).toEqual([{ lock_timeout: "0" }]);
            } finally {
              stdout.mockRestore();
              await holder.release();
              await connection.release();
            }
            expect(
              (await ledgerRows(observer)).map(({ name }) => name),
            ).toEqual([A, B]);
            expect(await probeEvents(observer)).toEqual(["20ms", "A"]);
            expect(await lockProbeColumns(observer)).toEqual([
              "id",
              "reissued",
            ]);
            expect(await laneHolders(observer)).toBe(0);
          });
        },
      );
    });

    test("a lock wait that never clears fails after bounded attempts and records nothing", async () => {
      await withBundle(
        [
          { name: A, sql: CREATE_PROBE },
          { name: B, sql: ALTER_LOCK_PROBE },
        ],
        async (folder) => {
          await withScratch(
            async ({ observer, openClient, run, scratchUrl }) => {
              await observer.unsafe(CREATE_LOCK_PROBE);
              const holder = holdLockProbe(openClient());
              const connection = await openClient().reserve();
              const sleeps: number[] = [];
              const timings: MigrationTimingRecord[] = [];
              const stdout = spyOn(process.stdout, "write").mockImplementation(
                () => true,
              );
              try {
                await holder.held;
                const rejection = await rejectionOf(
                  async () =>
                    await runMigrations({
                      connection,
                      databaseUrl: scratchUrl,
                      ebs: DISABLED_EBS,
                      migrationsFolder: folder,
                      runOnline: async () => ONLINE_COMPLETE,
                      timing: {
                        clock: () => performance.now(),
                        emit: (record) => {
                          timings.push(record);
                        },
                      },
                      lockWaitRetry: {
                        lockTimeoutsMs: [10, 20, 30],
                        pauseBaseMs: 10,
                        pauseCapMs: 10,
                        random: () => 1,
                        budgetMs: MIGRATION_LOCK_WAIT_RETRY_BUDGET_MS,
                        now: () => performance.now(),
                        sleep: async (ms) => {
                          sleeps.push(ms);
                          await Promise.resolve();
                        },
                      },
                    }),
                );
                expect(MigrationLockWaitError.is(rejection)).toBe(true);
                expect(rejection).toMatchObject({
                  reason: MIGRATION_LOCK_WAIT_FAILURE.exhausted,
                  attempts: 3,
                  lockTimeoutMs: 30,
                });
                expect(isPgError(rejection, PG_ERROR.LOCK_NOT_AVAILABLE)).toBe(
                  true,
                );
                expect(sleeps).toEqual([10, 10]);
                expect(timings).toHaveLength(1);
                expect(timings.at(0)).toMatchObject({
                  event: "migrate.phase_duration",
                  phase: "schema",
                  outcome: "failed",
                  retriesSpent: 2,
                });
                expect([...(await ledgerRows(observer))]).toEqual([]);

                const [probe] = await observer.unsafe<{ exists: boolean }[]>(
                  "SELECT to_regclass('migration_probe') IS NOT NULL AS exists",
                );
                expect(probe?.exists).toBe(false);
                expect(await lockProbeColumns(observer)).toEqual(["id"]);
              } finally {
                stdout.mockRestore();
                await holder.release();
                await connection.release();
              }
              // The failed run released the lane; the next one applies the set.
              expect(appliedResult(await run(folder)).insertedNames).toEqual([
                A,
                B,
              ]);
            },
          );
        },
      );
    });

    test("new receipts equal the preflight prediction in file order", async () => {
      await withBundle(
        [
          { name: A, sql: CREATE_PROBE },
          { name: B, sql: INSERT_B },
          { name: C, sql: INSERT_C },
        ],
        async (folder) => {
          await withScratch(async ({ observer, run }) => {
            const first = await run(folder);
            expect(first).toMatchObject({
              status: "applied",
              predictedNames: [A, B, C],
              insertedNames: [A, B, C],
            });
            expect(
              (await ledgerRows(observer)).map(({ name }) => name),
            ).toEqual([A, B, C]);
            expect(await probeEvents(observer)).toEqual(["A", "B", "C"]);
            const second = await run(folder);
            expect(second).toMatchObject({
              status: "applied",
              predictedNames: [],
              insertedNames: [],
            });
          });
        },
      );
    });

    test("every inventoried predecessor validates without replay and retains its repair", async () => {
      await withCorpusBundle(async (corpusFolder) => {
        const sourceMigrations = readMigrationFiles({
          migrationsFolder: CORPUS_DIR,
        });
        const corpusMigrations = readMigrationFiles({
          migrationsFolder: corpusFolder,
        });
        for (const alias of migrationAliasInventory) {
          expect(
            corpusMigrations.find(({ name }) => name === alias.fileName)?.hash,
          ).toBe(
            sourceMigrations.find(({ name }) => name === alias.fileName)?.hash,
          );
        }
        await withScratch(async ({ scratchUrl, observer, openClient }) => {
          const initialConnection = await openClient().reserve();
          try {
            const initial = appliedResult(
              await runMigrations({
                connection: initialConnection,
                migrationsFolder: corpusFolder,
                ebs: DISABLED_EBS,
                databaseUrl: scratchUrl,
              }),
            );
            expect(initial.insertedNames).toHaveLength(corpusMigrations.length);
          } finally {
            await initialConnection.release();
          }

          const baseline = await ledgerRows(observer);
          for (const alias of migrationAliasInventory) {
            const original = baseline.find(
              ({ name }) => name === alias.fileName,
            );
            if (original === undefined) {
              throw new Error(`Missing corpus receipt for ${alias.fileName}`);
            }
            expect(original.hash).toBe(alias.newHash);
            await observer.unsafe(
              "UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE name = $2",
              [alias.priorHash, alias.fileName],
            );
            try {
              const connection = await openClient().reserve();
              try {
                const result = appliedResult(
                  await runMigrations({
                    connection,
                    migrationsFolder: corpusFolder,
                    ebs: DISABLED_EBS,
                    databaseUrl: scratchUrl,
                    runOnline: async () => ONLINE_COMPLETE,
                  }),
                );
                expect(result.predictedNames).toEqual([]);
                expect(result.insertedNames).toEqual([]);
              } finally {
                await connection.release();
              }
              await assertMigrationHistory({
                context: "startup",
                migrationsDir: corpusFolder,
                queryAppliedRows: async () =>
                  (await ledgerRows(observer)).map(({ name, hash }) => ({
                    name,
                    hash,
                  })),
                remedy: "Run migrations",
              });
              expect((await ledgerRows(observer)).length).toBe(baseline.length);

              if (typeof alias.repair !== "string") {
                for (const index of alias.repair.indexes) {
                  const [state] = await observer.unsafe<
                    {
                      isReady: boolean;
                      isUnique: boolean;
                      isValid: boolean;
                    }[]
                  >(
                    `SELECT pg_index.indisready AS "isReady",
                      pg_index.indisunique AS "isUnique",
                      pg_index.indisvalid AS "isValid"
                   FROM pg_catalog.pg_index
                   JOIN pg_catalog.pg_class index_relation
                     ON index_relation.oid = pg_index.indexrelid
                   JOIN pg_catalog.pg_namespace index_namespace
                     ON index_namespace.oid = index_relation.relnamespace
                   JOIN pg_catalog.pg_class table_relation
                     ON table_relation.oid = pg_index.indrelid
                   WHERE index_namespace.nspname = 'public'
                     AND index_relation.relname = $1
                     AND table_relation.relname = $2`,
                    [index.name, index.tableName],
                  );
                  expect(state).toEqual({
                    isReady: true,
                    isUnique: index.isUnique,
                    isValid: true,
                  });
                }
              }
            } finally {
              await observer.unsafe(
                "UPDATE drizzle.__drizzle_migrations SET hash = $1 WHERE name = $2",
                [original.hash, alias.fileName],
              );
            }
          }
          expect(await ledgerRows(observer)).toEqual(baseline);
        });
      });
    }, 1_200_000);
  });
}
