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

type QueuePage = {
  baseCommit: { oid: string } | null;
  headCommit: { oid: string } | null;
  pullRequest: { number: number };
}[];
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
  queuePages?: QueuePage[];
  // Served to every queue read after the first: the group was rebuilt.
  rebuiltQueuePages?: QueuePage[];
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
  queuePages = [
    [
      {
        headCommit: { oid: SQUASH },
        baseCommit: { oid: PREDECESSOR },
        pullRequest: { number: 17 },
      },
    ],
    [
      {
        headCommit: { oid: PREDECESSOR },
        baseCommit: { oid: BASE },
        pullRequest: { number: 18 },
      },
    ],
  ],
  rebuiltQueuePages,
}: FixtureOptions = {}) => {
  let queueReads = 0;
  const requests: {
    route: string;
    params: Record<string, unknown>;
    token: string;
  }[] = [];
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let store = { signedContributors: signatures, policyVersion: "unchanged" };
  let blob = BLOB;
  let writes = 0;
  let prompts = 0;
  const pullReads = new Map<number, number>();
  const commentsByPull = new Map(
    pulls.map(({ number }) => [number, [...comments]]),
  );
  const injectFailure = (route: string) => {
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
              content: Buffer.from(JSON.stringify(store)).toString("base64"),
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
        const entry = queuePages
          .flat()
          .find(
            (candidate) =>
              candidate.baseCommit !== null &&
              candidate.headCommit !== null &&
              basehead ===
                `${candidate.baseCommit.oid}...${candidate.headCommit.oid}`,
          );
        const groupPull = entry
          ? pulls.find(
              (candidate) => candidate.number === entry.pullRequest.number,
            )
          : undefined;
        const squash: CompareCommit[] =
          entry?.headCommit && entry.baseCommit && groupPull
            ? [
                {
                  ...commit({
                    user: groupPull.user,
                    sha: entry.headCommit.oid,
                  }),
                  parents: [{ sha: entry.baseCommit.oid }],
                },
              ]
            : [];
        const commits: CompareCommit[] = selected
          ? (comparedCommits ??
            commitsByPull?.[selected.number] ?? [
              commit({ user: selected.user, sha: selected.head.sha }),
            ])
          : (groupedCommits ?? squash);
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
      injectFailure(
        query.includes("authors(") ? "GRAPHQL authors" : "GRAPHQL queue",
      );
      if (query.includes("authors(")) {
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
      expect(query).toContain(
        "baseCommit { oid } headCommit { oid } pullRequest { number }",
      );
      expect(params["branch"]).toBe("main");
      const page = params["cursor"] === null ? 0 : Number(params["cursor"]);
      if (page === 0) {
        queueReads++;
      }
      const served =
        queueReads > 1 ? (rebuiltQueuePages ?? queuePages) : queuePages;
      return {
        repository: {
          mergeQueue: {
            entries: {
              nodes: served.at(page) ?? [],
              pageInfo: {
                hasNextPage: page + 1 < served.length,
                endCursor: String(page + 1),
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
            yield { data: commits.slice(index, index + 100) };
          }
          return;
        }
        if (route.includes("/commits/")) {
          yield {
            data: pulls.filter(({ head }) => head.sha === params["commit_sha"]),
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
      core: { setFailed: (message: string) => errors.push(message) },
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

  const assertActiveChecksFailed = (
    run: ReturnType<typeof fixture>,
    status: number,
  ) => {
    expect(run.errors).toEqual([`CLA_API_ERROR_${status}`]);
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
    ["queue", "GRAPHQL queue"],
    ["store-put", "PUT /repos/{owner}/{repo}/contents/{path}"],
  ])(
    "every API failure keeps active CLA checks unsuccessful at %s",
    async (boundary, route) => {
      const options =
        boundary === "queue"
          ? {
              event: "merge_group",
              payload: {
                merge_group: {
                  head_sha: HEAD,
                  base_sha: BASE,
                  base_ref: "refs/heads/main",
                  head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${HEAD}`,
                },
              },
              apiError: { route: "GRAPHQL queue", status: 500 },
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
      assertActiveChecksFailed(run, 500);
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
    expect(run.errors).toEqual(["CLA_API_ERROR_500"]);
    expect(lastOutput(run, "cla").conclusion).toBe("success");
    expect(lastOutput(run, "cla/pr-17").conclusion).toBe("failure");
    expect(lastOutput(run, "cla/pr-17").output.title).toBe("CLA_ERROR");
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
            queuePages: [
              [
                {
                  headCommit: { oid: SQUASH },
                  baseCommit: { oid: BASE },
                  pullRequest: { number: 17 },
                },
              ],
            ],
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
      queuePages: [
        [
          {
            baseCommit: { oid: groupBase },
            headCommit: { oid: groupHead },
            pullRequest: { number: 4694 },
          },
        ],
      ],
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

  test("a group rebuilt during verification ends neutral; a group still queued fails", async () => {
    const groupHead = "f".repeat(40);
    const predecessor = "1".repeat(40);
    const group = [
      {
        baseCommit: { oid: predecessor },
        headCommit: { oid: groupHead },
        pullRequest: { number: 17 },
      },
      {
        baseCommit: { oid: BASE },
        headCommit: { oid: predecessor },
        pullRequest: { number: 18 },
      },
    ];
    const options = {
      event: "merge_group",
      payload: {
        merge_group: {
          head_sha: groupHead,
          base_sha: BASE,
          base_ref: "refs/heads/main",
          head_ref: "refs/heads/gh-readonly-queue/main/pr-17-deadbeef",
        },
      },
      pulls: [pull(), pull(18, author, OTHER_HEAD)],
      signatures: [signature()],
      queuePages: [group],
      // #18 left the queue; GitHub rebuilt #17 alone on the base.
      rebuiltQueuePages: [
        [
          {
            baseCommit: { oid: BASE },
            headCommit: { oid: "2".repeat(40) },
            pullRequest: { number: 17 },
          },
        ],
      ],
    } satisfies FixtureOptions;
    for (const changes of [
      { changedPull: pull(17, author, "3".repeat(40)) },
      { pulls: [pull(), { ...pull(18, author, OTHER_HEAD), state: "closed" }] },
    ]) {
      const rebuilt = fixture({ ...options, ...changes });
      await rebuilt.execute();
      expect(rebuilt.errors, JSON.stringify(changes)).toEqual([]);
      expect(lastOutput(rebuilt).conclusion).toBe("neutral");
      expect(lastOutput(rebuilt).output.title).toBe("CLA_GROUP_SUPERSEDED");
      const queued = fixture({
        ...options,
        ...changes,
        rebuiltQueuePages: [group],
      });
      await queued.execute();
      expect(queued.errors).toHaveLength(1);
      expect(lastOutput(queued).conclusion).toBe("failure");
    }
    // A head the first snapshot never held (a lagging view or an unbuilt
    // entry) proves no transition, so it fails even when a re-read misses it.
    const unseen = fixture({
      ...options,
      queuePages: [
        [
          {
            baseCommit: { oid: BASE },
            headCommit: { oid: predecessor },
            pullRequest: { number: 18 },
          },
        ],
      ],
      rebuiltQueuePages: [[]],
    });
    await unseen.execute();
    expect(unseen.errors).toEqual(["CLA_INCOMPLETE_MERGE_GROUP"]);
    expect(lastOutput(unseen).conclusion).toBe("failure");
    // Entries with only one commit (an unmergeable entry keeps its base but
    // loses its head; a queued one has neither) never link the chain.
    const partial = [
      {
        baseCommit: { oid: predecessor },
        headCommit: null,
        pullRequest: { number: 19 },
      },
      {
        baseCommit: null,
        headCommit: { oid: "4".repeat(40) },
        pullRequest: { number: 20 },
      },
      { baseCommit: null, headCommit: null, pullRequest: { number: 21 } },
    ];
    const withPartial = fixture({
      ...options,
      queuePages: [[...group, ...partial]],
    });
    await withPartial.execute();
    expect(withPartial.errors).toEqual([]);
    expect(lastOutput(withPartial).conclusion).toBe("success");
    // The group's own predecessor losing its head leaves the chain incomplete.
    const groupHeadEntry = {
      baseCommit: { oid: predecessor },
      headCommit: { oid: groupHead },
      pullRequest: { number: 17 },
    };
    const brokenChain = fixture({
      ...options,
      queuePages: [
        [
          groupHeadEntry,
          {
            baseCommit: { oid: BASE },
            headCommit: null,
            pullRequest: { number: 18 },
          },
          ...partial,
        ],
      ],
      rebuiltQueuePages: [[groupHeadEntry]],
    });
    await brokenChain.execute();
    expect(brokenChain.errors).toEqual(["CLA_INCOMPLETE_MERGE_GROUP"]);
    expect(lastOutput(brokenChain).conclusion).toBe("failure");
    // An unexpected commit shape is not a membership change, even in a rebuilt group.
    const reshaped = fixture({
      ...options,
      groupedCommits: [commit({ sha: groupHead })],
    });
    await reshaped.execute();
    expect(reshaped.errors).toEqual(["CLA_UNEXPECTED_GROUP_COMMIT"]);
    expect(lastOutput(reshaped).conclusion).toBe("failure");
    // Only membership changes end neutral: an unsigned author in a rebuilt
    // group still fails.
    const unsigned = fixture({ ...options, signatures: [] });
    await unsigned.execute();
    expect(lastOutput(unsigned).conclusion).toBe("failure");
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
          head_ref: "refs/heads/gh-readonly-queue/main/pr-17-deadbeef",
        },
      },
      pulls: [{ ...pull(), commits: 250 }],
      signatures: [signature()],
      commitsByPull: { 17: commits },
      queuePages: [
        [
          {
            baseCommit: { oid: BASE },
            headCommit: { oid: groupHead },
            pullRequest: { number: 17 },
          },
        ],
      ],
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
    expect(pages).toEqual([undefined]);
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

  test("merge-group success requires every PR in the complete paginated queue chain", async () => {
    const payload = {
      merge_group: {
        head_sha: SQUASH,
        base_sha: BASE,
        base_ref: "refs/heads/main",
        head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${BASE}`,
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
    const missing = fixture({
      event: "merge_group",
      payload,
      queuePages: [
        [
          {
            headCommit: { oid: SQUASH },
            baseCommit: { oid: OTHER_HEAD },
            pullRequest: { number: 17 },
          },
        ],
      ],
      memberships: { [author.login]: { state: "active", role: "member" } },
    });
    await missing.execute();
    expect(missing.errors).toContain("CLA_INCOMPLETE_MERGE_GROUP");
    expect(lastOutput(missing).conclusion).toBe("failure");
    const ambiguous = fixture({
      event: "merge_group",
      payload,
      queuePages: [
        [
          {
            headCommit: { oid: SQUASH },
            baseCommit: { oid: OTHER_HEAD },
            pullRequest: { number: 17 },
          },
          {
            headCommit: { oid: SQUASH },
            baseCommit: { oid: BASE },
            pullRequest: { number: 18 },
          },
        ],
      ],
    });
    await ambiguous.execute();
    expect(ambiguous.errors).toContain("CLA_AMBIGUOUS_GROUP_CHAIN");
  });

  test("privileged steps are pinned API actions with no executable PR-head data", () => {
    expect(readFileSync(WORKFLOW, "utf-8")).toContain("SECURITY INVARIANT");
    expect(workflow.jobs).not.toHaveProperty("cla");
    expect(steps).toHaveLength(3);
    expect(steps.map(({ uses }) => uses)).toEqual([
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
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
