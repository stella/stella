// Refresh pull requests whose only CI failures were fixed on main.
//
// While main is red, every pull request whose CI runs fails the same checks.
// A re-run tests the same merge commit (the old main), so the pull request
// stays red after main is fixed until its branch is updated. This script
// finds those pull requests conservatively:
//
// - a red window of a full-depth main workflow opens at its first failed run,
//   collects the failed (job family, step) pairs of every failed run inside it
//   and closes at the next run whose suites passed;
// - a pull request is selected only when its latest CI run started inside a
//   closed window and every check that run failed also failed on main then.
//
// Unknown or truncated evidence selects nothing.
//
//   bun scripts/refresh-after-main-fix.ts select --out <file> [--summary <file>]
//     Collects the evidence (network access through scripts/gh-retry.sh with
//     GITHUB_REPOSITORY) and writes the paced pull requests as
//     `[{ "number": 1, "headSha": "..." }]`.

import { panic, Result } from "better-result";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { GhCommandError, ghRetry, type Gh } from "./flaky-test-history";

export const MAIN_WORKFLOWS = ["main-pr-depth.yml", "main-heavy.yml"] as const;
export type MainWorkflow = (typeof MAIN_WORKFLOWS)[number];
// Dispatched runs pin release candidates, which need not be main's state.
export const MAIN_EVENTS: readonly string[] = ["push", "schedule"];
export const AGGREGATE_JOB = "ci-result";
export const HOLD_LABEL = "hold";
export const DEFAULT_LIMIT = 3;
export const HORIZON_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;
const DIGEST_ARTIFACT = "ci-failures";
// Uploaded by the result gate whenever it evaluated the suites, so a
// successful run with it really ran them.
const VERDICT_ARTIFACT = "ci-required-summary";
const RED_CONCLUSIONS: readonly string[] = [
  "failure",
  "timed_out",
  "startup_failure",
];
// No verdict about main: a cancelled or skipped run, or one still running.
const NEUTRAL_CONCLUSIONS: readonly (string | null)[] = [
  null,
  "cancelled",
  "skipped",
  "neutral",
];

export type CheckPair = { readonly job: string; readonly step: string };

export type MainRun = {
  readonly id: number;
  readonly workflow: MainWorkflow;
  readonly event: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly headSha: string;
  // Whether the result gate evaluated the suites (a success that skipped
  // them proves nothing about main).
  readonly suitesEvaluated: boolean;
  // From the run's failure digest; null when it is missing or unreadable.
  readonly failedPairs: readonly CheckPair[] | null;
};

export type RedWindow = {
  readonly workflow: MainWorkflow;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly closingRunId: number;
  // Normalised pair keys, see pairKey.
  readonly pairs: ReadonlySet<string>;
};

export type PullRequestRun = {
  readonly id: number;
  readonly event: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly headSha: string;
};

export type PullRequestEvidence = {
  readonly number: number;
  readonly state: string;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly baseRepository: string;
  readonly headRepository: string | null;
  readonly headSha: string;
  readonly labels: readonly string[];
  readonly inMergeQueue: boolean;
  // The latest CI Checks run of the head; null when unknown.
  readonly latestRun: PullRequestRun | null;
  // From that run's failure digest; null when missing or unreadable.
  readonly failedPairs: readonly CheckPair[] | null;
  // When the head commit merges a commit of main: that merge's commit date.
  readonly headMainMergeAt: string | null;
};

export type Selected = {
  readonly number: number;
  readonly headSha: string;
  readonly runId: number;
  readonly window: RedWindow;
};

// --- Pure selection ---------------------------------------------------------

const timeOf = (value: string): number | undefined => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
};

/**
 * The job family: no reusable-workflow prefix and no shard suffix, so
 * `suites / ci-tests (api-2)` and `ci-tests (api-1)` are one family.
 */
export const jobFamily = (job: string): string =>
  job.replace(/^suites \/ /u, "").replace(/ \([^()]*\)$/u, "");

/** One comparable key per (job family, step); steps compare exactly. */
export const pairKey = ({ job, step }: CheckPair): string =>
  JSON.stringify([jobFamily(job), step]);

/** Keys of the failed checks, without the aggregate result job. */
const failedKeys = (pairs: readonly CheckPair[]): string[] =>
  pairs
    .filter(({ job }) => jobFamily(job) !== AGGREGATE_JOB)
    .map((pair) => pairKey(pair));

