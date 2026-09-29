// Review gate: the verdict behind the `review-gate` check.
//
// GitHub's conversation-resolution rule is evaluated when a pull request
// enters the merge queue, not while it waits there, and automated reviewers
// post minutes after a push. A pull request armed right after its push can
// therefore be enqueued with zero threads and carry a finding a reviewer
// posts seconds later. As a required check, this verdict holds an armed pull
// request out of the queue until the configured reviewers have reported (or
// timed out) and no review thread is unresolved; re-evaluated on a merge
// group commit, it covers every pull request the group merges.
//
// This module is pure: it decides from snapshots and never calls GitHub.
// scripts/review-gate-github.ts reads GitHub, publishes, and is the CLI.
// Reviewers live in .github/review-gate.yml; nothing here knows one by name.

export const CHECK_NAME = "review-gate";
// GitHub Actions: the app that owns the check runs the trusted publisher
// writes, and the integration a ruleset pins the required check to.
export const GATE_APP_ID = 15_368;

// A named class: the gate runs install-free, so no better-result `panic`.
export class ReviewGateError extends Error {
  override readonly name = "ReviewGateError";
}

export const fail = (message: string): never => {
  throw new ReviewGateError(message);
};

// --- Config -------------------------------------------------------------------

// `shadow` publishes the check and nothing else. `enforce` also dequeues a
// queued pull request whose verdict turned to failure after it was enqueued.
export type Mode = "shadow" | "enforce";

export type ReviewerConfig = {
  name: string;
  // `head`: must report on the exact head commit (reviewers that run on every
  // push). `request`: reports once per request, on whatever commit was head
  // then, so its report does not cover later pushes.
  scope: "head" | "request";
  timeoutMinutes: number;
  done: {
    // A status or check run in one of these states/conclusions is a report;
    // any other terminal state is the reviewer erroring, not reviewing.
    commitStatus: { context: string; states: readonly string[] } | null;
    checkRun: { name: string; conclusions: readonly string[] } | null;
    reviewBy: string | null;
    reaction: { by: string; content: string } | null;
  };
  // A later comment containing this text, from someone with write access,
  // asks for a new report and restarts the wait.
  rerequestComment: string | null;
  skipAuthors: readonly string[];
};

export type ReviewGateConfig = {
  mode: Mode;
  reviewers: readonly ReviewerConfig[];
  // Skips waive the reviewer wait only, never the thread rule. They match
  // facts a pull request cannot edit: its author and its diff.
  skipAuthors: readonly string[];
  // Skip when EVERY changed file matches one of these globs.
  skipPaths: readonly string[];
};

const CONFIG_FILE = ".github/review-gate.yml";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertKnownKeys = (
  record: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void => {
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    fail(`${where}: unknown key(s) ${unknown.join(", ")}`);
  }
};

const requiredString = (
  record: Record<string, unknown>,
  key: string,
  where: string,
): string => {
  const value = record[key];
  return typeof value === "string" && value.length > 0
    ? value
    : fail(`${where}: \`${key}\` must be a non-empty string`);
};

const optionalString = (
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | null =>
  record[key] === undefined ? null : requiredString(record, key, where);

const stringList = (
  record: Record<string, unknown>,
  key: string,
  where: string,
): readonly string[] => {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    return fail(`${where}: \`${key}\` must be a list of non-empty strings`);
  }
  return value;
};

const optionalMapping = (
  record: Record<string, unknown>,
  key: string,
  known: readonly string[],
  where: string,
): Record<string, unknown> | null => {
  const value = record[key];
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return fail(`${where}: \`${key}\` must be a mapping`);
  }
  assertKnownKeys(value, known, `${where}.${key}`);
  return value;
};

const upperList = (values: readonly string[]): readonly string[] =>
  values.map((value) => value.toUpperCase());

