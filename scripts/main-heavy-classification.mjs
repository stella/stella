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

// This is the owner for repository actions whose whole purpose is preparing a
// runner. Keep code-producing, verification, and test actions out of this map.
export const LOCAL_INFRASTRUCTURE_ACTIONS = {
  "./.github/actions/ci-install":
    "installs the repository toolchain and dependencies",
  "./.github/actions/safe-chain": "installs the package-manager security shim",
  "./.github/actions/setup-playwright": "prepares browser executables",
  // Stack setup actions boot this repository's own services, so a failure
  // there can be a code failure and stays out of this map.
};

const INFRASTRUCTURE_ACTIONS = [
  "actions/checkout",
  "oven-sh/setup-bun",
  "actions/setup-node",
  "actions/cache",
];
const RUNNER_INFRASTRUCTURE_STEPS = new Set([
  "Set up job",
  "Initialize containers",
  "Complete job",
  "Post job cleanup",
]);

/** @param {string} uses */
const infrastructureAction = (uses) => {
  const action = uses.split("@").at(0);
  if (action === undefined) {
    return false;
  }
  return (
    INFRASTRUCTURE_ACTIONS.includes(action) ||
    Object.hasOwn(LOCAL_INFRASTRUCTURE_ACTIONS, action)
  );
};

/**
 * Read the job and step structure needed here without treating display names as
 * evidence. Workflow syntax outside jobs/steps is deliberately ignored.
 * @param {string} source Trusted workflow source.
 */
export const infrastructureStepsByJob = (source) => {
  const jobs = new Map();
  let inJobs = false;
  let job;
  let stepName;
  for (const line of source.split(/\r?\n/u)) {
    if (line === "jobs:") {
      inJobs = true;
      continue;
    }
    if (!inJobs) {
      continue;
    }
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (jobMatch) {
      job = jobMatch.at(1);
      if (job === undefined) {
        continue;
      }
      jobs.set(job, { displayName: job, steps: new Set() });
      stepName = undefined;
      continue;
    }
    if (!job) {
      continue;
    }
    const displayName = /^ {4}name:\s*["']?([^"']+?)["']?\s*$/u.exec(line);
    const display = displayName?.at(1);
    if (display && !display.includes("${{")) {
      const definition = jobs.get(job);
      if (definition) {
        definition.displayName = display;
      }
      continue;
    }
    const name = /^ {6}- name:\s*["']?([^"']+?)["']?\s*$/u.exec(line);
    if (name) {
      stepName = name.at(1);
      continue;
    }
    const uses = /^ {8}uses:\s*([^\s#]+)/u.exec(line);
    const action = uses?.at(1);
    const definition = jobs.get(job);
    if (stepName && action && definition && infrastructureAction(action)) {
      definition.steps.add(stepName);
      definition.steps.add(`Post ${stepName}`);
    }
  }
  return jobs;
};

/** @param {string} name @param {Map<string, { displayName: string, steps: Set<string> }>} definitions */
const jobInfrastructureSteps = (name, definitions) => {
  const normalized = jobName(name);
  for (const [id, definition] of definitions) {
    if (
      normalized === id ||
      normalized.startsWith(`${id} (`) ||
      normalized === definition.displayName ||
      normalized.startsWith(`${definition.displayName} (`)
    ) {
      return definition.steps;
    }
  }
  return new Set();
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
/** @param {{ jobs: Job[], queueJobs: Job[], workflow?: string }} options Main and queue execution evidence. */
export const classifyMainHeavyFailures = ({
  jobs,
  queueJobs,
  workflow = "",
}) => {
  const definitions = infrastructureStepsByJob(workflow);
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
    const infrastructureSteps = jobInfrastructureSteps(job.name, definitions);
    const failedSteps = executed.filter(failed);
    const allInfrastructure =
      failedSteps.length > 0 &&
      failedSteps.every(
        ({ name }) =>
          RUNNER_INFRASTRUCTURE_STEPS.has(name) ||
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
 * sha: string, workflow?: string, results: Record<string, { result: string }>, warn: (message: string) => void }} options Workflow context and evidence client.
 */
export const collectMainHeavyFailures = async ({
  github,
  context,
  sha,
  workflow = "",
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
  return classifyMainHeavyFailures({ jobs, queueJobs, workflow });
};