type Verdict = "red" | "green" | "neutral" | "unknown";

export const runVerdict = (run: MainRun): Verdict => {
  if (RED_CONCLUSIONS.includes(run.conclusion ?? "")) {
    return "red";
  }
  if (run.conclusion === "success") {
    return run.suitesEvaluated ? "green" : "neutral";
  }
  return NEUTRAL_CONCLUSIONS.includes(run.conclusion) ? "neutral" : "unknown";
};

const byCreation = (
  left: { createdAt: string; id: number },
  right: { createdAt: string; id: number },
): number =>
  (timeOf(left.createdAt) ?? 0) - (timeOf(right.createdAt) ?? 0) ||
  left.id - right.id;

/**
 * Closed red windows of the main workflows, oldest first. A window that
 * started before the first green run in the evidence, or that holds a failed
 * run without readable failed checks, is incomplete and left out.
 */
export const redWindows = (mainRuns: readonly MainRun[]): RedWindow[] => {
  const windows: RedWindow[] = [];
  for (const workflow of MAIN_WORKFLOWS) {
    const runs = mainRuns.filter(
      (run) => run.workflow === workflow && MAIN_EVENTS.includes(run.event),
    );
    if (
      runs.some(
        (run) =>
          timeOf(run.createdAt) === undefined ||
          timeOf(run.updatedAt) === undefined,
      )
    ) {
      continue;
    }
    let baseline = false;
    let open:
      | { openedAt: string; pairs: Set<string>; complete: boolean }
      | undefined;
    for (const run of runs.toSorted(byCreation)) {
      const verdict = runVerdict(run);
      if (verdict === "neutral") {
        continue;
      }
      if (verdict === "green") {
        if (open?.complete === true) {
          windows.push({
            workflow,
            openedAt: open.openedAt,
            closedAt: run.createdAt,
            closingRunId: run.id,
            pairs: open.pairs,
          });
        }
        open = undefined;
        baseline = true;
        continue;
      }
      open ??= {
        openedAt: run.createdAt,
        pairs: new Set(),
        complete: baseline,
      };
      const keys =
        verdict === "red" && run.failedPairs !== null
          ? failedKeys(run.failedPairs)
          : [];
      if (keys.length === 0) {
        open.complete = false;
      }
      for (const key of keys) {
        open.pairs.add(key);
      }
    }
  }
  return windows.toSorted(
    (left, right) =>
      (timeOf(left.openedAt) ?? 0) - (timeOf(right.openedAt) ?? 0) ||
      left.closingRunId - right.closingRunId,
  );
};

/**
 * Whether main is red now: a main workflow's latest run with a verdict is not
 * green. A refresh then would only re-test onto a failing main.
 */
export const mainIsRed = (mainRuns: readonly MainRun[]): boolean =>
  MAIN_WORKFLOWS.some((workflow) => {
    const latest = mainRuns
      .filter(
        (run) =>
          run.workflow === workflow &&
          MAIN_EVENTS.includes(run.event) &&
          runVerdict(run) !== "neutral",
      )
      .toSorted(byCreation)
      .at(-1);
    return latest !== undefined && runVerdict(latest) !== "green";
  });

/** Closed windows, oldest first, that contain the given time. */
export const windowsContaining = (
  windows: readonly RedWindow[],
  createdAt: string,
): RedWindow[] => {
  const time = timeOf(createdAt);
  return time === undefined
    ? []
    : windows.filter((window) => {
        const opened = timeOf(window.openedAt);
        const closed = timeOf(window.closedAt);
        return (
          opened !== undefined &&
          closed !== undefined &&
          opened <= time &&
          time <= closed
        );
      });
};

/** Why a pull request's own state rules out a refresh, if it does. */
export const pullRequestStateBlocker = (
  pull: Pick<
    PullRequestEvidence,
    | "state"
    | "draft"
    | "baseRef"
    | "baseRepository"
    | "headRepository"
    | "labels"
    | "inMergeQueue"
  >,
): string | undefined => {
  if (pull.state !== "open") {
    return "not open";
  }
  if (pull.draft) {
    return "draft";
  }
  if (pull.baseRef !== "main") {
    return "base is not main";
  }
  if (pull.inMergeQueue) {
    return "in the merge queue";
  }
  if (pull.labels.includes(HOLD_LABEL)) {
    return "held";
  }
  if (pull.headRepository !== pull.baseRepository) {
    return "head is in another repository";
  }
  return undefined;
};