const parseDone = (raw: unknown, where: string): ReviewerConfig["done"] => {
  if (!isRecord(raw)) {
    return fail(`${where}: must be a mapping`);
  }
  assertKnownKeys(
    raw,
    ["commit_status", "check_run", "review_by", "reaction"],
    where,
  );
  const status = optionalMapping(
    raw,
    "commit_status",
    ["context", "states"],
    where,
  );
  const check = optionalMapping(
    raw,
    "check_run",
    ["name", "conclusions"],
    where,
  );
  const reaction = optionalMapping(raw, "reaction", ["by", "content"], where);
  const done: ReviewerConfig["done"] = {
    commitStatus:
      status === null
        ? null
        : {
            context: requiredString(status, "context", where),
            states: upperList(stringList(status, "states", where)),
          },
    checkRun:
      check === null
        ? null
        : {
            name: requiredString(check, "name", where),
            conclusions: upperList(stringList(check, "conclusions", where)),
          },
    reviewBy: optionalString(raw, "review_by", where),
    reaction:
      reaction === null
        ? null
        : {
            by: requiredString(reaction, "by", where),
            content: requiredString(reaction, "content", where).toUpperCase(),
          },
  };
  if (done.commitStatus?.states.length === 0) {
    fail(`${where}: \`commit_status.states\` lists no state`);
  }
  if (done.checkRun?.conclusions.length === 0) {
    fail(`${where}: \`check_run.conclusions\` lists no conclusion`);
  }
  if (
    done.commitStatus === null &&
    done.checkRun === null &&
    done.reviewBy === null &&
    done.reaction === null
  ) {
    fail(`${where}: needs at least one signal`);
  }
  return done;
};

const parseReviewer = (raw: unknown, index: number): ReviewerConfig => {
  const where = `reviewers[${index}]`;
  if (!isRecord(raw)) {
    return fail(`${where}: must be a mapping`);
  }
  assertKnownKeys(
    raw,
    [
      "name",
      "scope",
      "timeout_minutes",
      "done",
      "rerequest_comment",
      "skip_authors",
    ],
    where,
  );
  const scope = raw["scope"];
  if (scope !== "head" && scope !== "request") {
    return fail(`${where}: \`scope\` must be head or request`);
  }
  const timeoutMinutes = raw["timeout_minutes"];
  if (
    typeof timeoutMinutes !== "number" ||
    !Number.isInteger(timeoutMinutes) ||
    timeoutMinutes <= 0
  ) {
    return fail(`${where}: \`timeout_minutes\` must be a positive integer`);
  }
  return {
    name: requiredString(raw, "name", where),
    scope,
    timeoutMinutes,
    done: parseDone(raw["done"], `${where}.done`),
    rerequestComment: optionalString(raw, "rerequest_comment", where),
    skipAuthors: stringList(raw, "skip_authors", where),
  };
};

export const parseReviewGateConfig = (raw: unknown): ReviewGateConfig => {
  if (!isRecord(raw)) {
    return fail(`${CONFIG_FILE}: must be a mapping`);
  }
  assertKnownKeys(
    raw,
    ["mode", "reviewers", "skip_authors", "skip_paths"],
    CONFIG_FILE,
  );
  const mode = raw["mode"];
  if (mode !== "shadow" && mode !== "enforce") {
    return fail(`${CONFIG_FILE}: \`mode\` must be shadow or enforce`);
  }
  const reviewers = raw["reviewers"];
  if (!Array.isArray(reviewers)) {
    return fail(`${CONFIG_FILE}: \`reviewers\` must be a list`);
  }
  const parsed = reviewers.map(parseReviewer);
  const names = parsed.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    fail(`${CONFIG_FILE}: reviewer names must be unique`);
  }
  return {
    mode,
    reviewers: parsed,
    skipAuthors: stringList(raw, "skip_authors", CONFIG_FILE),
    skipPaths: stringList(raw, "skip_paths", CONFIG_FILE),
  };
};

// --- Snapshot -----------------------------------------------------------------

// GitHub's author associations that carry write access to the repository.
const WRITE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type PullRequestSnapshot = {
  number: number;
  headSha: string;
  isDraft: boolean;
  author: string;
  // When the pull request last became ready for review.
  readyAt: string;
  // Null when the pull request changes more files than one page reads, which
  // disables the path skip rather than guessing.
  files: readonly string[] | null;
  reviews: readonly {
    author: string;
    submittedAt: string;
    commitSha: string | null;
  }[];
  reactions: readonly { user: string; content: string; createdAt: string }[];
  comments: readonly {
    author: string;
    authorAssociation: string;
    isBot: boolean;
    createdAt: string;
    body: string;
  }[];
  // Latest state per name on the head commit, as GitHub's rollup reports it.
  statuses: readonly { context: string; state: string }[];
  checkRuns: readonly {
    name: string;
    status: string;
    conclusion: string | null;
  }[];
  // `complete: false` when a page limit cut the read short: an unknown count,
  // never zero.
  threads:
    | {
        complete: true;
        unresolved: readonly { url: string; path: string | null }[];
      }
    | { complete: false };
  // When this gate first reported for this pull request on this head: the
  // start of the clock for `head`-scope reviewers. Null before that.
  headClockStartedAt: string | null;
};

