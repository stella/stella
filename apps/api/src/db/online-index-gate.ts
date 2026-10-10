import { panic, Result, TaggedError } from "better-result";

import { sleep } from "@stll/concurrency/sleep";
import {
  combine,
  decideStart,
  decideWhileRunning,
  isHeldTooLong,
} from "@stll/db-load-gate/health";
import type { BuildProgress, Signal, Verdict } from "@stll/db-load-gate/health";
import {
  AUTOVACUUM_SQL,
  LONG_TRANSACTION_SQL,
  autovacuumOnTarget,
  busyWindow,
  longTransaction,
} from "@stll/db-load-gate/indicators";
import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";
import { Temporal } from "@stll/time";

import { resolveDatabaseUrl } from "../db-url";
import { readOnlineIndexConfig } from "../env-online-index";
import type { OnlineIndexConfig } from "../env-online-index";
import { createEbsSignalReader } from "../lib/db/ebs-signal-reader";
import type { ConfiguredEbsConfiguration } from "../lib/db/ebs-signal-reader";
import { getPgErrorCode, PG_ERROR } from "../lib/pg-error";
import { isRecord } from "../lib/type-guards";
import { openOnlineIndexObserver } from "./online-index-observer";
import type { OnlineMigrationConnection } from "./online-migration-connection";

/** How long index work has been held on database health. */
type OnlineIndexHold =
  | { type: "clear" }
  | { type: "held"; since: number }
  | { type: "alerted"; since: number };

/**
 * One hold shared by every gate of a migrate process. Each deferral ends its
 * migrator run, so a per-gate hold would restart with every run and a long
 * hold would never alert.
 */
export type OnlineIndexHoldRef = { current: OnlineIndexHold };

export const createOnlineIndexHold = (): OnlineIndexHoldRef => ({
  current: { type: "clear" },
});

/**
 * Where the gate reads disk health: a configuration resolved at the env
 * boundary, which cannot be missing, or an injected reader.
 */
export type OnlineIndexEbsSource =
  | ConfiguredEbsConfiguration
  | { type: "reader"; read: () => Promise<Signal> };

export type OnlineIndexGateOptions = {
  ebs: OnlineIndexEbsSource;
  config?: OnlineIndexConfig;
  hold?: OnlineIndexHoldRef;
  clock?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  log?: (record: unknown) => void;
  cancelBackend?: (pid: number) => Promise<boolean>;
};

const parseProgress = (row: unknown): BuildProgress | undefined => {
  if (row === undefined) {
    return undefined;
  }
  if (
    !isRecord(row) ||
    typeof row["phase"] !== "string" ||
    typeof row["blocksDone"] !== "number" ||
    typeof row["blocksTotal"] !== "number"
  ) {
    return panic("Invalid online index progress response");
  }
  return {
    phase: row["phase"],
    blocksDone: row["blocksDone"],
    blocksTotal: row["blocksTotal"],
  };
};

class OnlineIndexCancelledError extends TaggedError(
  "OnlineIndexCancelledError",
)<{ message: string }> {}

class OnlineIndexMonitoringError extends TaggedError(
  "OnlineIndexMonitoringError",
)<{
  message: string;
  cause: unknown;
}> {}

// pg_cancel_backend reaches any backend in the cluster, so cancellation only
// needs a session the stalled migrator does not hold.
const cancelWithIndependentObserver = async (pid: number) => {
  const observer = await openOnlineIndexObserver(
    resolveDatabaseUrl() ??
      panic("Online index cancellation requires a database connection"),
  );
  try {
    return await cancelIndexBackend(observer, pid);
  } finally {
    await observer.release();
  }
};

const cancelIndexBackend = async (
  observer: OnlineMigrationConnection,
  pid: number,
) => {
  const response = (
    await observer.query("SELECT pg_cancel_backend($1) AS cancelled", [pid])
  ).at(0);
  if (!isRecord(response) || typeof response["cancelled"] !== "boolean") {
    return panic("Invalid online index cancellation response");
  }
  return response["cancelled"];
};

