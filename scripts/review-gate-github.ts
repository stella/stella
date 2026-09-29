#!/usr/bin/env bun
//
// Review gate publisher: reads GitHub, evaluates (scripts/review-gate.ts) and
// publishes the `review-gate` check run.
//
// Only the trusted workflow runs this: .github/workflows/review-gate.yml,
// whose every trigger executes the default branch's workflow at one pinned
// commit, and which checks out this script and its config from that commit.
// It trusts nothing an event carries beyond "look at this pull request or
// commit": every input is re-read here.
//
// Usage:
//   bun scripts/review-gate-github.ts pr <number> [--dry-run]
//   bun scripts/review-gate-github.ts sha <sha> [--signal <name>] [--dry-run]
//   bun scripts/review-gate-github.ts group <sha> [--dry-run]
//   bun scripts/review-gate-github.ts relay [--dry-run]   (workflow_run env)
//   bun scripts/review-gate-github.ts sweep [--dry-run]
//
// Imports only runtime built-ins, so the workflow runs it without an install.

import { readFileSync } from "node:fs";

import {
  CHECK_NAME,
  GATE_APP_ID,
  ReviewGateError,
  affectedGroups,
  confirmDequeue,
  decidePublish,
  decodeIdentity,
  encodeIdentity,
  evaluatePullRequest,
  fail,
  groupMembers,
  groupOutput,
  headClockStart,
  isReviewerSignal,
  latestRun,
  outputOf,
  outputStatus,
  parseReviewGateConfig,
  pullRequestOutput,
  runToRepost,
  selectSweepTargets,
  shouldDequeue,
  unknownMembershipOutput,
  unreadableOutput,
  type GateOutput,
  type OpenPullRequest,
  type PublishedRun,
  type PullRequestSnapshot,
  type PullRequestVerdict,
  type QueueEntry,
  type QueueRecheck,
  type ReviewGateConfig,
  type RunIdentity,
} from "./review-gate";

const CONFIG_PATH = ".github/review-gate.yml";
// Bounded reads. Past these, the gate reports "unknown", never a count.
const THREAD_PAGES = 3;
const DISCOVERY_PAGES = 6;
// Pull requests one sweep re-evaluates beyond the queued and armed ones.
const SWEEP_BUDGET = 25;
const SWEEP_INTERVAL_MS = 10 * 60_000;
// A merge_group event can arrive before the queue lists its entry's commit.
const MEMBERSHIP_ATTEMPTS = 3;
const MEMBERSHIP_RETRY_MS = 5000;
// Rate limits and server errors are retried; anything else fails the run.
const RETRY_DELAYS_MS = [3000, 10_000, 30_000];
const RETRYABLE =
  /rate limit|secondary rate|HTTP 429|HTTP 50[0-9]|was submitted too quickly|timeout/iu;

// --- GitHub transport -----------------------------------------------------------

let apiCalls = 0;