// Bot logins read as `name` from GraphQL actors and `name[bot]` from REST
// users and reactions; config may use either.
const normalizeLogin = (login: string): string =>
  login.toLowerCase().replace(/\[bot\]$/u, "");

const sameLogin = (a: string, b: string): boolean =>
  normalizeLogin(a) === normalizeLogin(b);

// --- Evaluation ---------------------------------------------------------------

export type ReviewerState =
  | "done"
  | "waiting"
  | "errored"
  | "timed-out"
  | "skipped";

export type ReviewerVerdict = {
  name: string;
  state: ReviewerState;
  detail: string;
};

export type Conclusion = "pending" | "success" | "failure";

export type PullRequestVerdict = {
  number: number;
  headSha: string;
  conclusion: Conclusion;
  title: string;
  reviewers: readonly ReviewerVerdict[];
  threads: PullRequestSnapshot["threads"];
  skipReason: string | null;
};

const minutesToMs = (minutes: number): number => minutes * 60_000;

const laterOf = (a: string, b: string): string =>
  Date.parse(a) >= Date.parse(b) ? a : b;

export const formatPragueTime = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));

const skipReasonFor = (
  authors: readonly string[],
  paths: readonly string[],
  pullRequest: PullRequestSnapshot,
): string | null => {
  if (authors.some((author) => sameLogin(author, pullRequest.author))) {
    return `author ${pullRequest.author}`;
  }
  const { files } = pullRequest;
  if (
    paths.length > 0 &&
    files !== null &&
    files.length > 0 &&
    files.every((file) =>
      paths.some((pattern) => new Bun.Glob(pattern).match(file)),
    )
  ) {
    return "only skipped paths changed";
  }
  return null;
};

/** When the current wait for this reviewer began. */
export const reviewerClockStart = (
  reviewer: ReviewerConfig,
  pullRequest: PullRequestSnapshot,
  now: string,
): string => {
  if (reviewer.scope === "head") {
    return laterOf(pullRequest.readyAt, pullRequest.headClockStartedAt ?? now);
  }
  let latest = pullRequest.readyAt;
  const { rerequestComment } = reviewer;
  if (rerequestComment === null) {
    return latest;
  }
  for (const comment of pullRequest.comments) {
    if (
      !comment.isBot &&
      WRITE_ASSOCIATIONS.has(comment.authorAssociation) &&
      comment.body.includes(rerequestComment)
    ) {
      latest = laterOf(latest, comment.createdAt);
    }
  }
  return latest;
};

type Signal = { kind: "done" | "errored"; detail: string };

const TERMINAL_STATUS_STATES = new Set(["SUCCESS", "FAILURE", "ERROR"]);

const findSignal = (
  reviewer: ReviewerConfig,
  pullRequest: PullRequestSnapshot,
  clockStart: string,
): Signal | null => {
  const { done } = reviewer;
  const since = Date.parse(clockStart);
  const shortHead = pullRequest.headSha.slice(0, 10);
  const coverage =
    reviewer.scope === "request"
      ? " (request scope: does not cover later pushes)"
      : "";

  if (done.reviewBy !== null) {
    const { reviewBy } = done;
    const review = pullRequest.reviews.find(
      (candidate) =>
        sameLogin(candidate.author, reviewBy) &&
        (reviewer.scope === "head"
          ? candidate.commitSha === pullRequest.headSha
          : Date.parse(candidate.submittedAt) >= since),
    );
    if (review !== undefined) {
      return {
        kind: "done",
        detail: `reviewed ${review.commitSha?.slice(0, 10) ?? "the pull request"}${coverage}`,
      };
    }
  }
  if (done.reaction !== null) {
    const { by, content } = done.reaction;
    const found = pullRequest.reactions.find(
      (candidate) =>
        sameLogin(candidate.user, by) &&
        candidate.content.toUpperCase() === content &&
        Date.parse(candidate.createdAt) >= since,
    );
    if (found !== undefined) {
      return { kind: "done", detail: `reacted ${content}${coverage}` };
    }
  }
  // Statuses and check runs are read from the head commit, so they are
  // per-commit signals whatever the scope.
  if (done.commitStatus !== null) {
    const { context, states } = done.commitStatus;
    const status = pullRequest.statuses.find(
      (candidate) => candidate.context === context,
    );
    const state = status?.state.toUpperCase();
    if (state !== undefined && states.includes(state)) {
      return { kind: "done", detail: `${state.toLowerCase()} on ${shortHead}` };
    }
    if (state !== undefined && TERMINAL_STATUS_STATES.has(state)) {
      return {
        kind: "errored",
        detail: `reported ${state.toLowerCase()} on ${shortHead}, not a review`,
      };
    }
  }
  if (done.checkRun !== null) {
    const { name, conclusions } = done.checkRun;
    const run = pullRequest.checkRuns.find(
      (candidate) => candidate.name === name,
    );
    if (run?.status.toUpperCase() === "COMPLETED") {
      const conclusion = (run.conclusion ?? "NONE").toUpperCase();
      return conclusions.includes(conclusion)
        ? {
            kind: "done",
            detail: `${conclusion.toLowerCase()} on ${shortHead}`,
          }
        : {
            kind: "errored",
            detail: `concluded ${conclusion.toLowerCase()} on ${shortHead}, not a review`,
          };
    }
  }
  return null;
};