type ObservedIndexWorkOptions = {
  connection: OnlineMigrationConnection & { terminate: () => Promise<void> };
  onTerminated: () => void;
  observer: OnlineMigrationConnection;
  pid: number;
  statement:
    | string
    | ((guardedConnection: OnlineMigrationConnection) => Promise<void>);
  config: OnlineIndexConfig;
  clock: () => number;
  readBalance: () => Promise<Signal>;
  initialVerdict: Verdict;
  wait: NonNullable<OnlineIndexGateOptions["wait"]>;
  emit: (record: unknown) => void;
  cancelBackend: (pid: number) => Promise<boolean>;
};

const runObservedIndexWork = async ({
  connection,
  onTerminated,
  observer,
  pid,
  statement,
  config,
  clock,
  readBalance,
  initialVerdict,
  wait,
  emit,
  cancelBackend,
}: ObservedIndexWorkOptions) => {
  const completed = new AbortController();
  const cancellation = new AbortController();
  const assertActive = () => {
    if (cancellation.signal.aborted) {
      throw new OnlineIndexCancelledError({
        message: "Online index work cancelled between statements",
      });
    }
  };
  // Cancellation is checked at both ends of every statement, including the gap
  // after DROP. A server cancellation acknowledgement alone cannot stop JS work.
  const guardedConnection: OnlineMigrationConnection = {
    execute: async (query, parameters) => {
      assertActive();
      await connection.execute(query, parameters);
      assertActive();
    },
    query: async (query, parameters) => {
      assertActive();
      const rows = await connection.query(query, parameters);
      assertActive();
      return rows;
    },
    release: () =>
      panic("Guarded index work cannot release its owner's session"),
  };
  const build = Result.tryPromise({
    try: async () => {
      try {
        if (typeof statement === "string") {
          await guardedConnection.execute(statement);
        } else {
          await statement(guardedConnection);
        }
      } finally {
        completed.abort();
      }
    },
    catch: (cause: unknown) => cause,
  });
  const history: Signal[] = [];
  let waiting: { phase: string; since: number } | undefined;
  const hasCompleted = () => completed.signal.aborted;
  const monitoring = await Result.tryPromise({
    try: async () => {
      while (!hasCompleted()) {
        await wait(config.pollMs, completed.signal);
        if (hasCompleted()) {
          break;
        }
        const progress = parseProgress(
          (
            await observer.query(
              `SELECT
          CASE WHEN p.phase LIKE 'waiting for %' THEN p.phase
          WHEN a.wait_event_type = 'Lock' THEN 'waiting for concurrent index lock'
          ELSE p.phase END AS phase,
          COALESCE(p.blocks_done, 0)::double precision AS "blocksDone",
          COALESCE(p.blocks_total, 0)::double precision AS "blocksTotal"
          FROM pg_stat_activity a LEFT JOIN pg_stat_progress_create_index p ON p.pid = a.pid
          WHERE a.pid = $1 AND (p.pid IS NOT NULL OR a.wait_event_type = 'Lock')`,
              [pid],
            )
          ).at(0),
        );
        history.push(await readBalance());
        if (history.length > 2) {
          history.shift();
        }
        const running = decideWhileRunning(history, config.health, progress);
        const now = clock();
        if (progress?.phase.startsWith("waiting for ")) {
          if (waiting?.phase !== progress.phase) {
            waiting = { phase: progress.phase, since: now };
          }
        } else {
          waiting = undefined;
        }
        const waitingMs = waiting === undefined ? 0 : now - waiting.since;
        const watchdog =
          waiting !== undefined && waitingMs >= config.maxSnapshotWaitMs;
        emit(
          watchdog
            ? {
                ...running,
                decision: "cancel",
                reason: "Snapshot wait watchdog",
                waitingMs,
                maxSnapshotWaitMs: config.maxSnapshotWaitMs,
              }
            : running,
        );
        if (running.decision === "cancel" || watchdog) {
          cancellation.abort();
          await cancelIndexBackend(observer, pid);
          break;
        }
      }
    },
    catch: (cause: unknown) => cause,
  });
  if (monitoring.isErr()) {
    cancellation.abort();
    emit({
      decision: "cancel",
      reason: "Monitoring failed",
      verdict: combine(history.length ? history : initialVerdict.signals),
      config: config.health,
    });
    // A failed monitoring session cannot be trusted to cancel its builder.
    const cancellationOutcome = await Result.tryPromise(
      async () => await cancelBackend(pid),
    );
    if (cancellationOutcome.isErr()) {
      onTerminated();
      await connection.terminate();
      // Settles once the closed session rejects the statement; how it ended
      // belongs in the report beside the two failures that forced it.
      const terminatedBuild = await build;
      throw new OnlineIndexMonitoringError({
        message:
          "Online index monitoring and independent cancellation failed; build session terminated",
        cause: {
          monitoring: monitoring.error,
          cancellation: cancellationOutcome.error,
          build: terminatedBuild.isErr() ? terminatedBuild.error : "completed",
        },
      });
    }
  }
  const outcome = await build;
  if (monitoring.isErr()) {
    throw monitoring.error;
  }
  if (outcome.isErr()) {
    if (
      (cancellation.signal.aborted &&
        getPgErrorCode(outcome.error) === PG_ERROR.QUERY_CANCELED) ||
      outcome.error instanceof OnlineIndexCancelledError
    ) {
      return { type: "retry" as const, history };
    }
    throw outcome.error;
  }
  return { type: "done" as const, history };
};