const runGh = (args: readonly string[], input?: string): string => {
  for (let attempt = 0; ; attempt += 1) {
    apiCalls += 1;
    const result = Bun.spawnSync(["gh", ...args], {
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      return result.stdout.toString();
    }
    const stderr = result.stderr.toString();
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined || !RETRYABLE.test(stderr)) {
      return fail(`gh ${args[0] ?? ""} ${args[1] ?? ""} failed: ${stderr}`);
    }
    console.log(`gh: retrying in ${delay / 1000}s (${stderr.trim()})`);
    Bun.sleepSync(delay);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A GraphQL response with `errors` is partial: it fails the read even when
// `data` came back, so a missing field never reads as an empty list.
const graphql = (
  query: string,
  variables: Record<string, string | number>,
): Record<string, unknown> => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  const parsed: unknown = JSON.parse(runGh(args));
  if (!isRecord(parsed) || parsed["errors"] !== undefined) {
    return fail(`GraphQL errors: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  const data = parsed["data"];
  return isRecord(data) ? data : fail("GraphQL response without data");
};

// Narrow accessors: a missing field is a contract break, and the gate fails
// closed on it.
const field = (value: unknown, ...path: readonly string[]): unknown => {
  let current = value;
  for (const key of path) {
    current = isRecord(current)
      ? current[key]
      : fail(`Expected object at ${path.join(".")}`);
  }
  return current;
};
const text = (value: unknown, ...path: readonly string[]): string => {
  const found = field(value, ...path);
  return typeof found === "string"
    ? found
    : fail(`Expected string at ${path.join(".")}`);
};
const integer = (value: unknown, ...path: readonly string[]): number => {
  const found = field(value, ...path);
  return typeof found === "number"
    ? found
    : fail(`Expected number at ${path.join(".")}`);
};
const list = (
  value: unknown,
  ...path: readonly string[]
): readonly unknown[] => {
  const found = field(value, ...path);
  return Array.isArray(found)
    ? found
    : fail(`Expected list at ${path.join(".")}`);
};
const nullableText = (value: unknown, ...path: readonly string[]) => {
  const found = field(value, ...path);
  return typeof found === "string" ? found : null;
};
const login = (actor: unknown): string =>
  isRecord(actor) && typeof actor["login"] === "string"
    ? actor["login"]
    : "ghost";

// --- Reads ----------------------------------------------------------------------

const THREADS_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes { isResolved path comments(first: 1) { nodes { url } } }`;

// This gate's own runs on a commit, read through GraphQL: the repository's
// REST allowance for the workflow token is shared with every other workflow.
const GATE_RUNS_FIELDS = `
  checkSuites(first: 10, filterBy: { appId: ${GATE_APP_ID}, checkName: "${CHECK_NAME}" }) {
    totalCount
    nodes { checkRuns(first: 100, filterBy: { checkName: "${CHECK_NAME}" }) {
      totalCount
      nodes { databaseId externalId status conclusion title summary startedAt }
    } }
  }`;

const RUNS_QUERY = `
query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit { ${GATE_RUNS_FIELDS} } }
  }
}`;

const PULL_REQUEST_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number headRefOid baseRefName isDraft createdAt
      author { login }
      autoMergeRequest { enabledAt }
      mergeQueueEntry { position }
      files(first: 100) { totalCount nodes { path } }
      reviews(last: 100) { nodes { author { login } submittedAt commit { oid } } }
      reactions(last: 100) { nodes { content createdAt user { login } } }
      comments(last: 100) {
        nodes { createdAt body authorAssociation author { __typename login } }
      }
      timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) {
        nodes { ... on ReadyForReviewEvent { createdAt } }
      }
      commits(last: 1) { nodes { commit {
        statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state description }
        } } }
        ${GATE_RUNS_FIELDS}
      } } }
      reviewThreads(first: 100) { ${THREADS_FIELDS} }
    }
  }
}`;

const THREADS_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) { ${THREADS_FIELDS} }
    }
  }
}`;

// The facts a success or a dequeue rests on, re-read just before acting.
const REVALIDATE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      mergeQueueEntry { position }
      reviewThreads(first: 100) { ${THREADS_FIELDS} }
    }
  }
}`;

const QUEUE_QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 100) {
        pageInfo { hasNextPage }
        nodes { position headCommit { oid } pullRequest { number } }
      }
    }
  }
}`;

const DISCOVERY_QUERY = `
query($owner: String!, $name: String!, $branch: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: $branch, first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number isDraft
        autoMergeRequest { enabledAt }
        mergeQueueEntry { position }
        commits(last: 1) { nodes { commit { ${GATE_RUNS_FIELDS} } } }
      }
    }
  }
}`;

const DEQUEUE_MUTATION = `
mutation($id: ID!) {
  dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } }
}`;

type Threads = PullRequestSnapshot["threads"];

export type PullRequestRead = PullRequestSnapshot & {
  id: string;
  baseRefName: string;
  queued: boolean;
  // When this read began: a verdict built from it judged state this old.
  readAt: string;
};

