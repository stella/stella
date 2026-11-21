import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import nodePath from "node:path";

const temporaryDirectory = await mkdtemp(
  nodePath.join(import.meta.dir, ".constraint-retry-test-"),
);
afterEach(async () => await rm(temporaryDirectory, { recursive: true }));

const matcher = nodePath.join(import.meta.dir, "lib/has-postgres-sqlstate.sh");

const matchesSqlstate = async (output: string, sqlstate: string) => {
  const logFile = nodePath.join(temporaryDirectory, "migration-output.log");
  await writeFile(logFile, output);
  const result = Bun.spawnSync([
    "bash",
    "-c",
    'source "$1"; has_postgres_sqlstate "$2" "$3"',
    "bash",
    matcher,
    logFile,
    sqlstate,
  ]);
  return result.exitCode === 0;
};

test("rehearsal accepts only the expected structured migration SQLSTATE", async () => {
  expect(await matchesSqlstate('errno: "P0001"', "P0001")).toBe(true);
  expect(await matchesSqlstate('code: "P0001"', "P0001")).toBe(false);
  expect(await matchesSqlstate('errno: "23505"', "P0001")).toBe(false);
  expect(
    await matchesSqlstate("Database query failed (values redacted)", "P0001"),
  ).toBe(false);
  expect(await matchesSqlstate('errno: "P0001"', "invalid")).toBe(false);
});
