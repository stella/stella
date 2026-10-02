import { decideStart, defaultConfig } from "@stll/db-load-gate/health";
import type { HealthConfig, Verdict } from "@stll/db-load-gate/health";

import {
  canStartCyclePage,
  reserveCycleBudget,
  remainingCycleMs,
} from "@/api/lib/legal-search/cycle-deadline";
import type { CycleDeadline } from "@/api/lib/legal-search/cycle-deadline";

/** 120 seconds of statement time plus 10 seconds for cancellation and settlement. */
export const SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS = 130_000;

type SourceStoredTotalAdmissionOptions = {
  readVerdict: (request: SourceStoredTotalAdmissionRequest) => Promise<Verdict>;
  config?: HealthConfig;
};
type SourceStoredTotalAdmissionRequest = {
  deadline: CycleDeadline | undefined;
  phase?: "reserve" | "start";
};

/** Recheck load and commit the operation's full budget before the exact count. */
export const createSourceStoredTotalAdmission = ({
  readVerdict,
  config = defaultConfig,
}: SourceStoredTotalAdmissionOptions) => {
  let admittedCycles: WeakSet<CycleDeadline> | undefined;
  return async ({
    deadline,
    phase = "reserve",
  }: SourceStoredTotalAdmissionRequest): Promise<
    "granted" | "held" | "unknown"
  > => {
    if (deadline === undefined || deadline.signal.aborted) {
      return "held";
    }
    if (phase === "start") {
      if (!admittedCycles?.has(deadline) || remainingCycleMs(deadline) < 0) {
        return "held";
      }
    } else if (
      admittedCycles?.has(deadline) ||
      !canStartCyclePage(deadline, SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS)
    ) {
      return "held";
    }
    const verdict = await readVerdict({ deadline, phase });
    if (verdict.kind === "unknown") {
      return "unknown";
    }
    if (
      decideStart(verdict, "backfill_batch", config).decision === "wait" ||
      deadline.signal.aborted ||
      (phase === "start"
        ? remainingCycleMs(deadline) < 0
        : admittedCycles?.has(deadline) ||
          !reserveCycleBudget(
            deadline,
            SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
          ))
    ) {
      return "held";
    }
    admittedCycles ??= new WeakSet();
    admittedCycles.add(deadline);
    return "granted";
  };
};