const readIndexStartVerdict = async ({
  observer,
  tableName,
  clock,
  config,
  readBalance,
}: Pick<
  ObservedIndexWorkOptions,
  "observer" | "clock" | "config" | "readBalance"
> & { tableName: string }): Promise<Verdict> => {
  const ebs = await readBalance();
  // While held on disk health, do not add database probes.
  if (
    ebs.kind === "unknown" ||
    ebs.kind === "stop" ||
    ebs.kind === "degraded"
  ) {
    return combine([ebs, busyWindow({ now: clock, config: config.health })]);
  }
  return combine([
    ebs,
    busyWindow({ now: clock, config: config.health }),
    await longTransaction({
      read: async () => {
        const row = (
          await observer.query(LONG_TRANSACTION_SQL, ["database", tableName])
        ).at(0);
        return isRecord(row) &&
          typeof row["ageMs"] === "number" &&
          typeof row["observedAt"] === "string"
          ? { ageMs: row["ageMs"], observedAt: row["observedAt"] }
          : null;
      },
      now: clock,
      config: config.health,
    }),
    await autovacuumOnTarget({
      read: async () => {
        const row = (await observer.query(AUTOVACUUM_SQL, [tableName])).at(0);
        return isRecord(row) &&
          typeof row["active"] === "boolean" &&
          typeof row["observedAt"] === "string"
          ? { active: row["active"], observedAt: row["observedAt"] }
          : null;
      },
      now: clock,
      config: config.health,
      kind: "index_build",
    }),
  ]);
};

type CreateOnlineIndexGateOptions = OnlineIndexGateOptions & {
  connection: OnlineMigrationConnection;
  observer: OnlineMigrationConnection;
  tableName: string;
  name: string;
  kind: "index_build" | "index_repair";
};

