import { describe, expect, test } from "bun:test";

import {
  MAIN_HEAVY,
  MAIN_INCIDENT_LABEL,
  reconcileMainHealth,
  type MainHealthApi,
  type MainHealthOptions,
} from "./main-health";

const ROOT = "0".repeat(40);
const GREEN_BEFORE_A = "1".repeat(40);
const RED_A = "2".repeat(40);
const GREEN_BEFORE_B = "3".repeat(40);
const RED_B = "4".repeat(40);
const REVERT_A_HEAD = "5".repeat(40);
const REVERT_A_MERGE = "6".repeat(40);
const REVERT_B_HEAD = "7".repeat(40);
const FOREIGN = "8".repeat(40);
const REPO = { owner: "stella", repo: "stella" };
const ACTOR = "recovery[bot]";
type Json = Record<string, unknown>;

const change = (filename: string, inverse = false) => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: inverse
    ? "@@ -1,3 +1,3 @@\n context\n-after\n+before\n tail"
    : "@@ -1,3 +1,3 @@\n context\n-before\n+after\n tail",
});

const fixture = () => {
  let mainHead = RED_B;
  const history = [RED_B, GREEN_BEFORE_B, RED_A, GREEN_BEFORE_A];
  const commits = new Map<string, Json>([
    [GREEN_BEFORE_A, { sha: GREEN_BEFORE_A, parents: [{ sha: ROOT }] }],
    [RED_A, { sha: RED_A, parents: [{ sha: GREEN_BEFORE_A }] }],
    [GREEN_BEFORE_B, { sha: GREEN_BEFORE_B, parents: [{ sha: RED_A }] }],
    [RED_B, { sha: RED_B, parents: [{ sha: GREEN_BEFORE_B }] }],
  ]);
  const writes: { route: string; args: Json }[] = [];
  const reads: { route: string; args: Json }[] = [];
  const checks = new Map<string, Json[]>();
  const issues: Json[] = [];
  const pulls = new Map<number, Json>();
  const proposals: { culprit: string; number: number }[] = [];
  const runs = new Map<number, Json>();
  const statuses = new Map<string, Json[]>();
  const comparisons = new Map<string, Json[]>([
    [`${GREEN_BEFORE_A}...${RED_A}`, [change("scripts/first.ts")]],
    [`${GREEN_BEFORE_B}...${RED_B}`, [change("scripts/second.ts")]],
  ]);
  const originals = [
    { culprit: RED_A, number: 10, file: "scripts/first.ts" },
    { culprit: RED_B, number: 20, file: "scripts/second.ts" },
  ];
  for (const original of originals) {
    pulls.set(original.number, {
      number: original.number,
      node_id: `PR_${original.number}`,
      state: "closed",
      merged: true,
      merged_at: "2026-10-02T12:00:00Z",
      merge_commit_sha: original.culprit,
      base: { ref: "main", repo: { full_name: "stella/stella" } },
      changed_files: 1,
      title: `fix: ${original.file}`,
      labels: [],
      user: { login: "maintainer" },
      body: "Original change",
    });
  }
  const setHeavy = (commit: string, state: "success" | "failure") => {
    const id = history.indexOf(commit) + 100;
    const link = `https://github.com/stella/stella/actions/runs/${id}`;
    runs.set(id, {
      id,
      path: MAIN_HEAVY.path,
      name: MAIN_HEAVY.name,
      repository: { full_name: "stella/stella" },
      head_branch: "main",
      head_sha: commit,
      display_title: `${MAIN_HEAVY.testedPrefix}${commit}`,
      html_url: link,
      event: "push",
      status: "completed",
      conclusion: state,
    });
    statuses.set(commit, [
      {
        context: MAIN_HEAVY.context,
        state,
        creator: { login: MAIN_HEAVY.publisher },
        target_url: link,
      },
    ]);
  };
  setHeavy(GREEN_BEFORE_A, "success");
  setHeavy(RED_A, "failure");
  setHeavy(GREEN_BEFORE_B, "success");
  setHeavy(RED_B, "failure");
  const isAncestor = (base: string, head: string) => {
    let current = head;
    const visited = new Set<string>();
    while (!visited.has(current)) {
      if (current === base) {
        return true;
      }
      visited.add(current);
      const parents = commits.get(current)?.parents;
      if (!Array.isArray(parents)) {
        return false;
      }
      const first: unknown = parents.at(0);
      if (
        !first ||
        typeof first !== "object" ||
        !("sha" in first) ||
        typeof first.sha !== "string"
      ) {
        return false;
      }
      current = first.sha;
    }
    return false;
  };
  const api: MainHealthApi = {
    request: async (route, args) => {
      if (!route.startsWith("GET")) {
        writes.push({ route, args });
        if (route.endsWith("/check-runs")) {
          const key = String(args.head_sha);
          const values = checks.get(key) ?? [];
          values.push({ ...args, app: { slug: "github-actions" } });
          checks.set(key, values);
        } else if (route.endsWith("/issues")) {
          issues.push({ ...args, number: 1000 + issues.length, state: "open" });
        } else if (route.endsWith("/issues/{issue_number}/labels")) {
          const pull = pulls.get(Number(args.issue_number));
          if (!pull) {
            throw new Error("FAKE_UNKNOWN_LABELED_PULL");
          }
          pull.labels = [{ name: MAIN_INCIDENT_LABEL }];
        } else if (
          route === "PATCH /repos/{owner}/{repo}/issues/{issue_number}"
        ) {
          const issue = issues.find(
            (entry) => entry.number === args.issue_number,
          );
          if (!issue) {
            throw new Error("FAKE_UNKNOWN_PATCHED_ISSUE");
          }
          issue.state = args.state;
        } else {
          throw new Error(`UNEXPECTED_FAKE_WRITE ${route}`);
        }
        return { data: {} };
      }
      reads.push({ route, args });
      let data: unknown;
      if (route.endsWith("/git/ref/{ref}")) {
        data = { object: { sha: mainHead } };
      } else if (route === "GET /repos/{owner}/{repo}/commits") {
        expect(args.sha).toBe(mainHead);
        expect(args.per_page).toBe(100);
        data =
          args.page === 1 ? history.map((commit) => commits.get(commit)) : [];
      } else if (route.endsWith("/git/commits/{commit_sha}")) {
        data = commits.get(String(args.commit_sha));
      } else if (route.endsWith("/compare/{basehead}")) {
        const [base, head] = String(args.basehead).split("...");
        if (!base || !head) {
          throw new Error("FAKE_INVALID_COMPARISON");
        }
        data = {
          merge_base_commit: { sha: isAncestor(base, head) ? base : ROOT },
          files: comparisons.get(`${base}...${head}`) ?? [],
        };
      } else if (route.endsWith("/statuses")) {
        data = statuses.get(String(args.ref)) ?? [];
      } else if (route.endsWith("/actions/runs/{run_id}")) {
        data = runs.get(Number(args.run_id));
      } else if (route.endsWith("/check-runs")) {
        data = { check_runs: checks.get(String(args.ref)) ?? [] };
      } else if (route.endsWith("/commits/{commit_sha}/pulls")) {
        data = [...pulls.values()].filter(
          (pull) => pull.merge_commit_sha === args.commit_sha,
        );
      } else if (route.endsWith("/pulls/{pull_number}")) {
        data = pulls.get(Number(args.pull_number));
      } else if (route.endsWith("/pulls")) {
        data = [...pulls.values()].filter(
          (pull) => args.state === "all" || pull.state === args.state,
        );
      } else if (route.endsWith("/issues")) {
        data = [
          ...issues,
          ...[...pulls.values()]
            .filter(
              (pull) =>
                Array.isArray(pull.labels) &&
                pull.labels.some(
                  (label: unknown) =>
                    !!label &&
                    typeof label === "object" &&
                    "name" in label &&
                    label.name === MAIN_INCIDENT_LABEL,
                ),
            )
            .map((pull) => {
              const issue = structuredClone(pull);
              issue["pull_request"] = {};
              return issue;
            }),
        ].filter((issue) => issue.state === "open");
      } else if (route.endsWith("/labels")) {
        data = [{ name: MAIN_INCIDENT_LABEL }];
      } else if (route.endsWith("/tags")) {
        data = [];
      } else if (route.endsWith("/jobs")) {
        data = { jobs: [{ name: "Heavy suite", conclusion: "failure" }] };
      } else {
        throw new Error(`UNEXPECTED_FAKE_ROUTE ${route}`);
      }
      return { data };
    },
    graphql: async (query, args) => {
      if (query.includes("viewer")) {
        reads.push({ route: "GRAPHQL", args: { query, ...args } });
        return { viewer: { login: ACTOR } };
      }
      if (!query.includes("revertPullRequest")) {
        throw new Error("UNEXPECTED_FAKE_MUTATION");
      }
      const input = args.input;
      if (
        !input ||
        typeof input !== "object" ||
        !("pullRequestId" in input) ||
        !("body" in input)
      ) {
        throw new Error("FAKE_INVALID_REVERT_INPUT");
      }
      const original = originals.find(
        (entry) => `PR_${entry.number}` === input.pullRequestId,
      );
      if (!original) {
        throw new Error("FAKE_UNKNOWN_ORIGINAL_PULL");
      }
      writes.push({ route: "GRAPHQL", args });
      const head = original.culprit === RED_A ? REVERT_A_HEAD : REVERT_B_HEAD;
      const pullNumber = original.number + 1;
      commits.set(head, {
        sha: head,
        parents: [{ sha: mainHead }],
        verification: { verified: true },
      });
      comparisons.set(`${mainHead}...${head}`, [change(original.file, true)]);
      pulls.set(pullNumber, {
        number: pullNumber,
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        user: { login: ACTOR },
        body: input.body,
        labels: [],
        changed_files: 1,
        base: { ref: "main", repo: { full_name: "stella/stella" } },
        head: {
          sha: head,
          ref: `revert-${original.number}`,
          repo: { full_name: "stella/stella" },
        },
      });
      proposals.push({ culprit: original.culprit, number: pullNumber });
      return {
        revertPullRequest: {
          revertPullRequest: {
            number: pullNumber,
            headRefOid: head,
            author: { login: ACTOR },
          },
        },
      };
    },
  };
  const reconcile = (eventName = "schedule") => {
    const options = {
      github: api,
      writer: api,
      context: {
        repo: REPO,
        eventName,
        payload:
          eventName === "workflow_run" ? { workflow_run: runs.get(100) } : {},
      },
      config: { autoRevert: "on" },
    } satisfies MainHealthOptions;
    return reconcileMainHealth(options);
  };
  const mergeA = () => {
    const pull = pulls.get(11);
    if (!pull) {
      throw new Error("FAKE_A_REVERT_NOT_OPENED");
    }
    Object.assign(pull, {
      state: "closed",
      merged: true,
      merged_at: "2026-10-02T13:00:00Z",
      merge_commit_sha: REVERT_A_MERGE,
    });
    commits.set(REVERT_A_MERGE, {
      sha: REVERT_A_MERGE,
      parents: [{ sha: mainHead }],
      verification: { verified: true },
    });
    comparisons.set(`${mainHead}...${REVERT_A_MERGE}`, [
      change("scripts/first.ts", true),
    ]);
    mainHead = REVERT_A_MERGE;
    history.unshift(REVERT_A_MERGE);
  };
  return {
    api,
    reconcile,
    mergeA,
    proposals,
    writes,
    reads,
    history,
    commits,
    statuses,
    checks,
    pulls,
    setHeavy,
  };
};

