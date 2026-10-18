/**
 * @typedef {{ name: string, conclusion: string | null }} JobStep
 * @typedef {{ name: string, conclusion: string | null, steps?: JobStep[] }} Job
 * @typedef {{ id: number, status: string | null, conclusion: string | null, created_at: string }} MergeGroupRun
 * @typedef {{
 *   state: string,
 *   headCommitOid: string | null,
 *   pullRequestId: string,
 *   number: number,
 *   headRefOid: string,
 *   attemptState: string | null,
 * }} QueueEntry
 * @typedef {{ action: "requeue" | "exhausted" | "skip", reason: string }} Decision
 * @typedef {{ owner: string, repo: string }} Repository
 * @typedef {{
 *   graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
 *   paginate: (method: unknown, options: Record<string, unknown>) => Promise<Job[]>,
 *   rest: {
 *     actions: {
 *       listJobsForWorkflowRun: unknown,
 *       listWorkflowRuns: (options: Record<string, unknown>) => Promise<{ data: { workflow_runs: MergeGroupRun[] } }>,
 *     },
 *     repos: { createCommitStatus: (options: Record<string, unknown>) => Promise<unknown> },
 *   },
 * }} Client
 * @typedef {{ graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown> }} QueueClient
 */

/** Commit status on the pull request head that records the one requeue. */
export const REQUEUE_CONTEXT = "ci/merge-group-requeue";
export const CI_WORKFLOW = "ci.yml";
export const RESULT_JOB = "ci-result";
/** ci-result's evaluation fails whenever any needed job did not succeed. */
export const RESULT_STEP = "Evaluate CI outcome";
/**
 * Runs only after a real failed step in the same job, which stays failed and
 * keeps the entry out of reach; mirrors CANONICAL_CANCEL_STEP.name in
 * scripts/ci-cancellation-contract.ts (a test pins the two together).
 */
export const CANCEL_STEP = "Cancel merge group after failure in this job";

/**
 * Failed steps that show something in the merged code broke. A step stopped
 * by a run-level cancel concludes `cancelled`, not `failure`, so only the
 * outcome evaluation and the self-cancel step are discounted.
 * @param {Job[]} jobs Jobs of the run's latest attempt.
 * @returns {string[]} `job / step` for every failed step that counts.
 */
export const realFailedSteps = (jobs) =>
  jobs.flatMap((job) =>
    (job.steps ?? [])
      .filter(
        (step) =>
          step.conclusion === "failure" &&
          step.name !== CANCEL_STEP &&
          !(job.name === RESULT_JOB && step.name === RESULT_STEP),
      )
      .map((step) => `${job.name} / ${step.name}`),
  );

/**
 * Whether an entry's merge group was cancelled from outside and may be
 * requeued once for its pull request head.
 * @param {{ entry: QueueEntry, run: MergeGroupRun | undefined, jobs: Job[] }} options Entry, its newest CI run and that run's jobs.
 * @returns {Decision} What to do with the entry.
 */
export const decideRequeue = ({ entry, run, jobs }) => {
  if (entry.state !== "UNMERGEABLE") {
    return { action: "skip", reason: `entry is ${entry.state}` };
  }
  if (!run) {
    return { action: "skip", reason: "no CI Checks run for the merge group" };
  }
  if (run.status !== "completed") {
    return {
      action: "skip",
      reason: `run ${run.id} is ${String(run.status)}`,
    };
  }
  if (run.conclusion !== "cancelled") {
    return {
      action: "skip",
      reason: `run ${run.id} concluded ${String(run.conclusion)}`,
    };
  }
  const failures = realFailedSteps(jobs);
  if (failures.length > 0) {
    return {
      action: "skip",
      reason: `run ${run.id} has failed steps: ${failures.join("; ")}`,
    };
  }
  if (entry.attemptState !== null) {
    return {
      action: "exhausted",
      reason: `run ${run.id} was cancelled again after this head was requeued once`,
    };
  }
  return {
    action: "requeue",
    reason: `run ${run.id} was cancelled with no failed step`,
  };
};

