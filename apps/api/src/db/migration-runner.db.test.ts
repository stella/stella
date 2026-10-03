import type { SQL } from "bun";
import { describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import migrationAliasInventory from "../lib/db/migration-alias-inventory.json";
import { assertMigrationHistory } from "../lib/db/migration-history";
import { withGatedTestClients } from "../tests/gated-test-database";
import { runMigrations } from "./migration-runner";

const databaseUrl = process.env["DATABASE_URL"];
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
const CORPUS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");

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
    expect(guardedRoleCreations).toBe(6);
    await work(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

type Scratch = {
  observer: SQL;
  openClient: () => SQL;
  run: (
    folder: string,
    onOnline?: () => Promise<void>,
  ) => ReturnType<typeof runMigrations>;
};

const withScratch = async (work: (scratch: Scratch) => Promise<void>) => {
  if (databaseUrl === undefined) {
    throw new Error(
      "DATABASE_URL is required for migration runner database tests",
    );
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const admin = openClient().sql;
    const name = `stella_runner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    try {
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await withGatedTestClients(
        url.toString(),
        async ({ openClient: openScratchClient }) => {
          const observer = openScratchClient().sql;
          await work({
            observer,
            openClient: () => openScratchClient().sql,
            run: async (folder, onOnline) => {
              const connection = await openScratchClient().sql.reserve();
              try {
                return await runMigrations({
                  connection,
                  migrationsFolder: folder,
                  runOnline: async () => {
                    await onOnline?.();
                  },
                });
              } finally {
                connection.release();
              }
            },
          });
        },
      );
    } finally {
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
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

const appliedResult = (result: Awaited<ReturnType<typeof runMigrations>>) => {
  if (result.status !== "applied") {
    throw new Error(`Expected migrations to apply, got ${result.status}`);
  }
  return result;
};

const waitUntilBlocked = async (observer: SQL, pid: number) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await observer.unsafe<{ blocked: boolean }[]>(
      "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS blocked",
      [pid],
    );
    if (row?.blocked === true) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Migration backend ${String(pid)} never waited on the lane`);
};

if (!runPostgresTests || databaseUrl === undefined) {
  describe.skip("migration runner PostgreSQL contract", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && databaseUrl !== undefined).toBe(false);
    });
  });
} else {
  describe("migration runner PostgreSQL contract", () => {
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
      await withBundle([{ name: A, sql: CREATE_PROBE }], async (folder) => {
        await withScratch(async ({ observer, openClient }) => {
          const first = await openClient().reserve();
          const second = await openClient().reserve();
          const [pidRow] = await second.unsafe<{ pid: number }[]>(
            "SELECT pg_backend_pid() AS pid",
          );
          if (pidRow === undefined) {
            throw new Error("Expected backend pid");
          }
          const entered = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const firstRun = runMigrations({
            connection: first,
            migrationsFolder: folder,
            runOnline: async () => {
              entered.resolve(undefined);
              await release.promise;
            },
          });
          try {
            await entered.promise;
            const secondRun = runMigrations({
              connection: second,
              migrationsFolder: folder,
              runOnline: async () => undefined,
            });
            await waitUntilBlocked(observer, pidRow.pid);
            release.resolve(undefined);
            expect(appliedResult(await firstRun).insertedNames).toEqual([A]);
            expect(appliedResult(await secondRun).insertedNames).toEqual([]);
            expect(await probeEvents(observer)).toEqual(["A"]);
            expect(
              (await ledgerRows(observer)).map(({ name }) => name),
            ).toEqual([A]);
          } finally {
            release.resolve(undefined);
            // swallow-ok: finally drains the first migration runner after its applied result has been asserted
            await firstRun.catch(() => undefined);
            first.release();
            second.release();
          }
        });
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
                      expect(stdout.mock.calls).toHaveLength(1);
                      const noopLine = String(stdout.mock.calls.at(0)?.at(0));
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
        await withScratch(async ({ observer, openClient }) => {
          const initialConnection = await openClient().reserve();
          try {
            const initial = appliedResult(
              await runMigrations({
                connection: initialConnection,
                migrationsFolder: corpusFolder,
              }),
            );
            expect(initial.insertedNames).toHaveLength(corpusMigrations.length);
          } finally {
            initialConnection.release();
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
                    runOnline: async () => undefined,
                  }),
                );
                expect(result.predictedNames).toEqual([]);
                expect(result.insertedNames).toEqual([]);
              } finally {
                connection.release();
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