// A partial list could hide the newest run or the first, so more runs than
// one read returns fails the read rather than deciding from part of them.
const parseRuns = (commit: unknown): readonly PublishedRun[] => {
  const suites = list(commit, "checkSuites", "nodes");
  if (integer(commit, "checkSuites", "totalCount") !== suites.length) {
    return fail("More review-gate check suites than one read returns");
  }
  return suites.flatMap((suite) => {
    const runs = list(suite, "checkRuns", "nodes");
    if (integer(suite, "checkRuns", "totalCount") !== runs.length) {
      return fail("More review-gate runs than one read returns");
    }
    return runs.map((run) => ({
      id: integer(run, "databaseId"),
      identity: decodeIdentity(nullableText(run, "externalId")),
      status: text(run, "status").toLowerCase(),
      conclusion: nullableText(run, "conclusion")?.toLowerCase() ?? null,
      title: nullableText(run, "title"),
      summary: nullableText(run, "summary"),
      startedAt: text(run, "startedAt"),
    }));
  });
};

export type Gateway = {
  readPullRequest: (number: number) => PullRequestRead;
  revalidate: (number: number) => QueueRecheck;
  readQueue: () => readonly QueueEntry[];
  readRuns: (sha: string) => readonly PublishedRun[];
  writeRun: (sha: string, output: GateOutput, identity: RunIdentity) => void;
  // Records a newer observation of an unchanged verdict on the run itself.
  restampRun: (id: number, identity: RunIdentity) => void;
  // The head alone, from the cheapest read: the fallback when a full read
  // fails and no event carried the head.
  readHead: (number: number) => string;
  pullRequestsForSha: (sha: string) => readonly number[];
  discoverOpenPullRequests: () => readonly OpenPullRequest[];
  dequeue: (id: string) => void;
};

const parsePullRequest = (
  pr: unknown,
  read: Pick<
    PullRequestRead,
    "number" | "threads" | "headClockStartedAt" | "readAt"
  >,
): PullRequestRead => {
  const files = field(pr, "files");
  const fileNodes = list(files, "nodes");
  const readyEvent = list(pr, "timelineItems", "nodes").at(0);
  const contexts = list(
    list(pr, "commits", "nodes").at(0),
    "commit",
    "statusCheckRollup",
    "contexts",
    "nodes",
  );
  return {
    ...read,
    id: text(pr, "id"),
    headSha: text(pr, "headRefOid"),
    baseRefName: text(pr, "baseRefName"),
    isDraft: field(pr, "isDraft") === true,
    author: login(field(pr, "author")),
    queued: isRecord(field(pr, "mergeQueueEntry")),
    readyAt:
      readyEvent === undefined
        ? text(pr, "createdAt")
        : text(readyEvent, "createdAt"),
    files:
      integer(files, "totalCount") === fileNodes.length
        ? fileNodes.map((file) => text(file, "path"))
        : null,
    // A review still being written has no submission time and is no report.
    reviews: list(pr, "reviews", "nodes").flatMap((review) => {
      const submittedAt = nullableText(review, "submittedAt");
      const commit = field(review, "commit");
      return submittedAt === null
        ? []
        : [
            {
              author: login(field(review, "author")),
              submittedAt,
              commitSha: isRecord(commit) ? text(commit, "oid") : null,
            },
          ];
    }),
    reactions: list(pr, "reactions", "nodes").map((reaction) => ({
      user: login(field(reaction, "user")),
      content: text(reaction, "content"),
      createdAt: text(reaction, "createdAt"),
    })),
    comments: list(pr, "comments", "nodes").map((comment) => {
      const author = field(comment, "author");
      return {
        author: login(author),
        authorAssociation: text(comment, "authorAssociation"),
        isBot: isRecord(author) && author["__typename"] === "Bot",
        createdAt: text(comment, "createdAt"),
        body: text(comment, "body"),
      };
    }),
    statuses: contexts
      .filter((node) => field(node, "__typename") === "StatusContext")
      .map((node) => ({
        context: text(node, "context"),
        state: text(node, "state"),
        description: nullableText(node, "description"),
      })),
    checkRuns: contexts
      .filter((node) => field(node, "__typename") === "CheckRun")
      .map((node) => ({
        name: text(node, "name"),
        status: text(node, "status"),
        conclusion: nullableText(node, "conclusion"),
      })),
  };
};

