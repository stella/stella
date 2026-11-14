import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const configured =
  "async tx => { await configureReadTransaction(tx); return fn(tx); }";
const unconfigured = "async tx => fn(tx)";
const deploymentBranches = (callbacks: readonly [string, string, string]) =>
  `const publicLawReadDb = async fn => { if (env.PUBLIC_LAW_DATABASE_URL) return external.transaction(${callbacks[0]}); if (fallback) return secondary.transaction(${callbacks[1]}); return primary.transaction(${callbacks[2]}); };`;
const readTransaction = (body: string) =>
  `const publicLawReadDb = fn => database.transaction(async tx => { ${body} });`;
// The owner module declares the helper; it shares line 1 with each source so
// reported lines stay put.
const OWNER = "const configureReadTransaction = async tx => setup(tx); ";
const lint = async (source: string) =>
  lintSingleRule(
    "require-configured-read-transaction",
    source.startsWith("const configureReadTransaction")
      ? source
      : `${OWNER}${source}`,
    { plugin: "public-law-read-boundary" },
  );

test("requires every deployment transaction to be configured regardless of branch order", async () => {
  const results = await Promise.all(
    [0, 1, 2].map(async (lintCase, index) => {
      const missing = lintCase;
      const callbacks: [string, string, string] = [
        configured,
        configured,
        configured,
      ];
      callbacks[missing] = unconfigured;

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lint(deploymentBranches(callbacks)),
        expected: [1],
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
});

test("accepts configuration in every deployment branch", async () => {
  expect(
    await lint(deploymentBranches([configured, configured, configured])),
  ).toEqual([]);
});

test("rejects every own-body callback invocation before configuration", async () => {
  const results = await Promise.all(
    [
      "fn(tx);",
      "await fn(tx);",
      "const result = await fn(tx);",
      "if (ready) await fn(tx);",
      "ready && fn(tx);",
    ].map(async (lintCase, index) => {
      const early = lintCase;

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lint(
          readTransaction(
            `${early} await configureReadTransaction(tx); return fn(tx);`,
          ),
        ),
        expected: [1],
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
});

test("rejects callback invocation in the configuration arguments", async () => {
  expect(
    await lint(
      readTransaction(
        "await configureReadTransaction(tx, fn(tx)); return fn(tx);",
      ),
    ),
  ).toEqual([1]);
});

test("rejects callback use with a different transaction", async () => {
  expect(
    await lint(
      readTransaction(
        "await configureReadTransaction(tx); await fn(other); return fn(tx);",
      ),
    ),
  ).toEqual([1]);
});

test("accepts repeated callback invocations after configuration", async () => {
  expect(
    await lint(
      readTransaction(
        "await configureReadTransaction(tx); const result = await fn(tx); return await fn(tx);",
      ),
    ),
  ).toEqual([]);
});

test("leaves deferred callback definitions outside the own-body execution boundary", async () => {
  expect(
    await lint(
      readTransaction(
        "const deferred = () => fn(tx); await configureReadTransaction(tx); return fn(tx);",
      ),
    ),
  ).toEqual([]);
});

test("still rejects conditional unawaited and wrong-transaction configuration", async () => {
  const results = await Promise.all(
    [
      "if (ready) await configureReadTransaction(tx);",
      "configureReadTransaction(tx);",
      "await configureReadTransaction(other);",
    ].map(async (lintCase, index) => {
      const configuration = lintCase;

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lint(readTransaction(`${configuration} return fn(tx);`)),
        expected: [1],
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
});

test("does not confuse a shadowed transaction with the callback transaction", async () => {
  expect(
    await lint(
      readTransaction(
        "await configureReadTransaction(tx); { const tx = other; await fn(tx); } return fn(tx);",
      ),
    ),
  ).toEqual([1]);
  expect(
    await lint(
      "const publicLawReadDb = fn => database.transaction(async other => { await configureReadTransaction(tx); return fn(tx); });",
    ),
  ).toEqual([1]);
});

test("accepts the actual transaction parameter under a different name", async () => {
  expect(
    await lint(
      "const publicLawReadDb = read => database.transaction(async current => { await configureReadTransaction(current); return read(current); });",
    ),
  ).toEqual([]);
});

test("requires a statically inspectable callback for every branch", async () => {
  expect(
    await lint(deploymentBranches([configured, "readCallback", configured])),
  ).toEqual([1]);
});

test("requires the configured transaction and shared callback bindings to stay unchanged", async () => {
  const results = await Promise.all(
    ["tx = other;", "fn = other;"].map(async (lintCase, index) => {
      const replacement = lintCase;

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lint(
          readTransaction(
            `await configureReadTransaction(tx); ${replacement} return fn(tx);`,
          ),
        ),
        expected: [1],
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
});

test("requires the module configuration helper rather than a local namesake", async () => {
  const results = await Promise.all(
    [
      "const configureReadTransaction = async () => {};",
      "function configureReadTransaction() {}",
    ].map(async (lintCase, index) => {
      const shadow = lintCase;

      return {
        label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
        result: await lint(
          readTransaction(
            `${shadow} await configureReadTransaction(tx); return fn(tx);`,
          ),
        ),
        expected: [1],
      };
    }),
  );
  expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
    results.map(({ label, expected }) => ({ label, result: expected })),
  );
  expect(
    await lint(
      `const configureReadTransaction = async tx => setup(tx); ${readTransaction("await configureReadTransaction(tx); return fn(tx);")}`,
    ),
  ).toEqual([]);
});

test("rejects a configuration call with no helper binding in the module", async () => {
  expect(
    await lintSingleRule(
      "require-configured-read-transaction",
      readTransaction("await configureReadTransaction(tx); return fn(tx);"),
      { plugin: "public-law-read-boundary" },
    ),
  ).toEqual([1]);
});

test("inspects the canonical public-read scope and the second transaction argument", async () => {
  expect(
    await lint(
      'import { withPublicReadIo as own } from "@/api/lib/legal-search/public-read-timeout-context"; const publicLawReadDb = fn => own("database", async io => io.readTransaction(database, async tx => { await configureReadTransaction(tx); return fn(tx); }));',
    ),
  ).toEqual([]);
  expect(
    await lint(
      'import { withPublicReadIo as own } from "@/api/lib/legal-search/public-read-timeout-context"; const publicLawReadDb = fn => own("database", async io => io.readTransaction(database, async tx => fn(tx)));',
    ),
  ).toEqual([1]);
});

test("an arbitrary nested scope cannot establish configured transactions", async () => {
  expect(
    await lint(
      'const own = async (kind, run) => run(fake); const publicLawReadDb = fn => own("database", async io => io.readTransaction(database, async tx => { await configureReadTransaction(tx); return fn(tx); }));',
    ),
  ).toEqual([1]);
});
