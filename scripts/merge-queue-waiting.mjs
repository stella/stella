/**
 * @typedef {{ owner: string, repo: string }} Repository
 * @typedef {{ status: string }} Job
 * @typedef {{
 *   paginate: (method: unknown, options: Repository & { run_id: number, filter: string, per_page: number }) => Promise<Job[]>,
 *   rest: {
 *     actions: {
 *       listJobsForWorkflowRun: unknown,
 *       listWorkflowRunsForRepo: (options: Repository & { event: string, status: string, per_page: number }) =>
 *         Promise<{ data: { total_count: number, workflow_runs: { id: number }[] } }>
 *     }
 *   }
 * }} ActionsClient
 */

/**
 * Whether merge-group runs have work waiting for a runner. The pull request
 * CI yield and the queued-run steward inline this same predicate; a test
 * keeps the three definitions identical.
 * @param {{ github: ActionsClient, repo: Repository }} options
 */
export const mergeQueueWaiting = async ({ github, repo }) => {
  for (const status of ["queued", "waiting", "pending", "requested"]) {
    const { data } = await github.rest.actions.listWorkflowRunsForRepo({
      ...repo,
      event: "merge_group",
      status,
      per_page: 1,
    });
    if (data.total_count > 0) return true;
  }
  const { data } = await github.rest.actions.listWorkflowRunsForRepo({
    ...repo,
    event: "merge_group",
    status: "in_progress",
    per_page: 20,
  });
  for (const run of data.workflow_runs) {
    const jobs = await github.paginate(
      github.rest.actions.listJobsForWorkflowRun,
      {
        ...repo,
        run_id: run.id,
        filter: "latest",
        per_page: 100,
      },
    );
    if (
      jobs.some((job) => job.status === "queued" || job.status === "waiting")
    )
      return true;
  }
  return false;
};

/**
 * Lets a pull request side workflow give its runners to the merge queue.
 * A first attempt that finds merge-group work waiting either skips (`polls`
 * is 0) or checks again every `intervalMs` until the queue clears, and runs
 * once `polls` checks have passed. A re-run, a Dependabot run and an idle
 * queue run at once, matching the pull request CI yield.
 * @param {{
 *   github: ActionsClient,
 *   context: { actor: string, repo: Repository },
 *   attempt: number,
 *   polls: number,
 *   intervalMs: number,
 *   sleep: (ms: number) => Promise<void>,
 *   notice: (message: string) => void,
 * }} options
 * @returns {Promise<"run" | "skip">}
 */
export const mergeQueueGate = async ({
  github,
  context,
  attempt,
  polls,
  intervalMs,
  sleep,
  notice,
}) => {
  if (context.actor === "dependabot[bot]" || attempt > 1) return "run";
  const waiting = () => mergeQueueWaiting({ github, repo: context.repo });
  if (!(await waiting())) return "run";
  if (polls === 0) {
    notice(
      "Merge queue has waiting work; skipped for this push. Re-run the workflow or push again to run it.",
    );
    return "skip";
  }
  for (let poll = 0; poll < polls; poll += 1) {
    await sleep(intervalMs);
    if (!(await waiting())) return "run";
  }
  notice("Merge queue still has waiting work; running anyway.");
  return "run";
};
