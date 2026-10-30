import { panic, Result } from "better-result";

import { sleep } from "@stll/concurrency/sleep";

import { isRecord } from "../lib/type-guards";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const FINGERPRINT_LIMIT = 256;

const blockCommentEnd = (query: string, start: number) => {
  let offset = start;
  let depth = 1;
  offset += 2;
  while (offset < query.length && depth > 0) {
    if (query.startsWith("/*", offset)) {
      depth += 1;
      offset += 2;
    } else if (query.startsWith("*/", offset)) {
      depth -= 1;
      offset += 2;
    } else {
      offset += 1;
    }
  }
  return offset;
};

/** Discard literal contents before normalizing or truncating a query. */
export const migrationQueryFingerprint = (query: string): string => {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < query.length) {
    const rest = query.slice(offset);
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      offset += end === -1 ? rest.length : end;
      tokens.push(" ");
      continue;
    }
    if (rest.startsWith("/*")) {
      offset = blockCommentEnd(query, offset);
      tokens.push(" ");
      continue;
    }
    // PostgreSQL's lexer accepts every non-ASCII byte in dollar-quote tags,
    // including combining marks and astral characters encoded as UTF-8.
    const dollar =
      /^\$(?:[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*)?\$/u
        .exec(rest)
        ?.at(0);
    if (dollar !== undefined) {
      const end = query.indexOf(dollar, offset + dollar.length);
      offset = end === -1 ? query.length : end + dollar.length;
      tokens.push("?");
      continue;
    }
    const quote = rest.at(0);
    if (quote === "'" || quote === '"') {
      const escaped = /(?:^|[^\p{L}\p{N}_$])e$/iu.test(query.slice(0, offset));
      offset += 1;
      while (offset < query.length) {
        const char = query.at(offset);
        offset += 1;
        if (char === "\\" && quote === "'") {
          // Ordinary strings depend on a per-session setting unavailable in activity.
          // Discard the remainder rather than choose the wrong closing quote.
          if (!escaped) {
            offset = query.length;
            break;
          }
          offset += 1;
        } else if (char === quote) {
          if (query.at(offset) !== quote) {
            break;
          }
          offset += 1;
        }
      }
      tokens.push(quote === '"' ? '"?"' : "?");
      continue;
    }
    const parameter = /^\$\d+/u.exec(rest)?.at(0);
    const number =
      /^(?:0[xob][0-9a-f_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[+-]?[\d_]+)?)/iu
        .exec(rest)
        ?.at(0);
    if (parameter !== undefined || number !== undefined) {
      offset += (parameter ?? number ?? panic("Missing numeric token")).length;
      tokens.push("?");
      continue;
    }
    const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(rest)?.at(0);
    if (word !== undefined) {
      tokens.push(
        ["true", "false", "null"].includes(word.toLowerCase())
          ? "?"
          : word.toLowerCase(),
      );
      offset += word.length;
      continue;
    }
    tokens.push(rest.at(0) ?? panic("Missing query character"));
    offset += 1;
  }
  return tokens
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, FINGERPRINT_LIMIT);
};

type MigrationBlocker = {
  pid: number;
  state: string | null;
  xactAgeMs: number | null;
  waitEvent: string | null;
  queryFingerprint: string;
};

type MigrationLockWait = {
  table: string | null;
  statementClass: string;
  lockMode: string;
  waitMs: number;
  blockers: MigrationBlocker[];
};

export type MigrationLockEvent = {
  event: "migrate.lock_attempt";
  phase: "schema" | "online";
  step: string;
  table: string | null;
  statementClass: string;
  lockMode: string | null;
  waitMs: number;
  attempt: number;
  retriesSpent: number;
  outcome: "done" | "deferred" | "failed";
  blockers: readonly MigrationBlocker[];
  waits: readonly MigrationLockWait[];
};

export type MigrationLockTelemetry = {
  attempts: Map<string, number>;
  retriesSpent: number;
  emit: (event: MigrationLockEvent) => void;
};

export const createMigrationLockTelemetry = (): MigrationLockTelemetry => ({
  attempts: new Map(),
  retriesSpent: 0,
  emit: (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  },
});

// Raw activity text stays inside this boundary; only its fingerprint leaves it.
const WAIT_SQL = `WITH waiting AS MATERIALIZED (
  SELECT l.mode, c.relname AS "tableName", a.query AS statement
  FROM pg_stat_activity a
  JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
  LEFT JOIN pg_class c ON c.oid = l.relation
  WHERE a.pid = $1
), blocking AS MATERIALIZED (
  SELECT unnest(pg_blocking_pids($1)) AS pid
  WHERE EXISTS (SELECT 1 FROM waiting)
)
SELECT w.mode, w."tableName", w.statement,
  b.pid, b.state,
  (extract(epoch FROM (clock_timestamp() - b.xact_start)) * 1000)::double precision AS "xactAgeMs",
  b.wait_event AS "waitEvent", b.query
FROM waiting w
LEFT JOIN blocking bp ON true
LEFT JOIN pg_stat_activity b ON b.pid = bp.pid`;

const nullableString = (value: unknown) =>
  typeof value === "string" ? value : null;

type ObserveMigrationLockAttemptOptions<T> = {
  observer: OnlineMigrationConnection;
  pid: number;
  phase: MigrationLockEvent["phase"];
  step: string;
  table: string | null;
  telemetry: MigrationLockTelemetry;
  work: () => Promise<T>;
  outcome: (result: T) => "done" | "deferred";
  pollMs?: number;
  cancelWork?: (() => Promise<void>) | undefined;
  additionalRetries?: () => number;
};

