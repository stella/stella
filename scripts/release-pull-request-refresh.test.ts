import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  type GitHubRequest,
  planReleaseRefresh,
  publishReleaseRefresh,
  stageReleaseRefresh,
  stagingBranch,
} from "./release-pull-request-refresh";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REPO = "stella/stella";
const MAIN = "a".repeat(40);
const HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const MERGED = "d".repeat(40);

const CLI_ENTRY = '---\n"@stll/cli": minor\n---\n\nAdd a command.\n';
const UI_ENTRY = "---\n@stll/ui: patch\n---\n\nKeep the toolbar in view.\n";

/** Answers `gh api` paths from a table and records every call. */
const fakeGitHub = (routes: Record<string, unknown>) => {
  const calls: { args: readonly string[]; input?: unknown }[] = [];
  const request: GitHubRequest = async (args, input) => {
    calls.push(input === undefined ? { args } : { args, input });
    const key = args.at(0) ?? "";
    if (!(key in routes)) {
      throw new Error(`unexpected request: ${key}`);
    }
    const route = routes[key];
    return typeof route === "function" ? route() : route;
  };
  return { calls, request };
};

const listing = (...names: string[]) => names.map((name) => ({ name }));
const encoded = (text: string) => ({
  content: Buffer.from(text).toString("base64"),
});

const MARKER = "---\n---\n";