const gateState = (run: PublishedRun | undefined): OpenPullRequest["gate"] => {
  if (run === undefined) {
    return null;
  }
  if (run.conclusion === null) {
    return "pending";
  }
  return run.conclusion === "success" ? "success" : "failure";
};

const parseOpenPullRequest = (node: unknown): OpenPullRequest => {
  const commit = field(list(node, "commits", "nodes").at(0), "commit");
  const latest = latestRun(parseRuns(commit));
  return {
    number: integer(node, "number"),
    isDraft: field(node, "isDraft") === true,
    queued: isRecord(field(node, "mergeQueueEntry")),
    armed: isRecord(field(node, "autoMergeRequest")),
    gate: gateState(latest),
  };
};

const createGateway = (repo: string, baseBranch: string): Gateway => {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined) {
    return fail(`Expected owner/name, got ${repo}`);
  }

  const collectThreads = (number: number, firstPage: unknown): Threads => {
    const unresolved: { url: string; path: string | null }[] = [];
    let page = firstPage;
    for (let read = 1; ; read += 1) {
      for (const node of list(page, "nodes")) {
        if (field(node, "isResolved") !== true) {
          unresolved.push({
            url: text(list(node, "comments", "nodes").at(0), "url"),
            path: nullableText(node, "path"),
          });
        }
      }
      if (field(page, "pageInfo", "hasNextPage") !== true) {
        return { complete: true, unresolved };
      }
      if (read >= THREAD_PAGES) {
        return { complete: false };
      }
      page = field(
        graphql(THREADS_PAGE_QUERY, {
          owner,
          name,
          number,
          cursor: text(page, "pageInfo", "endCursor"),
        }),
        "repository",
        "pullRequest",
        "reviewThreads",
      );
    }
  };

  const readRuns = (sha: string): readonly PublishedRun[] => {
    const commit = field(
      graphql(RUNS_QUERY, { owner, name, oid: sha }),
      "repository",
      "object",
    );
    return isRecord(commit) ? parseRuns(commit) : fail(`No commit ${sha}`);
  };

  return {
    readPullRequest: (number) => {
      const readAt = new Date().toISOString();
      const pr = field(
        graphql(PULL_REQUEST_QUERY, { owner, name, number }),
        "repository",
        "pullRequest",
      );
      const commit = field(list(pr, "commits", "nodes").at(0), "commit");
      return parsePullRequest(pr, {
        number,
        readAt,
        threads: collectThreads(number, field(pr, "reviewThreads")),
        headClockStartedAt: headClockStart(parseRuns(commit), number),
      });
    },
    revalidate: (number) => {
      const pr = field(
        graphql(REVALIDATE_QUERY, { owner, name, number }),
        "repository",
        "pullRequest",
      );
      return {
        headSha: text(pr, "headRefOid"),
        queued: isRecord(field(pr, "mergeQueueEntry")),
        threads: collectThreads(number, field(pr, "reviewThreads")),
      };
    },
    readQueue: () => {
      const queue = field(
        graphql(QUEUE_QUERY, { owner, name, branch: baseBranch }),
        "repository",
        "mergeQueue",
      );
      if (!isRecord(queue)) {
        return [];
      }
      if (field(queue, "entries", "pageInfo", "hasNextPage") === true) {
        return fail("Merge queue has more entries than one read returns");
      }
      return list(queue, "entries", "nodes").map((entry) => {
        const commit = field(entry, "headCommit");
        return {
          position: integer(entry, "position"),
          headSha: isRecord(commit) ? text(commit, "oid") : null,
          pullRequest: integer(entry, "pullRequest", "number"),
        };
      });
    },
    readRuns,
    writeRun: (sha, output, identity) => {
      const { status, conclusion } = outputStatus(output);
      const body = {
        name: CHECK_NAME,
        head_sha: sha,
        external_id: encodeIdentity(identity),
        status,
        ...(conclusion === null ? {} : { conclusion }),
        output: { title: output.title, summary: output.summary },
      };
      runGh(
        ["api", "-X", "POST", `repos/${repo}/check-runs`, "--input", "-"],
        JSON.stringify(body),
      );
    },
    restampRun: (id, identity) => {
      runGh(
        [
          "api",
          "-X",
          "PATCH",
          `repos/${repo}/check-runs/${id}`,
          "--input",
          "-",
        ],
        JSON.stringify({ external_id: encodeIdentity(identity) }),
      );
    },
    readHead: (number) =>
      runGh([
        "api",
        `repos/${repo}/pulls/${number}`,
        "--jq",
        ".head.sha",
      ]).trim(),
    pullRequestsForSha: (sha) => {
      const pulls: unknown = JSON.parse(
        runGh(["api", `repos/${repo}/commits/${sha}/pulls`]),
      );
      if (!Array.isArray(pulls)) {
        return fail("Expected a list of pull requests");
      }
      return pulls
        .filter((pull) => field(pull, "state") === "open")
        .map((pull) => integer(pull, "number"));
    },
    discoverOpenPullRequests: () => {
      const found: OpenPullRequest[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < DISCOVERY_PAGES; page += 1) {
        const variables: Record<string, string | number> = {
          owner,
          name,
          branch: baseBranch,
        };
        if (cursor !== null) {
          variables["cursor"] = cursor;
        }
        const connection = field(
          graphql(DISCOVERY_QUERY, variables),
          "repository",
          "pullRequests",
        );
        for (const node of list(connection, "nodes")) {
          found.push(parseOpenPullRequest(node));
        }
        if (field(connection, "pageInfo", "hasNextPage") !== true) {
          return found;
        }
        cursor = text(connection, "pageInfo", "endCursor");
      }
      return fail(
        `More than ${DISCOVERY_PAGES * 50} open pull requests; sweep incomplete`,
      );
    },
    dequeue: (id) => {
      graphql(DEQUEUE_MUTATION, { id });
    },
  };
};