const evaluateReviewer = (
  reviewer: ReviewerConfig,
  pullRequest: PullRequestSnapshot,
  now: string,
): ReviewerVerdict => {
  const skipped = skipReasonFor(reviewer.skipAuthors, [], pullRequest);
  if (skipped !== null) {
    return { name: reviewer.name, state: "skipped", detail: skipped };
  }
  const clockStart = reviewerClockStart(reviewer, pullRequest, now);
  const signal = findSignal(reviewer, pullRequest, clockStart);
  if (signal?.kind === "done") {
    return { name: reviewer.name, state: "done", detail: signal.detail };
  }
  const deadline = new Date(
    Date.parse(clockStart) + minutesToMs(reviewer.timeoutMinutes),
  ).toISOString();
  if (Date.parse(now) >= Date.parse(deadline)) {
    return {
      name: reviewer.name,
      state: "timed-out",
      detail:
        signal === null
          ? `never reported; review waived after ${reviewer.timeoutMinutes} min`
          : `${signal.detail}; review waived after ${reviewer.timeoutMinutes} min`,
    };
  }
  return {
    name: reviewer.name,
    state: signal === null ? "waiting" : "errored",
    detail: `${signal === null ? "waiting" : signal.detail} (times out ${formatPragueTime(deadline)})`,
  };
};

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export const evaluatePullRequest = (
  pullRequest: PullRequestSnapshot,
  config: ReviewGateConfig,
  now: string,
): PullRequestVerdict => {
  const base = {
    number: pullRequest.number,
    headSha: pullRequest.headSha,
    threads: pullRequest.threads,
  };
  if (pullRequest.isDraft) {
    return {
      ...base,
      conclusion: "pending",
      title: "Draft",
      reviewers: [],
      skipReason: null,
    };
  }

  const skipReason = skipReasonFor(
    config.skipAuthors,
    config.skipPaths,
    pullRequest,
  );
  const reviewers =
    skipReason === null
      ? config.reviewers.map((reviewer) =>
          evaluateReviewer(reviewer, pullRequest, now),
        )
      : [];
  const verdict = (conclusion: Conclusion, title: string) => ({
    ...base,
    conclusion,
    title,
    reviewers,
    skipReason,
  });

  // No timeout or skip ever waives the thread rule, and a count the gate
  // could not finish reading is not zero.
  const { threads } = pullRequest;
  if (!threads.complete) {
    return verdict("failure", "Review threads could not all be read");
  }
  if (threads.unresolved.length > 0) {
    return verdict(
      "failure",
      plural(threads.unresolved.length, "unresolved review thread"),
    );
  }
  const blocking = reviewers.filter(
    ({ state }) => state === "waiting" || state === "errored",
  );
  if (blocking.length > 0) {
    return verdict(
      "pending",
      `Waiting for ${blocking.map(({ name }) => name).join(", ")}`,
    );
  }
  const waived = reviewers.filter(({ state }) => state === "timed-out");
  return verdict(
    "success",
    waived.length > 0
      ? `Passed with review waived: ${waived.map(({ name }) => name).join(", ")} timed out`
      : "Reviews complete, no unresolved threads",
  );
};

