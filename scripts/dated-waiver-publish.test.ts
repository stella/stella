import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { publishRemoval, REMOVAL_TITLE } from "./dated-waiver-publish";

const BRANCH = "chore/dated-waiver-0123456789abcdef01234567";
const API = "repos/stella/stella";
const FILE = "scripts/fixture.ts";
const BEFORE = "export const waivers = [{ expiresAt: '2026-10-15' }];";
const AFTER = "export const waivers = [];";
const BODY = "Verified 20/20 probes at base-sha.";
const INPUT = v.object({ sha: v.string(), ref: v.optional(v.string()) });
const COMMIT_INPUT = v.object({
  variables: v.object({
    input: v.object({
      expectedHeadOid: v.string(),
      branch: v.object({ branchName: v.string() }),
      fileChanges: v.object({
        additions: v.array(
          v.object({ path: v.string(), contents: v.string() }),
        ),
      }),
    }),
  }),
});
const PR_INPUT = v.object({
  title: v.string(),
  body: v.string(),
  draft: v.optional(v.boolean()),
});
type FakeOptions = {
  failure?:
    | "signed"
    | "swap"
    | "cleanup"
    | "create"
    | "created-response"
    | "update";
};
const fakeGithub = ({ failure }: FakeOptions = {}) => {
  const prs: { number: number; title: string; body: string }[] = [];
  const refs = new Map<string, string>();
  const commits = new Map<string, Record<string, string>>();
  const parents = new Map<string, string[]>();
  const baseTrees = new Map<string, Record<string, string>>();
  const writes: { endpoint: string; input: unknown }[] = [];
  let mainSha = "base-sha";
  let failuresRemaining = failure ? 1 : 0;
  const fail = (point: FakeOptions["failure"]) => {
    if (point !== failure || failuresRemaining === 0) {
      return;
    }
    failuresRemaining--;
    throw new TypeError(`Transient ${point} failure`);
  };
  const request = async (
    args: readonly string[],
    input?: unknown,
  ): Promise<unknown> => {
    const endpoint = args.at(0) ?? "";
    const methodIndex = args.indexOf("--method");
    const method = methodIndex === -1 ? "GET" : args.at(methodIndex + 1);
    if (input !== undefined || method === "DELETE") {
      writes.push({ endpoint, input });
    }
    if (endpoint === `${API}/pulls` && method === "GET") {
      return prs.map((pr) => ({ ...pr }));
    }
    if (endpoint === `${API}/git/ref/heads/main`) {
      return { object: { sha: mainSha } };
    }
    if (endpoint === `${API}/git/ref/heads/${BRANCH}`) {
      return { object: { sha: refs.get(BRANCH) } };
    }
    if (endpoint.startsWith(`${API}/git/commits/`)) {
      const sha = endpoint.slice(`${API}/git/commits/`.length);
      return {
        parents: (parents.get(sha) ?? []).map((parent) => ({ sha: parent })),
      };
    }
    if (endpoint.startsWith(`${API}/git/matching-refs/heads/`)) {
      const branch = endpoint.slice(`${API}/git/matching-refs/heads/`.length);
      return refs.has(branch) ? [{ ref: `refs/heads/${branch}` }] : [];
    }
    if (endpoint.startsWith(`${API}/contents/`)) {
      const file = endpoint.slice(`${API}/contents/`.length);
      const reference =
        args.find((arg) => arg.startsWith("ref="))?.slice("ref=".length) ??
        BRANCH;
      const content = commits.get(refs.get(reference) ?? reference)?.[file];
      if (content === undefined) {
        throw new TypeError("Fixture branch file absent");
      }
      return { content: Buffer.from(content).toString("base64") };
    }
    if (endpoint === "graphql") {
      const commit = v.parse(COMMIT_INPUT, input).variables.input;
      expect(commit.expectedHeadOid).toBe(mainSha);
      expect(refs.get(commit.branch.branchName)).toBe(commit.expectedHeadOid);
      if (failure === "signed" && failuresRemaining > 0) {
        failuresRemaining--;
        return { errors: [{ message: "PRIVATE signed error output" }] };
      }
      const sha = `signed-${commits.size + 1}`;
      commits.set(sha, {
        ...baseTrees.get(commit.expectedHeadOid),
        ...Object.fromEntries(
          commit.fileChanges.additions.map(({ path, contents }) => [
            path,
            Buffer.from(contents, "base64").toString("utf-8"),
          ]),
        ),
      });
      parents.set(sha, [commit.expectedHeadOid]);
      refs.set(commit.branch.branchName, sha);
      return { data: { createCommitOnBranch: { commit: { oid: sha } } } };
    }
    if (
      endpoint === `${API}/git/refs` ||
      endpoint.startsWith(`${API}/git/refs/heads/`)
    ) {
      if (method === "DELETE") {
        fail("cleanup");
        refs.delete(endpoint.slice(`${API}/git/refs/heads/`.length));
        return null;
      }
      const parsed = v.parse(INPUT, input);
      const branch =
        parsed.ref?.slice("refs/heads/".length) ??
        endpoint.slice(`${API}/git/refs/heads/`.length);
      if (branch === BRANCH) {
        fail("swap");
      }
      refs.set(branch, parsed.sha);
      return {};
    }
    if (endpoint === `${API}/pulls` && method === "POST") {
      fail("create");
      const parsed = v.parse(PR_INPUT, input);
      expect(parsed.draft).toBe(false);
      const pr = { number: 42, title: parsed.title, body: parsed.body };
      prs.push(pr);
      fail("created-response");
      return { number: pr.number };
    }
    if (endpoint === `${API}/pulls/42` && method === "PATCH") {
      fail("update");
      const parsed = v.parse(PR_INPUT, input);
      const pr = prs.at(0);
      if (!pr) {
        throw new TypeError("Fixture PR absent");
      }
      pr.title = parsed.title;
      pr.body = parsed.body;
      return {};
    }
    throw new TypeError(`Unexpected GitHub call: ${endpoint}`);
  };
  const publish = (body = BODY) =>
    publishRemoval({
      branch: BRANCH,
      baseSha: "base-sha",
      baseFiles: { [FILE]: BEFORE },
      body,
      files: { [FILE]: AFTER },
      repo: "stella/stella",
      request,
    });
  return {
    request,
    publish,
    prs,
    refs,
    commits,
    parents,
    writes,
    advanceMain: (tree: Record<string, string> = {}) => {
      mainSha = "new-main-sha";
      baseTrees.set(mainSha, tree);
    },
  };
};

