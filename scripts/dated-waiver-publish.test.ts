import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import { applyHealing, HealingRunError } from "./dated-waiver-healing";
import type { HealingActions } from "./dated-waiver-healing";
import {
  publishRemoval,
  REMOVAL_TITLE,
  retireRemoval,
  validateRemovalModules,
  WaiverPublishFailures,
} from "./dated-waiver-publish";
import type { DatedWaiver } from "./dated-waivers";

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
    | "update"
    | "ref-mismatch"
    | "tree-mismatch";
};
const treeOid = (files: Readonly<Record<string, string>>) =>
  sha256Hex(
    JSON.stringify(
      Object.entries(files).toSorted(([left], [right]) =>
        compareCodeUnit(left, right),
      ),
    ),
  );
const fakeGithub = ({ failure }: FakeOptions = {}) => {
  const prs: {
    number: number;
    title: string;
    body: string;
    state?: "open" | "closed";
  }[] = [];
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
      expect(args).toContain(`head=stella:${BRANCH}`);
      expect(args).toContain("base=main");
      expect(args).toContain("state=open");
      return prs
        .filter(({ state }) => state !== "closed")
        .map((pr) => ({ ...pr }));
    }
    if (endpoint === `${API}/git/ref/heads/main`) {
      return { object: { sha: mainSha } };
    }
    if (endpoint === `${API}/git/ref/heads/${BRANCH}`) {
      if (failure === "ref-mismatch" && failuresRemaining > 0) {
        failuresRemaining--;
        return { object: { sha: "different-head" } };
      }
      return { object: { sha: refs.get(BRANCH) } };
    }
    if (endpoint.startsWith(`${API}/git/commits/`)) {
      const sha = endpoint.slice(`${API}/git/commits/`.length);
      return {
        parents: (parents.get(sha) ?? []).map((parent) => ({ sha: parent })),
        tree: {
          sha:
            failure === "tree-mismatch" && failuresRemaining-- > 0
              ? "different-tree"
              : treeOid(commits.get(sha) ?? {}),
        },
      };
    }
    if (endpoint.startsWith(`${API}/git/matching-refs/heads/`)) {
      const branch = endpoint.slice(`${API}/git/matching-refs/heads/`.length);
      return refs.has(branch) ? [{ ref: `refs/heads/${branch}` }] : [];
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
      return {
        data: {
          createCommitOnBranch: {
            commit: {
              oid: sha,
              tree: { oid: treeOid(commits.get(sha) ?? {}) },
            },
          },
        },
      };
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
      const pr = {
        number: 42 + prs.length,
        title: parsed.title,
        body: parsed.body,
      };
      prs.push(pr);
      fail("created-response");
      return { number: pr.number };
    }
    if (endpoint.startsWith(`${API}/pulls/`) && method === "PATCH") {
      fail("update");
      const pr = prs.find(
        ({ number }) =>
          String(number) === endpoint.slice(`${API}/pulls/`.length),
      );
      if (!pr) {
        throw new TypeError("Fixture PR absent");
      }
      if (
        v.is(v.object({ state: v.literal("closed"), body: v.string() }), input)
      ) {
        pr.state = input.state;
        pr.body = input.body;
        return {};
      }
      const parsed = v.parse(PR_INPUT, input);
      pr.title = parsed.title;
      pr.body = parsed.body;
      return {};
    }
    throw new TypeError(`Unexpected GitHub call: ${endpoint}`);
  };
  const publish = async (body = BODY) =>
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

