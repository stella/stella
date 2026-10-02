import { decideStart, defaultConfig } from "@stll/db-load-gate/health";
import type { Verdict } from "@stll/db-load-gate/health";

import {
  canStartCyclePage,
  reserveCycleBudget,
} from "@/api/lib/legal-search/cycle-deadline";
import type { CycleDeadline } from "@/api/lib/legal-search/cycle-deadline";

export const SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS = 10_000;

type SourceStoredTotalAdmissionOptions = {
  readVerdict: () => Promise<Verdict>;
};
type SourceStoredTotalAdmissionRequest = {
  deadline: CycleDeadline | undefined;
};

/** Recheck load and commit the operation's full budget before planning. */
export const createSourceStoredTotalAdmission =
  ({ readVerdict }: SourceStoredTotalAdmissionOptions) =>
  async ({
    deadline,
  }: SourceStoredTotalAdmissionRequest): Promise<"granted" | "held"> => {
    if (
      deadline === undefined ||
      !canStartCyclePage(deadline, SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS)
    ) {
      return "held";
    }
    const verdict = await readVerdict();
    if (
      decideStart(verdict, "backfill_batch", defaultConfig).decision === "wait"
    ) {
      return "held";
    }
    return reserveCycleBudget(deadline, SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS)
      ? "granted"
      : "held";
  };
