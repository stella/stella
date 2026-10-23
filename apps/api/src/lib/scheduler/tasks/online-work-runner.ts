import { panic, Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import { openMaintenanceSql } from "@/api/db/long-running-connection";
import { onlineWorkState, type ONLINE_WORK_STATES } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { envDbLoadGate } from "@/api/env-db-load-gate";
import { captureError, detached } from "@/api/lib/analytics/capture";
import {
  requireEbsConfiguration,
  resolveEbsConfiguration,
} from "@/api/lib/db/ebs-signal-reader";
import {
  type SchedulerDb,
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";

import { createOnlineIndexHold } from "../../../db/online-index-gate";
import { openOnlineIndexObserver } from "../../../db/online-index-observer";
import type {
  OnlineMigrationConnection,
  OnlineMigrationPool,
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
};

/**
 * The runner's only access to `online_work_state`. A unit finishes hours
 * after the tick that claimed it, so finish times are the database's clock.
 */
export type OnlineWorkStateStore = {
  readStates: () => Promise<readonly OnlineWorkStateSnapshot[]>;
  markBuilding: (options: {
    name: OnlineWorkName;
    attempts: number;
    at: Date;
  }) => Promise<void>;
  markFinalized: (name: OnlineWorkName) => Promise<void>;
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
    options: Pick<ClaimOnlineWorkUnitOptions, "name" | "lifecycle">,
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
            await store.markFinalized(name);
            return Result.ok(undefined);
          case "deferred":
            // The gate held the unit; it stays building and the next tick
            // claims it again.
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
    if (pending.length === 0) {
      return Result.ok(IDLE);
    }
    const states = await store.readStates();
    const finalized = new Set(
      states.flatMap(({ name, state }) =>
        state === "finalized" ? [name] : [],
      ),
    );
    const name = pending.find((candidate) => !finalized.has(candidate));
    if (name === undefined) {
      return Result.ok(IDLE);
    }
    const claimed = await claim({ name, lifecycle });
    switch (claimed.type) {
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
        if (current?.state === "finalized") {
          return "finished-elsewhere" as const;
        }
        await store.markBuilding({
          name,
          attempts: (current?.attempts ?? 0) + 1,
          at: now,
        });
        return "building" as const;
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
    if (marked.value === "finished-elsewhere") {
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
): OnlineWorkStateStore => ({
  readStates: async () =>
    await db
      .select({
        name: onlineWorkState.name,
        state: onlineWorkState.state,
        attempts: onlineWorkState.attempts,
      })
      .from(onlineWorkState),
  markBuilding: async ({ name, attempts, at }) => {
    const building = {
      state: "building",
      attempts,
      lastError: null,
      startedAt: at,
      finishedAt: null,
      updatedAt: at,
    } as const;
    // audit: skip - system migration lifecycle checkpoint
    await db
      .insert(onlineWorkState)
      .values({ name, ...building })
      .onConflictDoUpdate({ target: onlineWorkState.name, set: building });
  },
  markFinalized: async (name) => {
    // audit: skip - system migration lifecycle checkpoint
    await db
      .update(onlineWorkState)
      .set({
        state: "finalized",
        lastError: null,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(onlineWorkState.name, name));
  },
  markFailed: async ({ name, error }) => {
    // audit: skip - system migration lifecycle checkpoint
    await db
      .update(onlineWorkState)
      .set({
        state: "failed",
        lastError: error,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(onlineWorkState.name, name));
  },
});

const maintenancePool = (): OnlineMigrationPool => ({
  reserve: async () => {
    const client = await openMaintenanceSql(envBase.DATABASE_URL);
    const connection: OnlineMigrationConnection = {
      execute: async (query, params = []) => {
        await client.unsafe(query, params);
      },
      query: async (query, params = []) => await client.unsafe(query, params),
      release: client.end,
    };
    return connection;
  },
});

type RunnerByDb = (db: SchedulerDb) => OnlineWorkRunnerTick;

/** A unit that failed after writing its checkpoint is reported like a rejection. */
const reportUnitFailure = async (work: Promise<UnitResult>): Promise<void> => {
  const result = await work;
  if (Result.isError(result)) {
    captureError(result.error, { detached: "online-work.build-unit" });
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
          indexGate: {
            ebs: requireEbsConfiguration(
              resolveEbsConfiguration(envDbLoadGate),
            ).unwrap(),
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
