import { TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as v from "valibot";

const WORKFLOW = new URL("../.github/workflows/cla.yml", import.meta.url);
const SENTENCE = "I have read the CLA Document and I hereby sign the CLA";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OTHER_HEAD = "c".repeat(40);
const BLOB = "d".repeat(40);
const NEXT_BLOB = "e".repeat(40);
// The merge queue squashes: each entry head is a synthetic commit on its predecessor.
const SQUASH = "9".repeat(40);
const PREDECESSOR = "8".repeat(40);
const stepSchema = v.looseObject({
  name: v.string(),
  uses: v.string(),
  if: v.optional(v.string()),
  with: v.record(v.string(), v.unknown()),
});
const workflowSchema = v.looseObject({
  on: v.record(v.string(), v.unknown()),
  permissions: v.record(v.string(), v.string()),
  jobs: v.record(
    v.string(),
    v.looseObject({ if: v.optional(v.string()), steps: v.array(stepSchema) }),
  ),
});
const workflow = v.parse(
  workflowSchema,
  Bun.YAML.parse(readFileSync(WORKFLOW, "utf-8")),
);
const steps = workflow.jobs["verify-signatures"]?.steps ?? [];
const scriptStep = steps.find(
  ({ name }) => name === "Verify contributor signatures",
);
const source = v.parse(v.string(), scriptStep?.with["script"]);
const credentialsSource = v.parse(
  v.string(),
  steps.find(({ name }) => name === "Select signature credentials")?.with[
    "script"
  ],
);
const author = { id: 101, login: "fixture-author", type: "User" };
const pull = (number = 17, user = author, sha = HEAD) => ({
  number,
  state: "open",
  commits: 1,
  user,
  head: { sha },
  base: {
    ref: "main",
    sha: BASE,
    repo: { id: 200, full_name: "stella/stella" },
  },
});
const commit = ({
  user = author,
  sha = HEAD,
  committer = author,
}: {
  user?: typeof author | null;
  sha?: string;
  committer?: typeof author;
} = {}) => ({ sha, author: user, committer });
type CompareCommit = ReturnType<typeof commit> & {
  parents?: { sha: string }[];
  commit?: { message: string };
};
const signature = (id = author.id) => ({
  name: "original-name",
  id,
  comment_id: 301,
  created_at: "2026-01-01T00:00:00Z",
  repoId: 200,
  pullRequestNo: 8,
});
const comment = (user = author, body = SENTENCE) => ({
  id: 302,
  user,
  body,
  created_at: "2026-10-01T00:00:00Z",
});
class FixtureApiError extends TaggedError("FixtureApiError")<{
  message: string;
  status: number;
}> {}

// One queue entry: GitHub squashes the pull request into one commit (head) on
// its predecessor (base) and ends its subject with "(#<number>)".
type QueueEntry = {
  number: number;
  head: string;
  base: string;
  subject?: string;
};
const groupSchema = v.object({ base_sha: v.string(), head_sha: v.string() });
type FixtureOptions = {
  event?: string;
  payload?: Record<string, unknown>;
  pulls?: ReturnType<typeof pull>[];
  memberships?: Record<string, { state: string; role: string }>;
  commitsByPull?: Record<number, ReturnType<typeof commit>[]>;
  authorsByCommit?: Record<
    string,
    {
      users: (typeof author | null)[];
      totalCount?: number;
      oid?: string;
    }
  >;
  authorPreflightError?: boolean;
  accountsByLogin?: Record<string, typeof author>;
  changedPull?: ReturnType<typeof pull>;
  comparedCommits?: ReturnType<typeof commit>[];
  groupedCommits?: CompareCommit[];
  comments?: ReturnType<typeof comment>[];
  signatures?: ReturnType<typeof signature>[];
  conflicts?: number;
  membershipError?: number;
  storeError?: number;
  apiError?: { route: string; status: number };
  apiFailures?: { route: string; errors: unknown[] }[];
  commitPageFailures?: unknown[];
  // The merge group's entries from its base to its head.
  queueEntries?: QueueEntry[];
  // Replaces the commits the group's base...head comparison returns.
  groupCompare?: CompareCommit[];
};
const fixture = ({
  event = "pull_request_target",
  payload = { pull_request: { number: 17 } },
  pulls = [pull()],
  memberships = {},
  commitsByPull,
  authorsByCommit = {},
  authorPreflightError = false,
  accountsByLogin = {},
  changedPull,
  comparedCommits,
  groupedCommits,
  comments = [],
  signatures = [],
  conflicts = 0,
  membershipError,
  storeError,
  apiError,
  apiFailures = [],
  commitPageFailures = [],
  queueEntries = [
    { number: 18, head: PREDECESSOR, base: BASE },
    { number: 17, head: SQUASH, base: PREDECESSOR },
  ],
  groupCompare,
}: FixtureOptions = {}) => {
  const requests: {
    route: string;
    params: Record<string, unknown>;
    token: string;
  }[] = [];
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const annotations: { message: string; title: string }[] = [];
  const delays: number[] = [];
  const lateCommitFailures = [...commitPageFailures];
  const failures = apiFailures.map(({ route, errors: injected }) => ({
    route,
    errors: [...injected],
  }));
  let store = { signedContributors: signatures, policyVersion: "unchanged" };
  let blob = BLOB;
  let writes = 0;
  let prompts = 0;
  const pullReads = new Map<number, number>();
  const commentsByPull = new Map(
    pulls.map(({ number }) => [number, [...comments]]),
  );
  const injectFailure = (route: string) => {
    const injected = failures.find((failure) => failure.route === route);
    if (injected?.errors.length) {
      throw injected.errors.shift();
    }
    if (apiError?.route === route) {
      throw new FixtureApiError({
        status: apiError.status,
        message: "Injected API failure",
      });
    }
  };
  class Api {
    token: string;
    constructor({ auth = "base-fixture" } = {}) {
      this.token = auth;
    }
    async request(route: string, params: Record<string, unknown>) {
      requests.push({ route, params, token: this.token });
      injectFailure(route);
      if (route === "GET /users/{username}") {
        expect(this.token).toBe("base-fixture");
        const login = v.parse(v.string(), params["username"]);
        const users = [
          ...pulls.map(({ user }) => user),
          ...Object.values(commitsByPull ?? {})
            .flat()
            .map(({ author: user }) => user),
          ...Object.values(authorsByCommit).flatMap(
            ({ users: commitUsers }) => commitUsers,
          ),
        ];
        const user =
          accountsByLogin[login] ??
          users.find((candidate) => candidate?.login === login);
        if (!user) {
          throw new FixtureApiError({
            status: 404,
            message: "Account unavailable",
          });
        }
        return { data: user };
      }
      if (route.includes("/memberships/")) {
        expect(this.token).toBe("store-fixture");
        if (membershipError) {
          throw new FixtureApiError({
            status: membershipError,
            message: "Membership unavailable",
          });
        }
        const membership = memberships[v.parse(v.string(), params["username"])];
        if (!membership) {
          throw new FixtureApiError({ status: 404, message: "Not a member" });
        }
        return { data: membership };
      }
      if (route.includes("/contents/")) {
        expect(this.token).toBe("store-fixture");
        expect(params["owner"]).toBe("stella");
        expect(params["repo"]).toBe("cla");
        expect(params["path"]).toBe("signatures/cla.json");
        if (storeError) {
          throw new FixtureApiError({
            status: storeError,
            message: "Store unavailable",
          });
        }
        if (route.startsWith("GET")) {
          expect(params["ref"]).toBe("cla-signatures");
          return {
            data: {
              type: "file",
              encoding: "base64",
              sha: blob,
              content: Buffer.from(JSON.stringify(store)).toBase64(),
            },
          };
        }
        writes++;
        expect(params["branch"]).toBe("cla-signatures");
        expect(params["sha"]).toBe(blob);
        if (writes <= conflicts) {
          store = {
            ...store,
            signedContributors: [
              ...store.signedContributors,
              signature(999 + writes),
            ],
          };
          blob = NEXT_BLOB;
          throw new FixtureApiError({
            status: 409,
            message: "Concurrent update",
          });
        }
        store = v.parse(
          v.looseObject({
            signedContributors: v.array(
              v.looseObject({
                name: v.string(),
                id: v.number(),
                comment_id: v.number(),
                created_at: v.string(),
                repoId: v.number(),
                pullRequestNo: v.number(),
              }),
            ),
            policyVersion: v.string(),
          }),
          JSON.parse(
            Buffer.from(
              v.parse(v.string(), params["content"]),
              "base64",
            ).toString("utf-8"),
          ),
        );
        return { data: {} };
      }
      expect(this.token).toBe("base-fixture");
      expect(params["owner"]).toBe("stella");
      expect(params["repo"]).toBe("stella");
      if (route.endsWith("/pulls/{pull_number}")) {
        const selected = pulls.find(
          ({ number }) => number === params["pull_number"],
        );
        if (!selected) {
          throw new FixtureApiError({
            status: 404,
            message: "Pull request unavailable",
          });
        }
        const reads = (pullReads.get(selected.number) ?? 0) + 1;
        pullReads.set(selected.number, reads);
        return {
          data:
            reads > 1 && changedPull?.number === selected.number
              ? changedPull
              : selected,
        };
      }
      if (route.endsWith("/compare/{basehead}")) {
        const basehead = v.parse(v.string(), params["basehead"]);
        const selected = pulls.find(
          (candidate) =>
            `${candidate.base.sha}...${candidate.head.sha}` === basehead,
        );
        const mergeGroup = payload["merge_group"];
        const groupRange = v.is(groupSchema, mergeGroup)
          ? `${mergeGroup.base_sha}...${mergeGroup.head_sha}`
          : undefined;
        const squashOf = (queued: QueueEntry): CompareCommit => ({
          ...commit({
            user:
              pulls.find((candidate) => candidate.number === queued.number)
                ?.user ?? author,
            sha: queued.head,
          }),
          parents: [{ sha: queued.base }],
          commit: {
            message:
              queued.subject ??
              `change ${String(queued.number)} (#${String(queued.number)})\n\nDetails.`,
          },
        });
        const entry = queueEntries.find(
          ({ base, head }) => basehead === `${base}...${head}`,
        );
        const groupPull = entry
          ? pulls.find((candidate) => candidate.number === entry.number)
          : undefined;
        const squash: CompareCommit[] =
          entry && groupPull ? [squashOf(entry)] : [];
        const compared = (): CompareCommit[] => {
          if (selected) {
            return (
              comparedCommits ??
              commitsByPull?.[selected.number] ?? [
                commit({ user: selected.user, sha: selected.head.sha }),
              ]
            );
          }
          // The group's own base...head read lists every entry's squash.
          if (basehead === groupRange) {
            return groupCompare ?? queueEntries.map(squashOf);
          }
          return groupedCommits ?? squash;
        };
        const commits = compared();
        return {
          data: {
            commits:
              typeof params["page"] === "number"
                ? commits.slice(
                    (params["page"] - 1) * 100,
                    params["page"] * 100,
                  )
                : commits.slice(0, 250),
            total_commits: commits.length,
          },
        };
      }
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        expect(params["name"]).toMatch(/^cla(?:\/pr-\d+)?$/u);
        created.push(params);
        return { data: { id: created.length + 400 } };
      }
      if (route.startsWith("PATCH") && route.includes("/check-runs/")) {
        updates.push(params);
        return { data: {} };
      }
      if (route.startsWith("POST") && route.endsWith("/comments")) {
        prompts++;
        const pullComments = commentsByPull.get(
          v.parse(v.number(), params["issue_number"]),
        );
        if (!pullComments) {
          throw new FixtureApiError({
            status: 404,
            message: "Prompt PR unavailable",
          });
        }
        pullComments.push(
          comment(
            { id: 500, login: "github-actions[bot]", type: "Bot" },
            v.parse(v.string(), params["body"]),
          ),
        );
        return { data: {} };
      }
      if (route.startsWith("PATCH") && route.includes("/issues/comments/")) {
        return { data: {} };
      }
      throw new FixtureApiError({
        status: 500,
        message: `Unhandled fixture route: ${route}`,
      });
    }
    async graphql(query: string, params: Record<string, unknown>) {
      expect(this.token).toBe("base-fixture");
      requests.push({ route: "GRAPHQL", params, token: this.token });
      injectFailure("GRAPHQL authors");
      if (!query.includes("authors(")) {
        throw new FixtureApiError({
          status: 500,
          message: "Unhandled fixture GraphQL query",
        });
      }
      if (authorPreflightError && !query.includes("totalCount")) {
        throw new FixtureApiError({
          status: 503,
          message: "Commit author preflight unavailable",
        });
      }
      expect(params["owner"]).toBe("stella");
      expect(params["repo"]).toBe("stella");
      const oid = v.parse(v.string(), params["oid"]);
      const restCommit = pulls
        .flatMap(
          (candidate) =>
            commitsByPull?.[candidate.number] ?? [
              commit({ user: candidate.user, sha: candidate.head.sha }),
            ],
        )
        .find((candidate) => candidate.sha === oid);
      if (!restCommit) {
        throw new FixtureApiError({
          status: 404,
          message: "Commit author snapshot unavailable",
        });
      }
      const snapshot = authorsByCommit[oid];
      const users = snapshot?.users ?? [restCommit.author];
      const offset =
        params["cursor"] === null || params["cursor"] === undefined
          ? 0
          : Number(params["cursor"]);
      const page = users.slice(offset, offset + 100);
      return {
        repository: {
          object: {
            oid: snapshot?.oid ?? oid,
            authors: {
              totalCount: snapshot?.totalCount ?? users.length,
              nodes: page.map((user) => ({
                user:
                  user === null
                    ? null
                    : {
                        databaseId: user.id,
                        login: user.login,
                        __typename: "User",
                      },
              })),
              pageInfo: {
                hasNextPage: offset + page.length < users.length,
                endCursor: String(offset + page.length),
              },
            },
          },
        },
      };
    }
    paginate = {
      async *iterator(route: string, params: Record<string, unknown>) {
        requests.push({ route, params, token: "base-fixture" });
        injectFailure(route);
        if (route.endsWith("/pulls/{pull_number}/commits")) {
          const number = v.parse(v.number(), params["pull_number"]);
          const selected = pulls.find(
            (candidate) => candidate.number === number,
          );
          const commits =
            commitsByPull?.[number] ??
            (selected
              ? [commit({ user: selected.user, sha: selected.head.sha })]
              : []);
          for (
            let index = 0;
            index < Math.max(commits.length, 1);
            index += 100
          ) {
            if (index === 100 && lateCommitFailures.length) {
              throw lateCommitFailures.shift();
            }
            yield { data: commits.slice(index, index + 100) };
          }
          return;
        }
        if (route.includes("/commits/")) {
          // GitHub lists commit pulls without the commit count.
          yield {
            data: pulls
              .filter(({ head }) => head.sha === params["commit_sha"])
              .map(({ commits: _omitted, ...listed }) => listed),
          };
          return;
        }
        expect(route).toBe(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        );
        const pullComments =
          commentsByPull.get(v.parse(v.number(), params["issue_number"])) ?? [];
        for (
          let index = 0;
          index < Math.max(pullComments.length, 1);
          index += 100
        ) {
          yield { data: pullComments.slice(index, index + 100) };
        }
      },
    };
  }
  const credentials: Record<string, string> = {};
  const selectCredentials = async () => {
    const api = new Api();
    const paginate = async (route: string, params: Record<string, unknown>) => {
      const result: unknown[] = [];
      for await (const page of api.paginate.iterator(route, params)) {
        result.push(...page.data);
      }
      return result;
    };
    await runInNewContext(`(async () => { ${credentialsSource}\n })()`, {
      github: {
        request: api.request.bind(api),
        graphql: api.graphql.bind(api),
        paginate,
      },
      context: {
        eventName: event,
        payload,
        repo: { owner: "stella", repo: "stella" },
      },
      core: {
        setOutput: (name: string, value: string) => {
          credentials[name] = value;
        },
      },
    });
  };
  const execute = async () => {
    if (event === "workflow_run") {
      await selectCredentials();
    } else {
      credentials["store_required"] ??= "true";
    }
    const result: unknown = runInNewContext(`(async () => { ${source}\n })()`, {
      github: new Api(),
      context: {
        eventName: event,
        payload,
        repo: { owner: "stella", repo: "stella" },
      },
      core: {
        setFailed: (message: string) => errors.push(message),
        error: (message: string, { title }: { title: string }) => {
          annotations.push({ message, title });
        },
      },
      setTimeout: (callback: () => void, delay: number) => {
        delays.push(delay);
        callback();
      },
      process: {
        env: {
          ...(credentials["store_required"] === "false"
            ? {}
            : { CLA_STORE_TOKEN: "store-fixture" }),
          CLA_PULL_REQUESTS: credentials["pull_requests"],
        },
      },
      Buffer,
    });
    await result;
  };
  return {
    execute,
    selectCredentials,
    credentials,
    requests,
    created,
    updates,
    errors,
    annotations,
    delays,
    stored: () => store,
    writes: () => writes,
    prompts: () => prompts,
  };
};
const lastOutput = (run: ReturnType<typeof fixture>, name?: string) =>
  v.parse(
    v.object({
      conclusion: v.string(),
      output: v.object({ title: v.string(), summary: v.string() }),
    }),
    name === undefined
      ? run.updates.at(-1)
      : run.updates.findLast((update) => {
          const index = v.parse(v.number(), update["check_run_id"]) - 401;
          return run.created.at(index)?.["name"] === name;
        }),
  );