// --- Evaluate and publish -------------------------------------------------------

export type Run = {
  gateway: Gateway;
  config: ReviewGateConfig;
  baseBranch: string;
  dryRun: boolean;
  // Reads shared within one pass, so a pull request that several groups
  // contain is read and revalidated once. Every target's first attempt may
  // reuse them; a retry after the state moved never does.
  snapshots: Map<number, PullRequestRead>;
  revalidations: Map<number, QueueRecheck>;
  // Pull requests this run already removed from the queue.
  dequeued: Set<number>;
  // Head commits the triggering event named, trusted only as the place to
  // publish a blocking result when reading the pull request fails.
  eventHeads: Map<number, string>;
  failures: string[];
};

export const createRun = (
  gateway: Gateway,
  config: ReviewGateConfig,
  { baseBranch, dryRun }: { baseBranch: string; dryRun: boolean },
): Run => ({
  gateway,
  config,
  baseBranch,
  dryRun,
  snapshots: new Map(),
  revalidations: new Map(),
  dequeued: new Set(),
  eventHeads: new Map(),
  failures: [],
});

const now = (): string => new Date().toISOString();

const startPass = (run: Run): void => {
  run.snapshots.clear();
  run.revalidations.clear();
};

const forget = (run: Run, numbers: readonly number[]): void => {
  for (const number of numbers) {
    run.snapshots.delete(number);
    run.revalidations.delete(number);
  }
};

const readPullRequest = (run: Run, number: number): PullRequestRead => {
  const cached = run.snapshots.get(number);
  if (cached !== undefined) {
    return cached;
  }
  const read = run.gateway.readPullRequest(number);
  run.snapshots.set(number, read);
  return read;
};

// Each round needs another publisher's write to land in between, so this
// bounds only a pathological burst; past it the job fails visibly.
const MAX_SETTLE_ROUNDS = 10;

