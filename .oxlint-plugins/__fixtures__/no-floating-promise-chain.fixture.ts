// Passive regression fixture for
// `no-floating-promise-chain/no-floating-promise-chain`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the fixture
// too.

declare const detached: (work: () => unknown, context: string) => void;
declare const flushSearchRepairs: (ids: readonly string[]) => Promise<void>;
declare const report: (error: unknown) => void;
declare const started: Promise<void>;
declare const client: { close: () => Promise<void> } | undefined;

// MUST flag: post-commit work started with a bare `.catch` statement.
export const catchStatement = () => {
  // oxlint-disable-next-line no-floating-promise-chain/no-floating-promise-chain
  flushSearchRepairs(["a"]).catch(report);
};

// MUST flag: a `.then` chain as a statement.
export const thenStatement = () => {
  // oxlint-disable-next-line no-floating-promise-chain/no-floating-promise-chain
  flushSearchRepairs(["a"]).then(() => undefined);
};

// MUST flag: a `.finally` on an already started promise.
export const finallyStatement = () => {
  // oxlint-disable-next-line no-floating-promise-chain/no-floating-promise-chain
  started.finally(() => undefined);
};

// MUST flag: an optional chain.
export const optionalChain = () => {
  // oxlint-disable-next-line no-floating-promise-chain/no-floating-promise-chain
  client?.close().catch(report);
};

// Allowed: the sanctioned helper starts the work outside the caller's counter.
// expect-clean: no-floating-promise-chain/no-floating-promise-chain
export const viaHelper = () => {
  detached(
    () => flushSearchRepairs(["a"]).catch(report),
    "fixture.flush-search-repairs",
  );
};

// Allowed: awaited, returned or bound chains stay owned by the caller.
export const awaited = async () => {
  await flushSearchRepairs(["a"]).catch(report);
};
export const returned = () => flushSearchRepairs(["a"]).catch(report);
export const bound = () => {
  const pending = flushSearchRepairs(["a"]).finally(() => undefined);
  return pending;
};
