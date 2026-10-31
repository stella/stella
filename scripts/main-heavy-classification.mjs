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

import infrastructureDefinitions from "./main-heavy-infrastructure-steps.json" with { type: "json" };

const RUNNER_INFRASTRUCTURE_STEPS = new Set([
  "Set up job",
  "Initialize containers",
  "Complete job",
  "Post job cleanup",
]);

/** @param {string} name @param {typeof infrastructureDefinitions} definitions */
const jobInfrastructureSteps = (name, definitions) => {
  const normalized = jobName(name);
  for (const [id, definition] of Object.entries(definitions)) {
    const { prefix, suffix } = definition.displayName;
    if (
      normalized === id ||
      normalized.startsWith(`${id} (`) ||
      (normalized.startsWith(prefix) && normalized.endsWith(suffix))
    ) {
      return {
        declaredStepNames: new Set(definition.declaredStepNames),
        infrastructureSteps: new Set(definition.steps),
      };
    }
  }
  return { declaredStepNames: new Set(), infrastructureSteps: new Set() };
};

/** @param {string} name Workflow job display name. */
const jobName = (name) => name.replace(/^suites \/ /u, "");
/** @param {Job} job Completed or pending workflow job. */
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

// The jobs API has no task/file selection receipts. Even matching successful
// steps on the same Git tree cannot prove full versus affected test scope.
/** @param {{ jobs: Job[], queueJobs: Job[], definitions?: typeof infrastructureDefinitions }} options Main and queue execution evidence. */
export const classifyMainHeavyFailures = ({
  jobs,
  queueJobs,
  definitions = infrastructureDefinitions,
}) => {
  return jobs.filter(failed).map((job) => {
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
    const { declaredStepNames, infrastructureSteps } = jobInfrastructureSteps(
      job.name,
      definitions,
    );
    const failedSteps = executed.filter(failed);
    const allInfrastructure =
      failedSteps.length > 0 &&
      failedSteps.every(
        ({ name }) =>
          (RUNNER_INFRASTRUCTURE_STEPS.has(name) &&
            !declaredStepNames.has(name)) ||
          infrastructureSteps.has(name),
      );
    if (allInfrastructure) {
      const firstFailedStep = failedSteps.at(0);
      if (firstFailedStep === undefined) {
        throw new TypeError("Missing failed step");
      }
      return {
        name: job.name,
        type: "INFRA",
        reason: `The failed step ${firstFailedStep.name} prepares the runner or toolchain.`,
      };
    }
    return {
      name: job.name,
      type: "CODE",
      reason: passed
        ? "The same job and executed steps passed on the identical merge-group tree, but test-scope equivalence is unproven."
        : "No matching merge-group pass proves the same tree and scope.",
    };
  });
};

/**
 * @param {{ github: EvidenceClient, context: { repo: Repository, runId: number },
 * sha: string, results: Record<string, { result: string }>, warn: (message: string) => void }} options Workflow context and evidence client.
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
  const queueJobs = [];
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
        const matchingJobs = await github.paginate(
          github.rest.actions.listJobsForWorkflowRunAttempt,
          {
            ...repository,
            run_id: run.id,
            attempt_number: run.run_attempt,
            per_page: 100,
          },
        );
        queueJobs.push(...matchingJobs);
      }
    } catch {
      warn(
        "Merge-group evidence is incomplete; unproven failures remain CODE.",
      );
    }
  }
  return classifyMainHeavyFailures({ jobs, queueJobs });
};