const ENTRIES_QUERY = `query($owner: String!, $repo: String!, $context: String!) {
  repository(owner: $owner, name: $repo) {
    mergeQueue(branch: "main") {
      entries(first: 100) {
        nodes {
          state
          headCommit { oid }
          pullRequest {
            id
            number
            headRefOid
            commits(last: 1) {
              nodes { commit { oid status { context(name: $context) { state } } } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * @param {unknown} value Any parsed JSON value.
 * @returns {value is Record<string, unknown>} Whether it is a plain object.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value Any parsed JSON value.
 * @param {string} key Property to read.
 * @returns {unknown} The property, when value is an object.
 */
const field = (value, key) => (isRecord(value) ? value[key] : undefined);

/**
 * Reads queue entries, dropping any whose shape is not understood: an entry
 * that cannot be read is left alone.
 * @param {unknown} data GraphQL response for ENTRIES_QUERY.
 * @returns {{ entries: QueueEntry[], failure: string | null }} Readable entries or a failure for the workflow boundary to report.
 */
export const parseEntries = (data) => {
  const nodes = field(
    field(field(field(data, "repository"), "mergeQueue"), "entries"),
    "nodes",
  );
  if (!Array.isArray(nodes)) {
    return { entries: [], failure: "Merge queue entries are unavailable" };
  }
  const entries = nodes.flatMap((node) => {
    const state = field(node, "state");
    const pull = field(node, "pullRequest");
    const id = field(pull, "id");
    const number = field(pull, "number");
    const headRefOid = field(pull, "headRefOid");
    const headCommitOid = field(field(node, "headCommit"), "oid");
    const commits = field(field(pull, "commits"), "nodes");
    const commit = field(
      Array.isArray(commits) ? commits[0] : undefined,
      "commit",
    );
    if (
      typeof state !== "string" ||
      typeof id !== "string" ||
      typeof number !== "number" ||
      typeof headRefOid !== "string" ||
      field(commit, "oid") !== headRefOid
    ) {
      return [];
    }
    const attemptState = field(
      field(field(commit, "status"), "context"),
      "state",
    );
    return [
      {
        state,
        headCommitOid: typeof headCommitOid === "string" ? headCommitOid : null,
        pullRequestId: id,
        number,
        headRefOid,
        attemptState: typeof attemptState === "string" ? attemptState : null,
      },
    ];
  });
  return { entries, failure: null };
};

/**
 * Decides every unmergeable entry of the main merge queue. Read-only.
 * @param {{ github: Client, repo: Repository }} options GITHUB_TOKEN client and repository.
 * @returns {Promise<{ plans: Array<QueueEntry & Decision & { runId: number | null }>, failure: string | null }>} Decisions and any queue-read failure for the workflow boundary.
 */
export const planRequeues = async ({ github, repo }) => {
  const { entries, failure } = parseEntries(
    await github.graphql(ENTRIES_QUERY, { ...repo, context: REQUEUE_CONTEXT }),
  );
  if (failure !== null) {
    return { plans: [], failure };
  }
  const plans = [];
  for (const entry of entries) {
    if (entry.state !== "UNMERGEABLE") {
      continue;
    }
    let run;
    if (entry.headCommitOid !== null) {
      const { data } = await github.rest.actions.listWorkflowRuns({
        ...repo,
        workflow_id: CI_WORKFLOW,
        event: "merge_group",
        head_sha: entry.headCommitOid,
        per_page: 10,
      });
      run = data.workflow_runs.toSorted((left, right) =>
        right.created_at.localeCompare(left.created_at),
      )[0];
    }
    const jobs =
      run?.status === "completed" && run.conclusion === "cancelled"
        ? await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
            ...repo,
            run_id: run.id,
            filter: "latest",
            per_page: 100,
          })
        : [];
    plans.push({
      ...entry,
      ...decideRequeue({ entry, run, jobs }),
      runId: run?.id ?? null,
    });
  }
  return { plans, failure: null };
};

const DEQUEUE = `mutation($id: ID!) {
  dequeuePullRequest(input: { id: $id }) { clientMutationId }
}`;
const ENQUEUE = `mutation($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { clientMutationId }
}`;

/**
 * Requeues each planned entry once and marks exhausted heads. The attempt is
 * recorded on the head before the queue is touched, so a failed or repeated
 * tick can never requeue the same head twice.
 * @param {{
 *   github: Client,
 *   queue: QueueClient | null,
 *   repo: Repository,
 *   plans: Awaited<ReturnType<typeof planRequeues>>["plans"],
 *   runUrl: (runId: number | null) => string,
 *   log: { info: (message: string) => void, warning: (message: string) => void, error: (message: string) => void },
 * }} options Clients, plans and logging.
 * @returns {Promise<number>} Requeues that failed.
 */
export const applyRequeues = async ({
  github,
  queue,
  repo,
  plans,
  runUrl,
  log,
}) => {
  let failed = 0;
  for (const plan of plans) {
    const status = async (
      /** @type {string} */ state,
      /** @type {string} */ description,
    ) => {
      await github.rest.repos.createCommitStatus({
        ...repo,
        sha: plan.headRefOid,
        state,
        context: REQUEUE_CONTEXT,
        description,
        target_url: runUrl(plan.runId),
      });
    };
    if (plan.action === "skip") {
      log.info(`#${plan.number}: left alone, ${plan.reason}.`);
      continue;
    }
    if (plan.action === "exhausted") {
      log.warning(
        `#${plan.number}: ${plan.reason}; dequeue and re-enqueue it by hand.`,
      );
      if (plan.attemptState !== "ERROR") {
        await status("error", "Merge group cancelled again after one requeue");
      }
      continue;
    }
    if (queue === null) {
      log.warning(`#${plan.number}: ${plan.reason}; requeue is unavailable.`);
      continue;
    }
    await status("success", "Requeued once after a cancelled merge group");
    try {
      await queue.graphql(DEQUEUE, { id: plan.pullRequestId });
      await queue.graphql(ENQUEUE, {
        id: plan.pullRequestId,
        head: plan.headRefOid,
      });
      log.info(`#${plan.number}: requeued, ${plan.reason}.`);
    } catch (error) {
      failed += 1;
      log.error(
        `#${plan.number}: requeue failed (${error instanceof Error ? error.message : String(error)}); check its queue state by hand.`,
      );
      await status("error", "Requeue failed; check the queue entry");
    }
  }
  return failed;
};
