/**
 * The options of the run picker: one per verification of the document,
 * newest first as the history endpoint returns them.
 */

import { Temporal } from "@stll/time";

import type {
  VerificationRunStatus,
  VerificationRunSummary,
} from "@/features/avt/types";

export type RunHistoryOption = {
  id: string;
  status: VerificationRunStatus;
  createdAtMs: number;
  /** Claims per verdict; only a completed run has counted them. */
  claimCounts: VerificationRunSummary["claimCounts"] | null;
  /** The run checked the document against a list other than the view's. */
  otherList: boolean;
};

export const runHistoryOptions = (
  runs: readonly VerificationRunSummary[],
  viewListId: string | null,
): RunHistoryOption[] => {
  const seen = new Set<string>();
  const options: RunHistoryOption[] = [];
  for (const run of runs) {
    // A refetch while a new run lands can repeat a run across page edges.
    if (seen.has(run.id)) {
      continue;
    }
    seen.add(run.id);
    options.push({
      id: run.id,
      status: run.status,
      createdAtMs: Temporal.Instant.from(run.createdAt).epochMilliseconds,
      claimCounts: run.status === "completed" ? run.claimCounts : null,
      otherList: viewListId !== null && run.listId !== viewListId,
    });
  }
  return options;
};