const releaseRoutes = (
  mainEntries: Record<string, string>,
  // After the cut the release head holds only its marker entry; anything else
  // is a refresh that merged and did not version.
  headEntries: Record<string, string> = {},
) => ({
  [`repos/${REPO}/pulls/6777`]: {
    head: { sha: HEAD, ref: "release/v0.9.64" },
  },
  [`repos/${REPO}/compare/${HEAD}...${MAIN}`]: {
    merge_base_commit: { sha: BASE },
  },
  // The branch point holds what the cut had not yet consumed when it branched.
  [`repos/${REPO}/contents/.changeset?ref=${BASE}`]: listing(
    "README.md",
    "older.md",
  ),
  [`repos/${REPO}/contents/.changeset?ref=${MAIN}`]: listing(
    "README.md",
    "older.md",
    ...Object.keys(mainEntries),
  ),
  [`repos/${REPO}/contents/.changeset?ref=${HEAD}`]: listing(
    "README.md",
    "release-v0.9.64.md",
    ...Object.keys(headEntries),
  ),
  [`repos/${REPO}/contents/.changeset/release-v0.9.64.md?ref=${HEAD}`]:
    encoded(MARKER),
  ...Object.fromEntries(
    Object.entries(mainEntries).map(([name, text]) => [
      `repos/${REPO}/contents/.changeset/${name}?ref=${MAIN}`,
      encoded(text),
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(headEntries).map(([name, text]) => [
      `repos/${REPO}/contents/.changeset/${name}?ref=${HEAD}`,
      encoded(text),
    ]),
  ),
});

describe("which release pull request takes main", () => {
  test("refreshes the open release when main added a CLI changeset since it branched", async () => {
    const { calls, request } = fakeGitHub(
      releaseRoutes({ "cli.md": CLI_ENTRY, "ui.md": UI_ENTRY }),
    );

    expect(
      await planReleaseRefresh({
        request,
        repo: REPO,
        mainSha: MAIN,
        releaseNumbers: "6777",
      }),
    ).toEqual({
      refresh: true,
      number: 6777,
      branch: "release/v0.9.64",
      head: HEAD,
      merge: true,
      changesets: ["cli.md"],
    });
    // Only entries main added are read; older pending entries are the cut's.
    expect(
      calls
        .map(({ args }) => args.at(0))
        .filter((key) => key?.includes("older")),
    ).toEqual([]);
  });

  test("leaves the release alone when main added only other packages' changesets", async () => {
    const { request } = fakeGitHub(releaseRoutes({ "ui.md": UI_ENTRY }));

    expect(
      await planReleaseRefresh({
        request,
        repo: REPO,
        mainSha: MAIN,
        releaseNumbers: "6777",
      }),
    ).toEqual({
      refresh: false,
      reason:
        "release #6777 holds every @stll/cli changeset on main, versioned",
    });
  });

  test("versions a release that took main by hand without its versioning", async () => {
    // The hand merge moved the branch point past the CLI entry, so main adds
    // nothing new; the entry still pends on the release head itself.
    const { request } = fakeGitHub(
      releaseRoutes({}, { "cli.md": CLI_ENTRY, "ui.md": UI_ENTRY }),
    );

    expect(
      await planReleaseRefresh({
        request,
        repo: REPO,
        mainSha: MAIN,
        releaseNumbers: "6777",
      }),
    ).toEqual({
      refresh: true,
      number: 6777,
      branch: "release/v0.9.64",
      head: HEAD,
      merge: false,
      changesets: ["cli.md"],
    });
  });

  test("does nothing without an open release, and asks for a person with two", async () => {
    const { calls, request } = fakeGitHub({});
    expect(
      await planReleaseRefresh({
        request,
        repo: REPO,
        mainSha: MAIN,
        releaseNumbers: "",
      }),
    ).toEqual({ refresh: false, reason: "no release pull request is open" });
    expect(calls).toEqual([]);
    expect(
      String(
        await rejectionOf(
          planReleaseRefresh({
            request,
            repo: REPO,
            mainSha: MAIN,
            releaseNumbers: "6777 6780",
          }),
        ),
      ),
    ).toContain(
      "2 release pull requests are open (6777, 6780); refresh one by hand",
    );
  });

  test("refuses a main commit that is not a full SHA", async () => {
    const { request } = fakeGitHub({});
    expect(
      String(
        await rejectionOf(
          planReleaseRefresh({
            request,
            repo: REPO,
            mainSha: "main",
            releaseNumbers: "6777",
          }),
        ),
      ),
    ).toContain("GitHub main commit is not a full commit SHA");
  });
});

describe("staging main and the release head", () => {
  const STAGING = "refs/heads/release-refresh/6777";

  test("creates the staging branch at the planned head and merges main into it", async () => {
    const { calls, request } = fakeGitHub({
      // A prefix listing: another release's staging branch is not this one.
      [`repos/${REPO}/git/matching-refs/heads/release-refresh/6777`]: [
        { ref: "refs/heads/release-refresh/67770" },
      ],
      [`repos/${REPO}/git/refs`]: { ref: STAGING },
      [`repos/${REPO}/merges`]: { sha: MERGED },
    });

    expect(
      await stageReleaseRefresh({
        request,
        repo: REPO,
        number: 6777,
        head: HEAD,
        mainSha: MAIN,
        merge: true,
      }),
    ).toBe(MERGED);
    expect(calls.slice(1)).toEqual([
      {
        args: [`repos/${REPO}/git/refs`, "--method", "POST", "--input", "-"],
        input: { ref: STAGING, sha: HEAD },
      },
      {
        args: [`repos/${REPO}/merges`, "--method", "POST", "--input", "-"],
        input: {
          base: "release-refresh/6777",
          head: MAIN,
          commit_message: "Merge main into release #6777",
        },
      },
    ]);
  });

  test("restarts a staging branch a failed refresh left, and stages the head alone without a merge", async () => {
    const { calls, request } = fakeGitHub({
      [`repos/${REPO}/git/matching-refs/heads/release-refresh/6777`]: [
        { ref: STAGING },
      ],
      [`repos/${REPO}/git/${STAGING}`]: { ref: STAGING },
    });

    expect(
      await stageReleaseRefresh({
        request,
        repo: REPO,
        number: 6777,
        head: HEAD,
        mainSha: MAIN,
        merge: false,
      }),
    ).toBe(HEAD);
    expect(calls.slice(1)).toEqual([
      {
        args: [
          `repos/${REPO}/git/${STAGING}`,
          "--method",
          "PATCH",
          "--input",
          "-",
        ],
        input: { sha: HEAD, force: true },
      },
    ]);
  });

  test("keeps the head when the staging branch already holds main", async () => {
    const { request } = fakeGitHub({
      [`repos/${REPO}/git/matching-refs/heads/release-refresh/6777`]: [],
      [`repos/${REPO}/git/refs`]: { ref: STAGING },
      [`repos/${REPO}/merges`]: null,
    });

    expect(
      await stageReleaseRefresh({
        request,
        repo: REPO,
        number: 6777,
        head: HEAD,
        mainSha: MAIN,
        merge: true,
      }),
    ).toBe(HEAD);
  });
});

describe("moving the release branch to the versioned head", () => {
  const VERSIONED = "e".repeat(40);
  const signedCommit = (parent: string, verified = true) => ({
    commit: { verification: { verified } },
    parents: [{ sha: parent }, { sha: MAIN }],
  });
  const publishRoutes = ({
    releaseAt = HEAD,
    mergeVerified = true,
  }: { releaseAt?: string; mergeVerified?: boolean } = {}) => ({
    [`repos/${REPO}/commits/${VERSIONED}`]: signedCommit(MERGED),
    [`repos/${REPO}/commits/${MERGED}`]: signedCommit(HEAD, mergeVerified),
    [`repos/${REPO}/git/ref/heads/release/v0.9.64`]: {
      object: { sha: releaseAt },
    },
    [`repos/${REPO}/git/refs/heads/release/v0.9.64`]: { object: {} },
    [`repos/${REPO}/git/refs/heads/release-refresh/6777`]: null,
  });
  const publish = async (request: GitHubRequest, staged = VERSIONED) =>
    await publishReleaseRefresh({
      request,
      repo: REPO,
      number: 6777,
      branch: "release/v0.9.64",
      head: HEAD,
      staged,
    });

  test("fast-forwards the release from the planned head in one update, then drops the staging branch", async () => {
    const { calls, request } = fakeGitHub(publishRoutes());

    await publish(request);

    const writes = calls.filter((call) => call.args.includes("--method"));
    expect(writes).toEqual([
      {
        args: [
          `repos/${REPO}/git/refs/heads/release/v0.9.64`,
          "--method",
          "PATCH",
          "--input",
          "-",
        ],
        input: { sha: VERSIONED, force: false },
      },
      {
        args: [
          `repos/${REPO}/git/refs/heads/release-refresh/6777`,
          "--method",
          "DELETE",
        ],
      },
    ]);
  });

  test("leaves the release untouched when the versioning committed nothing", async () => {
    const { calls, request } = fakeGitHub(publishRoutes());

    expect(String(await rejectionOf(publish(request, "")))).toContain(
      `The refresh of release #6777 versioned nothing; the release keeps ${HEAD}`,
    );
    expect(calls).toEqual([]);
  });

  test("leaves the release untouched when a staged commit is unsigned", async () => {
    const { calls, request } = fakeGitHub(
      publishRoutes({ mergeVerified: false }),
    );

    expect(String(await rejectionOf(publish(request)))).toContain(
      `Staged commit ${MERGED} is not signed`,
    );
    expect(calls.some((call) => call.args.includes("--method"))).toBe(false);
  });

  test("leaves the release untouched when it moved since the plan", async () => {
    const { calls, request } = fakeGitHub(publishRoutes({ releaseAt: BASE }));

    expect(String(await rejectionOf(publish(request)))).toContain(
      `Release #6777 moved from ${HEAD} to ${BASE} during the refresh`,
    );
    expect(calls.some((call) => call.args.includes("--method"))).toBe(false);
  });
});

describe("the refresh workflow", () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/release-pr.yml", import.meta.url),
      "utf-8",
    ),
  );
  const steps = (job: string): Record<string, unknown>[] => {
    assert.ok(isRecord(workflow) && isRecord(workflow["jobs"]));
    const entry = workflow["jobs"][job];
    assert.ok(isRecord(entry) && Array.isArray(entry["steps"]), job);
    return entry["steps"].filter(isRecord);
  };

  test("commits the versioning to the staging branch and moves the release only after it", () => {
    const version = steps("refresh-release-version");
    const commit = version.findIndex(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].includes("/actions/signed-commit@"),
    );
    const publish = version.findIndex(
      (step) =>
        step["run"] === "bun scripts/release-pull-request-refresh.ts publish",
    );
    const commitInputs = version[commit]?.["with"];
    assert.ok(isRecord(commitInputs));

    expect(stagingBranch(6777)).toBe("release-refresh/6777");
    expect(commitInputs["branch"]).toBe(
      `release-refresh/\${{ needs.refresh-release-plan.outputs.number }}`,
    );
    expect(publish).toBe(version.length - 1);
    expect(publish).toBeGreaterThan(commit);
    expect(
      steps("refresh-release-stage").flatMap((step) =>
        typeof step["run"] === "string" ? [step["run"]] : [],
      ),
    ).toEqual(["bun scripts/release-pull-request-refresh.ts stage"]);
  });
});
