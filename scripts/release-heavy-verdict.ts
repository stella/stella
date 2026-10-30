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
export const heavyVerdict = (jobs: unknown): HeavyVerdict => {
  const result = Bun.spawnSync(
    [
      "jq",
      "-nc",
      "--argjson",
      "jobs",
      JSON.stringify(jobs),
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