// bun-types declares `.rejects.toThrow` as void, so awaiting it trips
// type-aware lint; capture the rejection explicitly instead.
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => "resolved",
    (error: unknown) => error,
  );

describe("contributor signature workflow", () => {
  test.each(["signed", "member"])(
    "unsigned opener cannot reuse fully signed or exempt commits (%s)",
    async (kind) => {
      const contributor = { ...author, id: 102, login: "signed-contributor" };
      const run = fixture({
        commitsByPull: { 17: [commit({ user: contributor })] },
        signatures: kind === "signed" ? [signature(contributor.id)] : [],
        memberships:
          kind === "member"
            ? { [contributor.login]: { state: "active", role: "member" } }
            : {},
      });
      await run.execute();
      expect(run.errors).toEqual([]);
      expect(lastOutput(run, "cla").conclusion).toBe("success");
      expect(lastOutput(run, "cla/pr-17").conclusion).toBe("failure");
      expect(lastOutput(run, "cla/pr-17").output.title).toBe("CLA_UNSIGNED");
      expect(lastOutput(run, "cla/pr-17").output.summary).toContain(
        author.login,
      );
      expect(
        run.stored().signedContributors.some(({ id }) => id === author.id),
      ).toBe(false);
      expect(run.writes()).toBe(0);
    },
  );

  test("opener signature cannot sign a different commit author", async () => {
    const contributor = { ...author, id: 102, login: "unsigned-contributor" };
    const run = fixture({
      signatures: [signature()],
      comments: [comment()],
      commitsByPull: { 17: [commit({ user: contributor })] },
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    for (const name of ["cla", "cla/pr-17"]) {
      expect(lastOutput(run, name).conclusion).toBe("failure");
      expect(lastOutput(run, name).output.title).toBe("CLA_UNSIGNED");
      expect(lastOutput(run, name).output.summary).toContain(contributor.login);
    }
    expect(run.writes()).toBe(0);
    expect(run.stored().signedContributors.map(({ id }) => id)).toEqual([
      author.id,
    ]);
  });

  test.each([
    "cursoragent-copy",
    "claude-suffix",
    "CursorAgent-copy",
    "claude-agent",
  ])(
    "allowlist exemptions require the complete account login (%s)",
    async (login) => {
      const run = fixture({
        pulls: [pull(17, { ...author, login, type: "User" })],
      });
      await run.execute();
      expect(run.errors).toEqual([]);
      expect(lastOutput(run).conclusion).toBe("failure");
      expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
      expect(lastOutput(run).output.summary).toContain(login);
      expect(run.writes()).toBe(0);
    },
  );

  test.each([
    ["gateway timeout", { status: 504 }],
    ["rate limit", { status: 429 }],
    ["server error", { status: 500 }],
    ["service unavailable", { status: 503 }],
    ["socket timeout", { code: "ETIMEDOUT" }],
    ["request timeout", { code: "ESOCKETTIMEDOUT" }],
    ["connection timeout", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }],
    ["headers timeout", { code: "UND_ERR_HEADERS_TIMEOUT" }],
    ["body timeout", { code: "UND_ERR_BODY_TIMEOUT" }],
    ["named timeout", { name: "TimeoutError" }],
  ])(
    "transient %s recovers before issuing the signature verdict",
    async (_kind, error) => {
      const route = "GET /repos/{owner}/{repo}/contents/{path}";
      const run = fixture({
        signatures: [signature()],
        apiFailures: [{ route, errors: [error] }],
      });
      await run.execute();
      expect(run.errors).toEqual([]);
      expect(run.annotations).toEqual([]);
      expect(run.delays).toEqual([2000]);
      expect(
        run.requests.filter((request) => request.route === route),
      ).toHaveLength(3);
      expect(lastOutput(run).conclusion).toBe("success");
    },
  );

  test("three gateway timeouts report a signature service outage and fail closed", async () => {
    const route = "GET /repos/{owner}/{repo}/contents/{path}";
    const message = "CLA_API_UNAVAILABLE status=504 attempts=3";
    const run = fixture({ apiError: { route, status: 504 } });
    await run.execute();
    expect(
      run.requests.filter((request) => request.route === route),
    ).toHaveLength(3);
    expect(run.delays).toEqual([2000, 4000]);
    expect(run.errors).toEqual([message]);
    expect(run.annotations).toEqual([
      { message, title: "signature-service-unavailable" },
    ]);
    expect(lastOutput(run).conclusion).toBe("failure");
  });

  test("timeout exhaustion has a distinct service outage diagnostic", async () => {
    const route = "GET /repos/{owner}/{repo}/contents/{path}";
    const message = "CLA_API_UNAVAILABLE status=TIMEOUT attempts=3";
    const run = fixture({
      apiFailures: [
        {
          route,
          errors: Array.from({ length: 3 }, () => ({ code: "ETIMEDOUT" })),
        },
      ],
    });
    await run.execute();
    expect(run.delays).toEqual([2000, 4000]);
    expect(run.errors).toEqual([message]);
    expect(run.annotations).toEqual([
      { message, title: "signature-service-unavailable" },
    ]);
  });

  test("a check reporting failure preserves the primary service outage diagnostic", async () => {
    const message = "CLA_API_UNAVAILABLE status=504 attempts=3";
    const run = fixture({
      apiError: {
        route: "GET /repos/{owner}/{repo}/contents/{path}",
        status: 504,
      },
      apiFailures: [
        {
          route: "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
          errors: [{ status: 403 }],
        },
      ],
    });
    await run.execute();
    expect(run.errors).toEqual([message]);
    expect(run.annotations).toEqual([
      { message, title: "signature-service-unavailable" },
      {
        message: "CLA_CHECK_REPORT_ERROR_403",
        title: "signature-check-report-failed",
      },
    ]);
    expect(run.delays).toEqual([2000, 4000]);
  });

  test.each([
    { status: 400 },
    { status: 401 },
    { status: 403 },
    { status: 404 },
    { status: 403, code: "ETIMEDOUT" },
    { status: 600 },
    { name: "AbortError" },
  ])("permanent API failures do not retry (%j)", async (error) => {
    const route = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
    const run = fixture({ apiFailures: [{ route, errors: [error] }] });
    await run.execute();
    expect(
      run.requests.filter((request) => request.route === route),
    ).toHaveLength(1);
    expect(run.delays).toEqual([]);
    expect(run.annotations).toEqual([]);
    expect(run.errors).toEqual([
      `CLA_API_ERROR_${"status" in error ? error.status : "UNKNOWN"}`,
    ]);
  });

  test.each([
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    "GRAPHQL authors",
  ])("transient errors recover at the %s boundary", async (route) => {
    const run = fixture({
      comments: [comment()],
      apiFailures: [{ route, errors: [{ status: 504 }] }],
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(run.delays).toEqual([2000]);
    expect(lastOutput(run).conclusion).toBe("success");
    expect(run.stored().signedContributors.map(({ id }) => id)).toContain(
      author.id,
    );
  });

  test("pagination retries discard pages accumulated before the failed page", async () => {
    const route = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";
    const commits = Array.from({ length: 101 }, (_, index) =>
      commit({ sha: (index + 1).toString(16).padStart(40, "0") }),
    );
    const run = fixture({
      pulls: [{ ...pull(), commits: commits.length }],
      commitsByPull: { 17: commits },
      signatures: [signature()],
      commitPageFailures: [{ status: 504 }],
    });
    await run.execute();
    expect(
      run.requests.filter((request) => request.route === route),
    ).toHaveLength(3);
    expect(run.delays).toEqual([2000]);
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).conclusion).toBe("success");
  });

  test("each API operation receives its own three-attempt budget", async () => {
    const routes = [
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
      "GET /repos/{owner}/{repo}/contents/{path}",
    ];
    const run = fixture({
      signatures: [signature()],
      apiFailures: routes.map((route) => ({
        route,
        errors: [{ status: 504 }, { status: 504 }],
      })),
    });
    await run.execute();
    expect(run.delays).toEqual([2000, 4000, 2000, 4000]);
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).conclusion).toBe("success");
  });

  test("a signature write failure is reported without replaying the write", async () => {
    const route = "PUT /repos/{owner}/{repo}/contents/{path}";
    const run = fixture({
      comments: [comment()],
      apiError: { route, status: 504 },
    });
    await run.execute();
    expect(
      run.requests.filter((request) => request.route === route),
    ).toHaveLength(1);
    expect(run.delays).toEqual([]);
    expect(run.annotations).toEqual([]);
    expect(run.errors).toEqual(["CLA_API_ERROR_504"]);
    expect(lastOutput(run).conclusion).toBe("failure");
  });

  test("the merge group's commit read recovers from a gateway timeout", async () => {
    const run = fixture({
      event: "merge_group",
      payload: {
        merge_group: {
          head_sha: SQUASH,
          base_sha: BASE,
          base_ref: "refs/heads/main",
          head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${PREDECESSOR}`,
        },
      },
      pulls: [pull(), pull(18)],
      signatures: [signature()],
      apiFailures: [
        {
          route: "GET /repos/{owner}/{repo}/compare/{basehead}",
          errors: [{ status: 504 }],
        },
      ],
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(run.delays).toEqual([2000]);
    expect(lastOutput(run).conclusion).toBe("success");
  });

  test("an unsigned contributor remains a policy verdict without API retries", async () => {
    const run = fixture();
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(run.annotations).toEqual([]);
    expect(run.delays).toEqual([]);
    expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
  });

  const assertActiveChecksFailed = (
    run: ReturnType<typeof fixture>,
    status: number,
    retryable = true,
  ) => {
    expect(run.errors).toEqual([
      retryable && (status === 429 || (status >= 500 && status <= 599))
        ? `CLA_API_UNAVAILABLE status=${status} attempts=3`
        : `CLA_API_ERROR_${status}`,
    ]);
    expect(run.created.length).toBeGreaterThan(0);
    for (let index = 0; index < run.created.length; index++) {
      const update = run.updates.findLast(
        (value) => value["check_run_id"] === index + 401,
      );
      expect(update?.["conclusion"]).toBe("failure");
      expect(update?.["status"]).toBe("completed");
    }
  };
  test.each([401, 403, 429, 500, 502, 503])(
    "every API failure keeps active CLA checks unsuccessful (%s)",
    async (status) => {
      for (const options of [
        { membershipError: status },
        { storeError: status },
      ]) {
        const run = fixture(options);
        await run.execute();
        assertActiveChecksFailed(run, status);
      }
    },
  );
  test.each([
    ["commits", "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"],
    ["comments", "GET /repos/{owner}/{repo}/issues/{issue_number}/comments"],
    ["group", "GET /repos/{owner}/{repo}/compare/{basehead}"],
    ["store-put", "PUT /repos/{owner}/{repo}/contents/{path}"],
  ])(
    "every API failure keeps active CLA checks unsuccessful at %s",
    async (boundary, route) => {
      const options =
        boundary === "group"
          ? {
              event: "merge_group",
              payload: {
                merge_group: {
                  head_sha: SQUASH,
                  base_sha: BASE,
                  base_ref: "refs/heads/main",
                  head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${PREDECESSOR}`,
                },
              },
              apiError: { route, status: 500 },
            }
          : {
              ...(boundary === "store-put" ? { comments: [comment()] } : {}),
              apiError: {
                route,
                status: 500,
              },
            };
      const run = fixture(options);
      await run.execute();
      assertActiveChecksFailed(run, 500, boundary !== "store-put");
    },
  );
  test("a scoped API error preserves the completed common contributor verdict", async () => {
    const contributor = { ...author, id: 102, login: "signed-contributor" };
    const run = fixture({
      commitsByPull: { 17: [commit({ user: contributor })] },
      signatures: [signature(contributor.id)],
      apiError: {
        route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        status: 500,
      },
    });
    await run.execute();
    expect(run.errors).toEqual(["CLA_API_UNAVAILABLE status=500 attempts=3"]);
    expect(lastOutput(run, "cla").conclusion).toBe("success");
    expect(lastOutput(run, "cla/pr-17").conclusion).toBe("failure");
    expect(lastOutput(run, "cla/pr-17").output.title).toBe(
      "CLA_API_UNAVAILABLE",
    );
    expect(
      run.updates.filter((update) => update["check_run_id"] === 401),
    ).toHaveLength(1);
  });

  for (const event of ["pull_request_target", "merge_group"]) {
    const eventOptions =
      event === "merge_group"
        ? {
            event,
            payload: {
              merge_group: {
                head_sha: SQUASH,
                base_sha: BASE,
                base_ref: "refs/heads/main",
                head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${BASE}`,
              },
            },
            queueEntries: [{ number: 17, head: SQUASH, base: BASE }],
          }
        : { event };
    test.each(["unsigned", "signed", "member", "unlinked"])(
      `${event} verifies every coauthor (%s)`,
      async (state) => {
        const coauthor = { ...author, id: 102, login: "coauthor" };
        const run = fixture({
          ...eventOptions,
          signatures:
            state === "signed"
              ? [signature(), signature(coauthor.id)]
              : [signature()],
          memberships:
            state === "member"
              ? { [coauthor.login]: { state: "active", role: "member" } }
              : {},
          authorsByCommit: {
            [HEAD]: { users: [author, state === "unlinked" ? null : coauthor] },
          },
        });
        await run.execute();
        expect(run.errors).toEqual([]);
        const output = lastOutput(
          run,
          event === "merge_group" ? "cla" : "cla/pr-17",
        );
        const linkedTitle =
          state === "unsigned" ? "CLA_UNSIGNED" : "CLA_VERIFIED";
        const expectedTitle =
          state === "unlinked" ? "CLA_UNLINKED_AUTHOR" : linkedTitle;
        expect(output.output.title).toBe(expectedTitle);
        expect(output.conclusion).toBe(
          state === "signed" || state === "member" ? "success" : "failure",
        );
        expect(
          run.requests.some(
            ({ route, params }) =>
              route === "GRAPHQL" && params["oid"] === HEAD,
          ),
        ).toBe(true);
        if (state === "unsigned") {
          expect(output.output.summary).toContain(coauthor.login);
        }
      },
    );

    test(`${event} contributor snapshots include the last author page`, async () => {
      const finalAuthor = { ...author, id: 1001, login: "last-page-coauthor" };
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        ...author,
        id: author.id + index,
        login: `${author.login}-${index}`,
      }));
      const users = [...firstPage, finalAuthor];
      const signedFirstPage = firstPage.map(({ id }) => signature(id));
      const run = fixture({
        ...eventOptions,
        signatures: signedFirstPage,
        authorsByCommit: { [HEAD]: { users } },
      });
      await run.execute();
      expect(run.errors).toEqual([]);
      expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
      expect(lastOutput(run).output.summary).toContain(finalAuthor.login);
      expect(
        run.requests.some(
          ({ route, params }) =>
            route === "GRAPHQL" &&
            params["oid"] === HEAD &&
            params["cursor"] === "100",
        ),
      ).toBe(true);
      const signed = fixture({
        ...eventOptions,
        signatures: [...signedFirstPage, signature(finalAuthor.id)],
        authorsByCommit: { [HEAD]: { users } },
      });
      await signed.execute();
      expect(signed.errors).toEqual([]);
      expect(lastOutput(signed).conclusion).toBe("success");
    });

    test.each(["incomplete", "wrong-oid"])(
      `${event} rejects %s contributor snapshots`,
      async (corruption) => {
        const run = fixture({
          ...eventOptions,
          signatures: [signature()],
          authorsByCommit: {
            [HEAD]: {
              users: [author],
              ...(corruption === "incomplete"
                ? { totalCount: 2 }
                : { oid: OTHER_HEAD }),
            },
          },
        });
        await run.execute();
        expect(run.errors).toContain(
          corruption === "incomplete"
            ? "CLA_INCOMPLETE_AUTHOR_LIST"
            : "CLA_INVALID_AUTHOR_LIST",
        );
        expect(lastOutput(run).output.title).toBe("CLA_ERROR");
        expect(lastOutput(run).conclusion).toBe("failure");
        expect(
          run.requests.some(
            ({ route, params }) =>
              route === "GRAPHQL" && params["oid"] === HEAD,
          ),
        ).toBe(true);
      },
    );
  }

  const notification = {
    workflow_run: {
      repository: { full_name: "stella/stella" },
      path: ".github/workflows/cla-notify.yml",
      event: "pull_request",
      conclusion: "success",
      head_sha: HEAD,
    },
  };
  const dependabot = {
    ...author,
    id: 1001,
    login: "dependabot[bot]",
    type: "Bot",
  };
  test("an ordinary all-bot PR skips store credentials after a fresh API preflight", async () => {
    const bot = { ...author, login: "release-fixture[bot]", type: "Bot" };
    const run = fixture({ pulls: [pull(17, bot)] });
    await run.selectCredentials();
    expect(run.credentials["store_required"]).toBe("false");
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run, "cla").conclusion).toBe("success");
    expect(lastOutput(run, "cla/pr-17").conclusion).toBe("success");
    expect(run.requests.some(({ token }) => token === "store-fixture")).toBe(
      false,
    );
    expect(
      run.requests.some(({ route }) => route === "GET /users/{username}"),
    ).toBe(true);
  });
  test("a bot preflight API failure cannot produce a check or credentials decision", async () => {
    const run = fixture({
      pulls: [pull(17, dependabot)],
      authorPreflightError: true,
    });
    expect(String(await rejectionOf(run.selectCredentials()))).toContain(
      "Commit author preflight unavailable",
    );
    expect(run.credentials).toEqual({});
    expect(run.created).toEqual([]);
    expect(run.writes()).toBe(0);
  });
  test("a bot preflight missing immutable commit object fails before reporting", async () => {
    const run = fixture({
      pulls: [pull(17, dependabot)],
      authorsByCommit: { [HEAD]: { users: [dependabot], oid: OTHER_HEAD } },
    });
    expect(String(await rejectionOf(run.selectCredentials()))).toContain(
      "CLA_INVALID_AUTHOR_LIST",
    );
    expect(run.credentials).toEqual({});
    expect(run.created).toEqual([]);
  });
  test("a linked GraphQL identity cannot borrow another REST account's exemption", async () => {
    const run = fixture({
      signatures: [signature()],
      accountsByLogin: { [author.login]: { ...author, id: 102, type: "Bot" } },
    });
    await run.execute();
    expect(run.errors).toEqual(["CLA_AUTHOR_IDENTITY_CHANGED"]);
    expect(lastOutput(run, "cla").conclusion).toBe("failure");
    expect(lastOutput(run, "cla").output.title).toBe("CLA_ERROR");
    expect(
      run.requests.some(
        ({ route, params }) =>
          route === "GET /users/{username}" &&
          params["username"] === author.login,
      ),
    ).toBe(true);
  });
  test("trusted all-bot notification reports both checks without signature-store credentials", async () => {
    const run = fixture({
      event: "workflow_run",
      payload: notification,
      pulls: [pull(17, dependabot)],
    });
    await run.execute();
    expect(run.credentials).toEqual({
      store_required: "false",
      pull_requests: "[17]",
    });
    expect(run.errors).toEqual([]);
    expect(lastOutput(run, "cla").conclusion).toBe("success");
    expect(lastOutput(run, "cla/pr-17").conclusion).toBe("success");
    expect(run.requests.some(({ token }) => token === "store-fixture")).toBe(
      false,
    );
  });
  test("bot-opened human contribution requires store credentials and human consent", async () => {
    const run = fixture({
      event: "workflow_run",
      payload: notification,
      pulls: [pull(17, dependabot)],
      commitsByPull: { 17: [commit()] },
    });
    await run.execute();
    expect(run.credentials["store_required"]).toBe("true");
    expect(run.errors).toEqual([]);
    expect(lastOutput(run, "cla").output.title).toBe("CLA_UNSIGNED");
    expect(lastOutput(run, "cla/pr-17").conclusion).toBe("failure");
  });
  test.each(["unlinked", "paginated"])(
    "notification preflight requests credentials for %s contributors",
    async (kind) => {
      const run = fixture({
        event: "workflow_run",
        payload: notification,
        pulls: [pull(17, dependabot)],
        authorsByCommit: {
          [HEAD]: {
            users:
              kind === "unlinked"
                ? [dependabot, null]
                : Array.from({ length: 101 }, () => dependabot),
          },
        },
      });
      await run.selectCredentials();
      expect(run.credentials["store_required"]).toBe("true");
      expect(run.created).toEqual([]);
    },
  );
  test.each(["repository", "path", "event", "head_sha", "conclusion"])(
    "notification rejects untrusted %s before reporting",
    async (field) => {
      const run = fixture({
        event: "workflow_run",
        payload: {
          workflow_run: {
            ...notification.workflow_run,
            [field]:
              field === "repository"
                ? { full_name: "attacker/repo" }
                : "attacker",
          },
        },
        pulls: [pull(17, dependabot)],
      });
      expect(String(await rejectionOf(run.selectCredentials()))).toContain(
        "CLA_UNTRUSTED_NOTIFICATION",
      );
      expect(run.created).toEqual([]);
      expect(run.writes()).toBe(0);
    },
  );

  test("a stale notification head cannot report on the current bot PR", async () => {
    const run = fixture({
      event: "workflow_run",
      payload: {
        workflow_run: { ...notification.workflow_run, head_sha: OTHER_HEAD },
      },
      pulls: [pull(17, dependabot)],
    });
    await run.execute();
    expect(run.credentials["pull_requests"]).toBe("[]");
    expect(run.created).toEqual([]);
    expect(run.updates).toEqual([]);
    expect(run.writes()).toBe(0);
  });

  test("members, owners, allowlisted accounts, Bot authors and Dependabot always report success", async () => {
    for (const options of [
      { memberships: { [author.login]: { state: "active", role: "member" } } },
      { memberships: { [author.login]: { state: "active", role: "admin" } } },
      { pulls: [pull(17, { ...author, login: "cursoragent" })] },
      { pulls: [pull(17, { ...author, login: "claude" })] },
      { pulls: [pull(17, { ...author, login: "fixture-bot", type: "Bot" })] },
      {
        pulls: [pull(17, { ...author, login: "dependabot[bot]", type: "Bot" })],
      },
    ]) {
      const run = fixture(options);
      await run.execute();
      expect(run.errors).toEqual([]);
      expect(lastOutput(run).conclusion).toBe("success");
      expect(run.created.at(0)?.["head_sha"]).toBe(HEAD);
      expect(run.writes()).toBe(0);
      expect(run.prompts()).toBe(0);
    }
  });

  test("a signed opener cannot carry unsigned commit authors", async () => {
    const second = { ...author, id: 102, login: "second-author" };
    const third = { ...author, id: 103, login: "third-author" };
    const run = fixture({
      signatures: [signature()],
      pulls: [{ ...pull(), commits: 2 }],
      commitsByPull: {
        17: [
          commit({ user: second }),
          commit({ user: third, sha: OTHER_HEAD }),
        ],
      },
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
    expect(lastOutput(run).conclusion).toBe("failure");
    for (const login of [second.login, third.login]) {
      expect(lastOutput(run).output.summary).toContain(login);
      expect(
        run.requests.find(
          ({ route }) =>
            route.startsWith("POST") && route.endsWith("/comments"),
        )?.params["body"],
      ).toContain(login);
    }
  });

  test("an exempt member opener does not exempt outsider commit authors", async () => {
    const second = { ...author, id: 102, login: "second-author" };
    const run = fixture({
      memberships: { [author.login]: { state: "active", role: "member" } },
      commitsByPull: { 17: [commit({ user: second })] },
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
    expect(lastOutput(run).output.summary).toContain(second.login);
  });

  test("each commit author signs only through their own exact comment", async () => {
    const second = { ...author, id: 102, login: "second-author" };
    const run = fixture({
      signatures: [signature()],
      comments: [comment(second)],
      commitsByPull: { 17: [commit({ user: second })] },
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).conclusion).toBe("success");
    expect(run.stored().signedContributors.map(({ id }) => id)).toEqual([
      author.id,
      second.id,
    ]);
  });

  test("unlinked commit authors fail with the commit SHA even with a web-flow committer", async () => {
    for (const committer of [
      author,
      { ...author, id: 19_864_447, login: "web-flow" },
    ]) {
      const run = fixture({
        signatures: [signature()],
        commitsByPull: { 17: [commit({ user: null, committer })] },
      });
      await run.execute();
      expect(run.errors).toEqual([]);
      expect(lastOutput(run).conclusion).toBe("failure");
      expect(lastOutput(run).output.title).toBe("CLA_UNLINKED_AUTHOR");
      expect(lastOutput(run).output.summary).toContain(HEAD);
    }
    const linked = fixture({
      signatures: [signature()],
      commitsByPull: {
        17: [
          commit({
            committer: { ...author, id: 19_864_447, login: "web-flow" },
          }),
        ],
      },
    });
    await linked.execute();
    expect(lastOutput(linked).conclusion).toBe("success");
  });

  test("commit author coverage is paginated through the 250 commit boundary", async () => {
    const second = { ...author, id: 102, login: "last-page-author" };
    const commits = Array.from({ length: 250 }, (_, index) =>
      commit({
        user: index === 249 ? second : author,
        sha: index === 249 ? HEAD : index.toString(16).padStart(40, "0"),
      }),
    );
    const run = fixture({
      signatures: [signature()],
      pulls: [{ ...pull(), commits: 250 }],
      commitsByPull: { 17: commits },
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
    expect(lastOutput(run).output.summary).toContain(second.login);
  });

  test("duplicate, replaced and changing commit snapshots fail closed", async () => {
    const duplicate = fixture({
      signatures: [signature()],
      pulls: [{ ...pull(), commits: 2 }],
      commitsByPull: { 17: [commit(), commit()] },
    });
    await duplicate.execute();
    expect(duplicate.errors).toEqual(["CLA_DUPLICATE_COMMIT"]);
    const replaced = fixture({
      signatures: [signature()],
      comparedCommits: [commit({ sha: OTHER_HEAD })],
    });
    await replaced.execute();
    expect(replaced.errors).toEqual(["CLA_COMMIT_SNAPSHOT_CHANGED"]);
    const changed = fixture({
      signatures: [signature()],
      changedPull: pull(17, author, OTHER_HEAD),
    });
    await changed.execute();
    expect(changed.errors).toEqual(["CLA_PULL_CHANGED"]);
  });

  test("merge groups verify one squash commit per entry and fail closed on any other shape", async () => {
    const options = {
      event: "merge_group",
      payload: {
        merge_group: {
          head_sha: SQUASH,
          base_sha: BASE,
          base_ref: "refs/heads/main",
          head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${PREDECESSOR}`,
        },
      },
      pulls: [pull(), pull(18, author, OTHER_HEAD)],
      signatures: [signature()],
    } satisfies FixtureOptions;
    const verified = fixture(options);
    await verified.execute();
    expect(verified.errors).toEqual([]);
    expect(lastOutput(verified).conclusion).toBe("success");
    for (const groupedCommits of [
      // A merge commit that carries the PR's own commits.
      [
        commit(),
        { ...commit({ sha: SQUASH }), parents: [{ sha: PREDECESSOR }] },
      ],
      [
        {
          ...commit({ sha: SQUASH }),
          parents: [{ sha: PREDECESSOR }, { sha: HEAD }],
        },
      ],
      [{ ...commit({ sha: SQUASH }), parents: [{ sha: BASE }] }],
      [{ ...commit({ sha: OTHER_HEAD }), parents: [{ sha: PREDECESSOR }] }],
      [commit({ sha: SQUASH })],
    ]) {
      const run = fixture({ ...options, groupedCommits });
      await run.execute();
      expect(run.errors, JSON.stringify(groupedCommits)).toEqual([
        "CLA_UNEXPECTED_GROUP_COMMIT",
      ]);
      expect(lastOutput(run).conclusion).toBe("failure");
    }
    const replaced = fixture({
      ...options,
      changedPull: pull(17, author, OTHER_HEAD),
    });
    await replaced.execute();
    expect(replaced.errors).toEqual(["CLA_PULL_CHANGED"]);
  });

  test("the recorded squash merge group verifies although the PR head is not its ancestor", async () => {
    // Shape of a merged queue group: one squash commit on main, PR branch diverged.
    const prHead = "d92bf5ed9b866b7303f31e2e16dffb50186d1b02";
    const groupBase = "45fca906f1d0b73949f9aee64a0daed90f09b206";
    const groupHead = "9eb492bf1d7cd44c24ecf417ce2297200d4bab10";
    const run = fixture({
      event: "merge_group",
      payload: {
        merge_group: {
          head_sha: groupHead,
          head_ref: `refs/heads/gh-readonly-queue/main/pr-4694-${groupBase}`,
          base_sha: groupBase,
          base_ref: "refs/heads/main",
        },
      },
      pulls: [pull(4694, author, prHead)],
      signatures: [signature()],
      queueEntries: [{ number: 4694, head: groupHead, base: groupBase }],
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).conclusion).toBe("success");
    expect(
      run.requests.some(
        ({ params }) => params["basehead"] === `${prHead}...${groupHead}`,
      ),
    ).toBe(false);
  });

  test("a merge group of 1 to 6 entries verifies exactly the pull requests its commits name", async () => {
    for (let size = 1; size <= 6; size++) {
      // Entries 101.. sit below the queued pull request #17 at the group head.
      const numbers = [
        ...Array.from({ length: size - 1 }, (_, index) => 101 + index),
        17,
      ];
      const heads = numbers.map((_, index) =>
        (index + 1).toString(16).padStart(40, "0"),
      );
      const queueEntries = numbers.map((number, index) => ({
        number,
        head: heads[index] ?? "",
        base: index === 0 ? BASE : (heads[index - 1] ?? ""),
      }));
      const groupHead = heads.at(-1) ?? "";
      const run = fixture({
        event: "merge_group",
        payload: {
          merge_group: {
            head_sha: groupHead,
            base_sha: BASE,
            base_ref: "refs/heads/main",
            head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${queueEntries.at(-1)?.base ?? ""}`,
          },
        },
        pulls: numbers.map((number) =>
          pull(number, author, number.toString(16).padStart(40, "e")),
        ),
        queueEntries,
        signatures: [signature()],
      });
      await run.execute();
      expect(run.errors, String(size)).toEqual([]);
      expect(lastOutput(run).conclusion, String(size)).toBe("success");
      const read = run.requests
        .filter(
          ({ route }) =>
            route.endsWith("/pulls/{pull_number}") && route.startsWith("GET"),
        )
        .map(({ params }) => params["pull_number"]);
      expect(new Set(read), String(size)).toEqual(new Set(numbers));
      // No merge queue snapshot is read.
      expect(
        run.requests.filter(({ route }) => route === "GRAPHQL"),
        String(size),
      ).toEqual(
        run.requests.filter(
          ({ route, params }) => route === "GRAPHQL" && "oid" in params,
        ),
      );
    }
  });

  test("a rebuilt merge group verifies its own commits; a member that changes mid-verification fails", async () => {
    // #18 left the queue: GitHub rebuilt #17 alone on the base.
    const rebuiltHead = "2".repeat(40);
    const rebuilt = fixture({
      event: "merge_group",
      payload: {
        merge_group: {
          head_sha: rebuiltHead,
          base_sha: BASE,
          base_ref: "refs/heads/main",
          head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${BASE}`,
        },
      },
      pulls: [pull()],
      queueEntries: [{ number: 17, head: rebuiltHead, base: BASE }],
      signatures: [signature()],
    });
    await rebuilt.execute();
    expect(rebuilt.errors).toEqual([]);
    expect(lastOutput(rebuilt).conclusion).toBe("success");
    // The superseded group's own run fails on its head, which can never merge.
    const options = {
      event: "merge_group",
      payload: {
        merge_group: {
          head_sha: SQUASH,
          base_sha: BASE,
          base_ref: "refs/heads/main",
          head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${PREDECESSOR}`,
        },
      },
      pulls: [pull(), pull(18, author, OTHER_HEAD)],
      signatures: [signature()],
    } satisfies FixtureOptions;
    const moved = fixture({
      ...options,
      changedPull: pull(18, author, "3".repeat(40)),
    });
    await moved.execute();
    expect(moved.errors).toEqual(["CLA_PULL_CHANGED"]);
    expect(lastOutput(moved).conclusion).toBe("failure");
    const closed = fixture({
      ...options,
      pulls: [pull(), { ...pull(18, author, OTHER_HEAD), state: "closed" }],
    });
    await closed.execute();
    expect(closed.errors).toEqual(["CLA_GROUP_PULL_CHANGED"]);
    // An unsigned author in a rebuilt group still fails.
    const unsigned = fixture({ ...options, signatures: [] });
    await unsigned.execute();
    expect(lastOutput(unsigned).conclusion).toBe("failure");
  });

  test("a merge group whose commits do not name one entry each fails closed", async () => {
    const options = {
      event: "merge_group",
      payload: {
        merge_group: {
          head_sha: SQUASH,
          base_sha: BASE,
          base_ref: "refs/heads/main",
          head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${PREDECESSOR}`,
        },
      },
      pulls: [pull(), pull(18, author, OTHER_HEAD)],
      signatures: [signature()],
    } satisfies FixtureOptions;
    const squashed = (
      sha: string,
      parents: string[],
      message: string,
    ): CompareCommit => ({
      ...commit({ sha }),
      parents: parents.map((parent) => ({ sha: parent })),
      commit: { message },
    });
    const first = squashed(PREDECESSOR, [BASE], "first (#18)");
    const second = squashed(SQUASH, [PREDECESSOR], "second (#17)");
    // GitHub's own suffix wins over a title that ends with another number.
    const titled = fixture({
      ...options,
      groupCompare: [
        first,
        squashed(SQUASH, [PREDECESSOR], "fix: see (#18) (#17)"),
      ],
    });
    await titled.execute();
    expect(titled.errors).toEqual([]);
    expect(lastOutput(titled).conclusion).toBe("success");
    for (const [groupCompare, code] of [
      [[], "CLA_UNEXPECTED_GROUP_COMMIT"],
      [
        [first, squashed(SQUASH, [PREDECESSOR], "no number")],
        "CLA_UNEXPECTED_GROUP_COMMIT",
      ],
      [
        [first, squashed(SQUASH, [PREDECESSOR], "body names it\n\n(#17)")],
        "CLA_UNEXPECTED_GROUP_COMMIT",
      ],
      [
        [first, squashed(SQUASH, [BASE], "second (#17)")],
        "CLA_UNEXPECTED_GROUP_COMMIT",
      ],
      [
        [first, squashed(SQUASH, [PREDECESSOR, HEAD], "second (#17)")],
        "CLA_UNEXPECTED_GROUP_COMMIT",
      ],
      [[first], "CLA_UNEXPECTED_GROUP_COMMIT"],
      [
        [squashed(PREDECESSOR, [BASE], "first (#17)"), second],
        "CLA_AMBIGUOUS_GROUP_CHAIN",
      ],
      [
        [
          squashed(PREDECESSOR, [BASE], "first (#17)"),
          squashed(SQUASH, [PREDECESSOR], "second (#18)"),
        ],
        "CLA_INVALID_QUEUE_REF",
      ],
    ] as const) {
      const run = fixture({ ...options, groupCompare: [...groupCompare] });
      await run.execute();
      expect(run.errors, JSON.stringify(groupCompare)).toEqual([code]);
      expect(lastOutput(run).conclusion).toBe("failure");
    }
    // The queue ref must name the group head's own entry base.
    const misnamed = fixture({
      ...options,
      payload: {
        merge_group: {
          ...options.payload.merge_group,
          head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${BASE}`,
        },
      },
    });
    await misnamed.execute();
    expect(misnamed.errors).toEqual(["CLA_INVALID_QUEUE_REF"]);
  });

  test("a 250 commit PR squashed into one queue commit verifies with one group comparison", async () => {
    const groupHead = "f".repeat(40);
    const commits = Array.from({ length: 250 }, (_, index) =>
      commit({
        sha: index === 249 ? HEAD : index.toString(16).padStart(40, "0"),
      }),
    );
    const run = fixture({
      event: "merge_group",
      payload: {
        merge_group: {
          head_sha: groupHead,
          base_sha: BASE,
          base_ref: "refs/heads/main",
          head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${BASE}`,
        },
      },
      pulls: [{ ...pull(), commits: 250 }],
      signatures: [signature()],
      commitsByPull: { 17: commits },
      queueEntries: [{ number: 17, head: groupHead, base: BASE }],
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).conclusion).toBe("success");
    const pages = run.requests
      .filter(
        ({ route, params }) =>
          route.endsWith("/compare/{basehead}") &&
          params["basehead"] === `${BASE}...${groupHead}`,
      )
      .map(({ params }) => params["page"]);
    // The group read and the entry check compare the one squash commit unpaged.
    expect(pages).toEqual([undefined, undefined]);
  });

  test("more than 250 commits and incomplete commit lists fail closed", async () => {
    for (const count of [251, 2]) {
      const run = fixture({
        signatures: [signature()],
        pulls: [{ ...pull(), commits: count }],
      });
      await run.execute();
      expect(lastOutput(run).conclusion).toBe("failure");
      expect(run.errors).toEqual([
        count > 250
          ? "CLA_COMMIT_LIMIT_EXCEEDED"
          : "CLA_INCOMPLETE_COMMIT_LIST",
      ]);
    }
  });

  test("unsigned outsiders receive one exact signing prompt and a failure on their head", async () => {
    const run = fixture();
    await run.execute();
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
    expect(lastOutput(run).conclusion).toBe("failure");
    expect(run.prompts()).toBe(1);
    const promptRequest = run.requests.find(
      ({ route }) => route.startsWith("POST") && route.endsWith("/comments"),
    );
    expect(promptRequest?.params["body"]).toContain(SENTENCE);
    expect(promptRequest?.params["body"]).toContain(
      "https://github.com/stella/cla/blob/main/CLA.md",
    );
  });

  test("an unrelated unsigned opener cannot pollute a member PR's shared-head contributor check", async () => {
    const run = fixture({
      pulls: [pull(), pull(18, { ...author, id: 102, login: "second-author" })],
      memberships: { [author.login]: { state: "active", role: "member" } },
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run, "cla").conclusion).toBe("success");
    expect(lastOutput(run, "cla/pr-17").conclusion).toBe("success");
    expect(run.created.some((check) => check["name"] === "cla/pr-18")).toBe(
      false,
    );
    const outsider = fixture({
      payload: { pull_request: { number: 18 } },
      pulls: [pull(), pull(18, { ...author, id: 102, login: "second-author" })],
      memberships: { [author.login]: { state: "active", role: "member" } },
      commitsByPull: { 18: [commit()] },
    });
    await outsider.execute();
    expect(outsider.errors).toEqual([]);
    expect(lastOutput(outsider, "cla").conclusion).toBe("success");
    expect(lastOutput(outsider, "cla/pr-18").output.title).toBe("CLA_UNSIGNED");
  });

  test("only active memberships exempt authors and signing comments are paginated", async () => {
    const pending = fixture({
      memberships: { [author.login]: { state: "pending", role: "member" } },
    });
    await pending.execute();
    expect(pending.errors).toEqual([]);
    expect(lastOutput(pending).output.title).toBe("CLA_UNSIGNED");
    const run = fixture({
      comments: [
        ...Array.from({ length: 150 }, () =>
          comment({ ...author, id: 102 }, "An unrelated comment"),
        ),
        comment(),
      ],
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).conclusion).toBe("success");
    expect(run.writes()).toBe(1);
  });

  test("existing numeric-ID signatures survive account renames without any store write", async () => {
    const old = signature();
    const run = fixture({ signatures: [old] });
    await run.execute();
    expect(lastOutput(run).conclusion).toBe("success");
    expect(run.stored().signedContributors).toEqual([old]);
    expect(run.writes()).toBe(0);
  });

  test("the PR author's exact signing comment flips the check and preserves signature metadata", async () => {
    const old = signature(99);
    const run = fixture({
      event: "issue_comment",
      payload: { issue: { number: 17, pull_request: {} } },
      signatures: [old],
      comments: [comment()],
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).conclusion).toBe("success");
    expect(run.stored()).toEqual({
      policyVersion: "unchanged",
      signedContributors: [
        old,
        {
          ...signature(),
          name: author.login,
          comment_id: 302,
          created_at: "2026-10-01T00:00:00Z",
          pullRequestNo: 17,
        },
      ],
    });
    await run.execute();
    expect(run.writes()).toBe(1);
  });

  test("other accounts and non-exact sentences cannot sign for the PR author", async () => {
    for (const signingComment of [
      comment({ ...author, id: 102 }),
      comment(author, `${SENTENCE}.`),
    ]) {
      const run = fixture({ comments: [signingComment] });
      await run.execute();
      expect(run.errors).toEqual([]);
      expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
      expect(run.writes()).toBe(0);
    }
  });

  test("conflicting signature writes re-read the blob and retain the other writer's records", async () => {
    const old = { ...signature(99), retainedMetadata: "legacy" };
    const run = fixture({
      signatures: [old],
      comments: [comment()],
      conflicts: 1,
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(run.writes()).toBe(2);
    expect(run.stored().signedContributors).toEqual([
      old,
      signature(1000),
      {
        ...signature(),
        name: author.login,
        comment_id: 302,
        created_at: "2026-10-01T00:00:00Z",
        pullRequestNo: 17,
      },
    ]);
    expect(lastOutput(run).conclusion).toBe("success");
  });

  test("exhausted conflicts and API permission errors fail closed with a reported check", async () => {
    for (const options of [
      { comments: [comment()], conflicts: 3 },
      { membershipError: 403 },
      { storeError: 403 },
    ]) {
      const run = fixture(options);
      await run.execute();
      expect(run.errors).toHaveLength(1);
      expect(lastOutput(run).output.title).toBe("CLA_ERROR");
      expect(lastOutput(run).conclusion).toBe("failure");
      expect(run.writes()).toBeLessThanOrEqual(3);
    }
  });

  test("dispatch re-evaluates validated PR numbers and prompts unsigned authors", async () => {
    const run = fixture({
      event: "workflow_dispatch",
      payload: { inputs: { pull_requests: "17, 18" } },
      pulls: [pull(), pull(18, { ...author, id: 102 })],
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(run.created).toHaveLength(4);
    expect(run.prompts()).toBe(2);
    const invalid = fixture({
      event: "workflow_dispatch",
      payload: { inputs: { pull_requests: "17; executable" } },
    });
    await invalid.execute();
    expect(invalid.errors).toEqual(["CLA_INVALID_DISPATCH_INPUT"]);
    expect(invalid.created).toEqual([]);
  });

  test("merge-group success requires every PR the group's commits name", async () => {
    const payload = {
      merge_group: {
        head_sha: SQUASH,
        base_sha: BASE,
        base_ref: "refs/heads/main",
        head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${PREDECESSOR}`,
      },
    };
    for (const signedSecond of [false, true]) {
      const run = fixture({
        event: "merge_group",
        payload,
        pulls: [
          pull(),
          pull(18, { ...author, id: 102, login: "second-author" }, OTHER_HEAD),
        ],
        memberships: { [author.login]: { state: "active", role: "member" } },
        signatures: signedSecond ? [signature(102)] : [],
      });
      await run.execute();
      expect(run.errors).toEqual([]);
      expect(run.created).toHaveLength(1);
      expect(run.created.at(0)?.["head_sha"]).toBe(SQUASH);
      expect(lastOutput(run).conclusion).toBe(
        signedSecond ? "success" : "failure",
      );
      if (!signedSecond) {
        expect(lastOutput(run).output.summary).toContain("#18");
      }
    }
  });

  test("privileged steps are pinned API actions with no executable PR-head data", () => {
    expect(readFileSync(WORKFLOW, "utf-8")).toContain("SECURITY INVARIANT");
    expect(workflow.jobs).not.toHaveProperty("cla");
    expect(steps).toHaveLength(3);
    expect(steps.map(({ uses }) => uses)).toEqual([
      expect.stringMatching(/^actions\/github-script@[a-f0-9]{40}$/u),
      expect.stringMatching(/^actions\/create-github-app-token@[a-f0-9]{40}$/u),
      expect.stringMatching(/^actions\/github-script@[a-f0-9]{40}$/u),
    ]);
    for (const step of steps) {
      expect(step).not.toHaveProperty("run");
      expect(step.uses).not.toContain("checkout");
    }
    expect(source).not.toContain("${{");
    expect(credentialsSource).not.toContain("${{");
    expect(source).not.toMatch(/\b(?:eval|require|exec|spawn)\s*\(/u);
    expect(credentialsSource).not.toMatch(
      /\b(?:eval|require|exec|spawn)\s*\(/u,
    );
    expect(steps.at(1)?.if).toBe(
      "steps.credentials.outputs.store_required == 'true'",
    );
    expect(scriptStep?.if).toBe(
      `\${{ !cancelled() && steps.credentials.outcome == 'success' }}`,
    );
    expect(workflow.jobs["verify-signatures"]?.if).toContain(
      "(github.event_name != 'workflow_run' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.actor.login == 'dependabot[bot]' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.path == '.github/workflows/cla-notify.yml' && github.event.workflow_run.event == 'pull_request'))",
    );
    expect(workflow.permissions).toEqual({
      contents: "read",
      checks: "write",
      issues: "write",
      "pull-requests": "read",
    });
    expect(workflow.on).toHaveProperty("merge_group");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).toHaveProperty("workflow_run");
    expect(source).not.toContain("author_association");
  });
});
