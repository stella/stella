import { decideStart, defaultConfig } from "@stll/db-load-gate/health";
import type { Verdict } from "@stll/db-load-gate/health";

import {
  canStartCyclePage,
  reserveCycleBudget,
} from "@/api/lib/legal-search/cycle-deadline";
import type { CycleDeadline } from "@/api/lib/legal-search/cycle-deadline";

/** 120 seconds of statement time plus 10 seconds for cancellation and settlement. */
export const SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS = 130_000;

type SourceStoredTotalAdmissionOptions = {
  readVerdict: () => Promise<Verdict>;
};
type SourceStoredTotalAdmissionRequest = {
  deadline: CycleDeadline | undefined;
};

/** Recheck load and commit the operation's full budget before the exact count. */
export const createSourceStoredTotalAdmission = ({
  readVerdict,
}: SourceStoredTotalAdmissionOptions) => {
  let admittedCycles: WeakSet<CycleDeadline> | undefined;
  return async ({
    deadline,
  }: SourceStoredTotalAdmissionRequest): Promise<
    "granted" | "held" | "unknown"
  > => {
    if (
      deadline === undefined ||
      admittedCycles?.has(deadline) ||
      !canStartCyclePage(deadline, SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS)
    ) {
      return "held";
    }
    const verdict = await readVerdict();
    if (verdict.kind === "unknown") {
      return "unknown";
    }
    if (
      decideStart(verdict, "backfill_batch", defaultConfig).decision ===
        "wait" ||
      admittedCycles?.has(deadline) ||
      !reserveCycleBudget(deadline, SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS)
    ) {
      return "held";
    }
    admittedCycles ??= new WeakSet();
    admittedCycles.add(deadline);
    return "granted";
  };
};
