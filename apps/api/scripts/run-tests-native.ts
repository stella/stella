// Experiment: run the API suite with Bun's native `--parallel` and `--shard`
// instead of scripts/run-tests.ts, to measure wall time, memory and failures
// against the batch runner. Not wired into CI; only the experiment workflow
// calls it.
import { panic } from "better-result";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PROPERTY_TEST_TIMEOUT_BASE_MS_ENV } from "@stll/property-testing";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import { API_TEST_TIMEOUT_MS } from "../src/tests/test-timeouts";
import { listApiTestPaths } from "./api-test-plan";
import { API_TEST_DURATIONS_FILE_ENV, durationSeconds } from "./test-timings";

const apiRoot = path.resolve(import.meta.dir, "..");
const shard =
  process.env["NATIVE_TEST_SHARD"] ??
  panic("NATIVE_TEST_SHARD must name the shard as i/n");
const junitPath =
  process.env["NATIVE_TEST_JUNIT"] ??
  panic("NATIVE_TEST_JUNIT must name the JUnit report path");
const workDirectory = mkdtempSync(path.join(tmpdir(), "native-api-tests-"));

const snapshotPath = path.join(workDirectory, "pglite-snapshot.tar");
const snapshotStartedAt = performance.now();
const snapshotBuild = Bun.spawnSync(
  [process.execPath, "scripts/build-pglite-snapshot.ts", snapshotPath],
  { cwd: apiRoot, stdout: "inherit", stderr: "inherit" },
);
if (snapshotBuild.exitCode !== 0) {
  panic(`PGlite snapshot build failed with exit ${snapshotBuild.exitCode}`);
}
const snapshotSeconds = (performance.now() - snapshotStartedAt) / 1000;

// The batch runner's duration cache, converted to Bun's timings format so
// `--shard` cuts by recorded duration as the batch runner's shards do.
const timingArguments: string[] = [];
const durationsPath = process.env[API_TEST_DURATIONS_FILE_ENV];
if (durationsPath !== undefined && existsSync(durationsPath)) {
  const seconds = durationSeconds(
    JSON.parse(readFileSync(durationsPath, "utf-8")),
  );
  const timingsPath = path.join(workDirectory, "timings.json");
  writeFileSync(
    timingsPath,
    JSON.stringify({
      version: 1,
      files: Object.fromEntries(
        Object.entries(seconds).map(([file, value]) => [
          file,
          Math.round(value * 1000),
        ]),
      ),
    }),
  );
  timingArguments.push(`--timings=${timingsPath}`);
} else {
  console.log("No API test duration cache; shards split by file count.");
}

const testStartedAt = performance.now();
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    `--timeout=${API_TEST_TIMEOUT_MS}`,
    "--preload",
    path.join(apiRoot, "src/tests/publisher-gate-preload.ts"),
    "--preload",
    path.join(apiRoot, "src/tests/setup-env.ts"),
    "--parallel",
    `--shard=${shard}`,
    ...timingArguments,
    "--reporter=junit",
    `--reporter-outfile=${junitPath}`,
    ...listApiTestPaths(apiRoot),
  ],
  {
    cwd: apiRoot,
    env: {
      ...process.env,
      PGLITE_TEST_SNAPSHOT: snapshotPath,
      [PROPERTY_TEST_TIMEOUT_BASE_MS_ENV]: String(API_TEST_TIMEOUT_MS),
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);
await child.exited;
const exitCode = childExitStatus(child);
const testSeconds = (performance.now() - testStartedAt) / 1000;
console.log(
  `Native API shard ${shard}: snapshot ${snapshotSeconds.toFixed(1)}s, tests ${testSeconds.toFixed(1)}s, exit ${exitCode}`,
);
process.exitCode = exitCode;
