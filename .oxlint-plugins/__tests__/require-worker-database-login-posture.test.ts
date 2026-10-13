import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const imports = [
  'import { createBullMqWorkerHost as host } from "@/api/lib/bullmq-queue";',
  'import { assertDatabaseLoginPosture as check } from "@/api/lib/db/assert-database-login-posture";',
].join("\n");
const lint = async (body: string, sourcePath = "apps/api/src/worker.ts") =>
  await lintSingleRule(
    "require-worker-database-login-posture",
    `${imports}\n${body}`,
    { sourcePath, cwd: "scratch" },
  );

describe.serial("worker hosts require the database login posture check", () => {
  test("accepts an awaited check for the same database binding", async () => {
    expect(
      await lint(
        'async function start(db) { await check(db); return host("api", { db }, mode, []); }',
      ),
    ).toEqual([]);
    expect(
      await lint(
        'const db = connect(); await check(db); host("worker", { db }, mode, []);',
      ),
    ).toEqual([]);
  });

  test("requires completion before creating the host", async () => {
    for (const body of [
      'async function start(db) { host("api", { db }, mode, []); }',
      'async function start(db) { check(db); host("api", { db }, mode, []); }',
      'async function start(db) { host("api", { db }, mode, []); await check(db); }',
    ]) {
      expect(await lint(body)).toEqual([3]);
    }
  });

  test("requires an unconditional check in the host's block", async () => {
    for (const checkStatement of [
      "if (enabled) { await check(db); }",
      "const later = async () => { await check(db); };",
      "try { await check(db); } catch (error) { report(error); }",
    ]) {
      expect(
        await lint(
          `async function start(db) { ${checkStatement} host("api", { db }, mode, []); }`,
        ),
      ).toEqual([3]);
    }
  });

  test("requires the checked binding to remain the host's database", async () => {
    for (const body of [
      'async function start(db, other) { await check(other); host("api", { db }, mode, []); }',
      'async function start(db) { await check(db); db = connect(); host("api", { db }, mode, []); }',
      'async function start(db) { await check(db); { const db = connect(); host("api", { db }, mode, []); } }',
      'async function start(db) { await check(db); host("api", context, mode, []); }',
      'async function start(db) { await check(db); host("api", { db, ...context }, mode, []); }',
      'async function start(db, other) { await check(db); host("api", { db, db: other }, mode, []); }',
      'async function start(db) { host.call(null, "api", { db }, mode, []); }',
    ]) {
      expect(await lint(body)).toEqual([3]);
    }
  });

  test("resolves imports rather than trusting matching names", async () => {
    expect(
      await lint(
        'async function start(db, check) { await check(db); host("api", { db }, mode, []); }',
      ),
    ).toEqual([3]);
    expect(
      await lint(
        'async function start(db, host) { host("api", { db }, mode, []); }',
      ),
    ).toEqual([]);
    expect(
      await lint(
        'import { assertDatabaseLoginPosture as otherCheck } from "./local-check"; async function start(db) { await otherCheck(db); host("api", { db }, mode, []); }',
      ),
    ).toEqual([3]);
  });

  test("allows isolated worker host test fixtures", async () => {
    expect(
      await lint(
        'host("api", { db }, mode, []);',
        "apps/api/src/worker.test.ts",
      ),
    ).toEqual([]);
  });
});
