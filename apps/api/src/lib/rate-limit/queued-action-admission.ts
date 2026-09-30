import { Result } from "better-result";
import { DelayedError } from "bullmq";

import { Temporal } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";

import {
  ActionAdmissionError,
  withActionAdmission,
  reserveQueuedKickoffPeriod,
} from "./action-admission";

export const QUEUED_ACTION_KIND = {
  extraction: "workflow.start",
  flow: "flow.start",
} as const;

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
  logicalPhaseId,
  periodReservation,
  run,
  admission = withActionAdmission,
}: QueuedKickoffOptions<T>): Promise<T> => {
  const result = await admission({
    organizationId,
    userId,
    execution: "queued-kickoff",
    periodIdentity: { actionKind, logicalPhaseId },
    periodReservation,
    run: async (signal) => await run(signal, reserveQueuedKickoffPeriod),
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

type BackgroundJobOptions<T> = {
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
  organizationId,
  userId,
  job,
  signal,
  run,
  admission = withActionAdmission,
  now = () => Temporal.Now.instant().epochMilliseconds,
  random = Math.random,
}: BackgroundJobOptions<T>): Promise<T> => {
  const result = await admission({
    organizationId,
    userId,
    execution: "background-job",
    run: async (leaseSignal) =>
      await run(AbortSignal.any([signal, leaseSignal])),
  });
  if (Result.isOk(result)) {
    return result.value;
  }
  if (!ActionAdmissionError.is(result.error)) {
    throw result.error;
  }
  // Busy capacity and coordination loss leave durable work queued for a fresh lease.
  await job.moveToDelayed(
    now() + admissionRetryDelayMs(job.attemptsStarted ?? 1, random),
    job.token,
  );
  throw new DelayedError();
};
