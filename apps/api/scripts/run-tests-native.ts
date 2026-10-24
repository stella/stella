// Experiment: run the API suite with Bun's native `--parallel` and `--shard`
// instead of scripts/run-tests.ts, to measure wall time, memory and failures
// against the batch runner. Not wired into CI; only the experiment workflow
// calls it.
import { panic } from "better-result";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PROPERTY_TEST_TIMEOUT_BASE_MS_ENV } from "@stll/property-testing";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";

import { API_TEST_TIMEOUT_MS } from "../src/tests/test-timeouts";
import { listApiTestPaths } from "./api-test-plan";

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

// Every shard cuts from the same committed seed table. `--update-timings`
// writes to the first `--timings` path and, with `--shard`, only the files
// this shard ran, so the six outputs together form the next table.
const shardTimingsPath =
  process.env["NATIVE_TIMINGS_OUT"] ??
  panic("NATIVE_TIMINGS_OUT must name this shard's timings output");
writeFileSync(shardTimingsPath, '{"version":1,"files":{}}\n');
const timingArguments = [
  `--timings=${shardTimingsPath}`,
  `--timings=${path.join(apiRoot, "scripts/native-timings-seed.json")}`,
  "--update-timings",
];

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
