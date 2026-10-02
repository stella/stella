import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  createMainHealthApi,
  MAIN_HEAVY,
  MAIN_INCIDENT_LABEL,
  runMainHealth,
  autoRevertEnabled,
  verifyInverseDiff,
  verifyReleaseHealth,
  verifyRevertCandidate,
  type MainHealthApi,
} from "./main-health";

const GREEN = "a".repeat(40);
const PARENT = "b".repeat(40);
const RED = "c".repeat(40);
const REVERT = "d".repeat(40);
const repo = { owner: "stella", repo: "stella" };
const file = {
  filename: "scripts/example.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,3 +1,3 @@\n context\n-before\n+after\n tail",
};
const inverse = {
  ...file,
  patch: "@@ -8,3 +8,3 @@\n context\n-after\n+before\n tail",
};
type Json = Record<string, unknown>;
const fixture = () => {
  const writes: { route: string; args: Json }[] = [];
  const checks = new Map<string, Json[]>();
  const issues: Json[] = [];
  const runs = new Map<number, Json>();
  const statuses = new Map<string, Json[]>();
  const commits = new Map<string, Json>([
    [RED, { parents: [{ sha: PARENT }] }],
    [PARENT, { parents: [{ sha: GREEN }] }],
    [REVERT, { parents: [{ sha: RED }], verification: { verified: true } }],
  ]);
  const original: Json = {
    number: 10,
    node_id: "PR_original",
    merged: true,
    merged_at: "2026-10-02",
    merge_commit_sha: RED,
    base: { ref: "main", repo: { full_name: "stella/stella" } },
    changed_files: 1,
    title: "fix: example",
    labels: [],
  };
  const pull: Json = {
    user: { login: "recovery[bot]" },
    number: 11,
    state: "open",
    draft: false,
    merged: false,
    body: `<!-- main-health:${RED} -->`,
    changed_files: 1,
    base: { ref: "main", repo: { full_name: "stella/stella" } },
    head: {
      sha: REVERT,
      ref: "revert-10-example",
      repo: { full_name: "stella/stella" },
    },
  };
  const existing: Json[] = [];
  const tags: Json[] = [];
  const originalFiles: Json[] = [structuredClone(file)];
  const revertFiles: Json[] = [structuredClone(inverse)];
  let graphError = false;
  const divergent = new Set<string>();
  const setHeavy = (
    commit: string,
    state: "success" | "failure" | "pending",
    event = "push",
  ) => {
    const id = new Map([
      [RED, 30],
      [PARENT, 20],
      [GREEN, 10],
    ]).get(commit);
    if (!id) {
      throw new Error("MISSING_FIXTURE_SHA");
    }
    const link = `https://github.com/stella/stella/actions/runs/${id}`;
    runs.set(id, {
      id,
      path: MAIN_HEAVY.path,
      name: MAIN_HEAVY.name,
      repository: { full_name: "stella/stella" },
      head_branch: "main",
      head_sha: event === "workflow_dispatch" ? RED : commit,
      display_title: `${MAIN_HEAVY.testedPrefix}${commit}`,
      html_url: link,
      event,
      status: state === "pending" ? "in_progress" : "completed",
      conclusion: state === "pending" ? null : state,
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
  setHeavy(GREEN, "success");
  setHeavy(PARENT, "success");
  setHeavy(RED, "failure");
  const api: MainHealthApi = {
    request: async (route, args) => {
      if (route.startsWith("POST") || route.startsWith("PATCH")) {
        writes.push({ route, args });
        if (route.endsWith("/check-runs")) {
          const values = checks.get(String(args.head_sha)) ?? [];
          values.push({ ...args, app: { slug: "github-actions" } });
          checks.set(String(args.head_sha), values);
        }
        if (route.endsWith("/issues")) {
          issues.push({ ...args, number: 100, state: "open" });
        }
        if (route.endsWith("/labels") && args.issue_number === 11) {
          issues.push({ ...pull, pull_request: {} });
        }
        if (route.startsWith("PATCH")) {
          const issue = issues.find(
            (value) => value.number === args.issue_number,
          );
          if (issue) {
            issue.state = args.state;
          }
        }
        return { data: {} };
      }
      let data: unknown;
      if (route.endsWith("/git/ref/{ref}")) {
        data = { object: { sha: RED } };
      } else if (route.endsWith("/compare/{basehead}")) {
        const [base, head] = String(args.basehead).split("...");
        let comparisonFiles: Json[] = [];
        if (head === original.merge_commit_sha) {
          comparisonFiles = originalFiles;
        } else if (base === RED && head === REVERT) {
          comparisonFiles = revertFiles;
        }
        data = {
          merge_base_commit: {
            sha: divergent.has(String(base)) ? GREEN : base,
          },
          files: comparisonFiles,
        };
      } else if (route.endsWith("/statuses")) {
        data = statuses.get(String(args.ref)) ?? [];
      } else if (route.endsWith("/actions/runs/{run_id}")) {
        data = runs.get(Number(args.run_id));
      } else if (route.endsWith("/issues")) {
        data = issues.filter((issue) => issue.state !== "closed");
      } else if (route.endsWith("/labels")) {
        data = [{ name: MAIN_INCIDENT_LABEL }];
      } else if (route.endsWith("/git/commits/{commit_sha}")) {
        data = commits.get(String(args.commit_sha));
      } else if (route.endsWith("/commits/{commit_sha}/pulls")) {
        data = [original];
      } else if (route.endsWith("/pulls/{pull_number}")) {
        data = args.pull_number === 10 ? original : pull;
      } else if (route.endsWith("/pulls")) {
        data = existing;
      } else if (route.endsWith("/tags")) {
        data = tags;
      } else if (route.endsWith("/check-runs")) {
        data = { check_runs: checks.get(String(args.ref)) ?? [] };
      } else if (route.endsWith("/jobs")) {
        data = { jobs: [{ name: "Heavy unit tests", conclusion: "failure" }] };
      } else {
        throw new Error(`UNEXPECTED_FAKE_ROUTE ${route}`);
      }
      return { data };
    },
    graphql: async (query, args) => {
      if (query.includes("viewer")) {
        return { viewer: { login: "recovery[bot]" } };
      }
      writes.push({ route: "GRAPHQL", args: { query, ...args } });
      if (graphError) {
        throw new Error("GRAPHQL_REVERT_CONFLICT");
      }
      if (
        typeof args.input === "object" &&
        args.input !== null &&
        "body" in args.input
      ) {
        pull.body = args.input.body;
      }
      existing.push(pull);
      return {
        revertPullRequest: {
          revertPullRequest: {
            number: 11,
            headRefOid: REVERT,
            author: { login: "recovery[bot]" },
          },
        },
      };
    },
  };
  const run = (
    options: { enabled?: string; eventName?: string; runId?: number } = {},
  ) =>
    runMainHealth({
      github: api,
      writer: api,
      context: {
        repo,
        eventName: options.eventName ?? "workflow_dispatch",
        payload: options.runId
          ? { workflow_run: { id: options.runId } }
          : { inputs: { sha: RED } },
      },
      config: { autoRevert: options.enabled ?? "on" },
    });
  return {
    api,
    run,
    writes,
    checks,
    issues,
    statuses,
    runs,
    setHeavy,
    original,
    pull,
    existing,
    tags,
    originalFiles,
    revertFiles,
    commits,
    divergent,
    conflict: () => {
      graphError = true;
    },
  };
};
const codeWrites = (f: ReturnType<typeof fixture>) =>
  f.writes.filter(
    (write) => write.route === "GRAPHQL" || write.route.endsWith("/dispatches"),
  );
describe("main recovery with a fake GitHub", () => {
  test("a non-main SHA cannot create an incident or revert", async () => {
    const f = fixture();
    f.divergent.add(RED);
    expect((await f.run()).reason).toBe("NOT_ON_MAIN");
    expect(f.writes).toHaveLength(0);
  });
  test.each([undefined, "", "off", "ON ", "on"])(
    "only exact on enables the workflow snapshot (%j)",
    async (value) => {
      expect(autoRevertEnabled(value)).toBe(value === "on");
      const f = fixture();
      const result = await runMainHealth({
        github: f.api,
        writer: f.api,
        context: {
          repo,
          eventName: "workflow_dispatch",
          payload: { inputs: { sha: RED } },
        },
        config: { autoRevert: value },
      });
      expect(result.title).toBe(
        value === "on" ? "MAIN_RED_REVERT_OPENED" : "MAIN_RED_ESCALATED",
      );
      expect(codeWrites(f)).toHaveLength(value === "on" ? 1 : 0);
    },
  );
  test("nightly heavy runs use the same trusted commit binding", async () => {
    const f = fixture();
    f.setHeavy(RED, "failure", "schedule");
    expect((await f.run({ eventName: "workflow_run", runId: 30 })).title).toBe(
      "MAIN_RED_REVERT_OPENED",
    );
    expect(codeWrites(f)).toHaveLength(1);
  });
  test("green parent identifies culprit and proposes a signed verified inverse", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.title).toBe("MAIN_RED_REVERT_OPENED");
    expect("queue" in result && result.queue).toEqual({
      pullNumber: 11,
      head: REVERT,
    });
    const mutation = codeWrites(f).at(0);
    expect(mutation?.args.query).toContain("revertPullRequest");
    expect(mutation?.args.input).toEqual({
      pullRequestId: "PR_original",
      title: "revert: fix: example (#10)",
      body: `<!-- main-health:${RED} -->\n<!-- main-health-origin:${RED} -->\nHeavy suites failed: Heavy unit tests.\nWorkflow run: https://github.com/stella/stella/actions/runs/30\nReverts #10.`,
    });
    expect(
      f.writes.some((write) =>
        String(write.args.query).includes("enqueuePullRequest"),
      ),
    ).toBe(false);
  });
  test("replaying the same incident retains exactly one revert", async () => {
    const f = fixture();
    await f.run();
    await f.run();
    expect(codeWrites(f)).toHaveLength(1);
    expect(f.existing).toHaveLength(1);
  });
  test("unknown parent dispatches oldest unknown once and green completion resumes incident", async () => {
    const f = fixture();
    f.statuses.delete(PARENT);
    expect((await f.run()).title).toBe("MAIN_RED_BISECTING");
    await f.run();
    expect(codeWrites(f)).toHaveLength(1);
    expect(codeWrites(f).at(0)?.args).toMatchObject({
      workflow_id: "main-heavy.yml",
      ref: "main",
      inputs: { sha: PARENT },
    });
    f.setHeavy(PARENT, "success", "workflow_dispatch");
    expect((await f.run({ eventName: "workflow_run", runId: 20 })).title).toBe(
      "MAIN_RED_REVERT_OPENED",
    );
    expect(codeWrites(f)).toHaveLength(2);
  });
  test("red re-evaluation attributes the older culprit without duplicating the incident", async () => {
    const f = fixture();
    f.statuses.delete(PARENT);
    await f.run();
    f.setHeavy(PARENT, "failure", "workflow_dispatch");
    f.original.merge_commit_sha = PARENT;
    const result = await f.run({ eventName: "workflow_run", runId: 20 });
    expect(result.title).toBe("MAIN_RED_REVERT_OPENED");
    expect("sha" in result && result.sha).toBe(PARENT);
    expect(f.issues.filter((issue) => issue.state !== "closed")).toHaveLength(
      1,
    );
    expect(codeWrites(f)).toHaveLength(2);
  });
  test("red parent records one incident and never opens another revert", async () => {
    const f = fixture();
    f.setHeavy(PARENT, "failure");
    expect((await f.run()).reason).toBe("SAME_INCIDENT_AS_RED_PARENT");
    await f.run();
    expect(f.issues).toHaveLength(1);
    expect(codeWrites(f)).toHaveLength(0);
  });
  test.each(["off", "", "unexpected"])(
    "kill switch %s only reports",
    async (enabled) => {
      const f = fixture();
      expect((await f.run({ enabled })).reason).toBe("AUTO_REVERT_OFF");
      expect(codeWrites(f)).toHaveLength(0);
      expect(f.issues).toHaveLength(1);
    },
  );
  test.each([
    "apps/api/drizzle/1.sql",
    "apps/api/migrations/1.sql",
    ".github/workflows/x.yml",
    ".github/branch-protection/ruleset-main.json",
    "apps/api/src/lib/db/migration-alias-inventory.json",
  ])("protected change %s escalates", async (filename) => {
    const f = fixture();
    const first = f.originalFiles.at(0);
    if (!first) {
      throw new Error("missing fixture");
    }
    first.filename = filename;
    expect((await f.run()).reason).toBe("PROTECTED_PATH");
    expect(codeWrites(f)).toHaveLength(0);
  });
  test("renaming a protected path is equally refused", async () => {
    const f = fixture();
    Object.assign(f.originalFiles.at(0) ?? {}, {
      status: "renamed",
      previous_filename: ".github/workflows/old.yml",
    });
    expect((await f.run()).reason).toBe("PROTECTED_PATH");
    expect(codeWrites(f)).toHaveLength(0);
  });
  test("release PR escalates without proposing a revert", async () => {
    const f = fixture();
    f.original.title = "chore: release v1.2.3";
    expect((await f.run()).reason).toBe("RELEASE_OR_TAGGED_COMMIT");
    expect(codeWrites(f)).toHaveLength(0);
  });
  test("a tagged culprit is refused even when its PR is not named release", async () => {
    const f = fixture();
    f.tags.push({ commit: { sha: RED } });
    expect((await f.run()).reason).toBe("RELEASE_OR_TAGGED_COMMIT");
    expect(codeWrites(f)).toHaveLength(0);
  });
  test("multiple incidents for the same commit still refuse automation", async () => {
    const f = fixture();
    f.issues.push(
      { body: `<!-- main-health:${RED} -->` },
      { body: `<!-- main-health:${RED} -->` },
    );
    expect((await f.run()).reason).toBe("MULTIPLE_INCIDENTS");
    expect(codeWrites(f)).toHaveLength(0);
  });
  test("a second open incident refuses another revert", async () => {
    const f = fixture();
    f.issues.push({ body: `<!-- main-health:${GREEN} -->` });
    expect((await f.run()).reason).toBe("ANOTHER_INCIDENT_OPEN");
    expect(codeWrites(f)).toHaveLength(0);
    expect(f.issues).toHaveLength(1);
  });
  test("GitHub revert conflicts escalate", async () => {
    const f = fixture();
    f.conflict();
    expect((await f.run()).reason).toBe("GITHUB_API_ERROR");
    expect(f.issues).toHaveLength(1);
    expect(f.existing).toHaveLength(0);
  });
  test("signed but non-inverse revert never produces an arming output", async () => {
    const f = fixture();
    Object.assign(f.revertFiles.at(0) ?? {}, {
      patch: inverse.patch.replace("+before", "+evil"),
    });
    const result = await f.run();
    expect(result.reason).toBe("REVERT_DIFF_MISMATCH");
    expect("queue" in result && result.queue).toBeUndefined();
  });
  test("unsigned revert never produces an arming output", async () => {
    const f = fixture();
    f.commits.set(REVERT, {
      parents: [{ sha: RED }],
      verification: { verified: false },
    });
    expect((await f.run()).reason).toBe("UNSIGNED_REVERT");
  });
  test("changed head cannot pass verification for an older proof", async () => {
    const f = fixture();
    await expect(
      verifyRevertCandidate({
        github: f.api,
        repo,
        pull: f.pull,
        culprit: RED,
        expectedHead: GREEN,
        actor: "recovery[bot]",
      }),
    ).rejects.toThrow("REVERT_HEAD_CHANGED");
  });
  test("closed recorded revert is retained without reopening", async () => {
    const f = fixture();
    await f.run();
    f.pull.state = "closed";
    f.writes.length = 0;
    expect((await f.run()).reason).toBe("REVERT_ALREADY_CLOSED");
    expect(codeWrites(f)).toHaveLength(0);
  });
  test("an outsider marker cannot suppress the legitimate revert", async () => {
    const f = fixture();
    f.existing.push({ ...f.pull, number: 99, user: { login: "outsider" } });
    expect((await f.run()).title).toBe("MAIN_RED_REVERT_OPENED");
    expect(codeWrites(f)).toHaveLength(1);
    expect(f.existing).toHaveLength(2);
  });
  test("matching App author without a mutation receipt cannot arm a head", async () => {
    const f = fixture();
    f.existing.push(f.pull);
    expect((await f.run()).reason).toBe("UNTRUSTED_REVERT_RECEIPT");
    expect(codeWrites(f)).toHaveLength(0);
  });
  test("completed CI resumes verification using the GraphQL-owned branch", async () => {
    const f = fixture();
    await f.run();
    f.runs.set(40, {
      id: 40,
      status: "completed",
      path: ".github/workflows/ci.yml",
      repository: { full_name: "stella/stella" },
      head_repository: { full_name: "stella/stella" },
      event: "pull_request",
      head_branch: "revert-10-example",
      head_sha: REVERT,
    });
    const result = await f.run({ eventName: "workflow_run", runId: 40 });
    expect("queue" in result && result.queue).toEqual({
      pullNumber: 11,
      head: REVERT,
    });
    expect(codeWrites(f)).toHaveLength(1);
  });
  test.each([
    "path",
    "repository",
    "event",
    "head_branch",
    "display_title",
    "head_sha",
  ])(
    "heavy provenance corruption in %s never proposes a revert",
    async (field) => {
      const f = fixture();
      const run = f.runs.get(30);
      if (!run) {
        throw new Error("missing run");
      }
      run[field] =
        field === "repository" ? { full_name: "attacker/repo" } : "attacker";
      expect(
        (await f.run({ eventName: "workflow_run", runId: 30 })).title,
      ).toBe("IGNORED");
      expect(codeWrites(f)).toHaveLength(0);
    },
  );
  test("a foreign publisher or mismatched completion cannot authorize recovery", async () => {
    for (const corruption of [
      { creator: { login: "attacker" } },
      { state: "success" },
      { target_url: "https://evil.example/run/30" },
    ]) {
      const f = fixture();
      Object.assign(f.statuses.get(RED)?.at(0) ?? {}, corruption);
      expect((await f.run()).title).toBe("MAIN_RED_ESCALATED");
      expect(codeWrites(f)).toHaveLength(0);
    }
  });
});
describe("exact inverse verification", () => {
  test("hunk offsets can move while content stays exact", () => {
    verifyInverseDiff([file], [inverse]);
  });
  test.each(["filename", "patch", "status", "additions", "deletions"])(
    "corruption of %s is refused",
    (key) => {
      let corruption: unknown = "wrong";
      if (key === "patch") {
        corruption = inverse.patch.replace("+before", "+wrong");
      } else if (key === "additions" || key === "deletions") {
        corruption = 9;
      }
      expect(() =>
        verifyInverseDiff([file], [{ ...inverse, [key]: corruption }]),
      ).toThrow(
        /(?:REVERT_DIFF_MISMATCH|UNSUPPORTED_FILE_STATUS|TRUNCATED_PATCH)/u,
      );
    },
  );
  test("missing or truncated patch fails closed", () => {
    expect(() =>
      verifyInverseDiff([file], [{ ...inverse, patch: undefined }]),
    ).toThrow("INVALID_STRING");
    expect(() =>
      verifyInverseDiff(
        [file],
        [
          {
            ...inverse,
            patch: inverse.patch.split("\n").slice(0, 2).join("\n"),
          },
        ],
      ),
    ).toThrow("TRUNCATED_PATCH");
  });
});
describe("release health", () => {
  test("green exact commit with no open incident is allowed", async () => {
    const f = fixture();
    f.setHeavy(RED, "success");
    await verifyReleaseHealth({ github: f.api, repo, commit: RED });
    expect(f.writes).toHaveLength(0);
  });
  test.each(["failure", "pending"] as const)(
    "heavy %s refuses a release",
    async (state) => {
      const f = fixture();
      f.setHeavy(RED, state);
      await expect(
        verifyReleaseHealth({ github: f.api, repo, commit: RED }),
      ).rejects.toThrow("RELEASE_HEAVY_NOT_GREEN");
    },
  );
  test("open incident blocks even a green release candidate", async () => {
    const f = fixture();
    f.setHeavy(RED, "success");
    f.issues.push({ body: "open incident" });
    await expect(
      verifyReleaseHealth({ github: f.api, repo, commit: RED }),
    ).rejects.toThrow("RELEASE_OPEN_MAIN_INCIDENT");
  });
  test("forged green status cannot replace a trusted successful run", async () => {
    const f = fixture();
    f.setHeavy(RED, "success");
    Object.assign(f.statuses.get(RED)?.at(0) ?? {}, {
      creator: { login: "attacker" },
    });
    await expect(
      verifyReleaseHealth({ github: f.api, repo, commit: RED }),
    ).rejects.toThrow("UNTRUSTED_HEAVY_STATUS");
  });
});
test("recovery workflow only executes trusted main and delegates pinned jump", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/main-health.yml", import.meta.url),
    "utf-8",
  );
  expect(workflow).toMatch(/ref: \$\{\{ github\.sha \}\}/u);
  expect(workflow).not.toMatch(
    /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/u,
  );
  expect(workflow).toContain(
    'bun scripts/merge-bar.ts "$PULL_NUMBER" --repo "$GITHUB_REPOSITORY" --jump --expected-head "$VERIFIED_HEAD"',
  );
  expect(workflow).toContain("--verify-revert");
  expect(workflow).toContain("cancel-in-progress: false");
});