/**
 * Pull requests whose latest CI run failed only checks that main failed in
 * the window that run started in, after that window closed.
 */
export const selectRefreshes = ({
  windows,
  pullRequests,
  now,
}: {
  readonly windows: readonly RedWindow[];
  readonly pullRequests: readonly PullRequestEvidence[];
  readonly now: Date;
}): Selected[] => {
  const current = now.getTime();
  if (!Number.isFinite(current)) {
    return [];
  }
  const closed = windows.filter(
    (window) => (timeOf(window.closedAt) ?? Infinity) <= current,
  );
  return pullRequests.flatMap((pull): Selected[] => {
    const run = pull.latestRun;
    if (
      pullRequestStateBlocker(pull) !== undefined ||
      run === null ||
      run.event !== "pull_request" ||
      run.conclusion !== "failure" ||
      run.headSha !== pull.headSha ||
      (timeOf(run.createdAt) ?? Infinity) > current ||
      pull.failedPairs === null
    ) {
      return [];
    }
    const keys = failedKeys(pull.failedPairs);
    if (keys.length === 0) {
      return [];
    }
    const freshAt =
      pull.headMainMergeAt === null ? undefined : timeOf(pull.headMainMergeAt);
    if (pull.headMainMergeAt !== null && freshAt === undefined) {
      return [];
    }
    const window = windowsContaining(closed, run.createdAt).find(
      (candidate) =>
        keys.every((key) => candidate.pairs.has(key)) &&
        (freshAt === undefined ||
          freshAt < (timeOf(candidate.closedAt) ?? -Infinity)),
    );
    return window === undefined
      ? []
      : [{ number: pull.number, headSha: pull.headSha, runId: run.id, window }];
  });
};

/**
 * At most `limit` runs in flight: none while a merge group waits, oldest
 * window first, then lowest pull request number.
 */
export const paceRefreshes = ({
  selected,
  inFlightPullRequestRuns,
  queuedMergeGroups,
  limit = DEFAULT_LIMIT,
}: {
  readonly selected: readonly Selected[];
  readonly inFlightPullRequestRuns: number;
  readonly queuedMergeGroups: number;
  readonly limit?: number;
}): Selected[] => {
  if (
    !Number.isSafeInteger(inFlightPullRequestRuns) ||
    !Number.isSafeInteger(queuedMergeGroups) ||
    !Number.isSafeInteger(limit) ||
    inFlightPullRequestRuns < 0 ||
    queuedMergeGroups !== 0
  ) {
    return [];
  }
  const room = Math.max(0, limit - inFlightPullRequestRuns);
  return selected
    .toSorted(
      (left, right) =>
        (timeOf(left.window.openedAt) ?? 0) -
          (timeOf(right.window.openedAt) ?? 0) || left.number - right.number,
    )
    .slice(0, room);
};

// --- Collection -------------------------------------------------------------

const isoString = v.pipe(
  v.string(),
  v.check((value) => timeOf(value) !== undefined, "Expected a timestamp"),
);

const runPagesSchema = v.array(
  v.object({
    total_count: v.number(),
    workflow_runs: v.array(
      v.object({
        id: v.number(),
        event: v.string(),
        conclusion: v.nullable(v.string()),
        created_at: isoString,
        updated_at: isoString,
        head_sha: v.string(),
      }),
    ),
  }),
);

const countSchema = v.object({ total_count: v.number() });

const artifactListSchema = v.object({
  total_count: v.number(),
  artifacts: v.array(v.object({ name: v.string(), expired: v.boolean() })),
});

// The digest scripts/ci-failure-digest.ts writes.
const digestFileSchema = v.object({
  version: v.literal(1),
  failures: v.array(v.object({ job: v.string(), step: v.string() })),
});

const pullSchema = v.object({
  number: v.number(),
  state: v.string(),
  draft: v.boolean(),
  labels: v.array(v.object({ name: v.string() })),
  head: v.object({
    sha: v.string(),
    repo: v.nullable(v.object({ full_name: v.string() })),
  }),
  base: v.object({
    ref: v.string(),
    repo: v.object({ full_name: v.string() }),
  }),
});
const pullPagesSchema = v.array(v.array(pullSchema));

