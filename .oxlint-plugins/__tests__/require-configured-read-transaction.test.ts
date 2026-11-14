import { expect, test } from "bun:test";

import { lintSingleRule as lintRule } from "./lint-single-rule.ts";

// The owner module declares the helper; it shares line 1 with each source so
// reported lines stay put.
const OWNER =
  "const configureReadTransaction = async tx => setup(tx); const observePublicLawReadTransaction = tx => tx; ";
const lintSingleRule = async (
  ruleName: string,
  source: string,
  options: Parameters<typeof lintRule>[2],
) => lintRule(ruleName, `${OWNER}${source}`, options);

test("rejects conditional or unawaited configuration", async () => {
  const results = await Promise.all(
    [
      "const publicLawReadDb = fn => database.transaction(async tx => { if (enabled) await configureReadTransaction(tx); return fn(tx); });",
      "const publicLawReadDb = fn => database.transaction(async tx => { configureReadTransaction(tx); return fn(tx); });",
    ].map(async (lintCase, index) => {
      const source = lintCase;

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lintSingleRule(
          "require-configured-read-transaction",
          source,
          {
            plugin: "public-law-read-boundary",
          },
        ),
        expected: [1],
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
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

test("accepts the legacy direct transaction without an observer binding", async () => {
  expect(
    await lintRule(
      "require-configured-read-transaction",
      "const configureReadTransaction = async tx => setup(tx); const publicLawReadDb = fn => database.transaction(async tx => { await configureReadTransaction(tx); return fn(tx); });",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([]);
});

test("accepts the owning observer alias when configuration and callback share it", async () => {
  expect(
    await lintSingleRule(
      "require-configured-read-transaction",
      "const publicLawReadDb = fn => database.transaction(async transaction => { const tx = observePublicLawReadTransaction(transaction); await configureReadTransaction(tx); return fn(tx); });",
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([]);
});

test("rejects observer aliases for another or reassigned transaction", async () => {
  const invalid = [
    "const publicLawReadDb = fn => database.transaction(async transaction => { const tx = observePublicLawReadTransaction(other); await configureReadTransaction(tx); return fn(tx); });",
    "const publicLawReadDb = fn => database.transaction(async transaction => { let tx = observePublicLawReadTransaction(transaction); tx = other; await configureReadTransaction(tx); return fn(tx); });",
    "const publicLawReadDb = fn => database.transaction(async transaction => { const observePublicLawReadTransaction = tx => other; const tx = observePublicLawReadTransaction(transaction); await configureReadTransaction(tx); return fn(tx); });",
  ];
  expect(
    await Promise.all(
      invalid.map(async (source) =>
        lintSingleRule("require-configured-read-transaction", source, {
          plugin: "public-law-read-boundary",
        }),
      ),
    ),
  ).toEqual([[1], [1], [1]]);
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
