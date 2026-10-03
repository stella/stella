import type { backfillHeartbeat } from "@stll/db-load-gate/health";
import { defaultConfig } from "@stll/db-load-gate/health";

import type { BackfillRunStatus } from "../../db/backfill-runtime";

export const SCHEDULER_BACKFILL_CONFIG = {
  ...defaultConfig,
  hardFloor: 65,
  resumeFloor: 75,
  startFloor: 80,
};

export const SCHEDULER_BACKFILL_IDS = {
  provisionState: "caseLaw.backfillProvisionState.minutely",
  expressionIds: "legislation.backfillExpressionIds.fiveMinute",
} as const;

export const emitSchedulerBackfillHeartbeat = (
  record: ReturnType<typeof backfillHeartbeat>,
) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

/** One summary per runtime close; only the minutely sampler emits the EMF gauge. */
export const logSchedulerBackfillStatus = (record: BackfillRunStatus) => {
  process.stdout.write(
    `${JSON.stringify({
      Backfill: record.Backfill,
      event: record.event,
      transitionEvent: record.transitionEvent,
      signalEvent: record.signalEvent,
      band: record.band,
      class: record.class,
      reason: record.reason,
      verdict: record.verdict,
      heldSince: record.heldSince,
      heldTooLong: record.heldTooLong,
    })}\n`,
  );
};