describe("main health reconciles replaced workflow events", () => {
  test("two independent reds are handled oldest first, once each", async () => {
    const f = fixture();
    expect(f.history).toEqual([RED_B, GREEN_BEFORE_B, RED_A, GREEN_BEFORE_A]);
    const first = await f.reconcile("workflow_run");
    expect(first).toMatchObject({
      sha: RED_A,
      title: "MAIN_RED_REVERT_OPENED",
      queue: { pullNumber: 11, head: REVERT_A_HEAD },
    });
    expect(f.proposals).toEqual([{ culprit: RED_A, number: 11 }]);
    await f.reconcile();
    expect(f.proposals).toEqual([{ culprit: RED_A, number: 11 }]);
    expect(
      f.checks
        .get(RED_A)
        ?.some((check) =>
          JSON.stringify(check).includes(
            `<!-- main-health-revert:11:${REVERT_A_HEAD}:${ACTOR} -->`,
          ),
        ),
    ).toBe(true);
    f.mergeA();
    const second = await f.reconcile();
    expect(second).toMatchObject({
      sha: RED_B,
      title: "MAIN_RED_REVERT_OPENED",
      queue: { pullNumber: 21, head: REVERT_B_HEAD },
    });
    expect(f.proposals).toEqual([
      { culprit: RED_A, number: 11 },
      { culprit: RED_B, number: 21 },
    ]);
    await f.reconcile();
    expect(f.proposals).toHaveLength(2);
    expect(
      f.reads.some(
        (read) =>
          read.route === "GET /repos/{owner}/{repo}/commits" &&
          read.args.page === 1,
      ),
    ).toBe(true);
  });

  test("a green history proposes no revert", async () => {
    const f = fixture();
    f.setHeavy(RED_A, "success");
    f.setHeavy(RED_B, "success");
    await f.reconcile();
    expect(f.proposals).toHaveLength(0);
    expect(f.writes.filter((write) => write.route === "GRAPHQL")).toHaveLength(
      0,
    );
  });

  test.each(["head", "parent", "duplicate"])(
    "invalid %s history fails closed",
    async (corruption) => {
      const f = fixture();
      if (corruption === "head") {
        f.history[0] = GREEN_BEFORE_B;
      } else if (corruption === "parent") {
        f.commits.set(RED_B, { sha: RED_B, parents: [{ sha: FOREIGN }] });
      } else {
        f.history.splice(1, 0, RED_B);
      }
      expect(await f.reconcile()).toMatchObject({
        title: "MAIN_RED_ESCALATED",
        reason:
          corruption === "head"
            ? "INVALID_MAIN_HISTORY"
            : "NON_LINEAR_MAIN_HISTORY",
      });
      expect(f.proposals).toHaveLength(0);
      expect(
        f.writes.filter((write) => write.route === "GRAPHQL"),
      ).toHaveLength(0);
    },
  );
  test.each(["skipped", "neutral"])(
    "heavy %s event performs no API work",
    async (conclusion) => {
      const f = fixture();
      const options = {
        github: f.api,
        writer: f.api,
        context: {
          repo: REPO,
          eventName: "workflow_run",
          payload: { workflow_run: { path: MAIN_HEAVY.path, conclusion } },
        },
        config: { autoRevert: "on" },
      } satisfies MainHealthOptions;
      expect(await reconcileMainHealth(options)).toEqual({
        title: "IGNORED",
        reason: "NO_HEAVY_KNOWLEDGE",
      });
      expect(f.reads).toHaveLength(0);
      expect(f.writes).toHaveLength(0);
      expect(f.proposals).toHaveLength(0);
    },
  );
});

test("an all-skipped push with success conclusion and no status is a cheap no-op", async () => {
  const reads: string[] = [];
  const api: MainHealthApi = {
    request: async (route) => {
      reads.push(route);
      return { data: [] };
    },
    graphql: async () => {
      throw new Error("UNEXPECTED_GRAPHQL_WRITE");
    },
  };
  const result = await reconcileMainHealth({
    github: api,
    writer: api,
    config: { autoRevert: "on" },
    context: {
      repo: REPO,
      eventName: "workflow_run",
      payload: {
        workflow_run: {
          id: 100,
          path: MAIN_HEAVY.path,
          repository: { full_name: "stella/stella" },
          event: "push",
          head_branch: "main",
          head_sha: RED_B,
          display_title: `${MAIN_HEAVY.testedPrefix}${RED_B}`,
          html_url: "https://github.com/stella/stella/actions/runs/100",
          conclusion: "success",
        },
      },
    },
  });
  expect(result).toEqual({ title: "IGNORED", reason: "NO_HEAVY_KNOWLEDGE" });
  expect(reads).toEqual(["GET /repos/{owner}/{repo}/commits/{ref}/statuses"]);
});
