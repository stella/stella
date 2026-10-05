import { Result } from "better-result";
import { DelayedError } from "bullmq";

import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";

import {
  ActionAdmissionError,
  withActionAdmission,
  reserveQueuedKickoffPeriod,
} from "./action-admission";
import type {
  ConcurrencyOnlyActionKind,
  QUEUED_ACTION_KIND,
} from "./action-kinds";
import {
  admitModelDispatch,
  type ModelDispatchAdmission,
} from "./model-dispatch-admission";

// BullMQ delays do not consume the job's failure attempts. A busy pool never hot-loops.
const MIN_ADMISSION_RETRY_MS = 1000;
const INITIAL_ADMISSION_RETRY_MS = 10_000;
const MAX_ADMISSION_RETRY_MS = 60_000;

export const admissionRetryDelayMs = (
  attemptsStarted: number,
  random: () => number = Math.random,
) => {
  const ceiling = Math.min(
    MAX_ADMISSION_RETRY_MS,
    INITIAL_ADMISSION_RETRY_MS *
      2 ** Math.min(6, Math.max(0, attemptsStarted - 1)),
  );
  return (
    MIN_ADMISSION_RETRY_MS +
    Math.floor(random() * (ceiling - MIN_ADMISSION_RETRY_MS))
  );
};

type QueuedKickoffOptions<T> = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  organizationStateDb?: ScopedDb;
  actionKind: (typeof QUEUED_ACTION_KIND)[keyof typeof QUEUED_ACTION_KIND];
  logicalPhaseId: string;
  run: (signal: AbortSignal, reservePeriod: () => Promise<void>) => Promise<T>;
  periodReservation?: "on-acceptance";
  admission?: typeof withActionAdmission;
};

export const runQueuedKickoff = async <T>({
  organizationId,
  userId,
  actionKind,
  organizationStateDb,
  logicalPhaseId,
  periodReservation,
  run,
  admission = withActionAdmission,
}: QueuedKickoffOptions<T>): Promise<T> => {
  const result = await admission({
    organizationId,
    userId,
    ...(organizationStateDb !== undefined && { organizationStateDb }),
    execution: "queued-kickoff",
    periodIdentity: { actionKind, logicalPhaseId },
    periodReservation,
    run: async (signal) =>
      await run(signal, async () => {
        const reserved = await reserveQueuedKickoffPeriod();
        if (Result.isError(reserved)) {
          throw reserved.error;
        }
      }),
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

type ScheduledBackgroundWorkOptions<T> = {
  actionKind: ConcurrencyOnlyActionKind;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The organization's scope, read for the work's managed model tier. */
  organizationStateDb: ScopedDb;
  run: (
    signal: AbortSignal,
    modelAdmission: ModelDispatchAdmission,
  ) => Promise<T>;
  admission?: typeof withActionAdmission;
};

/**
 * Background work a scheduler drains without a queue job takes a background
 * slot like a queued job. A refusal is returned: the work stays due and the
 * next drain retries it.
 */
export const runScheduledBackgroundWork = async <T>({
  actionKind,
  organizationId,
  userId,
  organizationStateDb,
  run,
  admission = withActionAdmission,
}: ScheduledBackgroundWorkOptions<T>): Promise<Result<T, unknown>> =>
  await admission({
    organizationId,
    userId,
    execution: "background-job",
    actionKind,
    run: async (leaseSignal) =>
      await admitModelDispatch({
        organizationId,
        actionKind,
        organizationStateDb,
        signal: leaseSignal,
        run: async (modelAdmission) => await run(leaseSignal, modelAdmission),
      }),
  });

type BackgroundJobOptions<T> = {
  actionKind: ConcurrencyOnlyActionKind;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The organization's scope, read for the job's managed model tier. */
  organizationStateDb: ScopedDb;
  job: {
    token?: string;
    attemptsStarted?: number;
    moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
  };
  signal: AbortSignal;
  run: (
    signal: AbortSignal,
    modelAdmission: ModelDispatchAdmission,
  ) => Promise<T>;
  admission?: typeof withActionAdmission;
  now?: () => number;
  random?: () => number;
};

export const runBackgroundJob = async <T>({
  actionKind,
  organizationId,
  userId,
  organizationStateDb,
  job,
  signal,
  run,
  admission = withActionAdmission,
  now = () => Temporal.Now.instant().epochMilliseconds,
  random = Math.random,
}: BackgroundJobOptions<T>): Promise<T> => {
  const executionState: { phase: "waiting" | "started" } = {
    phase: "waiting",
  };
  const result = await admission({
    organizationId,
    userId,
    execution: "background-job",
    actionKind,
    run: async (leaseSignal) => {
      executionState.phase = "started";
      // Dispatches on the proof abort with the lease even where a job body
      // discards the run signal.
      return await admitModelDispatch({
        organizationId,
        actionKind,
        organizationStateDb,
        signal: leaseSignal,
        run: async (modelAdmission) =>
          await run(AbortSignal.any([signal, leaseSignal]), modelAdmission),
      });
    },
  });
  if (Result.isOk(result)) {
    return result.value;
  }
  const refusal = result.error;
  if (executionState.phase === "started" || !ActionAdmissionError.is(refusal)) {
    throw refusal;
  }
  // Refusals before execution wait for a fresh lease without consuming retries.
  // A refusal that knows its reset waits for it (BullMQ has no delay ceiling),
  // spread over one initial backoff so deferred jobs do not resume at once.
  const { retryAtMs } = refusal;
  await job.moveToDelayed(
    retryAtMs === undefined
      ? now() + admissionRetryDelayMs(job.attemptsStarted ?? 1, random)
      : Math.max(now(), retryAtMs) +
          Math.floor(random() * INITIAL_ADMISSION_RETRY_MS),
    job.token,
  );
  throw new DelayedError();
};
