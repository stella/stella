import { expect, test } from "bun:test";

import { lintSingleRule as lintRule } from "./lint-single-rule.ts";

// The owner module declares the helper; it shares line 1 with each source so
// reported lines stay put.
const OWNER = "const configureReadTransaction = async tx => setup(tx); ";
const lintSingleRule = async (
  ruleName: string,
  source: string,
  options: Parameters<typeof lintRule>[2],
) => lintRule(ruleName, `${OWNER}${source}`, options);

test("rejects conditional or unawaited configuration", async () => {
  for (const source of [
    "const publicLawReadDb = fn => database.transaction(async tx => { if (enabled) await configureReadTransaction(tx); return fn(tx); });",
    "const publicLawReadDb = fn => database.transaction(async tx => { configureReadTransaction(tx); return fn(tx); });",
  ]) {
    expect(
      await lintSingleRule("require-configured-read-transaction", source, {
        plugin: "public-law-read-boundary",
      }),
    ).toEqual([1]);
  }
});

test("requires awaited configuration before returning the shared callback", async () => {
  expect(
    await lintSingleRule(
      "require-configured-read-transaction",
      "const publicLawReadDb = fn => database.transaction(async tx => { return fn(tx); await configureReadTransaction(tx); });",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1]);
});

test("rejects configuration of a different transaction", async () => {
  expect(
    await lintSingleRule(
      "require-configured-read-transaction",
      "const publicLawReadDb = fn => database.transaction(async tx => { await configureReadTransaction(other); return fn(tx); });",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1]);
});

test("accepts unconditional configured reads and direct awaited callback returns", async () => {
  expect(
    await lintSingleRule(
      "require-configured-read-transaction",
      "const publicLawReadDb = fn => database.transaction(async tx => { await configureReadTransaction(tx); return await fn(tx); });",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([]);
});

test("requires the owning public read wrapper to be present", async () => {
  expect(
    await lintSingleRule(
      "require-configured-read-transaction",
      "const unrelated = fn => database.transaction(async tx => { await configureReadTransaction(tx); return fn(tx); });",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1]);
});

test("accepts both configured deployment branches before invoking the callback", async () => {
  expect(
    await lintSingleRule(
      "require-configured-read-transaction",
      [
        "const publicLawReadDb = async fn => {",
        "if (env.PUBLIC_LAW_DATABASE_URL) {",
        "return external.transaction(async tx => { await configureReadTransaction(tx); return fn(tx); });",
        "}",
        "return primary.transaction(async tx => { await configureReadTransaction(tx); return fn(tx); });",
        "};",
      ].join("\n"),
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([]);
});

test("requires configuration in every deployment transaction callback", async () => {
  expect(
    await lintSingleRule(
      "require-configured-read-transaction",
      [
        "const publicLawReadDb = async fn => {",
        "if (env.PUBLIC_LAW_DATABASE_URL) {",
        "return external.transaction(async tx => { await configureReadTransaction(tx); return fn(tx); });",
        "}",
        "return primary.transaction(async tx => { return fn(tx); });",
        "};",
      ].join("\n"),
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1]);
});
