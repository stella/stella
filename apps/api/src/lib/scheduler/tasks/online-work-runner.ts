import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { openMaintenanceSql } from "@/api/db/long-running-connection";
import {
  decodeOnlineWorkState,
  readOnlineWorkPause,
} from "@/api/db/online-work-pause";
import { type ONLINE_WORK_STATES, onlineWorkState } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { envDbLoadGate } from "@/api/env-db-load-gate";
import { detached } from "@/api/lib/analytics/capture";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  lockOnlineWorkState,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { resolveEbsConfiguration } from "@/api/lib/db/ebs-signal-reader";
import { ONLINE_WORK_STATE_TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  transitionScopedBatch,
  transitionUpsertBatch,
} from "@/api/lib/db/transitions";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  type SchedulerDb,
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

import { createOnlineIndexHold } from "../../../db/online-index-gate";
import { openOnlineIndexObserver } from "../../../db/online-index-observer";
import type {
  OnlineBuildConnection,
  OnlineBuildPool,
} from "../../../db/online-migration-connection";
import {
  claimOnlineWorkUnit,
  type ClaimOnlineWorkUnitOptions,
  ONLINE_WORK_NAMES,
  type OnlineWorkName,
  type OnlineWorkUnitClaim,
} from "../../../db/online-migrations";
import {
  ONLINE_WORK_LIFECYCLE,
  type OnlineWorkLifecycle,
} from "../../../db/online-work-lifecycle";

export const ONLINE_WORK_RUNNER_TASK = "onlineWork.runPending" as const;
const MAX_ERROR_LENGTH = 2000;

type OnlineWorkRunnerOutcome =
  | { type: "idle" }
  | { type: "skipped" }
  | { type: "building"; name: OnlineWorkName }
  | { type: "started"; name: OnlineWorkName };

export type OnlineWorkStateSnapshot = {
  name: string;
  state: (typeof ONLINE_WORK_STATES)[number];
  attempts: number;
  finishedAt: Date | null;
  pausedUntil: Date | null;
};

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const retryDelayMs = (attempts: number) =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);

/**
 * The runner's only access to `online_work_state`. A unit finishes hours
 * after the tick that claimed it, so finish times are the database's clock.
 */
export type OnlineWorkStateStore = {
  initialize: (
    units: readonly { name: OnlineWorkName; state: "pending" | "done" }[],
  ) => Promise<void>;
  readStates: () => Promise<readonly OnlineWorkStateSnapshot[]>;
  markRunning: (options: {
    name: OnlineWorkName;
    attempts: number;
    at: Date;
  }) => Promise<boolean>;
  markDone: (name: OnlineWorkName) => Promise<void>;
  markPending: (name: OnlineWorkName) => Promise<void>;
  markFailed: (options: {
    name: OnlineWorkName;
    error: string;
  }) => Promise<void>;
};

type ClaimedUnit = Extract<OnlineWorkUnitClaim, { type: "claimed" }>;

type OnlineWorkRunnerDependencies = {
  /** Registered units in walk order; pending ones are built in this order. */
  names: readonly OnlineWorkName[];
  lifecycle: Readonly<Record<OnlineWorkName, OnlineWorkLifecycle>>;
  store: OnlineWorkStateStore;
  claim: (
    options: Required<Pick<ClaimOnlineWorkUnitOptions, "name" | "lifecycle">>,
  ) => Promise<OnlineWorkUnitClaim>;
  /** Runs the claimed walk past this tick; its failure is reported, never returned to the tick. */
  detach: (work: Promise<UnitResult>) => void;
};

/** How a detached unit ended: recorded, or failed with its checkpoint written. */
type UnitResult = Result<void, SchedulerTaskFailure>;

type OnlineWorkRunnerTick = (
  now: Date,
) => Promise<Result<OnlineWorkRunnerOutcome, SchedulerTaskFailure>>;

const redactedError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replaceAll(/postgres(?:ql)?:\/\/\S+/giu, "[database-url]")
    .slice(0, MAX_ERROR_LENGTH);
};

type BuildState = { type: "idle" } | { type: "building"; name: OnlineWorkName };

const IDLE_BUILD = { type: "idle" } as const satisfies BuildState;
const IDLE = { type: "idle" } as const satisfies OnlineWorkRunnerOutcome;
const SKIPPED = { type: "skipped" } as const satisfies OnlineWorkRunnerOutcome;

/**
 * Builds pending online work after rollout, one unit at a time. A unit (an
 * index build on a large table) can run for hours, longer than a scheduler
 * lease, so a tick only claims it and the walk continues past the tick on
 * its own session. The online lock that session holds keeps every other
 * process, and any migrate run, from claiming online work meanwhile; a
 * process that dies mid-build leaves an invalid index that the next claim
 * drops and rebuilds.
 */
