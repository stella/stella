import { Result } from "better-result";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSqlClient } from "../src/db/sql-client";
import { buildApiTestCommand } from "./api-test-command";
import {
  mergeJunitReports,
  missingBatchReport,
  planBatchReporterArguments,
} from "./junit-batch-report";
import { loadTestEnv } from "./load-test-env";
import { spawnPostgresTestProcess } from "./postgres-lock-diagnostics";
import {
  classifyPostgresTestIsolation,
  EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
} from "./postgres-test-plan";
import {
  planPostgresTestShards,
  selectPostgresTestShard,
} from "./postgres-test-shards";
import {
  parsePostgresWorkerCount,
  runPostgresWorkers,
} from "./postgres-test-workers";
import { preparePostgresTests } from "./prepare-postgres-tests";
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
const parsedWorkers = parsePostgresWorkerCount(Bun.argv.slice(2));
let clusterExclusivePaths = new Set<string>();

process.exitCode = await runGatedTests({
  requiredEnv: ["DATABASE_URL"],
  script: "test:postgres",
  preload: "./src/tests/setup-postgres.ts",
  selection: process.env["CI_POSTGRES_TEST_SELECTION"],
  exclusiveTestPaths: EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
  runnerArguments: parsedWorkers.arguments,
  spawnTestProcess: spawnPostgresTestProcess,
  prepare: preparePostgresTests,
  validateTestPlan: async (apiRoot, files) => {
    clusterExclusivePaths = await classifyPostgresTestIsolation(apiRoot, files);
    const shard = parseApiTestShard(shardValue);
    if (shard !== null) {
      planPostgresTestShards({ files, durations, count: shard.count });
    }
  },
  shardTestFiles: shardValue
    ? (files) => selectPostgresTestShard({ files, durations, shardValue })
    : undefined,
  runTestFiles: async ({ bunArguments, files, gate, gateValue, preload }) => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    const templateUrl = new URL(databaseUrl);
    const adminUrl = new URL(templateUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.searchParams.set(
      "application_name",
      `stella-postgres-runner-${process.pid}`,
    );
    const sql = createSqlClient({ url: adminUrl.toString(), max: 1 });
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "stella-postgres-junit-"),
    );
    const reporterPlan = planBatchReporterArguments(
      bunArguments,
      files.length,
      temporaryDirectory,
    );
    let invocation = 0;
    try {
      const status = await runPostgresWorkers({
        files,
        durations,
        exclusivePaths: EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS,
        clusterExclusivePaths,
        workers: parsedWorkers.workers,
        databaseUrl,
        admin: {
          query: async (query, parameters = []) =>
            sql.unsafe(query, [...parameters]),
          close: async () => {
            await sql.close();
          },
        },
        runWorker: ({ files: workerFiles, databaseUrl: workerUrl }) => {
          const reporterArguments =
            reporterPlan.argumentsByBatch.at(invocation++) ?? [];
          return spawnPostgresTestProcess({
            cmd: buildApiTestCommand({
              bunExecutable: process.execPath,
              bunRuntimeArguments: [],
              testArguments: [
                "--max-concurrency=1",
                "--preload",
                "./src/tests/setup-env.ts",
                ...(preload ? ["--preload", preload] : []),
                ...reporterArguments,
              ],
              testFiles: workerFiles,
            }),
            cwd: path.resolve(import.meta.dir, ".."),
            env: {
              ...process.env,
              [gate]: gateValue,
              DATABASE_URL: workerUrl,
            },
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          });
        },
      });
      let missingReport = false;
      if (reporterPlan.type === "file") {
        const reports = await Promise.all(
          reporterPlan.batchOutfiles
            .slice(0, invocation)
            .map(async (source) => {
              const report = Bun.file(source);
              if (await report.exists()) {
                return { source, xml: await report.text(), missing: false };
              }
              return {
                source,
                xml: missingBatchReport(source),
                missing: true,
              };
            }),
        );
        missingReport = reports.some(({ missing }) => missing);
        await Bun.write(
          path.resolve(import.meta.dir, "..", reporterPlan.requestedOutfile),
          mergeJunitReports(reports),
        );
      }
      // A batch without a report failed even if its process exited cleanly.
      return status === 0 && missingReport ? 1 : status;
    } finally {
      await sql.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
});
