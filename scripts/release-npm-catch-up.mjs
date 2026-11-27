/**
 * Decides whether `release-npm-catch-up.yml` dispatches the manual CLI
 * publication for a final release tag.
 *
 * The release's own publication (`publish-npm.yml`, started by the final
 * Release Artifacts run) refuses at its source check while the release pull
 * request is not on main. The catch-up covers only that refusal: it acts once
 * that publication has finished having refused, the pull request has merged,
 * and npm still lacks the tag's CLI version. While the release run or its
 * publication is still going, the publication itself is the one path; it
 * passes its source check once the pull request is on main, and its
 * completion runs this decision again.
 *
 * @typedef {{ status: string | null, conclusion: string | null, created_at: string, updated_at: string, event: string, id: number }} WorkflowRun
 * @typedef {{ name: string, conclusion: string | null }} WorkflowJob
 * @typedef {{
 *   releasePullMerged: boolean,
 *   releaseRun: WorkflowRun | null,
 *   publications: readonly (WorkflowRun & { refusedAtSource: boolean })[],
 *   npmStatus: number,
 * }} CatchUpState
 * @typedef {{ dispatch: boolean, reason: string }} CatchUpDecision
 */

/** The `publish-npm.yml` job whose source check refuses an unmerged release. */
export const SOURCE_JOB = "Resolve release trigger";

/** Events whose `publish-npm.yml` runs publish a final release's CLI. */
const RELEASE_PUBLICATION_EVENTS = new Set([
  "workflow_run",
  "workflow_dispatch",
]);

const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;

/**
 * @param {CatchUpState} state
 * @returns {CatchUpDecision}
 */
export const decideCatchUp = ({
  releasePullMerged,
  releaseRun,
  publications,
  npmStatus,
}) => {
  if (!releasePullMerged) {
    return {
      dispatch: false,
      reason: "The release pull request has not merged.",
    };
  }
  if (releaseRun === null) {
    return {
      dispatch: false,
      reason:
        "The final release run has not started; its publication follows it.",
    };
  }
  if (releaseRun.status !== "completed") {
    return {
      dispatch: false,
      reason:
        "The final release run is still going; its publication follows it.",
    };
  }
  if (publications.some(({ status }) => status !== "completed")) {
    return {
      dispatch: false,
      reason:
        "A publication for this release is still going; its completion decides again.",
    };
  }
  // Publications arrive oldest first; the first started by the release run
  // is the release's own.
  const own = publications.find(({ event }) => event === "workflow_run");
  if (own === undefined) {
    return {
      dispatch: false,
      reason:
        "The release's own publication has not started; its completion decides again.",
    };
  }
  if (!own.refusedAtSource) {
    return {
      dispatch: false,
      reason:
        "The release's own publication passed its source check, so it was the publication path.",
    };
  }
  if (
    publications.some(
      ({ event, conclusion }) =>
        event === "workflow_dispatch" && conclusion === "success",
    )
  ) {
    return {
      dispatch: false,
      reason: "A manual publication for this release already succeeded.",
    };
  }
  if (npmStatus === 200) {
    return { dispatch: false, reason: "npm already serves this CLI version." };
  }
  if (npmStatus !== 404) {
    throw new Error(
      `npm did not answer for the CLI version (status ${String(npmStatus)}).`,
    );
  }
  return {
    dispatch: true,
    reason:
      "The release's own publication refused before its pull request merged, and npm lacks the version.",
  };
};

/**
 * The final release tag whose publication just completed: the newest stable
 * tag whose Release Artifacts push run completed before that publication
 * started.
 *
 * @param {readonly (WorkflowRun & { head_branch: string | null })[]} releaseRuns
 * @param {string} publicationCreatedAt
 * @returns {string | null}
 */
export const tagForPublication = (releaseRuns, publicationCreatedAt) => {
  const started = Date.parse(publicationCreatedAt);
  const candidates = releaseRuns
    .filter(
      ({ head_branch, event, status, updated_at }) =>
        typeof head_branch === "string" &&
        STABLE_TAG.test(head_branch) &&
        event === "push" &&
        status === "completed" &&
        Date.parse(updated_at) <= started,
    )
    .toSorted((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return candidates.at(0)?.head_branch ?? null;
};

/**
 * The final release tag of a completed publication, read from the release
 * runs the API lists.
 *
 * @param {{ github: any, context: { repo: { owner: string, repo: string } }, createdAt: string }} options
 * @returns {Promise<string | null>}
 */
export const resolvePublicationTag = async ({ github, context, createdAt }) => {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: "release.yml",
    event: "push",
    status: "completed",
    per_page: 30,
  });
  return tagForPublication(data.workflow_runs, createdAt);
};

/**
 * Reads the state `decideCatchUp` needs from the GitHub API and npm.
 *
 * @param {{
 *   github: any,
 *   context: { repo: { owner: string, repo: string } },
 *   tag: string,
 *   fetchStatus: (url: string) => Promise<number>,
 * }} options
 * @returns {Promise<CatchUpState & { version: string }>}
 */
export const collectCatchUpState = async ({
  github,
  context,
  tag,
  fetchStatus,
}) => {
  const repo = context.repo;
  const { data: pulls } = await github.rest.pulls.list({
    ...repo,
    state: "closed",
    base: "main",
    head: `${repo.owner}:release/${tag}`,
    per_page: 10,
  });
  const releasePullMerged = pulls.some(
    (/** @type {{ merged_at: string | null }} */ pull) =>
      typeof pull.merged_at === "string",
  );

  const { data: releaseData } = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: "release.yml",
    branch: tag,
    event: "push",
    per_page: 10,
  });
  /** @type {WorkflowRun[]} */
  const releaseRuns = releaseData.workflow_runs;
  const releaseRun =
    releaseRuns.toSorted(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    )[0] ?? null;

  /** @type {(WorkflowRun & { refusedAtSource: boolean })[]} */
  const publications = [];
  if (releaseRun !== null && releaseRun.status === "completed") {
    const finished = Date.parse(releaseRun.updated_at);
    const { data: publishData } = await github.rest.actions.listWorkflowRuns({
      ...repo,
      workflow_id: "publish-npm.yml",
      created: `>=${new Date(finished - 60_000).toISOString()}`,
      per_page: 50,
    });
    for (const run of /** @type {WorkflowRun[]} */ (
      publishData.workflow_runs
    )) {
      if (!RELEASE_PUBLICATION_EVENTS.has(run.event)) {
        continue;
      }
      let refusedAtSource = false;
      if (run.event === "workflow_run" && run.status === "completed") {
        const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun(
          {
            ...repo,
            run_id: run.id,
            per_page: 100,
          },
        );
        refusedAtSource = jobs.jobs.some(
          (/** @type {WorkflowJob} */ job) =>
            job.name === SOURCE_JOB && job.conclusion === "failure",
        );
      }
      publications.push({ ...run, refusedAtSource });
    }
    // The earliest publication after the release run is the release's own.
    publications.sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    );
  }

  const { data: manifest } = await github.rest.repos.getContent({
    ...repo,
    path: "packages/cli/package.json",
    ref: `refs/tags/${tag}`,
  });
  const { version } = JSON.parse(
    Buffer.from(manifest.content, manifest.encoding).toString("utf8"),
  );
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`${tag} carries no stable CLI version.`);
  }
  const npmStatus = await fetchStatus(
    `https://registry.npmjs.org/@stll%2fcli/${version}`,
  );
  return { releasePullMerged, releaseRun, publications, npmStatus, version };
};