export const publish = (
  run: Run,
  sha: string,
  output: GateOutput,
  identity: RunIdentity,
): void => {
  // Read the published runs as late as possible: the decision is what keeps
  // a slower, older evaluation from overwriting a newer one.
  const runs = run.gateway.readRuns(sha);
  const decision = decidePublish(runs, output, identity.observedAt);
  console.log(
    `${sha.slice(0, 10)} ${encodeIdentity(identity)}: ${output.conclusion} (${output.title}) -> ${decision}`,
  );
  if (decision === "stale" || decision === "unchanged" || run.dryRun) {
    return;
  }
  const latest = latestRun(runs);
  if (decision === "restamp" && latest !== undefined) {
    run.gateway.restampRun(latest.id, identity);
  } else {
    run.gateway.writeRun(sha, output, identity);
  }
  // Publishers for one commit run concurrently and can race past the
  // decision above; settle to a fixed point so the newest run carries the
  // newest observation, whoever wrote last.
  for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
    const repost = runToRepost(run.gateway.readRuns(sha));
    const repostIdentity = repost?.identity ?? null;
    const repostOutput = repost === undefined ? null : outputOf(repost);
    if (repostIdentity === null || repostOutput === null) {
      return;
    }
    console.log(
      `${sha.slice(0, 10)}: a newer observation was overtaken; re-posting ${encodeIdentity(repostIdentity)}`,
    );
    run.gateway.writeRun(sha, repostOutput, repostIdentity);
  }
  fail(
    `${sha.slice(0, 10)}: still overtaken after ${MAX_SETTLE_ROUNDS} re-posts`,
  );
};

const sameThreads = (a: Threads, b: Threads): boolean =>
  a.complete &&
  b.complete &&
  a.unresolved.map(({ url }) => url).join(",") ===
    b.unresolved.map(({ url }) => url).join(",");

// A success is re-checked against a fresh read of the facts it rests on; a
// failure or pending verdict only ever blocks, so it publishes as read.
const stillHolds = (run: Run, pullRequest: PullRequestRead): boolean => {
  let fresh = run.revalidations.get(pullRequest.number);
  if (fresh === undefined) {
    fresh = run.gateway.revalidate(pullRequest.number);
    run.revalidations.set(pullRequest.number, fresh);
  }
  return (
    fresh.headSha === pullRequest.headSha &&
    sameThreads(fresh.threads, pullRequest.threads)
  );
};

// Enforce mode's eviction. The fresh read is taken right before the mutation
// and never served from the pass cache: only the confirmed offender leaves.
const dequeueIfConfirmed = (
  run: Run,
  pullRequest: PullRequestRead,
  verdict: PullRequestVerdict,
): void => {
  if (
    run.dequeued.has(pullRequest.number) ||
    !shouldDequeue(run.config.mode, verdict, pullRequest.queued)
  ) {
    return;
  }
  const fresh = run.gateway.revalidate(pullRequest.number);
  if (!confirmDequeue(verdict, fresh)) {
    console.log(
      `#${pullRequest.number}: not dequeued; the fresh read no longer confirms it`,
    );
    return;
  }
  console.log(
    `#${pullRequest.number}: ${verdict.title} while queued; dequeuing`,
  );
  if (!run.dryRun) {
    run.gateway.dequeue(pullRequest.id);
  }
  run.dequeued.add(pullRequest.number);
};

export const evaluatePullRequestTarget = (run: Run, number: number): void => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    forget(run, [number]);
    const pullRequest = readPullRequest(run, number);
    if (pullRequest.baseRefName !== run.baseBranch) {
      console.log(`#${number} targets ${pullRequest.baseRefName}; skipped`);
      return;
    }
    const observedAt = pullRequest.readAt;
    const verdict = evaluatePullRequest(pullRequest, run.config, observedAt);
    const output = pullRequestOutput(verdict, pullRequest.files);
    if (output.conclusion === "success" && !stillHolds(run, pullRequest)) {
      continue;
    }
    publish(run, pullRequest.headSha, output, {
      kind: "pr",
      pullRequest: number,
      observedAt,
    });
    dequeueIfConfirmed(run, pullRequest, verdict);
    return;
  }
  publish(
    run,
    run.gateway.revalidate(number).headSha,
    unreadableOutput("The pull request changed while the gate read it."),
    { kind: "pr", pullRequest: number, observedAt: now() },
  );
};

const earliest = (first: string, rest: readonly string[]): string => {
  let result = first;
  for (const time of rest) {
    if (Date.parse(time) < Date.parse(result)) {
      result = time;
    }
  }
  return result;
};