export const createOnlineWorkRunner = ({
  names,
  lifecycle,
  store,
  claim,
  detach,
}: OnlineWorkRunnerDependencies) => {
  let build: BuildState = IDLE_BUILD;
  const pending = names.filter((name) => {
    const entry = lifecycle[name];
    switch (entry.state) {
      case "pending":
        return true;
      case "finalized":
        return false;
      default:
        entry satisfies never;
        return panic(`Online work ${name} has an invalid lifecycle`);
    }
  });

  const finishUnit = async (
    name: OnlineWorkName,
    run: ClaimedUnit["run"],
  ): Promise<UnitResult> => {
    try {
      return await run(async (outcome): Promise<UnitResult> => {
        if (Result.isError(outcome)) {
          await store.markFailed({ name, error: redactedError(outcome.error) });
          return Result.err(
            new SchedulerTaskFailure({
              message: `Online work ${name} failed`,
              cause: outcome.error,
            }),
          );
        }
        switch (outcome.value.type) {
          case "complete":
            await store.markDone(name);
            return Result.ok(undefined);
          case "deferred":
            await store.markPending(name);
            return Result.ok(undefined);
          default:
            outcome.value satisfies never;
            return panic("Unknown online work outcome");
        }
      });
    } finally {
      build = IDLE_BUILD;
    }
  };

  /** `now` is the tick's own time: it dates the claim. */
  const tick: OnlineWorkRunnerTick = async (now) => {
    if (build.type === "building") {
      return Result.ok({ type: "building", name: build.name });
    }
    await store.initialize(
      names.map((name) => ({
        name,
        state: lifecycle[name].state === "finalized" ? "done" : "pending",
      })),
    );
    if (pending.length === 0) {
      return Result.ok(IDLE);
    }
    const states = await store.readStates();
    const stateByName = new Map(states.map((state) => [state.name, state]));
    const name = pending.find((candidate) => {
      const state = stateByName.get(candidate);
      if (state === undefined) {
        return true;
      }
      if (
        state.state === "done" ||
        (state.pausedUntil !== null && state.pausedUntil > now)
      ) {
        return false;
      }
      return !(
        state.state === "failed" &&
        state.finishedAt !== null &&
        now.getTime() <
          state.finishedAt.getTime() + retryDelayMs(state.attempts)
      );
    });
    if (name === undefined) {
      return Result.ok(IDLE);
    }
    const claimed = await claim({ name, lifecycle });
    switch (claimed.type) {
      case "paused":
      case "lock_held":
        return Result.ok(SKIPPED);
      case "claimed":
        break;
      default:
        claimed satisfies never;
        return panic("Unknown online work claim");
    }
    // The snapshot above chose the unit before the lock was held; another
    // process may have finished it since. Only the state read under the
    // claim decides whether it still needs work, and counts the attempt.
    const marked = await Result.tryPromise({
      try: async () => {
        const current = (await store.readStates()).find(
          (state) => state.name === name,
        );
        if (current?.state === "done") {
          return "finished-elsewhere" as const;
        }
        const started = await store.markRunning({
          name,
          attempts: (current?.attempts ?? 0) + 1,
          at: now,
        });
        return started ? ("building" as const) : ("paused" as const);
      },
      catch: (cause: unknown) => cause,
    });
    if (Result.isError(marked)) {
      await claimed.release();
      return Result.err(
        new SchedulerTaskFailure({
          message: `Recording the claim on online work ${name} failed`,
          cause: marked.error,
        }),
      );
    }
    if (marked.value !== "building") {
      await claimed.release();
      return Result.ok(IDLE);
    }
    build = { type: "building", name };
    detach(finishUnit(name, claimed.run));
    return Result.ok({ type: "started", name });
  };
  return tick;
};