type HealingPublicationOptions = {
  github: ReturnType<typeof fakeGithub>;
  arm: (number: number) => Promise<void>;
};
const healingPublication = async ({
  github,
  arm,
}: HealingPublicationOptions) => {
  const entry = {
    source: FILE,
    line: 1,
    id: "fixture",
    kind: "release-age-exclusion",
    expiresAt: "2026-10-15T00:00:00.000Z",
    probe: { command: ["bun", "probe"], attempts: 3 },
  } as const satisfies DatedWaiver;
  const actions = {
    openRemoval: async ({ outcome }) =>
      publishRemoval({
        branch: BRANCH,
        baseSha: "base-sha",
        baseFiles: outcome.baseFiles,
        files: outcome.files,
        body: BODY,
        repo: "stella/stella",
        request: github.request,
      }),
    armRemoval: arm,
    retireRemoval: async () => {},
    assessRemoval: async () => ({ status: "eligible" as const }),
    resolveFixTask: async () => {},
    openFixTask: async () => {
      throw new TypeError("Unexpected fix task creation");
    },
    findTask: async () => undefined,
    alertExpiry: async () => {},
  } satisfies HealingActions;
  return applyHealing({
    now: new Date("2026-10-12T00:00:00Z"),
    actions,
    report: {
      sha: "base-sha",
      observedAt: "2026-10-12T00:00:00Z",
      failures: [],
      entries: [
        {
          entry,
          outcome: {
            status: "green",
            files: { [FILE]: AFTER },
            baseFiles: { [FILE]: BEFORE },
            evidence: {
              passed: 3,
              attempts: 3,
              command: entry.probe.command,
              output: "",
              runner: "Linux",
              sha: "base-sha",
              sourceFingerprint: "source-fingerprint",
              run: "fixture-run",
              observedAt: "2026-10-12T00:00:00.000Z",
            },
          },
        },
      ],
    },
  });
};