const REVIEWER_MARK: Record<ReviewerState, string> = {
  done: "✅",
  waiting: "⏳",
  errored: "⚠️",
  "timed-out": "⌛",
  skipped: "➖",
};

// Paths that decide how this gate behaves. A pull request that changes them
// is judged by the version on the base branch, which the summary says.
const GATE_PATHS = [
  ".github/review-gate.yml",
  ".github/workflows/**",
  "scripts/review-gate*.ts",
];

const describePullRequest = (
  verdict: PullRequestVerdict,
  files: readonly string[] | null,
): string => {
  const lines: string[] = [];
  if (verdict.skipReason !== null) {
    lines.push(`- Reviewer wait skipped: ${verdict.skipReason}`);
  }
  for (const reviewer of verdict.reviewers) {
    lines.push(
      `- ${REVIEWER_MARK[reviewer.state]} ${reviewer.name}: ${reviewer.detail}`,
    );
  }
  const { threads } = verdict;
  if (!threads.complete) {
    lines.push("- ❌ Review threads: more than the gate reads; count unknown");
  } else if (threads.unresolved.length === 0) {
    lines.push("- ✅ No unresolved review threads");
  } else {
    lines.push(
      `- ❌ ${plural(threads.unresolved.length, "unresolved review thread")}:`,
    );
    for (const thread of threads.unresolved) {
      lines.push(
        `  - ${thread.url}${thread.path === null ? "" : ` (${thread.path})`}`,
      );
    }
  }
  if (
    files?.some((file) =>
      GATE_PATHS.some((pattern) => new Bun.Glob(pattern).match(file)),
    ) === true
  ) {
    lines.push(
      "- ℹ️ Changes workflows or this gate: judged by the base branch's version; workflow edits need a human review",
    );
  }
  return lines.join("\n");
};

export type GateOutput = {
  conclusion: Conclusion;
  title: string;
  summary: string;
};

export const pullRequestOutput = (
  verdict: PullRequestVerdict,
  files: readonly string[] | null,
): GateOutput => ({
  conclusion: verdict.conclusion,
  title: verdict.title,
  summary: describePullRequest(verdict, files),
});

/** A gate that could not read GitHub blocks rather than guessing. */
export const unreadableOutput = (reason: string): GateOutput => ({
  conclusion: "pending",
  title: "Gate could not read GitHub; retrying",
  summary: `- ⚠️ ${reason}\n- The next event or the scheduled sweep retries.`,
});

const CONCLUSION_RANK: Record<Conclusion, number> = {
  success: 0,
  pending: 1,
  failure: 2,
};

/** A merge group passes only if every pull request it merges passes. */
export const groupOutput = (
  verdicts: readonly PullRequestVerdict[],
): GateOutput => {
  let conclusion: Conclusion = "success";
  for (const verdict of verdicts) {
    if (CONCLUSION_RANK[verdict.conclusion] > CONCLUSION_RANK[conclusion]) {
      conclusion = verdict.conclusion;
    }
  }
  const blocking = verdicts.filter(
    (verdict) => verdict.conclusion === conclusion,
  );
  return {
    conclusion,
    title:
      conclusion === "success"
        ? `${plural(verdicts.length, "pull request")} clear`
        : blocking
            .map((verdict) => `#${verdict.number}: ${verdict.title}`)
            .join("; "),
    summary: verdicts
      .map(
        (verdict) =>
          `### #${verdict.number}: ${verdict.title}\n\n${describePullRequest(verdict, null)}`,
      )
      .join("\n\n"),
  };
};

export const unknownMembershipOutput = (headSha: string): GateOutput => ({
  conclusion: "pending",
  title: "Merge group membership unknown",
  summary: `- ⚠️ No queue entry lists ${headSha.slice(0, 10)} with a complete prefix ahead of it; the gate cannot tell which pull requests this commit merges.\n- The next event or the scheduled sweep retries.`,
});

// --- Merge queue ----------------------------------------------------------------

export type QueueEntry = {
  position: number;
  headSha: string | null;
  pullRequest: number;
};

/**
 * The pull requests a merge group commit merges: the queue entry whose group
 * commit it is, and every entry ahead of it. Null when the queue does not
 * list the commit or the prefix ahead of it has a gap: unknown membership
 * blocks, it never shrinks to a guess.
 */
