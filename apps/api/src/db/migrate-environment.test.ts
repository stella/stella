import { expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";

/**
 * The migrate entrypoint runs with a database-only environment.
 *
 * The ECS `api-migrate` task definition injects `HOME`, `NODE_ENV` and the
 * `DB_*` connection components, and deliberately nothing else: "only the
 * secrets the migrate command needs", so a compromised migration script cannot
 * exfiltrate the rest. CI's `apply-fresh` and `postgres-suites` jobs run it the
 * same way.
 *
 * That makes any import reaching the API's full `env` a deploy-breaking
 * regression rather than a lint preference: the schema validates every variable
 * at module scope, so the entrypoint dies on `S3_BUCKET` before it opens a
 * connection, and every environment's migration fails. An online repair is the
 * easiest place to introduce one, because a repair naturally wants to know
 * something the application knows.
 *
 * This runs the real entrypoint in a scrubbed environment carrying only a
 * database URL and the load-gate setting, which migrate requires before it
 * connects, and asserts it gets as far as the connection. Pointed at a
 * closed port on purpose: reaching "connection refused" proves the module graph
 * loaded without the API environment, which is the property under test, and
 * needs no database to prove it.
 *
 * `--env-file` pointed at an empty file is load-bearing. Bun otherwise loads
 * `apps/api/.env` whatever the process environment holds, so a developer's
 * local file would supply the very variables this proves are unnecessary, and
 * the test would pass while CI failed. Checked against the regression it
 * guards: with the env-backed resource builder restored, this fails on
 * `Invalid environment variables`.
 */

const API_ROOT = nodePath.resolve(import.meta.dir, "../..");

/**
 * Empties Bun's default `.env` loading for the spawned process. Written to the
 * temp directory rather than into the tree: an empty file named `*.env` under
 * `src/` is exactly the shape secret scanners and `.gitignore` rules argue
 * about, and it carries no fixture content worth versioning.
 */
const EMPTY_ENV_FILE = nodePath.join(
  nodeOs.tmpdir(),
  "stella-migrate-environment-empty.env",
);

// A port nothing listens on, so the connection attempt fails immediately.
const UNREACHABLE_DATABASE_URL =
  "postgres://stella_owner:stella@127.0.0.1:1/stella?sslmode=require";

const ENVIRONMENT_VALIDATION_MESSAGE = "Invalid environment variables";

setDefaultTimeout(60_000);

const runMigrateEntrypoint = async (environment: Record<string, string>) => {
  await Bun.write(EMPTY_ENV_FILE, "");
  // Keep the generated .env.test in a developer checkout out of this scrubbed
  // environment, including its database URL.
  const directory = await mkdtemp(
    nodePath.join(nodeOs.tmpdir(), "migrate-env-"),
  );
  await mkdir(nodePath.join(directory, "src/db"), { recursive: true });
  await mkdir(nodePath.join(directory, "scripts"));
  const entrypoint = nodePath.join(directory, "src/db/migrate.ts");
  await copyFile(nodePath.join(API_ROOT, "src/db/migrate.ts"), entrypoint);
  await copyFile(
    nodePath.join(API_ROOT, "scripts/load-test-env.ts"),
    nodePath.join(directory, "scripts/load-test-env.ts"),
  );
  for (const dependency of ["db-url.ts", "env-db-load-gate.ts", "lib"]) {
    await symlink(
      nodePath.join(API_ROOT, "src", dependency),
      nodePath.join(directory, "src", dependency),
    );
  }
  await symlink(
    nodePath.join(API_ROOT, "src/db/migration-runner.ts"),
    nodePath.join(directory, "src/db/migration-runner.ts"),
  );
  await symlink(
    nodePath.join(API_ROOT, "../../node_modules"),
    nodePath.join(directory, "node_modules"),
  );
  try {
    const migrate = Bun.spawn({
      cmd: ["bun", "run", `--env-file=${EMPTY_ENV_FILE}`, entrypoint],
      env: {
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        HOME: "/tmp",
        NODE_ENV: "test",
        // `bun` itself has to be findable; nothing else is inherited.
        PATH: process.env["PATH"] ?? "",
        ...environment,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stderr, stdout, exitCode] = await Promise.all([
      new Response(migrate.stderr).text(),
      new Response(migrate.stdout).text(),
      migrate.exited,
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("the migrate entrypoint needs only the database and its load-gate setting", async () => {
  const { output } = await runMigrateEntrypoint({
    DB_LOAD_GATE_EBS_SIGNAL: "disabled",
  });

  // The failure that matters: env validation ran and rejected the scrubbed
  // environment. Its message names the missing variables, so a regression
  // reports which import pulled the API env in.
  expect(output).not.toContain(ENVIRONMENT_VALIDATION_MESSAGE);
  // And the positive half, so this cannot pass by failing earlier for an
  // unrelated reason: the entrypoint reached the database connection.
  expect(output).toContain("ERR_POSTGRES_CONNECTION_REFUSED");
});

test("the migrate entrypoint rejects a missing load-gate setting before connecting", async () => {
  const { exitCode, output } = await runMigrateEntrypoint({});

  expect(exitCode).toBe(1);
  expect(output).toContain("EbsConfigurationMissingError");
  expect(output).toContain("DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER");
  expect(output).toContain("DB_LOAD_GATE_EBS_SIGNAL=disabled");
  // Failing before the connection: an index build never gets to hold.
  expect(output).not.toContain("ERR_POSTGRES_CONNECTION_REFUSED");
});

for (const scenario of [
  { name: "defaults", environment: {}, expected: ["9000ms", "8000ms"] },
  {
    name: "configured pool cap",
    environment: {
      DATABASE_POOL_IDLE_TIMEOUT_S: "10",
      DATABASE_STATEMENT_TIMEOUT_MS: "6000",
    },
    expected: ["5000ms", "5000ms"],
  },
]) {
  test(`database-only timeout queries honor ${scenario.name} without load-gate or API settings`, async () => {
    await Bun.write(EMPTY_ENV_FILE, "");
    const modulePath = nodePath.join(
      import.meta.dir,
      "shared-pool-timeouts.ts",
    );
    const child = Bun.spawn({
      cmd: [
        "bun",
        `--env-file=${EMPTY_ENV_FILE}`,
        "--eval",
        `const { setSharedQueryTimeouts } = await import(${JSON.stringify(modulePath)});
         await setSharedQueryTimeouts(async (_statement, parameters) => {
           await Bun.write(Bun.stdout, JSON.stringify(parameters));
         }, { statementTimeoutMs: 9000, lockTimeoutMs: 8000 });`,
      ],
      env: {
        HOME: "/tmp",
        NODE_ENV: "test",
        PATH: process.env["PATH"] ?? "",
        ...scenario.environment,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stderr, stdout, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(scenario.expected);
  });
}

for (const failure of [
  { sqlState: "42883", failureCause: "function_missing" },
  { sqlState: "42501", failureCause: "execute_denied" },
]) {
  test(`database-only indicator ${failure.failureCause} records its structured warning without application settings`, async () => {
    await Bun.write(EMPTY_ENV_FILE, "");
    const runtimePath = nodePath.join(import.meta.dir, "backfill-runtime.ts");
    const child = Bun.spawn({
      cmd: [
        "bun",
        `--env-file=${EMPTY_ENV_FILE}`,
        "--eval",
        `const { createDatabaseLoadVerdictReader } = await import(${JSON.stringify(runtimePath)});
         const { PgDialect } = await import('drizzle-orm/pg-core');
         const dialect = new PgDialect();
         const warnings = [];
         const read = createDatabaseLoadVerdictReader({
           db: { transaction: async (work) => await work({
             execute: async (statement) => {
               if (dialect.sqlToQuery(statement).sql.includes('set_config')) return [];
               throw Object.assign(new Error('private diagnostic payload'), { code: ${JSON.stringify(failure.sqlState)} });
             },
           }) },
           tableName: 'case_law_decisions',
           clock: () => 1000,
           warn: (...record) => { warnings.push(record); },
         });
         const verdict = await read();
         await Bun.write(Bun.stdout, JSON.stringify({ verdict, warnings }));`,
      ],
      env: {
        HOME: "/tmp",
        NODE_ENV: "test",
        PATH: process.env["PATH"] ?? "",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stderr, stdout, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(stderr).not.toContain(ENVIRONMENT_VALIDATION_MESSAGE);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      verdict: expect.objectContaining({ kind: "unknown" }),
      warnings: [
        [
          "database_load_gate.indicators_unavailable",
          { failureCause: failure.failureCause, sqlState: failure.sqlState },
        ],
      ],
    });
    expect(stderr).not.toContain("private diagnostic payload");
    expect(stdout).not.toContain("private diagnostic payload");
  });
}