/** The observer must be a different physical session: CIC monopolizes its session. */
export const createOnlineIndexGate = ({
  connection,
  observer,
  tableName,
  name,
  kind,
  config = readOnlineIndexConfig(),
  hold = createOnlineIndexHold(),
  clock = () => Temporal.Now.instant().epochMilliseconds,
  ebs,
  cancelBackend = cancelWithIndependentObserver,
  wait = async (milliseconds, signal) =>
    await sleep(milliseconds, { signal }).catch((error: unknown) => {
      if (signal.aborted && Object.is(error, signal.reason)) {
        return;
      }
      throw error;
    }),
  log = (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
}: CreateOnlineIndexGateOptions) => {
  const readBalance =
    ebs.type === "reader"
      ? ebs.read
      : createEbsSignalReader({
          configuration: ebs,
          clock,
          config: config.health,
        });
  const emit = (record: unknown) =>
    log({ event: "online_index_decision", name, record });
  let lifecycle: "active" | "terminated" = "active";
  const sessionIsActive = () => lifecycle === "active";
  const slot = createHeavyWorkSlot({
    kind,
    session: {
      query: async (statement, parameters) =>
        (await connection.query(statement, parameters)).map((row) => {
          if (!isRecord(row) || typeof row["acquired"] !== "boolean") {
            return panic("Invalid online index advisory lock response");
          }
          return { acquired: row["acquired"] };
        }),
    },
  });
  const markHeld = (record: unknown) => {
    const current = hold.current;
    emit(record);
    switch (current.type) {
      case "alerted":
        return;
      case "clear":
        hold.current = { type: "held", since: clock() };
        return;
      case "held": {
        const now = clock();
        if (!isHeldTooLong({ heldSince: current.since }, now, config.health)) {
          return;
        }
        log({
          event: "database_load_gate_held_too_long",
          name,
          heldSince: current.since,
          now,
          record,
        });
        hold.current = { type: "alerted", since: current.since };
        return;
      }
      default:
        current satisfies never;
        panic("Unexpected online index hold state");
    }
  };
  const attempt = async (
    statement:
      | string
      | ((guardedConnection: OnlineMigrationConnection) => Promise<void>),
  ): Promise<"done" | "retry" | "wait"> => {
    const start = decideStart(
      await readIndexStartVerdict({
        observer,
        tableName,
        clock,
        config,
        readBalance,
      }),
      "index_build",
      config.health,
    );
    if (start.decision === "wait") {
      markHeld(start);
      return "wait";
    }
    if (!sessionIsActive()) {
      return panic("Cannot reuse a terminated online index session");
    }
    if (!connection.terminate) {
      return panic(
        "Online index work requires physical session termination support",
      );
    }
    const buildConnection = { ...connection, terminate: connection.terminate };
    const acquisition = await slot.tryAcquire();
    if (acquisition.isErr()) {
      throw acquisition.error;
    }
    if (!acquisition.value) {
      markHeld({
        ...start,
        decision: "wait",
        reason: "Heavy-work slot unavailable",
      });
      return "wait";
    }
    hold.current = { type: "clear" };
    try {
      const row = (
        await connection.query(
          "SELECT pg_backend_pid() AS pid, current_database() AS database",
        )
      ).at(0);
      if (
        !isRecord(row) ||
        typeof row["pid"] !== "number" ||
        typeof row["database"] !== "string"
      ) {
        return panic("Invalid online index backend pid response");
      }
      const pid = row["pid"];
      const observerPid = (
        await observer.query(
          "SELECT pg_backend_pid() AS pid, current_database() AS database",
        )
      ).at(0);
      if (
        !isRecord(observerPid) ||
        observerPid["pid"] === pid ||
        observerPid["database"] !== row["database"]
      ) {
        return panic(
          "Online index observer must use a separate physical session in the same database",
        );
      }
      await connection.execute("SET lock_timeout = '0'");
      await connection.execute("SET statement_timeout = '0'");
      await connection.query(
        "SELECT set_config('max_parallel_maintenance_workers', $1, false), set_config('maintenance_work_mem', $2, false)",
        [String(config.parallelWorkers), `${config.maintenanceWorkMemMb}MB`],
      );
      await connection.query(
        "SELECT set_config('client_connection_check_interval', $1, false)",
        [`${config.clientConnectionCheckMs}ms`],
      );
      emit(start);
      const outcome = await runObservedIndexWork({
        connection: buildConnection,
        onTerminated: () => {
          lifecycle = "terminated";
        },
        observer,
        pid,
        statement,
        config,
        clock,
        readBalance,
        initialVerdict: start.verdict,
        wait,
        emit,
        cancelBackend,
      });
      if (outcome.type === "retry") {
        return "retry";
      }
      const { history } = outcome;
      emit({
        decision: "done",
        verdict: combine(history.length ? history : start.verdict.signals),
        config: config.health,
      });
      return "done";
    } finally {
      if (sessionIsActive()) {
        await slot.release();
        await connection.execute("SET lock_timeout = '1s'");
      }
    }
  };
  return {
    attempt,
    close: async () => {
      if (sessionIsActive()) {
        await slot.close();
      }
    },
    retryAfterMs: config.retryMs,
  };
};
