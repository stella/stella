import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  type GitHubRequest,
  planReleaseRefresh,
  updateReleaseBranch,
} from "./release-pull-request-refresh";

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

  test("resumes a refresh whose merge landed and whose versioning did not", async () => {
    // The merge moved the branch point past the CLI entry, so main adds
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

describe("merging main into the release branch", () => {
  test("updates only from the planned head and returns the merged head", async () => {
    let reads = 0;
    const slept: number[] = [];
    const { calls, request } = fakeGitHub({
      [`repos/${REPO}/pulls/6777/update-branch`]: null,
      [`repos/${REPO}/pulls/6777`]: () => {
        reads += 1;
        return { head: { sha: reads < 3 ? HEAD : MERGED } };
      },
    });

    expect(
      await updateReleaseBranch({
        request,
        repo: REPO,
        number: 6777,
        head: HEAD,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    ).toBe(MERGED);
    expect(calls.at(0)).toEqual({
      args: [
        `repos/${REPO}/pulls/6777/update-branch`,
        "--method",
        "PUT",
        "--input",
        "-",
      ],
      input: { expected_head_sha: HEAD },
    });
    expect(slept).toHaveLength(2);
  });

  test("fails when the branch never moves", async () => {
    const { request } = fakeGitHub({
      [`repos/${REPO}/pulls/6777/update-branch`]: null,
      [`repos/${REPO}/pulls/6777`]: { head: { sha: HEAD } },
    });
    expect(
      String(
        await rejectionOf(
          updateReleaseBranch({
            request,
            repo: REPO,
            number: 6777,
            head: HEAD,
            sleep: async () => {},
          }),
        ),
      ),
    ).toContain(`Release #6777 still points at ${HEAD} after the update`);
  });
});
