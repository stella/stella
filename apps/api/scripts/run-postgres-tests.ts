import { panic, Result, TaggedError } from "better-result";
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import path from "node:path";

import { loadTestEnv } from "./load-test-env";
import { spawnPostgresTestProcess } from "./postgres-lock-diagnostics";
import {
  assertTemplateDatabaseTestsAreExclusive,
  assertSharedTableDdlIsolated,
  EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
  needsTemplateDatabase,
} from "./postgres-test-plan";
import {
  planPostgresTestShards,
  selectPostgresTestShard,
} from "./postgres-test-shards";
import { runGatedTests } from "./run-gated-tests";
import { parseApiTestShard } from "./test-file-shards";
import { durationSeconds } from "./test-timings";

const shardValue = process.env["CI_POSTGRES_TEST_SHARD"];
const durationPath = process.env["POSTGRES_TEST_DURATIONS_FILE"];
const measured = durationPath
  ? Result.try(() =>
      durationSeconds(JSON.parse(readFileSync(durationPath, "utf-8"))),
    )
  : undefined;
if (measured === undefined || measured.isErr()) {
  console.log(
    "::notice::Postgres duration cache unavailable; using conservative estimates",
  );
}
const durations = measured?.unwrapOr({}) ?? {};

loadTestEnv(path.resolve(import.meta.dir, "../.env.test"));

const quoteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

class MigratedTemplateError extends TaggedError("MigratedTemplateError")<{
  message: string;
  cause: unknown;
}> {}

const withMigratedTemplate = async (
  testPaths: readonly string[],
  run: () => Promise<number>,
): Promise<number> => {
  if (!needsTemplateDatabase(testPaths)) {
    return await run();
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined) {
    panic("DATABASE_URL required for migrated template creation");
  }
  const sourceUrl = new URL(databaseUrl);
  const sourceDatabase = decodeURIComponent(sourceUrl.pathname.slice(1));
  if (sourceDatabase.length === 0) {
    panic("DATABASE_URL must name the migrated database");
  }
  const templateDatabase = `${sourceDatabase}_migrated_template`;
  const maintenanceUrl = new URL(sourceUrl);
  maintenanceUrl.pathname = "/postgres";
  const admin = new SQL({ url: maintenanceUrl.toString(), max: 1 });
  const quotedTemplate = quoteIdentifier(templateDatabase);
  const quotedSource = quoteIdentifier(sourceDatabase);

  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quotedTemplate}`);
    const creation = await admin
      .unsafe(`CREATE DATABASE ${quotedTemplate} TEMPLATE ${quotedSource}`)
      .then(
        () => ({ type: "created" }) as const,
        (error: unknown) => ({ type: "failed", error }) as const,
      );
    if (creation.type === "failed") {
      const sessions = await admin<
        { pid: number; application_name: string; usename: string }[]
      >`SELECT pid, application_name, usename FROM pg_stat_activity WHERE datname = ${sourceDatabase} ORDER BY pid`;
      const detail = sessions
        .map(
          ({ pid, application_name, usename }) =>
            `pid=${String(pid)} application_name=${JSON.stringify(application_name)} usename=${JSON.stringify(usename)}`,
        )
        .join("\n");
      throw new MigratedTemplateError({
        message: `Could not clone migrated database ${sourceDatabase}: ${String(creation.error)}${
          detail.length === 0
            ? "\nNo connected sessions were reported by pg_stat_activity."
            : `\nConnected sessions (none were terminated):\n${detail}`
        }`,
        cause: creation.error,
      });
    }

    process.env["STELLA_TEST_TEMPLATE_DATABASE"] = templateDatabase;
    return await run();
  } finally {
    delete process.env["STELLA_TEST_TEMPLATE_DATABASE"];
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quotedTemplate}`);
    } finally {
      await admin.close();
    }
  }
};

process.exitCode = await runGatedTests({
  requiredEnv: ["DATABASE_URL"],
  script: "test:postgres",
  preload: "./src/tests/setup-postgres.ts",
  selection: process.env["CI_POSTGRES_TEST_SELECTION"],
  exclusiveTestPaths: EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
  spawnTestProcess: spawnPostgresTestProcess,
  validateTestPlan: async (apiRoot, files) => {
    assertTemplateDatabaseTestsAreExclusive();
    await assertSharedTableDdlIsolated(apiRoot, files);
    const shard = parseApiTestShard(shardValue);
    if (shard !== null) {
      planPostgresTestShards({ files, durations, count: shard.count });
    }
  },
  shardTestFiles: shardValue
    ? (files) => selectPostgresTestShard({ files, durations, shardValue })
    : undefined,
  withTestRun: withMigratedTemplate,
});
