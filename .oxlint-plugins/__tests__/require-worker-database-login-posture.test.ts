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
    const results = await Promise.all(
      [
        'async function start(db) { host("api", { db }, mode, []); }',
        'async function start(db) { check(db); host("api", { db }, mode, []); }',
        'async function start(db) { host("api", { db }, mode, []); await check(db); }',
      ].map(async (lintCase, index) => {
        const body = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(body),
          expected: [3],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });

  test("requires an unconditional check in the host's block", async () => {
    const results = await Promise.all(
      [
        "if (enabled) { await check(db); }",
        "const later = async () => { await check(db); };",
        "try { await check(db); } catch (error) { report(error); }",
      ].map(async (lintCase, index) => {
        const checkStatement = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(
            `async function start(db) { ${checkStatement} host("api", { db }, mode, []); }`,
          ),
          expected: [3],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });

  test("requires the checked binding to remain the host's database", async () => {
    const results = await Promise.all(
      [
        'async function start(db, other) { await check(other); host("api", { db }, mode, []); }',
        'async function start(db) { await check(db); db = connect(); host("api", { db }, mode, []); }',
        'async function start(db) { await check(db); { const db = connect(); host("api", { db }, mode, []); } }',
        'async function start(db) { await check(db); host("api", context, mode, []); }',
        'async function start(db) { await check(db); host("api", { db, ...context }, mode, []); }',
        'async function start(db, other) { await check(db); host("api", { db, db: other }, mode, []); }',
        'async function start(db) { host.call(null, "api", { db }, mode, []); }',
      ].map(async (lintCase, index) => {
        const body = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(body),
          expected: [3],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
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

  test("requires explicit property names in the host context", async () => {
    const results = await Promise.all(
      [
        'async function start(db, key, other) { await check(db); host("api", { db, [key]: other }, mode, []); }',
        'async function start(db, other) { const key = "db"; await check(db); host("api", { db, [key]: other }, mode, []); }',
        'async function start(db, other) { await check(db); host("api", { db, ["db"]: other }, mode, []); }',
      ].map(async (lintCase, index) => {
        const body = lintCase;

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lint(body),
          expected: [3],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
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