const pullState = (
  pull: v.InferOutput<typeof pullSchema>,
  queued: ReadonlySet<number>,
) => ({
  state: pull.state,
  draft: pull.draft,
  baseRef: pull.base.ref,
  baseRepository: pull.base.repo.full_name,
  headRepository: pull.head.repo?.full_name ?? null,
  labels: pull.labels.map(({ name }) => name),
  inMergeQueue: queued.has(pull.number),
});

const mergeQueueSchema = v.object({
  data: v.object({
    repository: v.object({
      mergeQueue: v.nullable(
        v.object({
          entries: v.object({
            totalCount: v.number(),
            nodes: v.array(
              v.object({
                pullRequest: v.nullable(v.object({ number: v.number() })),
              }),
            ),
          }),
        }),
      ),
    }),
  }),
});

const commitSchema = v.object({
  parents: v.array(v.object({ sha: v.string() })),
  commit: v.object({ committer: v.object({ date: isoString }) }),
});

const compareSchema = v.object({ status: v.string() });

const parsed = <T>(
  schema: v.GenericSchema<unknown, T>,
  text: string,
  what: string,
): Result<T, GhCommandError> => {
  const result = Result.try((): unknown => JSON.parse(text));
  if (result.isErr()) {
    return Result.err(new GhCommandError({ message: `${what}: invalid JSON` }));
  }
  const output = v.safeParse(schema, result.value);
  return output.success
    ? Result.ok(output.output)
    : Result.err(
        new GhCommandError({ message: `${what}: unexpected response shape` }),
      );
};

const getJson = async <T>(
  gh: Gh,
  schema: v.GenericSchema<unknown, T>,
  endpoint: string,
  paginate = false,
): Promise<Result<T, GhCommandError>> => {
  const response = await gh(
    paginate
      ? ["api", "--paginate", "--slurp", endpoint]
      : ["api", "--method", "GET", endpoint],
  );
  return response.isErr() ? response : parsed(schema, response.value, endpoint);
};

const utcDays = (now: Date): string[] => {
  const days: string[] = [];
  const first = new Date(now.getTime() - HORIZON_HOURS * HOUR_MS);
  first.setUTCHours(0, 0, 0, 0);
  for (let day = first.getTime(); day <= now.getTime(); day += 24 * HOUR_MS) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return days;
};

type CollectOptions = {
  readonly gh: Gh;
  readonly repository: string;
  readonly now: Date;
  readonly workdir: string;
};

/** Failed checks from a run's digest, or null when it is unreadable. */
const downloadDigest = async (
  { gh, repository, workdir }: CollectOptions,
  runId: number,
): Promise<Result<CheckPair[] | null, GhCommandError>> => {
  const dir = path.join(workdir, `${runId}-${DIGEST_ARTIFACT}`);
  const fetched = await gh([
    "run",
    "download",
    String(runId),
    "--repo",
    repository,
    "--name",
    DIGEST_ARTIFACT,
    "--dir",
    dir,
  ]);
  if (fetched.isErr()) {
    return Result.ok(null);
  }
  const file = path.join(dir, "ci-failures.json");
  if (!existsSync(file)) {
    return Result.ok(null);
  }
  const digest = parsed(digestFileSchema, readFileSync(file, "utf-8"), file);
  return Result.ok(
    digest.isOk()
      ? digest.value.failures.map(({ job, step }) => ({ job, step }))
      : null,
  );
};