describe("GitHub transport boundary", () => {
  test("encodes path parameters and paginated queries without interpolating input into code", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const api = createMainHealthApi("fixture-token", async (url, init) => {
      requests.push({ url, init });
      return Response.json({ value: "on" });
    });
    await api.request("GET /repos/{owner}/{repo}/commits/{ref}/statuses", {
      owner: "stella",
      repo: "stella",
      ref: "release/test",
      page: 2,
    });
    expect(requests.at(0)?.url).toBe(
      "https://api.github.com/repos/stella/stella/commits/release%2Ftest/statuses?page=2",
    );
    expect(requests.at(0)?.init.redirect).toBe("error");
  });
  test.each([403, 404, 500])(
    "HTTP %s refuses rather than inventing a response",
    async (status) => {
      const api = createMainHealthApi(
        "fixture-token",
        async () => new Response("", { status }),
      );
      await expect(
        api.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          ...repo,
          ref: "heads/main",
        }),
      ).rejects.toThrow(`GITHUB_HTTP_${status}`);
    },
  );
  test("GraphQL errors cannot masquerade as a created revert", async () => {
    const api = createMainHealthApi("fixture-token", async () =>
      Response.json({ errors: [{ message: "revert conflict" }] }),
    );
    await expect(api.graphql("mutation", {})).rejects.toThrow(
      "GITHUB_GRAPHQL_ERROR",
    );
  });
});
