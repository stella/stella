/**
 * Cancel pull request CI runs to give hosted runners back to the merge queue,
 * and record each one as deferred so it comes back by itself.
 *
 * Each run's head gets the pending `ci/merge-queue-yield` status that the
 * queued-run steward (`.github/workflows/cleanup-queued-pr-runs.yml`) writes
 * when it defers a run. The steward resumes every head carrying that status,
 * oldest first and one at a time while the merge queue waits, so a relief
 * cancellation never depends on its owner remembering to re-run it.
 *
 * Only same-repository `pull_request` runs of `ci.yml` are touched; anything
 * else (merge groups, pushes, schedules, forks) is refused.
 *
 * Run: `bun scripts/relief-cancel-pr-runs.ts <run-id>...`
 */

import * as v from "valibot";

import { githubRequest } from "./dated-waiver-publish";

export const YIELD_CONTEXT = "ci/merge-queue-yield";
export const RELIEF_DESCRIPTION =
  "Cancelled for runner relief; resumes automatically";
const REPO = "stella/stella";

const runSchema = v.object({
  id: v.number(),
  event: v.string(),
  path: v.string(),
  status: v.string(),
  conclusion: v.nullish(v.string()),
  head_sha: v.string(),
  html_url: v.string(),
  head_repository: v.nullish(v.object({ full_name: v.string() })),
});

export type ReliefOutcome =
  | { runId: number; outcome: "deferred"; headSha: string }
  | { runId: number; outcome: "skipped"; reason: string }
  | { runId: number; outcome: "uncertain"; headSha: string }
  | { runId: number; outcome: "failed" };

type Request = (args: readonly string[], input?: unknown) => Promise<unknown>;

const setYieldStatus = async (
  request: Request,
  run: { head_sha: string; html_url: string },
  state: "pending" | "success",
  description: string,
) =>
  request(
    [
      `repos/${REPO}/statuses/${run.head_sha}`,
      "--method",
      "POST",
      "--input",
      "-",
    ],
    {
      state,
      context: YIELD_CONTEXT,
      description,
      target_url: run.html_url,
    },
  );

const reliefCancelOne = async (
  runId: number,
  request: Request,
): Promise<ReliefOutcome> => {
  const run = v.parse(
    runSchema,
    await request([`repos/${REPO}/actions/runs/${runId}`]),
  );
  if (
    run.event !== "pull_request" ||
    run.path !== ".github/workflows/ci.yml" ||
    run.head_repository?.full_name !== REPO
  ) {
    return {
      runId,
      outcome: "skipped",
      reason: "not a same-repository pull request CI run",
    };
  }
  if (run.status === "completed") {
    return { runId, outcome: "skipped", reason: "already completed" };
  }
  // Record the deferral before cancelling: a cancelled run without the
  // record would never resume.
  await setYieldStatus(request, run, "pending", RELIEF_DESCRIPTION);
  try {
    await request([
      `repos/${REPO}/actions/runs/${runId}/cancel`,
      "--method",
      "POST",
    ]);
  } catch {
    // A failed request does not prove the cancellation was refused: it may
    // have taken effect before the response was lost. Clear the record only
    // when the run demonstrably finished without being cancelled; when even
    // that cannot be read, keep the record and report the run.
    const after = await request([`repos/${REPO}/actions/runs/${runId}`])
      .then((value) => v.parse(runSchema, value))
      .catch(() => undefined);
    if (after?.status === "completed" && after.conclusion !== "cancelled") {
      await setYieldStatus(request, run, "success", "Not deferred");
      return { runId, outcome: "skipped", reason: "cancel refused" };
    }
    if (after?.status === "completed") {
      return { runId, outcome: "deferred", headSha: run.head_sha };
    }
    // Still running or unreadable: the steward resumes it only once the run
    // ends cancelled, so keep the record and report it for a manual check.
    return { runId, outcome: "uncertain", headSha: run.head_sha };
  }
  return { runId, outcome: "deferred", headSha: run.head_sha };
};

// One run's failure never stops the others, and each outcome is reported as
// soon as it is known.
export const reliefCancel = async (
  runIds: readonly number[],
  request: Request,
  report?: (outcome: ReliefOutcome) => void,
): Promise<ReliefOutcome[]> => {
  const outcomes: ReliefOutcome[] = [];
  for (const runId of runIds) {
    const outcome = await reliefCancelOne(runId, request).catch(
      (): ReliefOutcome => ({ runId, outcome: "failed" }),
    );
    report?.(outcome);
    outcomes.push(outcome);
  }
  return outcomes;
};

if (import.meta.main) {
  const runIds = Bun.argv.slice(2).map(Number);
  if (runIds.length === 0 || runIds.some((id) => !Number.isSafeInteger(id))) {
    console.error("Usage: bun scripts/relief-cancel-pr-runs.ts <run-id>...");
    process.exit(2);
  }
  const outcomes = await reliefCancel(runIds, githubRequest, (outcome) => {
    console.log(JSON.stringify(outcome));
  });
  if (
    outcomes.some(
      ({ outcome }) => outcome === "failed" || outcome === "uncertain",
    )
  ) {
    process.exitCode = 1;
  }
}