/** One terminal work event, retaining blockers and nested statement retries. */
export const observeMigrationLockAttempt = async <T>({
  observer,
  pid,
  phase,
  step,
  table,
  telemetry,
  work,
  outcome,
  pollMs = 100,
  cancelWork,
  additionalRetries,
}: ObserveMigrationLockAttemptOptions<T>): Promise<T> => {
  const key = `${phase}:${step}`;
  const attempt = (telemetry.attempts.get(key) ?? 0) + 1;
  telemetry.attempts.set(key, attempt);
  if (attempt > 1) {
    telemetry.retriesSpent += 1;
  }
  const completed = new AbortController();
  const workIsPending = () => !completed.signal.aborted;
  const blockers = new Map<number, MigrationBlocker>();
  let waitMs = 0;
  const waits = new Map<string, MigrationLockWait>();
  let currentWaits = new Set<string>();
  let lastSampleAt = performance.now();
  const accrueWaits = (now: number) => {
    for (const waitKey of currentWaits) {
      const observedWait =
        waits.get(waitKey) ?? panic("Missing sampled migration wait");
      observedWait.waitMs += now - lastSampleAt;
    }
    lastSampleAt = now;
  };
  let lockMode: string | null = null;
  let statementClass = "none";
  let observedTable = table;
  let waitingSince: number | null = null;
  const currentWaitingSince = () => waitingSince;
  const startedAt = performance.now();
  const sampling = Result.tryPromise(async () => {
    while (!completed.signal.aborted) {
      const rows = await observer.query(WAIT_SQL, [pid]);
      const now = performance.now();
      accrueWaits(now);
      currentWaits = new Set();
      if (rows.length > 0) {
        waitingSince ??= now;
      } else if (waitingSince !== null) {
        waitMs += now - waitingSince;
        waitingSince = null;
      }
      for (const row of rows) {
        if (!isRecord(row) || typeof row["mode"] !== "string") {
          panic("Invalid migration lock observation");
        }
        lockMode = row["mode"];
        observedTable = nullableString(row["tableName"]) ?? table;
        const fingerprint = migrationQueryFingerprint(
          nullableString(row["statement"]) ?? "",
        );
        statementClass = fingerprint.split(/\W+/u).at(0) ?? "unknown";
        const waitKey = JSON.stringify([observedTable, lockMode, fingerprint]);
        const observedWait: MigrationLockWait = waits.get(waitKey) ?? {
          table: observedTable,
          statementClass,
          lockMode,
          waitMs: 0,
          blockers: [],
        };
        waits.set(waitKey, observedWait);
        currentWaits.add(waitKey);
        if (typeof row["pid"] === "number") {
          const blocker = {
            pid: row["pid"],
            state: nullableString(row["state"]),
            xactAgeMs:
              typeof row["xactAgeMs"] === "number" ? row["xactAgeMs"] : null,
            waitEvent: nullableString(row["waitEvent"]),
            queryFingerprint: migrationQueryFingerprint(
              nullableString(row["query"]) ?? "",
            ),
          };
          blockers.set(blocker.pid, blocker);
          const previous = observedWait.blockers.findIndex(
            ({ pid: blockerPid }) => blockerPid === blocker.pid,
          );
          if (previous === -1) {
            observedWait.blockers.push(blocker);
          } else {
            observedWait.blockers[previous] = blocker;
          }
        }
      }
      await sleep(pollMs, { signal: completed.signal }).catch(
        (error: unknown) => {
          if (
            !completed.signal.aborted ||
            !Object.is(error, completed.signal.reason)
          ) {
            throw error;
          }
        },
      );
    }
  });
  const monitoring = Result.tryPromise({
    try: async () => {
      const sampled = await sampling;
      if (sampled.isErr()) {
        if (workIsPending()) {
          await cancelWork?.();
        }
        throw sampled.error;
      }
    },
    catch: (cause) => cause,
  });
  const result = await Result.tryPromise({
    try: work,
    catch: (cause) => cause,
  });
  completed.abort();
  const observed = await monitoring;
  accrueWaits(performance.now());
  const finalWaitingSince = currentWaitingSince();
  if (finalWaitingSince !== null) {
    waitMs += performance.now() - finalWaitingSince;
  }
  const terminalOutcome =
    result.isErr() || observed.isErr() ? "failed" : outcome(result.value);
  const nestedRetries = additionalRetries?.() ?? 0;
  const finalAttempt = attempt + nestedRetries;
  telemetry.retriesSpent += nestedRetries;
  if (terminalOutcome === "done") {
    telemetry.attempts.delete(key);
  } else {
    telemetry.attempts.set(key, finalAttempt);
  }
  telemetry.emit({
    event: "migrate.lock_attempt",
    phase,
    step,
    table: observedTable,
    statementClass,
    lockMode,
    waitMs: Math.max(
      0,
      Math.round(Math.min(waitMs, performance.now() - startedAt)),
    ),
    attempt: finalAttempt,
    retriesSpent: finalAttempt - 1,
    outcome: terminalOutcome,
    blockers: [...blockers.values()],
    waits: [...waits.values()].map((wait) => ({
      ...wait,
      waitMs: Math.max(0, Math.round(wait.waitMs)),
    })),
  });
  if (observed.isErr()) {
    throw observed.error;
  }
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
};
