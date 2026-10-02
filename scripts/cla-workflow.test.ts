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
const stepSchema = v.looseObject({
  name: v.string(),
  uses: v.string(),
  if: v.optional(v.string()),
  with: v.record(v.string(), v.unknown()),
});
const workflowSchema = v.looseObject({
  on: v.record(v.string(), v.unknown()),
  permissions: v.record(v.string(), v.string()),
  jobs: v.record(v.string(), v.looseObject({ steps: v.array(stepSchema) })),
});
const workflow = v.parse(
  workflowSchema,
  Bun.YAML.parse(readFileSync(WORKFLOW, "utf-8")),
);
const steps = workflow.jobs["verify-signatures"]?.steps ?? [];
const scriptStep = steps.find(({ uses }) =>
  uses.startsWith("actions/github-script@"),
);
const source = v.parse(v.string(), scriptStep?.with["script"]);
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

type FixtureOptions = {
  event?: string;
  payload?: Record<string, unknown>;
  pulls?: ReturnType<typeof pull>[];
  memberships?: Record<string, { state: string; role: string }>;
  commitsByPull?: Record<number, ReturnType<typeof commit>[]>;
  changedPull?: ReturnType<typeof pull>;
  comparedCommits?: ReturnType<typeof commit>[];
  groupAncestor?: string;
  groupedCommits?: ReturnType<typeof commit>[];
  comments?: ReturnType<typeof comment>[];
  signatures?: ReturnType<typeof signature>[];
  conflicts?: number;
  membershipError?: number;
  storeError?: number;
  queuePages?: {
    baseCommit: { oid: string };
    headCommit: { oid: string };
    pullRequest: { number: number };
  }[][];
};
const fixture = ({
  event = "pull_request_target",
  payload = { pull_request: { number: 17 } },
  pulls = [pull()],
  memberships = {},
  commitsByPull,
  changedPull,
  comparedCommits,
  groupAncestor,
  groupedCommits,
  comments = [],
  signatures = [],
  conflicts = 0,
  membershipError,
  storeError,
  queuePages = [
    [
      {
        headCommit: { oid: HEAD },
        baseCommit: { oid: OTHER_HEAD },
        pullRequest: { number: 17 },
      },
    ],
    [
      {
        headCommit: { oid: OTHER_HEAD },
        baseCommit: { oid: BASE },
        pullRequest: { number: 18 },
      },
    ],
  ],
}: FixtureOptions = {}) => {
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
  class Api {
    token: string;
    constructor({ auth = "base-fixture" } = {}) {
      this.token = auth;
    }
    async request(route: string, params: Record<string, unknown>) {
      requests.push({ route, params, token: this.token });
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
        const ancestryPull = pulls.find((candidate) =>
          basehead.startsWith(`${candidate.head.sha}...`),
        );
        const entry = queuePages
          .flat()
          .find(
            (candidate) =>
              basehead ===
              `${candidate.baseCommit.oid}...${candidate.headCommit.oid}`,
          );
        // Group fixtures may share their SHA with a PR; either route represents the same commits.
        const groupPull = entry
          ? pulls.find(
              (candidate) => candidate.number === entry.pullRequest.number,
            )
          : undefined;
        const candidate = selected ?? groupPull;
        const commits =
          (entry && !selected ? groupedCommits : undefined) ??
          comparedCommits ??
          (candidate
            ? (commitsByPull?.[candidate.number] ?? [
                commit({ user: candidate.user, sha: candidate.head.sha }),
              ])
            : []);
        return {
          data: {
            commits,
            total_commits: commits.length,
            merge_base_commit: {
              sha: groupAncestor ?? ancestryPull?.head.sha ?? BASE,
            },
          },
        };
      }
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        expect(params["name"]).toBe("cla");
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
      expect(query).toContain(
        "baseCommit { oid } headCommit { oid } pullRequest { number }",
      );
      expect(params["branch"]).toBe("main");
      const page = params["cursor"] === null ? 0 : Number(params["cursor"]);
      return {
        repository: {
          mergeQueue: {
            entries: {
              nodes: queuePages.at(page) ?? [],
              pageInfo: {
                hasNextPage: page + 1 < queuePages.length,
                endCursor: String(page + 1),
              },
            },
          },
        },
      };
    }
    paginate = {
      async *iterator(route: string, params: Record<string, unknown>) {
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
  const execute = async () => {
    const result: unknown = runInNewContext(`(async () => { ${source}\n })()`, {
      github: new Api(),
      context: {
        eventName: event,
        payload,
        repo: { owner: "stella", repo: "stella" },
      },
      core: { setFailed: (message: string) => errors.push(message) },
      process: { env: { CLA_STORE_TOKEN: "store-fixture" } },
      Buffer,
    });
    await result;
  };
  return {
    execute,
    requests,
    created,
    updates,
    errors,
    stored: () => store,
    writes: () => writes,
    prompts: () => prompts,
  };
};
const lastOutput = (run: ReturnType<typeof fixture>) =>
  v.parse(
    v.object({
      conclusion: v.string(),
      output: v.object({ title: v.string(), summary: v.string() }),
    }),
    run.updates.at(-1),
  );

describe("contributor signature workflow", () => {
  test("members, owners, allowlisted accounts, Bot authors and Dependabot always report success", async () => {
    for (const options of [
      { memberships: { [author.login]: { state: "active", role: "member" } } },
      { memberships: { [author.login]: { state: "active", role: "admin" } } },
      { pulls: [pull(17, { ...author, login: "cursoragent" })] },
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
          commit({ committer: { ...author, id: 19_864_447, login: "web-flow" } }),
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
        sha: index.toString(16).padStart(40, "0"),
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

  test("merge groups cannot verify a replaced PR head or additional old commits", async () => {
    const groupHead = "f".repeat(40);
    const predecessor = "1".repeat(40);
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
      queuePages: [
        [
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
        ],
      ],
    } satisfies FixtureOptions;
    const changed = fixture({ ...options, groupAncestor: BASE });
    await changed.execute();
    expect(changed.errors).toEqual(["CLA_GROUP_PULL_CHANGED"]);
    const extra = fixture({
      ...options,
      groupedCommits: [commit(), commit({ sha: "2".repeat(40) })],
    });
    await extra.execute();
    expect(extra.errors).toEqual(["CLA_GROUP_COMMIT_SNAPSHOT_CHANGED"]);
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

  test("a member PR sharing a head cannot hide an unsigned outsider's check", async () => {
    const run = fixture({
      pulls: [pull(), pull(18, { ...author, id: 102, login: "second-author" })],
      memberships: { [author.login]: { state: "active", role: "member" } },
    });
    await run.execute();
    expect(run.errors).toEqual([]);
    expect(lastOutput(run).conclusion).toBe("failure");
    expect(lastOutput(run).output.title).toBe("CLA_UNSIGNED");
    expect(lastOutput(run).output.summary).toContain("#18");
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
    expect(run.created).toHaveLength(2);
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
        head_sha: HEAD,
        base_sha: BASE,
        base_ref: "refs/heads/main",
        head_ref: `refs/heads/gh-readonly-queue/main/pr-17-${HEAD}`,
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
      expect(run.created.at(0)?.["head_sha"]).toBe(HEAD);
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
            headCommit: { oid: HEAD },
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
            headCommit: { oid: HEAD },
            baseCommit: { oid: OTHER_HEAD },
            pullRequest: { number: 17 },
          },
          {
            headCommit: { oid: HEAD },
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
    expect(steps).toHaveLength(2);
    expect(steps.map(({ uses }) => uses)).toEqual([
      "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
    ]);
    for (const step of steps) {
      expect(step).not.toHaveProperty("run");
      expect(step.uses).not.toContain("checkout");
    }
    expect(source).not.toContain("${{");
    expect(source).not.toMatch(/\b(?:eval|require|exec|spawn)\s*\(/u);
    expect(scriptStep?.if).toBe(`\${{ !cancelled() }}`);
    expect(workflow.permissions).toEqual({
      contents: "read",
      checks: "write",
      issues: "write",
      "pull-requests": "read",
    });
    expect(workflow.on).toHaveProperty("merge_group");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(source).not.toContain("author_association");
  });
});
