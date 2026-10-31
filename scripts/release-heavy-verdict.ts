import { panic } from "better-result";
import nodePath from "node:path";
import * as v from "valibot";

const VERDICT_FILTER = nodePath.join(
  import.meta.dirname,
  "release-heavy-verdict.jq",
);

const HeavyVerdictSchema = v.object({
  advisoryJobs: v.optional(v.array(v.string())),
  aggregateJobs: v.optional(v.array(v.string())),
  advisoryRequiredJob: v.optional(v.string()),
  advisoryStep: v.optional(v.string()),
  comparisonMarkerStep: v.optional(v.string()),
  advisory: v.array(v.string()),
  blocking: v.array(v.string()),
  advisoryOnly: v.boolean(),
});

export type HeavyVerdict = v.InferOutput<typeof HeavyVerdictSchema>;

/**
 * Decides a failed main/heavy run from its latest-attempt job list. The
 * decision lives in release-heavy-verdict.jq so the shell release gate, which
 * runs where Bun is not installed, applies the very same rule.
 */
export type HeavyVerdictInput = {
  /** The run's latest-attempt jobs, with their steps. */
  jobs: unknown;
  /** The jobs API's total_count, which the pages read must equal. */
  total: unknown;
  /** The run's `ci-required-summary` record; null when unreadable. */
  record: unknown;
  /** The run's `ci-required-violations` record; null when unreadable. */
  violations: unknown;
  runId: number;
  /** The workflow run's current attempt; every input must come from it. */
  runAttempt: number;
  head: string;
};

export const heavyVerdict = ({
  jobs,
  total,
  record,
  violations,
  runId,
  runAttempt,
  head,
}: HeavyVerdictInput): HeavyVerdict => {
  const result = Bun.spawnSync(
    [
      "jq",
      "-nc",
      "--argjson",
      "jobs",
      JSON.stringify(jobs),
      "--argjson",
      "total",
      JSON.stringify(total ?? null),
      "--argjson",
      "record",
      JSON.stringify(record ?? null),
      "--argjson",
      "violations",
      JSON.stringify(violations ?? null),
      "--argjson",
      "run_id",
      String(runId),
      "--argjson",
      "run_attempt",
      String(runAttempt),
      "--arg",
      "head",
      head,
      "-f",
      VERDICT_FILTER,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  if (!result.success) {
    return panic(
      `release-heavy-verdict.jq failed: ${result.stderr.toString()}`,
    );
  }
  return v.parse(HeavyVerdictSchema, JSON.parse(result.stdout.toString()));
};