export const evaluateGroupTarget = (run: Run, headSha: string): void => {
  for (let attempt = 0; attempt < MEMBERSHIP_ATTEMPTS; attempt += 1) {
    const queueReadAt = now();
    const members = groupMembers(run.gateway.readQueue(), headSha);
    if (members === null) {
      if (attempt + 1 < MEMBERSHIP_ATTEMPTS) {
        Bun.sleepSync(MEMBERSHIP_RETRY_MS);
        continue;
      }
      publish(run, headSha, unknownMembershipOutput(headSha), {
        kind: "group",
        members: [],
        observedAt: queueReadAt,
      });
      return;
    }
    if (attempt > 0) {
      forget(run, members);
    }
    const pullRequests = members.map((number) => readPullRequest(run, number));
    // The verdict is as old as the oldest read it rests on.
    const observedAt = earliest(
      queueReadAt,
      pullRequests.map(({ readAt }) => readAt),
    );
    const verdicts = pullRequests.map((pullRequest) =>
      evaluatePullRequest(pullRequest, run.config, observedAt),
    );
    const output = groupOutput(verdicts);
    if (output.conclusion === "success") {
      const again = groupMembers(run.gateway.readQueue(), headSha);
      const unchanged =
        again?.join(",") === members.join(",") &&
        pullRequests.every((pullRequest) => stillHolds(run, pullRequest));
      if (!unchanged) {
        forget(run, members);
        continue;
      }
    }
    publish(run, headSha, output, { kind: "group", members, observedAt });
    // The failing group names its offenders; only they leave, each confirmed
    // by its own fresh read, so the rest of the group is rebuilt without them.
    for (const [index, pullRequest] of pullRequests.entries()) {
      const verdict = verdicts[index];
      if (verdict !== undefined) {
        dequeueIfConfirmed(run, pullRequest, verdict);
      }
    }
    return;
  }
  publish(
    run,
    headSha,
    unreadableOutput("The merge group changed while the gate read it."),
    { kind: "group", members: [], observedAt: now() },
  );
};

// A queued pull request that changed (a late thread, a new request) moves the
// verdict of every group that contains it.
const evaluatePullRequestAndGroups = (run: Run, number: number): void => {
  evaluatePullRequestTarget(run, number);
  if (run.snapshots.get(number)?.queued !== true) {
    return;
  }
  for (const headSha of affectedGroups(run.gateway.readQueue(), number)) {
    evaluateGroupTarget(run, headSha);
  }
};

// One target's failure must not stop the others, and must block that target:
// the gate reports that it could not read GitHub rather than leaving a stale
// success standing.
const attempt = (work: () => void): string | null => {
  try {
    work();
    return null;
  } catch (error) {
    if (!(error instanceof ReviewGateError)) {
      throw error;
    }
    return error.message;
  }
};

const guarded = (
  run: Run,
  label: string,
  work: () => void,
  onFailure: (reason: string) => void,
): void => {
  const reason = attempt(work);
  if (reason === null) {
    return;
  }
  run.failures.push(`${label}: ${reason}`);
  console.log(`${label}: ${reason}`);
  const reportFailure = attempt(() => onFailure(reason));
  if (reportFailure !== null) {
    run.failures.push(`${label}: could not report: ${reportFailure}`);
  }
};

export const guardedPullRequest = (
  run: Run,
  number: number,
  { withGroups }: { withGroups: boolean },
): void =>
  guarded(
    run,
    `#${number}`,
    () => {
      startPass(run);
      if (withGroups) {
        evaluatePullRequestAndGroups(run, number);
      } else {
        evaluatePullRequestTarget(run, number);
      }
    },
    (reason) => {
      const headSha =
        run.snapshots.get(number)?.headSha ??
        run.eventHeads.get(number) ??
        run.gateway.readHead(number);
      publish(run, headSha, unreadableOutput(reason), {
        kind: "pr",
        pullRequest: number,
        observedAt: now(),
      });
    },
  );

const guardedGroup = (run: Run, headSha: string): void =>
  guarded(
    run,
    `group ${headSha.slice(0, 10)}`,
    () => evaluateGroupTarget(run, headSha),
    (reason) =>
      publish(run, headSha, unreadableOutput(reason), {
        kind: "group",
        members: [],
        observedAt: now(),
      }),
  );