export const groupMembers = (
  entries: readonly QueueEntry[],
  headSha: string,
): readonly number[] | null => {
  const own = entries.find((entry) => entry.headSha === headSha);
  if (own === undefined) {
    return null;
  }
  const prefix = entries
    .filter((entry) => entry.position <= own.position)
    .toSorted((a, b) => a.position - b.position);
  const contiguous = prefix.every(
    (entry, index) => entry.position === index + 1,
  );
  return contiguous && prefix.length === own.position
    ? prefix.map((entry) => entry.pullRequest)
    : null;
};

/**
 * The group commits a change to one queued pull request affects: its own
 * entry's and every entry behind it, since each of those groups contains it.
 */
export const affectedGroups = (
  entries: readonly QueueEntry[],
  pullRequest: number,
): readonly string[] => {
  const own = entries.find((entry) => entry.pullRequest === pullRequest);
  if (own === undefined) {
    return [];
  }
  return entries.flatMap((entry) =>
    entry.position >= own.position && entry.headSha !== null
      ? [entry.headSha]
      : [],
  );
};

export type QueueRecheck = {
  queued: boolean;
  headSha: string;
  threads: PullRequestSnapshot["threads"];
};

/**
 * Dequeuing is the primary eviction, so it removes only a confirmed
 * offender: a fresh read taken right before the mutation must still show the
 * pull request queued, on the head the verdict judged, and still failing the
 * thread rule (the only rule that fails rather than waits).
 */
export const confirmDequeue = (
  verdict: PullRequestVerdict,
  fresh: QueueRecheck,
): boolean =>
  verdict.conclusion === "failure" &&
  fresh.queued &&
  fresh.headSha === verdict.headSha &&
  (!fresh.threads.complete || fresh.threads.unresolved.length > 0);

/** In enforce mode only, a queued pull request that now fails leaves. */
export const shouldDequeue = (
  mode: Mode,
  verdict: PullRequestVerdict,
  queued: boolean,
): boolean => mode === "enforce" && queued && verdict.conclusion === "failure";

// --- Publishing -------------------------------------------------------------------

// Each published check run carries who it speaks for and when the state it
// judged was read, in the check run's `external_id`.
export type RunIdentity =
  | { kind: "pr"; pullRequest: number; observedAt: string }
  | { kind: "group"; members: readonly number[]; observedAt: string };

const IDENTITY_VERSION = "rg1";

export const encodeIdentity = (identity: RunIdentity): string =>
  identity.kind === "pr"
    ? `${IDENTITY_VERSION};pr=${identity.pullRequest};at=${identity.observedAt}`
    : `${IDENTITY_VERSION};group=${identity.members.join(",")};at=${identity.observedAt}`;

export const decodeIdentity = (
  externalId: string | null,
): RunIdentity | null => {
  if (externalId === null) {
    return null;
  }
  // An empty member list is a group whose membership was unknown.
  const match =
    /^rg1;(?:pr=(?<pr>\d+)|group=(?<group>(?:\d+(?:,\d+)*)?));at=(?<at>[^;]+)$/u.exec(
      externalId,
    );
  const { pr, group, at } = match?.groups ?? {};
  if (at === undefined || Number.isNaN(Date.parse(at))) {
    return null;
  }
  if (pr !== undefined) {
    return { kind: "pr", pullRequest: Number(pr), observedAt: at };
  }
  if (group === undefined) {
    return null;
  }
  return {
    kind: "group",
    members: group === "" ? [] : group.split(",").map(Number),
    observedAt: at,
  };
};

export type PublishedRun = {
  // GitHub's id: it grows with creation, and the newest run of a name is
  // the one a required check reads.
  id: number;
  identity: RunIdentity | null;
  status: string;
  conclusion: string | null;
  title: string | null;
  summary: string | null;
  startedAt: string;
};

/**
 * When this gate first reported for this pull request on the commit whose
 * runs these are. Another pull request that shares the commit, or a run this
 * gate did not write, never starts the clock.
 */
export const headClockStart = (
  runs: readonly PublishedRun[],
  pullRequest: number,
): string | null => {
  let earliest: string | null = null;
  for (const run of runs) {
    const { identity } = run;
    if (identity?.kind === "pr" && identity.pullRequest === pullRequest) {
      earliest =
        earliest === null || Date.parse(run.startedAt) < Date.parse(earliest)
          ? run.startedAt
          : earliest;
    }
  }
  return earliest;
};