const runArtifacts = async (
  options: CollectOptions,
  runId: number,
): Promise<Result<ReadonlySet<string>, GhCommandError>> => {
  const listed = await getJson(
    options.gh,
    artifactListSchema,
    `repos/${options.repository}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  if (listed.isErr()) {
    return listed;
  }
  if (listed.value.total_count !== listed.value.artifacts.length) {
    return Result.err(
      new GhCommandError({ message: `run ${runId}: artifact list truncated` }),
    );
  }
  return Result.ok(
    new Set(
      listed.value.artifacts
        .filter(({ expired }) => !expired)
        .map(({ name }) => name),
    ),
  );
};

/** Runs of both main workflows in the horizon, listed per UTC day. */
export const collectMainRuns = async (
  options: CollectOptions,
): Promise<Result<MainRun[], GhCommandError>> => {
  const { gh, repository, now } = options;
  const since = now.getTime() - HORIZON_HOURS * HOUR_MS;
  const runs: MainRun[] = [];
  for (const workflow of MAIN_WORKFLOWS) {
    const listed: v.InferOutput<
      typeof runPagesSchema
    >[number]["workflow_runs"] = [];
    for (const day of utcDays(now)) {
      const pages = await getJson(
        gh,
        runPagesSchema,
        `repos/${repository}/actions/workflows/${workflow}/runs?branch=main&created=${day}&per_page=100`,
        true,
      );
      if (pages.isErr()) {
        return pages;
      }
      const dayRuns = pages.value.flatMap((page) => page.workflow_runs);
      if (dayRuns.length !== (pages.value[0]?.total_count ?? 0)) {
        return Result.err(
          new GhCommandError({
            message: `${workflow} runs of ${day}: listed ${dayRuns.length} of ${pages.value[0]?.total_count ?? 0}`,
          }),
        );
      }
      listed.push(...dayRuns);
    }
    const inHorizon = listed
      .filter(
        (run) =>
          MAIN_EVENTS.includes(run.event) &&
          (timeOf(run.created_at) ?? 0) >= since,
      )
      .map((run): MainRun => ({
        id: run.id,
        workflow,
        event: run.event,
        conclusion: run.conclusion,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        headSha: run.head_sha,
        suitesEvaluated: false,
        failedPairs: null,
      }))
      .toSorted(byCreation);
    // Artifacts matter for failed runs, every success after the first one,
    // and the last success before it that evaluated the suites (the baseline).
    const firstRed = inHorizon.findIndex((run) => runVerdict(run) === "red");
    if (firstRed === -1) {
      runs.push(...inHorizon);
      continue;
    }
    const resolve = async (
      run: MainRun,
    ): Promise<Result<MainRun, GhCommandError>> => {
      const red = runVerdict(run) === "red";
      if (!red && run.conclusion !== "success") {
        return Result.ok(run);
      }
      const names = await runArtifacts(options, run.id);
      if (names.isErr()) {
        return names;
      }
      if (!red) {
        return Result.ok({
          ...run,
          suitesEvaluated: names.value.has(VERDICT_ARTIFACT),
        });
      }
      if (!names.value.has(DIGEST_ARTIFACT)) {
        return Result.ok(run);
      }
      const pairs = await downloadDigest(options, run.id);
      return pairs.isErr()
        ? pairs
        : Result.ok({ ...run, failedPairs: pairs.value });
    };
    const resolved = [...inHorizon];
    for (let index = firstRed - 1; index >= 0; index -= 1) {
      const run = resolved[index];
      if (run?.conclusion !== "success") {
        continue;
      }
      const result = await resolve(run);
      if (result.isErr()) {
        return result;
      }
      resolved[index] = result.value;
      if (result.value.suitesEvaluated) {
        break;
      }
    }
    for (let index = firstRed; index < resolved.length; index += 1) {
      const run = resolved[index];
      if (run === undefined) {
        continue;
      }
      const result = await resolve(run);
      if (result.isErr()) {
        return result;
      }
      resolved[index] = result.value;
    }
    runs.push(...resolved);
  }
  return Result.ok(runs);
};

const mergeQueueNumbers = async ({
  gh,
  repository,
}: Pick<CollectOptions, "gh" | "repository">): Promise<
  Result<ReadonlySet<number>, GhCommandError>
> => {
  const [owner = "", name = ""] = repository.split("/");
  const response = await gh([
    "api",
    "graphql",
    "-f",
    'query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: "main") { entries(first: 100) { totalCount nodes { pullRequest { number } } } } } }',
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ]);
  if (response.isErr()) {
    return response;
  }
  const queue = parsed(mergeQueueSchema, response.value, "merge queue");
  if (queue.isErr()) {
    return queue;
  }
  const entries = queue.value.data.repository.mergeQueue?.entries;
  if (entries !== undefined && entries.totalCount !== entries.nodes.length) {
    return Result.err(
      new GhCommandError({ message: "merge queue entries truncated" }),
    );
  }
  return Result.ok(
    new Set(
      (entries?.nodes ?? []).flatMap(({ pullRequest }) =>
        pullRequest === null ? [] : [pullRequest.number],
      ),
    ),
  );
};

/** The head commit's date when it merges a commit of main, else null. */
const headMainMergeAt = async (
  { gh, repository }: CollectOptions,
  headSha: string,
): Promise<Result<string | null, GhCommandError>> => {
  const commit = await getJson(
    gh,
    commitSchema,
    `repos/${repository}/commits/${headSha}`,
  );
  if (commit.isErr()) {
    return commit;
  }
  if (commit.value.parents.length < 2) {
    return Result.ok(null);
  }
  for (const parent of commit.value.parents) {
    const compared = await getJson(
      gh,
      compareSchema,
      `repos/${repository}/compare/${parent.sha}...main?per_page=1`,
    );
    if (compared.isErr()) {
      return compared;
    }
    if (["ahead", "identical"].includes(compared.value.status)) {
      return Result.ok(commit.value.commit.committer.date);
    }
  }
  return Result.ok(null);
};

/** Open pull requests with the evidence selection needs. */
export const collectPullRequests = async (
  options: CollectOptions,
  windows: readonly RedWindow[],
): Promise<Result<PullRequestEvidence[], GhCommandError>> => {
  const { gh, repository } = options;
  const queued = await mergeQueueNumbers(options);
  if (queued.isErr()) {
    return queued;
  }
  const pages = await getJson(
    gh,
    pullPagesSchema,
    `repos/${repository}/pulls?state=open&base=main&per_page=100`,
    true,
  );
  if (pages.isErr()) {
    return pages;
  }
  const evidence: PullRequestEvidence[] = [];
  for (const pull of pages.value.flat()) {
    const base: PullRequestEvidence = {
      number: pull.number,
      ...pullState(pull, queued.value),
      headSha: pull.head.sha,
      latestRun: null,
      failedPairs: null,
      headMainMergeAt: null,
    };
    if (pullRequestStateBlocker(base) !== undefined) {
      evidence.push(base);
      continue;
    }
    const runs = await getJson(
      gh,
      runPagesSchema,
      `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`,
      true,
    );
    if (runs.isErr()) {
      return runs;
    }
    const listed = runs.value.flatMap((page) => page.workflow_runs);
    if (listed.length !== (runs.value[0]?.total_count ?? 0)) {
      evidence.push(base);
      continue;
    }
    const latest = listed
      .map((run): PullRequestRun => ({
        id: run.id,
        event: run.event,
        conclusion: run.conclusion,
        createdAt: run.created_at,
        headSha: run.head_sha,
      }))
      .toSorted(byCreation)
      .at(-1);
    if (
      latest === undefined ||
      latest.conclusion !== "failure" ||
      windowsContaining(windows, latest.createdAt).length === 0
    ) {
      evidence.push({ ...base, latestRun: latest ?? null });
      continue;
    }
    const pairs = await downloadDigest(options, latest.id);
    if (pairs.isErr()) {
      return pairs;
    }
    const merged = await headMainMergeAt(options, pull.head.sha);
    if (merged.isErr()) {
      return merged;
    }
    evidence.push({
      ...base,
      latestRun: latest,
      failedPairs: pairs.value,
      headMainMergeAt: merged.value,
    });
  }
  return Result.ok(evidence);
};

/**
 * Why a selected pull request may no longer be refreshed, read right before
 * its update: the expected head guards only its commits, while a hold label
 * or a merge queue entry can arrive without one.
 */
export const recheckRefresh = async (
  options: Pick<CollectOptions, "gh" | "repository">,
  { number, headSha }: Pick<Selected, "number" | "headSha">,
): Promise<Result<string | undefined, GhCommandError>> => {
  const pull = await getJson(
    options.gh,
    pullSchema,
    `repos/${options.repository}/pulls/${number}`,
  );
  if (pull.isErr()) {
    return pull;
  }
  if (pull.value.head.sha !== headSha) {
    return Result.ok("head moved");
  }
  // Last, so the queue is read as close to the update as possible.
  const queued = await mergeQueueNumbers(options);
  if (queued.isErr()) {
    return queued;
  }
  return Result.ok(
    pullRequestStateBlocker(pullState(pull.value, queued.value)),
  );
};

const runCount = async (
  { gh, repository }: CollectOptions,
  query: string,
): Promise<Result<number, GhCommandError>> => {
  const counted = await getJson(
    gh,
    countSchema,
    `repos/${repository}/actions/workflows/ci.yml/runs?${query}&per_page=1`,
  );
  return counted.isErr() ? counted : Result.ok(counted.value.total_count);
};

export type Plan = {
  readonly windows: readonly RedWindow[];
  readonly selected: readonly Selected[];
  readonly paced: readonly Selected[];
  readonly inFlightPullRequestRuns: number;
  readonly queuedMergeGroups: number;
};

export const plan = async (
  options: CollectOptions,
): Promise<Result<Plan, GhCommandError>> => {
  const mainRuns = await collectMainRuns(options);
  if (mainRuns.isErr()) {
    return mainRuns;
  }
  const windows = redWindows(mainRuns.value);
  if (windows.length === 0 || mainIsRed(mainRuns.value)) {
    return Result.ok({
      windows,
      selected: [],
      paced: [],
      inFlightPullRequestRuns: 0,
      queuedMergeGroups: 0,
    });
  }
  const pullRequests = await collectPullRequests(options, windows);
  if (pullRequests.isErr()) {
    return pullRequests;
  }
  const selected = selectRefreshes({
    windows,
    pullRequests: pullRequests.value,
    now: options.now,
  });
  const counts: number[] = [];
  for (const query of [
    "event=pull_request&status=in_progress",
    "event=pull_request&status=queued",
    "event=merge_group&status=queued",
  ]) {
    const count = await runCount(options, query);
    if (count.isErr()) {
      return count;
    }
    counts.push(count.value);
  }
  const [inProgress = 0, queuedPull = 0, queuedMergeGroups = 0] = counts;
  const inFlightPullRequestRuns = inProgress + queuedPull;
  return Result.ok({
    windows,
    selected,
    paced: paceRefreshes({
      selected,
      inFlightPullRequestRuns,
      queuedMergeGroups,
    }),
    inFlightPullRequestRuns,
    queuedMergeGroups,
  });
};

export const planSummary = (result: Plan): string => {
  const lines = [
    "### Refresh after main fix",
    "",
    `Closed red windows on main in the last ${HORIZON_HOURS} hours: ${result.windows.length}.`,
    ...result.windows.map(
      (window) =>
        `- ${window.workflow}: ${window.openedAt} to ${window.closedAt} (${window.pairs.size} failed checks)`,
    ),
    "",
    `Pull requests whose only failures were fixed on main: ${result.selected.length}.`,
    `In-flight pull request runs: ${result.inFlightPullRequestRuns}; queued merge groups: ${result.queuedMergeGroups}.`,
    `Refreshing now: ${result.paced.map(({ number }) => `#${number}`).join(", ") || "none"}.`,
    "",
  ];
  return lines.join("\n");
};

const option = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args.at(index + 1);
};

const runSelect = async (args: readonly string[]): Promise<void> => {
  const out =
    option(args, "--out") ??
    panic(
      "Usage: refresh-after-main-fix.ts select --out <file> [--summary <file>]",
    );
  const repository =
    process.env["GITHUB_REPOSITORY"] ?? panic("GITHUB_REPOSITORY is required");
  const result = await plan({
    gh: ghRetry,
    repository,
    now: new Date(),
    workdir: mkdtempSync(path.join(tmpdir(), "refresh-after-main-fix-")),
  });
  if (result.isErr()) {
    console.error(
      `Evidence is incomplete, so no pull request is refreshed: ${result.error.message}`,
    );
    process.exitCode = 1;
    return;
  }
  writeFileSync(
    out,
    `${JSON.stringify(
      result.value.paced.map(({ number, headSha }) => ({ number, headSha })),
    )}\n`,
  );
  const summary = option(args, "--summary");
  if (summary !== undefined) {
    appendFileSync(summary, planSummary(result.value));
  }
};

// Prints `eligible` or why the pull request is skipped; exits non-zero only
// when its state cannot be read.
const runRecheck = async (args: readonly string[]): Promise<void> => {
  const usage =
    "Usage: refresh-after-main-fix.ts recheck --number <n> --head <sha>";
  const number = Number(option(args, "--number") ?? panic(usage));
  const headSha = option(args, "--head") ?? panic(usage);
  const repository =
    process.env["GITHUB_REPOSITORY"] ?? panic("GITHUB_REPOSITORY is required");
  const blocker = await recheckRefresh(
    { gh: ghRetry, repository },
    { number, headSha },
  );
  if (blocker.isErr()) {
    console.error(
      `#${number} could not be rechecked: ${blocker.error.message}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(blocker.value ?? "eligible");
};

if (import.meta.main) {
  const [command = "", ...args] = process.argv.slice(2);
  if (command === "select") {
    await runSelect(args);
  } else if (command === "recheck") {
    await runRecheck(args);
  } else {
    panic(
      "Usage: bun scripts/refresh-after-main-fix.ts select --out <file> | recheck --number <n> --head <sha>",
    );
  }
}