const sweep = (run: Run): void => {
  const targets = selectSweepTargets(
    run.gateway.discoverOpenPullRequests(),
    SWEEP_BUDGET,
    Math.floor(Date.now() / SWEEP_INTERVAL_MS),
  );
  for (const number of targets) {
    startPass(run);
    guardedPullRequest(run, number, { withGroups: false });
  }
  // Every queued group, settled or not: a missed event may have left one
  // passing a pull request that has since gained a thread.
  startPass(run);
  for (const entry of run.gateway.readQueue()) {
    if (entry.headSha !== null) {
      guardedGroup(run, entry.headSha);
    }
  }
};

// --- CLI --------------------------------------------------------------------------

const takeOption = (
  argv: readonly string[],
  option: string,
): { value: string | null; rest: readonly string[] } => {
  const index = argv.indexOf(option);
  if (index === -1) {
    return { value: null, rest: argv };
  }
  return {
    value: argv[index + 1] ?? fail(`${option} needs a value`),
    rest: [...argv.slice(0, index), ...argv.slice(index + 2)],
  };
};

const pullRequestNumbers = (raw: string): readonly number[] =>
  raw
    .split(",")
    .filter((part) => part.length > 0)
    .map((part) =>
      /^\d+$/u.test(part) ? Number(part) : fail(`Not a number: ${part}`),
    );

const main = (argv: readonly string[]): void => {
  const signal = takeOption(
    argv.filter((arg) => arg !== "--dry-run"),
    "--signal",
  );
  const [command = "", target] = signal.rest;
  const config = parseReviewGateConfig(
    Bun.YAML.parse(readFileSync(CONFIG_PATH, "utf-8")),
  );
  const baseBranch = process.env["REVIEW_GATE_BASE"] ?? "main";
  const run = createRun(
    createGateway(
      process.env["GITHUB_REPOSITORY"] ?? "stella/stella",
      baseBranch,
    ),
    config,
    { baseBranch, dryRun: argv.includes("--dry-run") },
  );

  switch (command) {
    case "pr": {
      const numbers = pullRequestNumbers(target ?? "");
      const head = takeOption(argv, "--head").value;
      for (const number of numbers) {
        if (head !== null && head.length > 0 && numbers.length === 1) {
          run.eventHeads.set(number, head);
        }
        guardedPullRequest(run, number, { withGroups: true });
      }
      break;
    }
    case "sha": {
      if (signal.value !== null && !isReviewerSignal(config, signal.value)) {
        console.log(`${signal.value} is not a reviewer signal; nothing to do`);
        break;
      }
      const sha = target ?? fail("sha needs a commit");
      for (const number of run.gateway.pullRequestsForSha(sha)) {
        run.eventHeads.set(number, sha);
        guardedPullRequest(run, number, { withGroups: true });
      }
      break;
    }
    case "group": {
      guardedGroup(run, target ?? fail("group needs a commit"));
      break;
    }
    case "relay": {
      // A run of the permissionless relay workflow: its event, commit and
      // pull requests say only where to look.
      const event = process.env["RELAY_EVENT"] ?? "";
      const headSha = process.env["RELAY_HEAD_SHA"] ?? "";
      const numbers = pullRequestNumbers(
        process.env["RELAY_PULL_REQUESTS"] ?? "",
      );
      if (event === "merge_group") {
        guardedGroup(run, headSha);
      } else {
        // Fork pull requests are not listed on a workflow run. Either way,
        // the run's head is the reviewed pull request's head.
        const listed =
          numbers.length > 0
            ? numbers
            : run.gateway.pullRequestsForSha(headSha);
        for (const number of listed) {
          run.eventHeads.set(number, headSha);
          guardedPullRequest(run, number, { withGroups: true });
        }
      }
      break;
    }
    case "sweep": {
      sweep(run);
      break;
    }
    default: {
      fail(
        `Unknown command "${command}"; expected pr, sha, group, relay or sweep`,
      );
    }
  }

  console.log(`API calls: ${apiCalls}`);
  if (run.failures.length > 0) {
    console.log(`Failed:\n${run.failures.join("\n")}`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  main(process.argv.slice(2));
}
