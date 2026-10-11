/**
 * @typedef {{ name: string, conclusion: string | null }} JobStep
 * @typedef {{ name: string, conclusion: string | null, steps?: JobStep[] }} Job
 * @typedef {{ owner: string, repo: string }} Repository
 * @typedef {{ id: number, head_sha: string, run_attempt: number }} QueueRun
 * @typedef {{ run_id: number, per_page: number, filter?: string, attempt_number?: number } & Repository} JobQuery
 * @typedef {{ workflow_id: string, event: string, status: string, per_page: number } & Repository} RunQuery
 * @typedef {{
 *   paginate: (method: unknown, options: JobQuery) => Promise<Job[]>,
 *   rest: {
 *     actions: {
 *       listJobsForWorkflowRun: unknown,
 *       listJobsForWorkflowRunAttempt: unknown,
 *       listWorkflowRuns: (options: RunQuery) => Promise<{ data: { workflow_runs: QueueRun[] } }>
 *     },
 *     repos: { getCommit: (options: Repository & { ref: string }) => Promise<{ data: { commit: { tree: { sha: string } } } }> }
 *   }
 * }} EvidenceClient
 */

/** @param {string} name */
const jobName = (name) => name.replace(/^suites \/ /u, "");
/** @param {Job} job */
const failed = ({ conclusion }) =>
  conclusion !== null &&
  [
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "startup_failure",
    "stale",
  ].includes(conclusion);

// A matching job name alone cannot prove that a scoped step ran in the queue.
/** @param {{ jobs: Job[], queueJobs: Job[] }} options */
export const classifyMainHeavyFailures = ({ jobs, queueJobs }) =>
  jobs.filter(failed).map((job) => {
    const executed = (job.steps ?? []).filter(
      ({ conclusion }) => conclusion !== "skipped",
    );
    const passed = queueJobs.some(
      (queueJob) =>
        jobName(queueJob.name) === jobName(job.name) &&
        queueJob.conclusion === "success" &&
        executed.length > 0 &&
        executed.every((step) =>
          queueJob.steps?.some(
            (queueStep) =>
              queueStep.name === step.name &&
              queueStep.conclusion === "success",
          ),
        ),
    );
    return {
      name: job.name,
      type: passed ? "INFRA" : "CODE",
      reason: passed
        ? "The same job and executed steps passed on the identical merge-group tree."
        : "No matching merge-group pass proves the same tree and scope.",
    };
  });

/**
 * @param {{ github: EvidenceClient, context: { repo: Repository, runId: number },
 * sha: string, results: Record<string, { result: string }>, warn: (message: string) => void }} options
 */
export const collectMainHeavyFailures = async ({
  github,
  context,
  sha,
  results,
  warn,
}) => {
  const repository = { owner: context.repo.owner, repo: context.repo.repo };
  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRun,
    {
      ...repository,
      run_id: context.runId,
      filter: "latest",
      per_page: 100,
    },
  );
  if (!jobs.some(failed)) {
    return Object.entries(results)
      .filter(([, { result }]) => result !== "success")
      .map(([name]) => ({
        name,
        type: "CODE",
        reason: "No completed job evidence is available.",
      }));
  }
  /** @type {Job[]} */
  let queueJobs = [];
  if (sha) {
    try {
      const { data: tested } = await github.rest.repos.getCommit({
        ...repository,
        ref: sha,
      });
      const { data: runs } = await github.rest.actions.listWorkflowRuns({
        ...repository,
        workflow_id: "ci.yml",
        event: "merge_group",
        status: "completed",
        per_page: 100,
      });
      // Squash merges change commit IDs, so compare the complete Git tree.
      for (const run of runs.workflow_runs) {
        const { data: queued } = await github.rest.repos.getCommit({
          ...repository,
          ref: run.head_sha,
        });
        if (queued.commit.tree.sha !== tested.commit.tree.sha) {
          continue;
        }
        queueJobs = await github.paginate(
          github.rest.actions.listJobsForWorkflowRunAttempt,
          {
            ...repository,
            run_id: run.id,
            attempt_number: run.run_attempt,
            per_page: 100,
          },
        );
        break;
      }
    } catch {
      warn("Merge-group evidence is unavailable; failures remain CODE.");
    }
  }
  return classifyMainHeavyFailures({ jobs, queueJobs });
};
