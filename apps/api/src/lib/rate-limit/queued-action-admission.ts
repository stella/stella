import { Result } from "better-result";
import { DelayedError } from "bullmq";

import { Temporal } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";

import { ActionAdmissionError, withActionAdmission } from "./action-admission";

export const QUEUED_ACTION_KIND = {
  extraction: "workflow.start",
  flow: "flow.start",
} as const;

// BullMQ delays do not consume the job's failure attempts. A busy pool never hot-loops.
const ADMISSION_RETRY_DELAY_MS = 5000;

type QueuedKickoffOptions<T> = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  actionKind: (typeof QUEUED_ACTION_KIND)[keyof typeof QUEUED_ACTION_KIND];
  logicalPhaseId: string;
  run: (signal: AbortSignal) => Promise<T>;
  admission?: typeof withActionAdmission;
};

export const runQueuedKickoff = async <T>({
  organizationId,
  userId,
  actionKind,
  logicalPhaseId,
  run,
  admission = withActionAdmission,
}: QueuedKickoffOptions<T>): Promise<T> => {
  const result = await admission({
    organizationId,
    userId,
    execution: "queued-kickoff",
    periodIdentity: { actionKind, logicalPhaseId },
    run,
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
    moveToDelayed: (timestamp: number, token?: string) => Promise<void>;
  };
  signal: AbortSignal;
  run: (signal: AbortSignal) => Promise<T>;
  admission?: typeof withActionAdmission;
  now?: () => number;
};

export const runBackgroundJob = async <T>({
  organizationId,
  userId,
  job,
  signal,
  run,
  admission = withActionAdmission,
  now = () => Temporal.Now.instant().epochMilliseconds,
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
  await job.moveToDelayed(now() + ADMISSION_RETRY_DELAY_MS, job.token);
  throw new DelayedError();
};
