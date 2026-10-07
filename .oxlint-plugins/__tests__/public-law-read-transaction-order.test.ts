import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const configured =
  "async tx => { await configureReadTransaction(tx); return fn(tx); }";
const unconfigured = "async tx => fn(tx)";
const deploymentBranches = (callbacks: readonly [string, string, string]) =>
  `const publicLawReadDb = async fn => { if (env.PUBLIC_LAW_DATABASE_URL) return external.transaction(${callbacks[0]}); if (fallback) return secondary.transaction(${callbacks[1]}); return primary.transaction(${callbacks[2]}); };`;
const readTransaction = (body: string) =>
  `const publicLawReadDb = fn => database.transaction(async tx => { ${body} });`;
const lint = async (source: string) =>
  lintSingleRule("require-configured-read-transaction", source, {
    plugin: "public-law-read-boundary",
  });

test("requires every deployment transaction to be configured regardless of branch order", async () => {
  for (const missing of [0, 1, 2]) {
    const callbacks: [string, string, string] = [
      configured,
      configured,
      configured,
    ];
    callbacks[missing] = unconfigured;
    expect(await lint(deploymentBranches(callbacks))).toEqual([1]);
  }
});

test("accepts configuration in every deployment branch", async () => {
  expect(
    await lint(deploymentBranches([configured, configured, configured])),
  ).toEqual([]);
});

test("rejects every own-body callback invocation before configuration", async () => {
  for (const early of [
    "fn(tx);",
    "await fn(tx);",
    "const result = await fn(tx);",
    "if (ready) await fn(tx);",
    "ready && fn(tx);",
  ]) {
    expect(
      await lint(
        readTransaction(
          `${early} await configureReadTransaction(tx); return fn(tx);`,
        ),
      ),
    ).toEqual([1]);
  }
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
  for (const configuration of [
    "if (ready) await configureReadTransaction(tx);",
    "configureReadTransaction(tx);",
    "await configureReadTransaction(other);",
  ]) {
    expect(
      await lint(readTransaction(`${configuration} return fn(tx);`)),
    ).toEqual([1]);
  }
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
  for (const replacement of ["tx = other;", "fn = other;"]) {
    expect(
      await lint(
        readTransaction(
          `await configureReadTransaction(tx); ${replacement} return fn(tx);`,
        ),
      ),
    ).toEqual([1]);
  }
});

test("requires the module configuration helper rather than a local namesake", async () => {
  for (const shadow of [
    "const configureReadTransaction = async () => {};",
    "function configureReadTransaction() {}",
  ]) {
    expect(
      await lint(
        readTransaction(
          `${shadow} await configureReadTransaction(tx); return fn(tx);`,
        ),
      ),
    ).toEqual([1]);
  }
  expect(
    await lint(
      `const configureReadTransaction = async tx => setup(tx); ${readTransaction("await configureReadTransaction(tx); return fn(tx);")}`,
    ),
  ).toEqual([]);
});