export const outputStatus = ({
  conclusion,
}: GateOutput):
  | { status: "in_progress"; conclusion: null }
  | { status: "completed"; conclusion: "success" | "failure" } =>
  conclusion === "pending"
    ? { status: "in_progress", conclusion: null }
    : { status: "completed", conclusion };

export type PublishDecision = "write" | "unchanged" | "stale";

/**
 * Publishers race: two events for one commit can finish in either order.
 * A verdict built from state read before the latest published one is stale
 * and never overwrites it; an identical verdict is not written twice.
 */
export const decidePublish = (
  latest: PublishedRun | undefined,
  output: GateOutput,
  observedAt: string,
): PublishDecision => {
  if (latest === undefined) {
    return "write";
  }
  if (
    latest.identity !== null &&
    Date.parse(latest.identity.observedAt) > Date.parse(observedAt)
  ) {
    return "stale";
  }
  const next = outputStatus(output);
  const same =
    latest.status === next.status &&
    latest.conclusion === next.conclusion &&
    latest.title === output.title &&
    latest.summary === output.summary;
  return same ? "unchanged" : "write";
};

/** The latest run this gate published on a commit, by start time. */
export const latestRun = (
  runs: readonly PublishedRun[],
): PublishedRun | undefined => runs.toSorted((a, b) => a.id - b.id).at(-1);

const observedTime = (run: PublishedRun): number =>
  run.identity === null
    ? Number.NEGATIVE_INFINITY
    : Date.parse(run.identity.observedAt);

/**
 * Two publishers can both read the same latest run, both decide to write,
 * and land in the reverse order of what they observed. After every write the
 * publisher re-reads, and when the newest run no longer carries the newest
 * observation, re-posts the run that does. The last writer always settles
 * last, so the latest run ends up carrying the newest observation.
 */
export const runToRepost = (
  runs: readonly PublishedRun[],
): PublishedRun | undefined => {
  const latest = latestRun(runs);
  let newest: PublishedRun | undefined;
  for (const run of runs) {
    if (newest === undefined || observedTime(run) > observedTime(newest)) {
      newest = run;
    }
  }
  if (latest === undefined || newest === undefined) {
    return undefined;
  }
  if (
    newest.identity === null ||
    observedTime(newest) <= observedTime(latest)
  ) {
    return undefined;
  }
  return newest;
};

/** The output a published run carries, to post it again unchanged. */
export const outputOf = (run: PublishedRun): GateOutput | null => {
  if (run.title === null || run.summary === null) {
    return null;
  }
  if (run.status !== "completed") {
    return { conclusion: "pending", title: run.title, summary: run.summary };
  }
  return run.conclusion === "success" || run.conclusion === "failure"
    ? { conclusion: run.conclusion, title: run.title, summary: run.summary }
    : null;
};

// --- Sweep --------------------------------------------------------------------

export type OpenPullRequest = {
  number: number;
  isDraft: boolean;
  queued: boolean;
  armed: boolean;
  // The latest `review-gate` state on the head, or null when none exists.
  gate: "success" | "failure" | "pending" | null;
};

/**
 * What one sweep re-evaluates. Queued and armed pull requests are the ones
 * about to land, so they are always included whatever their last verdict: a
 * missed event may have left a success standing. Then every pull request
 * whose gate is pending, failed or missing: timeouts to apply and failures
 * that may have been resolved. Past the budget, the rest rotates by sweep
 * so none starves.
 */
export const selectSweepTargets = (
  pullRequests: readonly OpenPullRequest[],
  budget: number,
  rotation: number,
): readonly number[] => {
  const ready = pullRequests.filter(({ isDraft }) => !isDraft);
  const landing = ready.filter(({ queued, armed }) => queued || armed);
  const unsettled = ready.filter(
    ({ queued, armed, gate }) => !queued && !armed && gate !== "success",
  );
  const room = Math.max(budget - landing.length, 0);
  const offset =
    unsettled.length === 0 ? 0 : (rotation * room) % unsettled.length;
  const rotated = [...unsettled.slice(offset), ...unsettled.slice(0, offset)];
  return [...landing, ...rotated.slice(0, room)].map(({ number }) => number);
};

/**
 * Whether a status or check run of this name is some reviewer's signal. Every
 * other status and check run leaves the gate unchanged.
 */
export const isReviewerSignal = (
  config: ReviewGateConfig,
  name: string,
): boolean =>
  config.reviewers.some(
    ({ done }) =>
      done.commitStatus?.context === name || done.checkRun?.name === name,
  );