export const createDrizzleOnlineWorkStateStore = (
  db: SchedulerDb,
  auditSubject:
    | SafeId<"schedulerJobRun">
    | SafeId<"systemScriptRun"> = createSafeId<"systemScriptRun">(),
): OnlineWorkStateStore => ({
  initialize: async (units) => {
    await withAggregateTransaction(db, async (tx) => {
      await transitionUpsertBatch({
        tx,
        spec: ONLINE_WORK_STATE_TRANSITIONS,
        values: units,
        onExisting: "preserve",
        recordTransitionAuditEvent: async (auditTx, rows) => {
          await recordSystemAudit(auditTx, "system:online-work", {
            subject: auditSubject,
            counts: { transitions: rows.length },
          });
        },
      });
    });
  },
  readStates: async () => {
    const rows = await db
      .select({
        name: onlineWorkState.name,
        state: onlineWorkState.state,
        attempts: onlineWorkState.attempts,
        finishedAt: onlineWorkState.finishedAt,
        pausedUntil: onlineWorkState.pausedUntil,
      })
      .from(onlineWorkState);
    return rows.map((row) => ({
      ...row,
      state: decodeOnlineWorkState(row.state),
    }));
  },
  markRunning: async ({ name, attempts, at }) =>
    await withAggregateTransaction(db, async (tx) => {
      const row = await lockOnlineWorkState({ tx, name });
      if (row?.state === "done" || row?.paused === true) {
        return false;
      }
      const audit = async (auditTx: typeof tx, changed: readonly unknown[]) => {
        await recordSystemAudit(auditTx, "system:online-work", {
          subject: auditSubject,
          counts: { transitions: changed.length },
        });
      };
      if (row?.state === "paused") {
        await transitionScopedBatch({
          tx,
          spec: ONLINE_WORK_STATE_TRANSITIONS,
          identities: [{ name }],
          options: {
            from: ["paused"],
            to: "pending",
            set: { pausedUntil: null, updatedAt: sql`now()` },
          },
          recordTransitionAuditEvent: audit,
        });
      }
      await transitionUpsertBatch({
        tx,
        spec: ONLINE_WORK_STATE_TRANSITIONS,
        values: [
          {
            name,
            state: "running",
            attempts,
            lastError: null,
            startedAt: at,
            finishedAt: null,
            updatedAt: at,
          },
        ],
        recordTransitionAuditEvent: audit,
      });
      return true;
    }),
  markDone: async (name) =>
    await finishOnlineWork(db, auditSubject, {
      name,
      state: "done",
      lastError: null,
    }),
  markPending: async (name) =>
    await finishOnlineWork(db, auditSubject, {
      name,
      state: "pending",
      lastError: null,
    }),
  markFailed: async ({ name, error }) =>
    await finishOnlineWork(db, auditSubject, {
      name,
      state: "failed",
      lastError: error,
    }),
});

type FinishOnlineWorkOptions = {
  name: OnlineWorkName;
  state: Extract<
    (typeof ONLINE_WORK_STATES)[number],
    "done" | "failed" | "pending"
  >;
  lastError: string | null;
};

/** A unit's end, dated by the database: it finishes hours after its claim. */
const finishOnlineWork = async (
  db: SchedulerDb,
  auditSubject: SafeId<"schedulerJobRun"> | SafeId<"systemScriptRun">,
  { name, state, lastError }: FinishOnlineWorkOptions,
): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    await transitionScopedBatch({
      tx,
      spec: ONLINE_WORK_STATE_TRANSITIONS,
      identities: [{ name }],
      options: {
        from: ["running"],
        to: state,
        set: { lastError, finishedAt: sql`now()`, updatedAt: sql`now()` },
      },
      recordTransitionAuditEvent: async (auditTx, rows) => {
        await recordSystemAudit(auditTx, "system:online-work", {
          subject: auditSubject,
          counts: { transitions: rows.length },
        });
      },
    });
  });
};

const maintenancePool = (): OnlineBuildPool => ({
  reserve: async () => {
    const client = await openMaintenanceSql(envBase.DATABASE_URL);
    const connection: OnlineBuildConnection = {
      execute: async (query, params = []) => {
        await client.unsafe(query, params);
      },
      query: async (query, params = []) => await client.unsafe(query, params),
      release: client.end,
      terminate: client.terminate,
    };
    return connection;
  },
});

type RunnerByDb = (db: SchedulerDb) => OnlineWorkRunnerTick;

const unitFailed = failureSink({
  event: "scheduler.online_work_unit_failed",
  expected: [],
});

/** A unit that failed after writing its checkpoint is observed as a failure. */
const reportUnitFailure = async (work: Promise<UnitResult>): Promise<void> => {
  const result = await work;
  if (Result.isError(result)) {
    observeFailure(result.error, { sink: unitFailed });
  }
};

/**
 * One runner per process: its build state must outlive the tick that
 * started a build, so it is created on the first tick and kept.
 */
const processRunner = (): RunnerByDb => {
  let runner: OnlineWorkRunnerTick | undefined;
  return (db) => {
    runner ??= createOnlineWorkRunner({
      names: ONLINE_WORK_NAMES,
      lifecycle: ONLINE_WORK_LIFECYCLE,
      store: createDrizzleOnlineWorkStateStore(db),
      claim: async ({ name, lifecycle }) =>
        await claimOnlineWorkUnit(maintenancePool(), {
          name,
          lifecycle,
          isPaused: async () => await readOnlineWorkPause(db, name),
          indexGate: {
            // Background work waits on a missing setting instead of failing
            // every tick; the gate reports it and holds the build.
            ebs: resolveEbsConfiguration(envDbLoadGate),
            hold: createOnlineIndexHold(),
          },
          reserveObserver: async () =>
            await openOnlineIndexObserver(envBase.DATABASE_URL),
        }),
      detach: (work) => {
        detached(reportUnitFailure(work), "online-work.build-unit");
      },
    });
    return runner;
  };
};

const runnerFor = processRunner();

export const runPendingOnlineWork = (async ({ db, dueAt }) =>
  (await runnerFor(db)(dueAt.claimedAtDate())).map(
    () => undefined,
  )) satisfies SchedulerTask;
