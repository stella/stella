import { SQL } from "bun";
import { describe, expect, spyOn, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { validateLedger } from "../lib/db/migration-ledger";
import { isPgError, PG_ERROR } from "../lib/pg-error";
import { DEFAULT_LOCK_RETRY_CONFIG } from "./lock-retry-ladder";
import {
  applyPendingRetryingLockWaits,
  applySchemaMigrationsRetryingLockWaits,
  classifyMigrationLedger,
  decideLedgerAheadPolicy,
  MIGRATION_LOCK_WAIT_FAILURE,
  MIGRATION_LOCK_WAIT_RETRY_BUDGET_MS,
  MigrationLockWaitError,
} from "./migration-runner";

const A = "20260929100000_first";
const B = "20260929110000_second";
const NEWER = "20260930100000_newer";
const NEWEST = "20260930110000_newest";

const bundle = [
  { name: A, hash: "first", folderMillis: 1, sql: ["SELECT 1;"], bps: true },
  { name: B, hash: "second", folderMillis: 2, sql: ["SELECT 2;"], bps: true },
];

const receipt = (id: number, name: string, hash: string) => ({
  id,
  name,
  hash,
  created_at: id,
});

test("ledger-ahead policy refuses pending SQL and no-ops otherwise", () => {
  const applied = receipt(1, A, "first");
  const newer = receipt(2, NEWER, "newer");
  const pending = validateLedger({
    receipts: [applied, newer],
    bundle,
    inventory: [],
  });
  expect(decideLedgerAheadPolicy(pending)).toEqual({
    status: "stale_bundle_refused",
    unknownCount: 1,
    newestUnknownName: NEWER,
    unknownNames: [NEWER],
    mismatchCount: 0,
    mismatchedNames: [],
  });

  const complete = validateLedger({
    receipts: [
      applied,
      receipt(3, B, "second"),
      newer,
      receipt(4, NEWEST, "newest"),
    ],
    bundle,
    inventory: [],
  });
  expect(decideLedgerAheadPolicy(complete)).toEqual({
    status: "stale_bundle_noop",
    unknownCount: 2,
    newestUnknownName: NEWEST,
    unknownNames: [NEWER, NEWEST],
    mismatchCount: 0,
    mismatchedNames: [],
  });
  expect(
    decideLedgerAheadPolicy(
      validateLedger({
        receipts: [applied, receipt(3, B, "second")],
        bundle,
        inventory: [],
      }),
    ),
  ).toEqual({ status: "ready" });
});

test("an alias rewrite ahead of this bundle joins an unknown migration in the rollback decision", () => {
  const newerLedger = [receipt(1, A, "h2"), receipt(2, NEWER, "newer")];
  const olderA = { name: A, hash: "h1", folderMillis: 1, sql: ["SELECT 1;"] };
  const olderBundle = [olderA];
  expect(
    decideLedgerAheadPolicy(
      validateLedger({
        receipts: newerLedger,
        bundle: olderBundle,
        inventory: [],
      }),
    ),
  ).toEqual({
    status: "stale_bundle_noop",
    unknownCount: 1,
    newestUnknownName: NEWER,
    unknownNames: [NEWER],
    mismatchCount: 1,
    mismatchedNames: [A],
  });
  expect(
    decideLedgerAheadPolicy(
      validateLedger({
        receipts: newerLedger,
        bundle: [
          olderA,
          { name: B, hash: "second", folderMillis: 2, sql: ["SELECT 2;"] },
        ],
        inventory: [],
      }),
    ),
  ).toMatchObject({
    status: "stale_bundle_refused",
    unknownCount: 1,
    mismatchCount: 1,
  });
});

test("ledger retry classification accepts only an ordered prefix of this run's receipts", () => {
  const preflight = [receipt(10, "20260928000000_existing", "existing")];
  const first = { ...receipt(11, A, "first"), created_at: 1 };
  const second = { ...receipt(12, B, "second"), created_at: 2 };
  const classify = (currentRows: typeof preflight) =>
    classifyMigrationLedger({
      preflightRows: preflight,
      currentRows,
      predicted: bundle,
    });

  expect(classify(preflight)).toEqual({
    status: "unchanged",
    committedReceipts: 0,
  });
  expect(classify([...preflight, first])).toEqual({
    status: "own",
    committedReceipts: 1,
  });
  expect(classify([...preflight, first, second])).toEqual({
    status: "own",
    committedReceipts: 2,
  });

  const foreignCases = [
    [...preflight, receipt(99, NEWER, "newer")],
    [...preflight, second, first],
    [...preflight, receipt(11, A, "changed")],
    [],
  ];
  for (const currentRows of foreignCases) {
    expect(classify(currentRows)).toEqual({
      status: "foreign",
      committedReceipts: 0,
    });
  }
});

const serverFailure = (errno: string) =>
  new DrizzleQueryError(
    "ALTER TABLE probe ADD COLUMN reissued boolean",
    [],
    new SQL.PostgresError("server failure", {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno,
      detail: "",
      hint: "",
      severity: "ERROR",
    }),
  );

const lockWaitLoss = () => serverFailure(PG_ERROR.LOCK_NOT_AVAILABLE);

type ScriptedRunOptions = {
  /** One outcome per attempt: the failure it throws, or null to apply. */
  script: readonly (Error | null)[];
  ledgerProgress?: "unchanged" | "own" | "foreign";
  /** How long each attempt takes on the fake clock. */
  attemptMs?: number;
};

const runScripted = async ({
  script,
  ledgerProgress = "unchanged",
  attemptMs = 0,
}: ScriptedRunOptions) => {
  let attempts = 0;
  let clock = 0;
  const sleeps: number[] = [];
  const lockTimeouts: number[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const outcome = await applyPendingRetryingLockWaits({
      apply: async (lockTimeoutMs) => {
        lockTimeouts.push(lockTimeoutMs);
        const failure = script.at(attempts);
        attempts += 1;
        clock += attemptMs;
        if (failure === undefined) {
          throw new Error("apply ran past its script");
        }
        if (failure !== null) {
          throw failure;
        }
        await Promise.resolve();
      },
      classifyLedger: async () =>
        await Promise.resolve(
          ledgerProgress === "own"
            ? { status: "own", committedReceipts: 1 }
            : { status: ledgerProgress, committedReceipts: 0 },
        ),
      retry: {
        ...DEFAULT_LOCK_RETRY_CONFIG,
        random: () => 0.5,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
          await Promise.resolve();
        },
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    const events: unknown[] = stdout.mock.calls.map((call) =>
      JSON.parse(String(call.at(0))),
    );
    return { outcome, attempts, sleeps, events, lockTimeouts };
  } finally {
    stdout.mockRestore();
  }
};

const ATTEMPTS = DEFAULT_LOCK_RETRY_CONFIG.lockTimeoutsMs.length;
const JITTERED_PAUSES_MS = [50, 100, 200, 400];

describe("a pending set that loses a lock wait", () => {
  test("reruns whole after each pause and stops once an attempt applies", async () => {
    const nested = new Error("migrate failed", { cause: lockWaitLoss() });
    expect(isPgError(nested, PG_ERROR.LOCK_NOT_AVAILABLE)).toBe(true);
    const run = await runScripted({ script: [lockWaitLoss(), nested, null] });
    expect(run.outcome).toBeNull();
    expect(run.attempts).toBe(3);
    expect(run.lockTimeouts).toEqual(
      DEFAULT_LOCK_RETRY_CONFIG.lockTimeoutsMs.slice(0, 3),
    );
    expect(run.sleeps).toEqual(JITTERED_PAUSES_MS.slice(0, 2));
    expect(run.events).toEqual(
      JITTERED_PAUSES_MS.slice(0, 2).map((delayMs, index) => ({
        event: "migrate.lock_wait_retry",
        level: "warn",
        attempt: index + 1,
        attempts: ATTEMPTS,
        delayMs,
        lockTimeoutMs: DEFAULT_LOCK_RETRY_CONFIG.lockTimeoutsMs.at(index),
        committedReceipts: 0,
      })),
    );
  });

  test("gives up after the timeout ladder, citing the last failure", async () => {
    const failures = Array.from({ length: ATTEMPTS }, lockWaitLoss);
    const run = await runScripted({ script: failures });
    expect(run.attempts).toBe(ATTEMPTS);
    expect(run.sleeps).toEqual(JITTERED_PAUSES_MS);
    expect(MigrationLockWaitError.is(run.outcome)).toBe(true);
    expect(run.outcome).toMatchObject({
      reason: MIGRATION_LOCK_WAIT_FAILURE.exhausted,
      attempts: ATTEMPTS,
      lockTimeoutMs: DEFAULT_LOCK_RETRY_CONFIG.lockTimeoutsMs.at(-1),
      cause: failures.at(-1),
    });
  });

  test("does not rerun a run that outlasted the rerun budget, such as a migration's own lock-wait loop", async () => {
    const failure = lockWaitLoss();
    const run = await runScripted({
      script: [failure, null],
      attemptMs: MIGRATION_LOCK_WAIT_RETRY_BUDGET_MS,
    });
    expect(run.attempts).toBe(1);
    expect(run.sleeps).toEqual([]);
    expect(run.outcome).toMatchObject({
      reason: MIGRATION_LOCK_WAIT_FAILURE.budgetSpent,
      attempts: 1,
      cause: failure,
    });
  });

  test("stops rerunning once the next pause would pass the rerun budget", async () => {
    const failures = Array.from({ length: ATTEMPTS }, lockWaitLoss);
    const attemptMs = MIGRATION_LOCK_WAIT_RETRY_BUDGET_MS / 2;
    const run = await runScripted({ script: failures, attemptMs });
    expect(run.attempts).toBe(2);
    expect(run.sleeps).toEqual(JITTERED_PAUSES_MS.slice(0, 1));
    expect(run.outcome).toMatchObject({
      reason: MIGRATION_LOCK_WAIT_FAILURE.budgetSpent,
      attempts: 2,
    });
  });

  test("reruns after this run committed a predicted receipt", async () => {
    const failure = lockWaitLoss();
    const run = await runScripted({
      script: [failure, null],
      ledgerProgress: "own",
    });
    expect(run.attempts).toBe(2);
    expect(run.sleeps).toEqual(JITTERED_PAUSES_MS.slice(0, 1));
    expect(run.outcome).toBeNull();
    expect(run.events.at(0)).toMatchObject({
      event: "migrate.lock_wait_retry",
      committedReceipts: 1,
    });
  });

  test("does not rerun after a foreign receipt appeared", async () => {
    const failure = lockWaitLoss();
    const run = await runScripted({
      script: [failure, null],
      ledgerProgress: "foreign",
    });
    expect(run.attempts).toBe(1);
    expect(run.sleeps).toEqual([]);
    expect(run.outcome).toMatchObject({
      reason: MIGRATION_LOCK_WAIT_FAILURE.ledgerMoved,
      attempts: 1,
      cause: failure,
    });
  });

  test("propagates every other failure unchanged from the first attempt", async () => {
    const others = [
      serverFailure(PG_ERROR.QUERY_CANCELED),
      serverFailure(PG_ERROR.DEADLOCK_DETECTED),
      serverFailure(PG_ERROR.UNIQUE_VIOLATION),
      new Error("not a database failure"),
    ];
    for (const failure of others) {
      expect(isPgError(failure, PG_ERROR.LOCK_NOT_AVAILABLE)).toBe(false);
      const run = await runScripted({ script: [failure, null] });
      expect(run.outcome).toBe(failure);
      expect(run.attempts).toBe(1);
      expect(run.sleeps).toEqual([]);
      expect(run.events).toEqual([]);
    }
  });
});

test("the schema ladder restores the session lock timeout before the online phase", async () => {
  const statements: string[] = [];
  const connection = {
    unsafe: async (statement: string) => {
      statements.push(statement);
      return [];
    },
  };

  await applySchemaMigrationsRetryingLockWaits({
    connection,
    apply: async (lockTimeoutMs) => {
      await connection.unsafe(
        `SET lock_timeout = '${String(lockTimeoutMs)}ms'`,
      );
    },
    classifyLedger: async () => ({ status: "unchanged", committedReceipts: 0 }),
    retry: {
      ...DEFAULT_LOCK_RETRY_CONFIG,
      lockTimeoutsMs: [25],
      random: () => 0.5,
      now: () => 0,
      sleep: async () => await Promise.resolve(),
    },
  });
  await connection.unsafe("ONLINE PHASE FIRST STATEMENT");

  expect(statements).toEqual([
    "SET lock_timeout = '25ms'",
    "RESET lock_timeout",
    "ONLINE PHASE FIRST STATEMENT",
  ]);
});

test("the schema ladder restores the session lock timeout after a failure", async () => {
  const statements: string[] = [];
  const connection = {
    unsafe: async (statement: string) => {
      statements.push(statement);
      return [];
    },
  };
  const failure = new Error("schema migration failed");

  const rejection = await applySchemaMigrationsRetryingLockWaits({
    connection,
    apply: async (lockTimeoutMs) => {
      await connection.unsafe(
        `SET lock_timeout = '${String(lockTimeoutMs)}ms'`,
      );
      throw failure;
    },
    classifyLedger: async () => ({ status: "unchanged", committedReceipts: 0 }),
    retry: {
      ...DEFAULT_LOCK_RETRY_CONFIG,
      lockTimeoutsMs: [25],
      random: () => 0.5,
      now: () => 0,
      sleep: async () => await Promise.resolve(),
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejection).toBe(failure);
  expect(statements).toEqual([
    "SET lock_timeout = '25ms'",
    "RESET lock_timeout",
  ]);
});

test("a terminated schema session preserves the observation failure without resetting it", async () => {
  const failure = new Error("observation failed");
  const statements: string[] = [];
  let connectionState: "open" | "terminated" = "open";
  const rejection = await applySchemaMigrationsRetryingLockWaits({
    connection: {
      unsafe: async (statement) => {
        statements.push(statement);
        throw new Error("connection closed");
      },
    },
    connectionState: () => connectionState,
    apply: async () => {
      connectionState = "terminated";
      throw failure;
    },
    classifyLedger: async () => ({ status: "unchanged", committedReceipts: 0 }),
    retry: {
      ...DEFAULT_LOCK_RETRY_CONFIG,
      random: () => 0.5,
      now: () => 0,
      sleep: async () => await Promise.resolve(),
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBe(failure);
  expect(statements).toEqual([]);
});
