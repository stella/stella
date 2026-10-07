import { Result } from "better-result";
import { DelayedError } from "bullmq";

import { backoffDelay } from "@stll/concurrency/backoff-delay";
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

// BullMQ delays do not consume the job's failure attempts. A busy pool never hot-loops.
const MIN_ADMISSION_RETRY_MS = 1000;
const INITIAL_ADMISSION_RETRY_MS = 10_000;
const MAX_ADMISSION_RETRY_MS = 60_000;

export const admissionRetryDelayMs = (
  attemptsStarted: number,
  random: () => number = Math.random,
) =>
  backoffDelay(Math.min(6, Math.max(0, attemptsStarted - 1)), {
    baseMs: INITIAL_ADMISSION_RETRY_MS,
    maxMs: MAX_ADMISSION_RETRY_MS,
    jitter: {
      type: "full",
      random: random(),
      minMs: MIN_ADMISSION_RETRY_MS,
      rounding: "floor",
    },
  });

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

type BackgroundJobOptions<T> = {
  actionKind: ConcurrencyOnlyActionKind;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  job: {
    token?: string;
    attemptsStarted?: number;
    moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
  };
  signal: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
  admission?: typeof withActionAdmission;
  now?: () => number;
  random?: () => number;
};

export const runBackgroundJob = async <T>({
  actionKind,
  organizationId,
  userId,
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
      return await run(AbortSignal.any([signal, leaseSignal]));
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
          backoffDelay(0, {
            baseMs: INITIAL_ADMISSION_RETRY_MS,
            jitter: { type: "full", random: random(), rounding: "floor" },
          }),
    job.token,
  );
  throw new DelayedError();
};