describe("dated waiver removal publication", () => {
  test("replayed evidence retains one signed commit and one ready PR", async () => {
    const github = fakeGithub();
    expect(await github.publish()).toBe(42);
    const writes = github.writes.length;
    expect(await github.publish()).toBe(42);
    expect(github.writes).toHaveLength(writes);
    expect(github.commits.size).toBe(1);
    expect(github.prs).toEqual([
      { number: 42, title: REMOVAL_TITLE, body: BODY },
    ]);
    expect(github.refs.get(BRANCH)).toBe("signed-1");
    expect(github.refs.has(`${BRANCH}-next`)).toBe(false);
  });

  test("new evidence refreshes the existing PR without rewriting identical files", async () => {
    const github = fakeGithub();
    await github.publish();
    expect(await github.publish("Verified new run.")).toBe(42);
    expect(github.commits.size).toBe(1);
    expect(github.prs).toEqual([
      { number: 42, title: REMOVAL_TITLE, body: "Verified new run." },
    ]);
  });

  test("fresh main evidence rebuilds an unchanged removal on the freshly probed base", async () => {
    const github = fakeGithub();
    await github.publish();
    github.advanceMain({
      [FILE]: BEFORE,
      "bun.lock": "updated probe dependency",
    });
    const body = "Verified 20/20 probes at new-main-sha.";
    const publishFresh = () =>
      publishRemoval({
        branch: BRANCH,
        baseSha: "new-main-sha",
        baseFiles: { [FILE]: BEFORE },
        files: { [FILE]: AFTER },
        body,
        repo: "stella/stella",
        request: github.request,
      });
    expect(await publishFresh()).toBe(42);
    const head = github.refs.get(BRANCH) ?? "";
    expect(head).not.toBe("signed-1");
    expect(github.parents.get(head)).toEqual(["new-main-sha"]);
    expect(github.commits.get(head)).toEqual({
      [FILE]: AFTER,
      "bun.lock": "updated probe dependency",
    });
    expect(github.prs).toEqual([{ number: 42, title: REMOVAL_TITLE, body }]);
    const writes = github.writes.length;
    expect(await publishFresh()).toBe(42);
    expect(github.writes).toHaveLength(writes);
  });

  test("only a single commit parent equal to the probed base permits reuse", async () => {
    for (const parents of [
      [],
      ["different-base"],
      ["base-sha", "other-parent"],
    ]) {
      const github = fakeGithub();
      await github.publish();
      github.parents.set("signed-1", parents);
      expect(await github.publish()).toBe(42);
      const head = github.refs.get(BRANCH) ?? "";
      expect(head).toBe("signed-2");
      expect(github.parents.get(head)).toEqual(["base-sha"]);
      expect(github.prs).toHaveLength(1);
    }
  });

  test("an existing removal PR receives refreshed files on the same branch", async () => {
    const github = fakeGithub();
    await github.publish();
    github.commits.set("signed-1", { [FILE]: BEFORE });
    expect(await github.publish()).toBe(42);
    expect(github.prs).toHaveLength(1);
    expect(github.refs.get(BRANCH)).toBe("signed-2");
    expect(github.commits.get("signed-2")).toEqual({ [FILE]: AFTER });
  });

  test("a removal already on main performs no writes even with an open PR", async () => {
    for (const existing of [false, true]) {
      const github = fakeGithub();
      if (existing) {
        github.prs.push({ number: 42, title: "outdated", body: "outdated" });
      }
      expect(
        await publishRemoval({
          branch: BRANCH,
          baseSha: "base-sha",
          baseFiles: { [FILE]: AFTER },
          body: BODY,
          files: { [FILE]: AFTER },
          repo: "stella/stella",
          request: github.request,
        }),
      ).toBeUndefined();
      expect(github.writes).toEqual([]);
    }
  });

  test("ambiguous reserved-branch PRs block all mutations", async () => {
    const github = fakeGithub();
    github.prs.push(
      { number: 1, title: "", body: "" },
      { number: 2, title: "", body: "" },
    );
    expect(await rejectionOf(github.publish())).toMatchObject({
      message: expect.stringContaining("Multiple open dated-waiver"),
    });
    expect(github.writes).toEqual([]);
  });

  test("syntax diagnostics in every module extension block even GitHub reads", async () => {
    for (const extension of [
      "ts",
      "tsx",
      "mts",
      "cts",
      "js",
      "jsx",
      "mjs",
      "cjs",
    ]) {
      let calls = 0;
      const file = `fixture.${extension}`;
      expect(
        await rejectionOf(
          publishRemoval({
            branch: BRANCH,
            baseSha: "base-sha",
            baseFiles: {},
            body: BODY,
            files: { [file]: "export const waivers = [].concat(, {});" },
            repo: "stella/stella",
            request: async () => {
              calls++;
              throw new TypeError("GitHub must not be contacted");
            },
          }),
        ),
      ).toMatchObject({
        message: expect.stringContaining(
          `Generated module has syntax diagnostics: ${file}`,
        ),
      });
      expect(calls).toBe(0);
    }
  });

  test("advanced main invalidates evidence before branch mutations", async () => {
    const github = fakeGithub();
    github.advanceMain();
    expect(await rejectionOf(github.publish())).toMatchObject({
      message: expect.stringContaining(
        "Main advanced; evidence must be recomputed",
      ),
    });
    expect(github.writes).toEqual([]);
  });

  test("signed commit errors withhold response text and retain the PR head", async () => {
    const github = fakeGithub({ failure: "signed" });
    github.refs.set(BRANCH, "prior-head");
    github.commits.set("prior-head", { [FILE]: BEFORE });
    github.prs.push({
      number: 42,
      title: REMOVAL_TITLE,
      body: "prior evidence",
    });
    expect(await rejectionOf(github.publish())).toMatchObject({
      message: "GitHub signed commit failed; response withheld.",
    });
    expect(github.refs.get(BRANCH)).toBe("prior-head");
    expect(github.prs.at(0)?.body).toBe("prior evidence");
    expect(github.writes.map(({ endpoint }) => endpoint)).toEqual([
      `${API}/git/refs`,
      "graphql",
    ]);
    expect(await github.publish()).toBe(42);
    expect(github.prs).toHaveLength(1);
    expect(github.prs.at(0)?.body).toBe(BODY);
  });

  test("partial writes converge to one PR after swap, cleanup, creation or response failure", async () => {
    for (const failure of [
      "swap",
      "cleanup",
      "create",
      "created-response",
    ] as const) {
      const github = fakeGithub({ failure });
      expect(await rejectionOf(github.publish())).toMatchObject({
        message: expect.stringContaining(`Transient ${failure} failure`),
      });
      expect(await github.publish()).toBe(42);
      expect(github.prs).toEqual([
        { number: 42, title: REMOVAL_TITLE, body: BODY },
      ]);
      expect(github.commits.get(github.refs.get(BRANCH) ?? "")).toEqual({
        [FILE]: AFTER,
      });
      const writes = github.writes.length;
      expect(await github.publish()).toBe(42);
      expect(github.writes).toHaveLength(writes);
    }
  });

  test("failed evidence updates recover in the existing PR", async () => {
    const github = fakeGithub({ failure: "update" });
    await github.publish();
    expect(await rejectionOf(github.publish("new evidence"))).toMatchObject({
      message: expect.stringContaining("Transient update failure"),
    });
    expect(await github.publish("new evidence")).toBe(42);
    expect(github.prs).toEqual([
      { number: 42, title: REMOVAL_TITLE, body: "new evidence" },
    ]);
    expect(github.commits.size).toBe(1);
  });

  test("invalid branch or repository refuses every GitHub call", async () => {
    for (const fixture of [
      {
        branch: "main",
        repo: "stella/stella",
        message: "Invalid removal branch",
      },
      { branch: BRANCH, repo: "other/repo", message: "requires stella/stella" },
    ]) {
      let calls = 0;
      expect(
        await rejectionOf(
          publishRemoval({
            ...fixture,
            baseSha: "base-sha",
            baseFiles: {},
            body: BODY,
            files: { [FILE]: AFTER },
            request: async () => {
              calls++;
              throw new TypeError("Unexpected GitHub call");
            },
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining(fixture.message) });
      expect(calls).toBe(0);
    }
  });
});