describe("dated waiver removal publication", () => {
  test("a proposal with additional content is rebuilt from the probe base before arming", async () => {
    const github = fakeGithub();
    await github.publish();
    github.commits.set("signed-1", {
      [FILE]: AFTER,
      "additional.txt": "unrelated content",
    });
    let arms = 0;
    await healingPublication({
      github,
      arm: async (number) => {
        expect(number).toBe(42);
        const head = github.refs.get(BRANCH) ?? "";
        expect(head).toBe("signed-2");
        expect(github.parents.get(head)).toEqual(["base-sha"]);
        expect(github.commits.get(head)).toEqual({ [FILE]: AFTER });
        arms++;
      },
    });
    expect(arms).toBe(1);
    expect(github.prs).toHaveLength(1);
  });

  test("pushed reference or tree mismatches block arming and PR publication", async () => {
    for (const failure of ["ref-mismatch", "tree-mismatch"] as const) {
      const github = fakeGithub({ failure });
      let arms = 0;
      const error = await rejectionOf(
        healingPublication({
          github,
          arm: async () => {
            arms++;
          },
        }),
      );
      expect(error).toBeInstanceOf(HealingRunError);
      if (error instanceof HealingRunError) {
        expect(error.failures.map(({ stage }) => stage)).toEqual([
          "openRemoval",
        ]);
      }
      expect(arms).toBe(0);
      expect(github.prs).toEqual([]);
    }
  });
  test("replayed evidence rebuilds signed commits while retaining one ready PR", async () => {
    const github = fakeGithub();
    expect(await github.publish()).toBe(42);
    const writes = github.writes.length;
    expect(await github.publish()).toBe(42);
    expect(github.writes.length).toBeGreaterThan(writes);
    expect(github.commits.size).toBe(2);
    expect(github.prs).toEqual([
      { number: 42, title: REMOVAL_TITLE, body: BODY },
    ]);
    expect(github.refs.get(BRANCH)).toBe("signed-2");
    expect(github.refs.has(`${BRANCH}-next`)).toBe(false);
  });

  test("new evidence rebuilds the existing PR from its probed base", async () => {
    const github = fakeGithub();
    await github.publish();
    expect(await github.publish("Verified new run.")).toBe(42);
    expect(github.commits.size).toBe(2);
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
    const publishFresh = async () =>
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
    expect(github.writes.length).toBeGreaterThan(writes);
    expect(github.refs.get(BRANCH)).toBe("signed-3");
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

  test("a removal already on main without an open proposal performs no writes", async () => {
    const github = fakeGithub();
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
  });

  test("an existing proposal closes once with a neutral note when removal is already on main", async () => {
    const github = fakeGithub();
    await github.publish();
    const publishNoop = async () =>
      publishRemoval({
        branch: BRANCH,
        baseSha: "base-sha",
        baseFiles: { [FILE]: AFTER },
        body: BODY,
        files: { [FILE]: AFTER },
        repo: "stella/stella",
        request: github.request,
      });
    const writes = github.writes.length;
    expect(await publishNoop()).toBeUndefined();
    expect(github.prs.at(0)?.state).toBe("closed");
    expect(github.prs.at(0)?.body).toBe(
      `${BODY}\n\nThe dated maintenance entry is already removed on main.`,
    );
    expect(github.writes.slice(writes).map(({ endpoint }) => endpoint)).toEqual(
      [`${API}/pulls/42`],
    );
    expect(github.commits.size).toBe(1);
    expect(await publishNoop()).toBeUndefined();
    expect(github.writes).toHaveLength(writes + 1);
  });

  test("a stale already-removed checkout cannot close a current proposal", async () => {
    const github = fakeGithub();
    await github.publish();
    github.advanceMain();
    const writes = github.writes.length;
    expect(
      await rejectionOf(
        publishRemoval({
          branch: BRANCH,
          baseSha: "base-sha",
          baseFiles: { [FILE]: AFTER },
          body: BODY,
          files: { [FILE]: AFTER },
          repo: "stella/stella",
          request: github.request,
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Main advanced; evidence must be recomputed",
      ),
    });
    expect(github.writes).toHaveLength(writes);
    expect(github.prs.at(0)?.state).not.toBe("closed");
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
      expect(github.writes.length).toBeGreaterThan(writes);
      expect(github.prs).toHaveLength(1);
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
    expect(github.commits.size).toBe(3);
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

describe("independent proposal file failures", () => {
  test("module parsing reports every invalid file and succeeds exactly when none are invalid", async () => {
    const modules = ["one.ts", "two.js", "three.mts", "four.tsx"];
    for (const invalid of [[], ["one.ts"], ["two.js", "four.tsx"], modules]) {
      const files = Object.fromEntries(
        modules.map((file) => [
          file,
          invalid.includes(file)
            ? "export const value = (;"
            : "export const value = 1;",
        ]),
      );
      files["nonmodule.txt"] = "export const value = (;";
      if (invalid.length === 0) {
        expect(validateRemovalModules(files)).toBeUndefined();
        continue;
      }
      let githubCalls = 0;
      const failure = await rejectionOf(
        publishRemoval({
          branch: BRANCH,
          baseSha: "base-sha",
          baseFiles: {},
          body: BODY,
          files,
          repo: "stella/stella",
          request: async () => {
            githubCalls++;
            throw new TypeError("GitHub must not be contacted");
          },
        }),
      );
      expect(failure).toBeInstanceOf(WaiverPublishFailures);
      if (failure instanceof WaiverPublishFailures) {
        expect(
          failure.failures.map(({ file, stage }) => ({ file, stage })),
        ).toEqual(invalid.map((file) => ({ file, stage: "parse" })));
        expect(
          failure.failures.every(({ cause }) => cause instanceof Error),
        ).toBe(true);
      }
      expect(githubCalls).toBe(0);
    }
  });
});

describe("retiring an ineligible removal proposal", () => {
  test("disarms the reserved proposal before closing it once with a neutral note", async () => {
    const github = fakeGithub();
    await github.publish();
    const disarmed: number[] = [];
    const writes = github.writes.length;
    const retire = async () =>
      retireRemoval({
        branch: BRANCH,
        repo: "stella/stella",
        request: github.request,
        disarm: async (number) => {
          expect(github.prs.at(0)?.state).not.toBe("closed");
          expect(github.writes).toHaveLength(writes);
          disarmed.push(number);
        },
      });
    await retire();
    expect(disarmed).toEqual([42]);
    expect(github.prs.at(0)?.state).toBe("closed");
    expect(github.prs.at(0)?.body).toBe(
      `${BODY}\n\nThis dated maintenance proposal is superseded.`,
    );
    expect(github.writes.slice(writes).map(({ endpoint }) => endpoint)).toEqual(
      [`${API}/pulls/42`],
    );
    expect(github.commits.size).toBe(1);
    await retire();
    expect(disarmed).toEqual([42]);
    expect(github.writes).toHaveLength(writes + 1);
  });

  test("a sanctioned disarm refusal leaves the proposal open without publishing diagnostics", async () => {
    const github = fakeGithub();
    await github.publish();
    const writes = github.writes.length;
    expect(
      await rejectionOf(
        retireRemoval({
          branch: BRANCH,
          repo: "stella/stella",
          request: github.request,
          disarm: async () => {
            throw new TypeError("Disarm refused: private diagnostic");
          },
        }),
      ),
    ).toMatchObject({ message: "Disarm refused: private diagnostic" });
    expect(github.writes).toHaveLength(writes);
    expect(github.prs.at(0)?.state).not.toBe("closed");
    expect(github.prs.at(0)?.body).toBe(BODY);
  });

  test("ambiguous reserved proposals block both disarm and closure", async () => {
    const github = fakeGithub();
    github.prs.push(
      { number: 42, title: REMOVAL_TITLE, body: BODY },
      { number: 43, title: REMOVAL_TITLE, body: BODY },
    );
    let disarms = 0;
    expect(
      await rejectionOf(
        retireRemoval({
          branch: BRANCH,
          repo: "stella/stella",
          request: github.request,
          disarm: async () => {
            disarms++;
          },
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("Multiple open dated-waiver"),
    });
    expect(disarms).toBe(0);
    expect(github.writes).toEqual([]);
  });

  test("a failed close can replay safely and later green evidence rebuilds a new proposal", async () => {
    const github = fakeGithub({ failure: "update" });
    await github.publish();
    const disarmed: number[] = [];
    const retire = async () =>
      retireRemoval({
        branch: BRANCH,
        repo: "stella/stella",
        request: github.request,
        disarm: async (number) => {
          disarmed.push(number);
        },
      });
    expect(await rejectionOf(retire())).toMatchObject({
      message: "Transient update failure",
    });
    expect(github.prs.at(0)?.state).not.toBe("closed");
    await retire();
    expect(disarmed).toEqual([42, 42]);
    expect(github.prs.at(0)?.state).toBe("closed");
    expect(await github.publish("Verified fresh green evidence.")).toBe(43);
    expect(github.prs.filter(({ state }) => state !== "closed")).toEqual([
      {
        number: 43,
        title: REMOVAL_TITLE,
        body: "Verified fresh green evidence.",
      },
    ]);
    expect(github.refs.get(BRANCH)).toBe("signed-2");
    expect(github.parents.get("signed-2")).toEqual(["base-sha"]);
  });

  test("invalid retirement scope refuses even GitHub reads", async () => {
    for (const fixture of [
      {
        branch: "main",
        repo: "stella/stella",
        message: "Invalid removal branch",
      },
      { branch: BRANCH, repo: "other/repo", message: "requires stella/stella" },
    ]) {
      let reads = 0;
      let disarms = 0;
      expect(
        await rejectionOf(
          retireRemoval({
            ...fixture,
            request: async () => {
              reads++;
              return [];
            },
            disarm: async () => {
              disarms++;
            },
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining(fixture.message) });
      expect(reads).toBe(0);
      expect(disarms).toBe(0);
    }
  });
});
