import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { propertyConfig } from "@stll/property-testing";
import { createTestState } from "@stll/test-state";

import { parseChangelogMarkdown } from "../apps/landing/src/lib/changelog-markdown";
import { parseChangesetEntry } from "./changeset-entry";
import {
  assertReleaseCutReady,
  changesetVersionEnv,
  foldSupersededChangelog,
  maintenanceChangelog,
  MaintenanceReleaseError,
  nextPatchVersion,
  parseMaintenanceReleaseOptions,
  parseStableVersion,
  prepareMaintenanceReleaseFiles,
  projectReleaseDates,
  readPendingChangesets,
  readPreviousRelease,
  readReleaseManifest,
  refreshMaintenanceReleaseFiles,
  resolveGitHubToken,
  withFileRollback,
} from "./prepare-maintenance-release";

const roots: string[] = [];
const restores: (() => void)[] = [];

// Responses are consumed in request order: the release by tag, then, once that
// answers 404, the tag ref and the pages of the release listing. An unexpected
// extra request reads as HTTP 599 rather than reaching GitHub.
const respondWith = (...responses: readonly Response[]) => {
  const spy = spyOn(globalThis, "fetch");
  for (const response of responses) {
    spy.mockResolvedValueOnce(response);
  }
  spy.mockResolvedValue(new Response(null, { status: 599 }));
  restores.push(() => {
    spy.mockRestore();
  });
};

const missing = () => new Response(null, { status: 404 });
const tagRef = () => Response.json({ ref: "refs/tags/v1.2.3" });
const draftRelease = { draft: true, published_at: null, tag_name: "v1.2.3" };
const PUBLISHED = {
  kind: "published",
  publishedAt: "2026-02-03T04:05:06Z",
} as const;
const UNPROMOTED = { kind: "unpromoted" } as const;

const failureMessage = async (tag: string): Promise<string> => {
  let previous: unknown;
  try {
    previous = await readPreviousRelease(tag);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected a failure; read ${JSON.stringify(previous)}`);
};

const releaseFixture = (root: string, releaseDates: string) => {
  mkdirSync(nodePath.join(root, "docs/changelog"), { recursive: true });
  mkdirSync(nodePath.join(root, "apps/landing/src/data"), { recursive: true });
  writeFileSync(nodePath.join(root, "VERSION"), "1.2.3\n");
  writeFileSync(
    nodePath.join(root, "docs/changelog/v1.2.3.md"),
    "# Previous release\n",
  );
  writeFileSync(
    nodePath.join(root, "apps/landing/src/data/changelog-release-dates.json"),
    releaseDates,
  );
};

const readReleaseDates = (root: string): unknown =>
  JSON.parse(
    readFileSync(
      nodePath.join(root, "apps/landing/src/data/changelog-release-dates.json"),
      "utf-8",
    ),
  );

// The reads resolve their token once, falling back to spawning `gh auth token`
// when no variable holds one. Fetch is stubbed here, so a fixed token keeps the
// first read from waiting on the CLI.
const testState = createTestState({ file: import.meta.path, config: {} });
testState.setEnv("GH_TOKEN", "test-token");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
  for (const restore of restores.splice(0)) {
    restore();
  }
});

// The CLI is a spawned process in a release run; here it is a command runner
// that records what it was asked to run, if anything.
const cliToken = (stdout: string | null) => {
  const commands: (readonly string[])[] = [];
  return {
    commands,
    run: (command: readonly string[]) => {
      commands.push(command);
      return stdout;
    },
  };
};

describe("the token the GitHub reads are made with", () => {
  test("prefers GH_TOKEN, and does not ask the CLI for one", () => {
    const cli = cliToken("cli-token\n");

    expect(
      resolveGitHubToken(
        { GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" },
        cli.run,
      ),
    ).toBe("gh-token");
    expect(cli.commands).toEqual([]);
  });

  test("accepts GITHUB_TOKEN where GH_TOKEN is unset", () => {
    const cli = cliToken("cli-token\n");

    expect(resolveGitHubToken({ GITHUB_TOKEN: "github-token" }, cli.run)).toBe(
      "github-token",
    );
    expect(cli.commands).toEqual([]);
  });

  // Without this the reads go out anonymous, and the anonymous rate limit
  // answers a release preparation with HTTP 403.
  test("falls back to the signed-in CLI when neither variable is set", () => {
    const cli = cliToken("cli-token\n");

    expect(resolveGitHubToken({}, cli.run)).toBe("cli-token");
    // The reads go to github.com. A bare `gh auth token` would answer for
    // the CLI's default host, which is an Enterprise instance under GH_HOST.
    expect(cli.commands).toEqual([
      ["gh", "auth", "token", "--hostname", "github.com"],
    ]);
  });

  test("reads an empty variable as no token at all", () => {
    expect(
      resolveGitHubToken(
        { GH_TOKEN: "", GITHUB_TOKEN: "" },
        cliToken("cli-token\n").run,
      ),
    ).toBe("cli-token");
  });

  // A missing `gh`, one signed out of github.com, or one that answers with
  // nothing: the run continues unauthenticated rather than failing.
  test.each([[null], [""], ["\n"]])(
    "stays unauthenticated when the CLI answers %p",
    (stdout) => {
      expect(resolveGitHubToken({}, cliToken(stdout).run)).toBeNull();
    },
  );

  // The nested `changeset version` run reads GITHUB_TOKEN and nothing else, so
  // a token that came from GH_TOKEN or the signed-in CLI has to be handed down
  // under that name; otherwise the version run fails and the preparation rolls
  // back.
  test("hands a token resolved elsewhere to the version run as GITHUB_TOKEN", () => {
    const fromVariable = { GH_TOKEN: "gh-token", PATH: "/usr/bin" };
    expect(
      changesetVersionEnv(
        fromVariable,
        resolveGitHubToken(fromVariable, cliToken(null).run),
      ),
    ).toEqual({
      GH_TOKEN: "gh-token",
      GITHUB_TOKEN: "gh-token",
      PATH: "/usr/bin",
    });

    const fromCli = { PATH: "/usr/bin" };
    expect(
      changesetVersionEnv(
        fromCli,
        resolveGitHubToken(fromCli, cliToken("cli-token\n").run),
      ),
    ).toEqual({ GITHUB_TOKEN: "cli-token", PATH: "/usr/bin" });
  });

  test("changes GITHUB_TOKEN alone, whatever the parent environment holds", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[A-Z][A-Z_]{0,7}$/u), fc.string()),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        (parent, token) => {
          const child = changesetVersionEnv(parent, token);
          const added = token === null ? [] : ["GITHUB_TOKEN"];
          expect(Object.keys(child).toSorted()).toEqual(
            [...new Set([...Object.keys(parent), ...added])].toSorted(),
          );
          for (const [key, value] of Object.entries(parent)) {
            if (key !== "GITHUB_TOKEN" || token === null) {
              expect(child[key]).toBe(value);
            }
          }
          expect(child["GITHUB_TOKEN"]).toBe(token ?? parent["GITHUB_TOKEN"]);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

describe("pending changesets folded into the release", () => {
  const CLI_ENTRY =
    '---\n"@stll/cli": minor\n---\n\nNew `case-law lookup` command:\nseveral references per call.\n';
  const UI_ENTRY = "---\n@stll/ui: patch\n---\n\nKeep the toolbar in view.\n";

  // What `changeset version` leaves behind: the entries are gone, and the
  // packages carry their new versions.
  const consumeChangesets = () => {
    const calls: string[] = [];
    return {
      calls,
      versionPackages: (root: string) => {
        calls.push(root);
        for (const file of readdirSync(nodePath.join(root, ".changeset"))) {
          if (file !== "README.md") {
            rmSync(nodePath.join(root, ".changeset", file));
          }
        }
        writeFileSync(
          nodePath.join(root, "packages/cli/CHANGELOG.md"),
          "# @stll/cli\n\n## 1.7.0\n",
        );
      },
    };
  };

  const changesetFixture = (root: string, entries: Record<string, string>) => {
    mkdirSync(nodePath.join(root, ".changeset"), { recursive: true });
    for (const [file, text] of Object.entries(entries)) {
      writeFileSync(nodePath.join(root, ".changeset", file), text);
    }
    // The release policy declares the generated paths a version run rewrites;
    // the preparation restores exactly those on failure.
    mkdirSync(nodePath.join(root, "scripts"), { recursive: true });
    writeFileSync(
      nodePath.join(root, "scripts/changeset-policy.json"),
      `${JSON.stringify({ generatedPaths: ["packages/cli/CHANGELOG.md"] })}\n`,
    );
    mkdirSync(nodePath.join(root, "packages/cli"), { recursive: true });
    writeFileSync(
      nodePath.join(root, "packages/cli/CHANGELOG.md"),
      "# @stll/cli\n",
    );
  };

  test("reads the packages and the summary of an entry", () => {
    expect(parseChangesetEntry(CLI_ENTRY)).toEqual({
      packages: ["@stll/cli"],
      summary: "New `case-law lookup` command:\nseveral references per call.",
    });
    expect(parseChangesetEntry(UI_ENTRY)).toEqual({
      packages: ["@stll/ui"],
      summary: "Keep the toolbar in view.",
    });
    // `bun run changeset --empty`: a deliberate no-release change.
    expect(parseChangesetEntry("---\n---\n")).toEqual({
      packages: [],
      summary: "",
    });
    expect(parseChangesetEntry("No frontmatter at all.\n")).toEqual({
      packages: [],
      summary: "",
    });
    expect(() => parseChangesetEntry('---\n"@stll/cli": minor\n')).toThrow(
      "unterminated frontmatter",
    );
  });

  test("lists the pending entries and leaves the Changesets README alone", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    changesetFixture(root, {
      "README.md": "# Changesets\n",
      "b-ui.md": UI_ENTRY,
      "a-cli.md": CLI_ENTRY,
    });

    expect(readPendingChangesets(root).map(({ file }) => file)).toEqual([
      "a-cli.md",
      "b-ui.md",
    ]);
    // A repository that has never had one must not fail the read.
    const bare = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(bare);
    expect(readPendingChangesets(bare)).toEqual([]);
  });

  test("summarizes only the entries that release something", () => {
    expect(maintenanceChangelog([], "1.2.4")).toBe(
      "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n",
    );
    expect(
      maintenanceChangelog(
        [
          { file: "empty.md", packages: [], summary: "" },
          {
            file: "cli.md",
            packages: ["@stll/cli"],
            summary: "Lookup command.",
          },
        ],
        "1.2.4",
      ),
    ).toBe(
      "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n\n## Packages\n\n- [@stll/cli](https://github.com/stella/stella/blob/v1.2.4/packages/cli/CHANGELOG.md): Lookup command.\n",
    );
  });

  test.each([
    "| Old | New |\n| --- | --- |\n| list | search |",
    "Migration details in a second paragraph.\n\nA third paragraph.",
    "```sh\nstella search\n```",
    "- First detail\n- Second detail",
  ])("keeps detail blocks out of the release bullet: %s", (details) => {
    const summary = `Renamed capabilities.\nExisting calls need updating.\n\n${details}`;
    const entry = parseChangesetEntry(
      `---\n"@stll/cli": major\n---\n\n${summary}\n`,
    );
    expect(entry.summary).toBe(summary);
    const markdown = maintenanceChangelog(
      [{ file: "cli.md", ...entry }],
      "1.2.4",
    );
    const bullet =
      "[@stll/cli](https://github.com/stella/stella/blob/v1.2.4/packages/cli/CHANGELOG.md): Renamed capabilities. Existing calls need updating.";
    expect(markdown).toContain(`- ${bullet}\n`);
    expect(markdown).not.toContain(details);
    expect(parseChangelogMarkdown(markdown)).toEqual([
      { type: "heading", level: 1, text: "Maintenance release" },
      {
        type: "paragraph",
        text: "stella includes reliability and maintenance improvements.",
      },
      { type: "heading", level: 2, text: "Packages" },
      { type: "list", items: [bullet] },
    ]);
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    mkdirSync(nodePath.join(root, "docs/changelog"), { recursive: true });
    writeFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), markdown);
    const guard = Bun.spawnSync(
      [
        "bash",
        nodePath.join(import.meta.dirname, "check-release-changelog.sh"),
        "--version",
        "1.2.4",
      ],
      { cwd: root },
    );
    expect(guard.stderr.toString()).toBe("");
    expect(guard.exitCode).toBe(0);
  });

  test.each([
    "| Old | New |\n| --- | --- |\n| list | search |",
    "Old | New\n--- | ---\nlist | search",
    "Intro without a blank line.\n| Old | New |\n| --- | --- |",
    "```sh\nstella search\n```",
    "# Details\n\nMore text.",
    "- First detail\n- Second detail",
  ])("links block-first summaries without flattening markup: %s", (summary) => {
    expect(
      maintenanceChangelog(
        [{ file: "cli.md", packages: ["@stll/cli"], summary }],
        "1.2.4",
      ),
    ).toEndWith(
      "- [@stll/cli](https://github.com/stella/stella/blob/v1.2.4/packages/cli/CHANGELOG.md): See package changelog for details.\n",
    );
  });

  test("links every named package to the release tag", () => {
    const markdown = maintenanceChangelog(
      [
        {
          file: "shared.md",
          packages: ["@stll/cli", "@stll/ui"],
          summary: "Shared fix.",
        },
      ],
      "2.3.4",
    );
    for (const name of ["cli", "ui"]) {
      expect(markdown).toContain(
        `[@stll/${name}](https://github.com/stella/stella/blob/v2.3.4/packages/${name}/CHANGELOG.md)`,
      );
    }
  });

  test("increments the supplied newest final version even when main VERSION differs", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    releaseFixture(root, "{}\n");
    writeFileSync(nodePath.join(root, "VERSION"), "9.9.9\n");
    const prepared = prepareMaintenanceReleaseFiles({
      previousFinalVersion: "1.2.3",
      previousRelease: PUBLISHED,
      rootDir: root,
    });
    expect(prepared.version).toBe("1.2.4");
    expect(readFileSync(nodePath.join(root, "VERSION"), "utf-8")).toBe(
      "1.2.4\n",
    );
  });

  test("versions the pending packages and records them in the changelog", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    releaseFixture(root, "{}\n");
    changesetFixture(root, {
      "README.md": "# Changesets\n",
      "cli.md": CLI_ENTRY,
      "empty.md": "---\n---\n",
      "ui.md": UI_ENTRY,
    });
    const { calls, versionPackages } = consumeChangesets();

    expect(
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
        versionPackages,
      }),
    ).toEqual({
      changelogPath: "docs/changelog/v1.2.4.md",
      changesets: ["cli.md", "empty.md", "ui.md"],
      foldedChangelogPath: null,
      previousTag: "v1.2.3",
      version: "1.2.4",
    });
    expect(calls).toEqual([root]);
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(
      "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n\n## Packages\n\n- [@stll/cli](https://github.com/stella/stella/blob/v1.2.4/packages/cli/CHANGELOG.md): New `case-law lookup` command: several references per call.\n- [@stll/ui](https://github.com/stella/stella/blob/v1.2.4/packages/ui/CHANGELOG.md): Keep the toolbar in view.\n",
    );
    // The generated bumps are release-gated paths, so the release commit
    // carries the empty entry the changeset policy asks for beside them.
    expect(
      readFileSync(
        nodePath.join(root, ".changeset/release-v1.2.4.md"),
        "utf-8",
      ),
    ).toBe("---\n---\n");
    expect(readdirSync(nodePath.join(root, ".changeset")).toSorted()).toEqual([
      "README.md",
      "release-v1.2.4.md",
    ]);
  });

  test("leaves versioning alone when nothing is pending", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    releaseFixture(root, "{}\n");
    changesetFixture(root, { "README.md": "# Changesets\n" });
    const { calls, versionPackages } = consumeChangesets();

    expect(
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
        versionPackages,
      }).changesets,
    ).toEqual([]);
    expect(calls).toEqual([]);
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(
      "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n",
    );
    expect(readdirSync(nodePath.join(root, ".changeset"))).toEqual([
      "README.md",
    ]);
  });

  test("restores the version run's writes when a later one fails", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    releaseFixture(root, "{}\n");
    changesetFixture(root, { "cli.md": CLI_ENTRY });
    const { versionPackages } = consumeChangesets();
    const versionPath = nodePath.join(root, "VERSION");

    expect(() =>
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
        versionPackages,
        writeFile: (path, contents) => {
          if (path === versionPath) {
            throw new Error("simulated write failure");
          }
          writeFileSync(path, contents);
        },
      }),
    ).toThrow("simulated write failure");
    expect(
      existsSync(nodePath.join(root, ".changeset/release-v1.2.4.md")),
    ).toBe(false);
    expect(existsSync(nodePath.join(root, "docs/changelog/v1.2.4.md"))).toBe(
      false,
    );
    // The consumed entry and the package changelog the version run rewrote are
    // back, so the next attempt starts from the clean worktree it asserts.
    expect(
      readFileSync(nodePath.join(root, ".changeset/cli.md"), "utf-8"),
    ).toBe(CLI_ENTRY);
    expect(
      readFileSync(nodePath.join(root, "packages/cli/CHANGELOG.md"), "utf-8"),
    ).toBe("# @stll/cli\n");
  });

  // A release branch after its cut: VERSION names the cut version, its note
  // lists what the cut consumed, and the cut's empty marker entry is present.
  const cutRelease = (root: string, entries: Record<string, string>) => {
    releaseFixture(root, "{}\n");
    writeFileSync(nodePath.join(root, "VERSION"), "1.2.4\n");
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.4.md"),
      "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n\n## Packages\n\n- [@stll/ui](https://github.com/stella/stella/blob/v1.2.4/packages/ui/CHANGELOG.md): Keep the toolbar in view.\n",
    );
    changesetFixture(root, {
      "README.md": "# Changesets\n",
      "release-v1.2.4.md": "---\n---\n",
      ...entries,
    });
  };

  test("a refresh versions entries that reached main after the cut into the same release", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    cutRelease(root, { "cli.md": CLI_ENTRY });
    const { calls, versionPackages } = consumeChangesets();

    expect(
      refreshMaintenanceReleaseFiles({ rootDir: root, versionPackages }),
    ).toEqual({
      changelogPath: "docs/changelog/v1.2.4.md",
      changesets: ["cli.md"],
      version: "1.2.4",
    });
    expect(calls).toEqual([root]);
    expect(readFileSync(nodePath.join(root, "VERSION"), "utf-8")).toBe(
      "1.2.4\n",
    );
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(
      "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n\n## Packages\n\n- [@stll/ui](https://github.com/stella/stella/blob/v1.2.4/packages/ui/CHANGELOG.md): Keep the toolbar in view.\n- [@stll/cli](https://github.com/stella/stella/blob/v1.2.4/packages/cli/CHANGELOG.md): New `case-law lookup` command: several references per call.\n",
    );
    // The version run consumed the marker with the new entry; the release
    // policy still needs it beside the regenerated package files.
    expect(readdirSync(nodePath.join(root, ".changeset")).toSorted()).toEqual([
      "README.md",
      "release-v1.2.4.md",
    ]);
    expect(
      readFileSync(
        nodePath.join(root, ".changeset/release-v1.2.4.md"),
        "utf-8",
      ),
    ).toBe("---\n---\n");
  });

  test("a refresh leaves a release with nothing new untouched", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    cutRelease(root, {});
    const { calls, versionPackages } = consumeChangesets();
    const note = readFileSync(
      nodePath.join(root, "docs/changelog/v1.2.4.md"),
      "utf-8",
    );

    expect(
      refreshMaintenanceReleaseFiles({ rootDir: root, versionPackages }),
    ).toBeNull();
    expect(calls).toEqual([]);
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(note);
  });

  test("a refresh runs only on a branch whose release was cut", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    cutRelease(root, { "cli.md": CLI_ENTRY });
    rmSync(nodePath.join(root, ".changeset/release-v1.2.4.md"));
    const { calls, versionPackages } = consumeChangesets();

    expect(() =>
      refreshMaintenanceReleaseFiles({ rootDir: root, versionPackages }),
    ).toThrow(
      "No cut release v1.2.4 to refresh: .changeset/release-v1.2.4.md is missing",
    );
    expect(calls).toEqual([]);
  });

  test("a refresh restores the version run's writes when the note cannot be written", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    cutRelease(root, { "cli.md": CLI_ENTRY });
    const { versionPackages } = consumeChangesets();
    const notePath = nodePath.join(root, "docs/changelog/v1.2.4.md");
    const note = readFileSync(notePath, "utf-8");

    expect(() =>
      refreshMaintenanceReleaseFiles({
        rootDir: root,
        versionPackages,
        writeFile: (path, contents) => {
          if (path === notePath) {
            throw new Error("simulated write failure");
          }
          writeFileSync(path, contents);
        },
      }),
    ).toThrow("simulated write failure");
    expect(readFileSync(notePath, "utf-8")).toBe(note);
    expect(
      readFileSync(nodePath.join(root, ".changeset/cli.md"), "utf-8"),
    ).toBe(CLI_ENTRY);
    expect(
      readFileSync(
        nodePath.join(root, ".changeset/release-v1.2.4.md"),
        "utf-8",
      ),
    ).toBe("---\n---\n");
    expect(
      readFileSync(nodePath.join(root, "packages/cli/CHANGELOG.md"), "utf-8"),
    ).toBe("# @stll/cli\n");
  });
});

describe("maintenance release preparation", () => {
  test("increments every safe stable patch version without changing its series", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (major, minor, patch) => {
          const next = nextPatchVersion(
            parseStableVersion(`${major}.${minor}.${patch}`),
          );
          expect(next).toEqual({
            major,
            minor,
            patch: patch + 1,
            value: `${major}.${minor}.${patch + 1}`,
          });
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("defaults the recording attestation and keeps an explicit one overridable", () => {
    expect(parseMaintenanceReleaseOptions([])).toEqual({
      allowUnprovenMain: false,
      recordingReviewReason: "Patch release, UX diff negligible",
    });
    expect(() =>
      parseMaintenanceReleaseOptions([
        "--reason",
        "Current recordings remain representative.",
      ]),
    ).toThrow("requires --confirm-current-recordings-reviewed");
    expect(
      parseMaintenanceReleaseOptions([
        "--confirm-current-recordings-reviewed",
        "--reason",
        "Current recordings remain representative.",
      ]),
    ).toEqual({
      allowUnprovenMain: false,
      recordingReviewReason: "Current recordings remain representative.",
    });
  });

  test("takes the unproven-main override only when it is spelled out, once", () => {
    expect(parseMaintenanceReleaseOptions(["--allow-unproven-main"])).toEqual({
      allowUnprovenMain: true,
      recordingReviewReason: "Patch release, UX diff negligible",
    });
    expect(() =>
      parseMaintenanceReleaseOptions([
        "--allow-unproven-main",
        "--allow-unproven-main",
      ]),
    ).toThrow("may be passed only once");
    expect(() => parseMaintenanceReleaseOptions(["--allow-unproven"])).toThrow(
      "Unknown argument",
    );
  });

  test("writes the complete release file set", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    mkdirSync(nodePath.join(root, "docs/changelog"), { recursive: true });
    mkdirSync(nodePath.join(root, "apps/landing/src/data"), {
      recursive: true,
    });
    writeFileSync(nodePath.join(root, "VERSION"), "1.2.3\n");
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.3.md"),
      "# Previous release\n",
    );
    writeFileSync(
      nodePath.join(root, "apps/landing/src/data/changelog-release-dates.json"),
      `${JSON.stringify({ _note: "fixture", "v1.2.2": "2026-01-01T00:00:00Z" }, null, 2)}\n`,
    );

    expect(
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
      }),
    ).toEqual({
      changelogPath: "docs/changelog/v1.2.4.md",
      changesets: [],
      foldedChangelogPath: null,
      previousTag: "v1.2.3",
      version: "1.2.4",
    });
    expect(readFileSync(nodePath.join(root, "VERSION"), "utf-8")).toBe(
      "1.2.4\n",
    );
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(
      "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n",
    );
    // The release guard exempts this changelog from the media requirement by
    // its heading; the generated file must keep satisfying it.
    const guard = Bun.spawnSync(
      [
        "bash",
        nodePath.join(import.meta.dirname, "check-release-changelog.sh"),
        "--version",
        "1.2.4",
      ],
      { cwd: root },
    );
    expect(guard.stderr.toString()).toBe("");
    expect(guard.exitCode).toBe(0);
    const releaseDates: unknown = JSON.parse(
      readFileSync(
        nodePath.join(
          root,
          "apps/landing/src/data/changelog-release-dates.json",
        ),
        "utf-8",
      ),
    );
    expect(releaseDates).toEqual({
      _note: "fixture",
      "v1.2.2": "2026-01-01T00:00:00Z",
      "v1.2.3": "2026-02-03T04:05:06Z",
    });
  });

  test("records a previous tag that was never promoted", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    releaseFixture(
      root,
      `${JSON.stringify({ "v1.2.2": "2026-01-01T00:00:00Z" }, null, 2)}\n`,
    );

    expect(
      prepareMaintenanceReleaseFiles({
        previousRelease: { kind: "unpromoted" },
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
      }),
    ).toMatchObject({ previousTag: "v1.2.3", version: "1.2.4" });
    expect(readReleaseDates(root)).toEqual({
      "v1.2.2": "2026-01-01T00:00:00Z",
      "v1.2.3": null,
    });
  });

  test("records nothing for a superseded VERSION that was never tagged", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    const dates = { "v1.2.2": "2026-01-01T00:00:00Z" };
    releaseFixture(root, `${JSON.stringify(dates, null, 2)}\n`);

    expect(
      prepareMaintenanceReleaseFiles({
        previousRelease: { kind: "superseded" },
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
      }),
    ).toMatchObject({ previousTag: "v1.2.3", version: "1.2.4" });
    expect(readReleaseDates(root)).toEqual(dates);
    expect(readFileSync(nodePath.join(root, "VERSION"), "utf-8")).toBe(
      "1.2.4\n",
    );
  });

  test("a previous tag recorded as never promoted takes the date GitHub now gives it", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    releaseFixture(root, `${JSON.stringify({ "v1.2.3": null }, null, 2)}\n`);

    prepareMaintenanceReleaseFiles({
      previousRelease: PUBLISHED,
      previousFinalVersion: readFileSync(
        nodePath.join(root, "VERSION"),
        "utf-8",
      ).trim(),
      rootDir: root,
    });
    expect(readReleaseDates(root)).toEqual({ "v1.2.3": PUBLISHED.publishedAt });
  });

  test("a recorded never-promoted release stays null even when GitHub shows it published", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    const recorded = `${JSON.stringify(
      {
        _note: "Publication timestamps, keyed by tag.",
        "v0.8.10": null,
        "v0.9.14": null,
        "v1.2.2": "2026-01-01T00:00:00Z",
      },
      null,
      2,
    )}\n`;
    releaseFixture(root, recorded);

    // Each recorded null is a release that was never promoted to production;
    // a GitHub release published for it later does not change that.
    prepareMaintenanceReleaseFiles({
      previousRelease: PUBLISHED,
      previousFinalVersion: "1.2.3",
      rootDir: root,
    });
    expect(
      readFileSync(
        nodePath.join(
          root,
          "apps/landing/src/data/changelog-release-dates.json",
        ),
        "utf-8",
      ),
    ).toBe(
      `${JSON.stringify(
        {
          _note: "Publication timestamps, keyed by tag.",
          "v0.8.10": null,
          "v0.9.14": null,
          "v1.2.2": "2026-01-01T00:00:00Z",
          "v1.2.3": PUBLISHED.publishedAt,
        },
        null,
        2,
      )}\n`,
    );
    expect(
      projectReleaseDates({
        dates: readReleaseManifest(root).releases,
        previousRelease: UNPROMOTED,
        previousTag: "v1.2.4",
      }),
    ).toMatchObject({ "v0.8.10": null, "v0.9.14": null, "v1.2.4": null });
  });

  test.each([
    [{ latest: "2026-01-01T00:00:00Z" }, "invalid stable release ref: latest"],
    [{ "v1.2": null }, "invalid stable release ref: v1.2"],
    [{ _note: 3 }, "note must be a string"],
    [{ "v1.2.1": 1 }, "invalid publication time for v1.2.1"],
  ])("the manifest reader refuses %j", (entries, message) => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    releaseFixture(root, `${JSON.stringify(entries, null, 2)}\n`);

    expect(() => readReleaseManifest(root)).toThrow(message);
  });

  test("reads the publication date of a published release", async () => {
    respondWith(Response.json({ published_at: "2026-02-03T04:05:06Z" }));
    expect(await readPreviousRelease("v1.2.3")).toEqual(PUBLISHED);
  });

  test("reads a drafted release as never promoted", async () => {
    respondWith(missing(), tagRef(), Response.json([draftRelease]));
    expect(await readPreviousRelease("v1.2.3")).toEqual(UNPROMOTED);
  });

  test("reads a release without a publication date as never promoted", async () => {
    respondWith(Response.json({ published_at: null }));
    expect(await readPreviousRelease("v1.2.3")).toEqual(UNPROMOTED);
  });

  test("reads a release omitting the publication date as never promoted", async () => {
    respondWith(Response.json({ tag_name: "v1.2.3" }));
    expect(await readPreviousRelease("v1.2.3")).toEqual(UNPROMOTED);
  });

  test("pages through the release listing to find the drafted release", async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      draft: false,
      published_at: "2026-01-01T00:00:00Z",
      tag_name: `v0.0.${String(index)}`,
    }));
    respondWith(
      missing(),
      tagRef(),
      Response.json(filler),
      Response.json([draftRelease]),
    );
    expect(await readPreviousRelease("v1.2.3")).toEqual(UNPROMOTED);
  });

  test("fails when the previous tag has no release yet", async () => {
    respondWith(missing(), tagRef(), Response.json([{ tag_name: "v1.2.2" }]));
    expect(await failureMessage("v1.2.3")).toContain("has no GitHub release");
  });

  test("reads a VERSION that was never tagged as superseded", async () => {
    respondWith(missing(), missing());
    expect(await readPreviousRelease("v1.2.3")).toEqual({ kind: "superseded" });
  });

  test("fails on an unreadable tag ref", async () => {
    respondWith(missing(), new Response(null, { status: 502 }));
    expect(await failureMessage("v1.2.3")).toContain("HTTP 502");
  });

  test("fails on a GitHub error", async () => {
    respondWith(new Response(null, { status: 500 }));
    expect(await failureMessage("v1.2.3")).toContain("HTTP 500");
  });

  test("fails on an unreadable publication timestamp", async () => {
    respondWith(Response.json({ published_at: "not a timestamp" }));
    expect(await failureMessage("v1.2.3")).toContain(
      "no valid published_at timestamp",
    );
  });

  test("refuses to overwrite an already prepared release", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    mkdirSync(nodePath.join(root, "docs/changelog"), { recursive: true });
    mkdirSync(nodePath.join(root, "apps/landing/src/data"), {
      recursive: true,
    });
    writeFileSync(nodePath.join(root, "VERSION"), "1.2.3\n");
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.3.md"),
      "# Previous release\n",
    );
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.4.md"),
      "# Existing release\n",
    );
    writeFileSync(
      nodePath.join(root, "apps/landing/src/data/changelog-release-dates.json"),
      "{}\n",
    );

    expect(() =>
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
      }),
    ).toThrow("already exists");
  });

  test("restores every release file when preparation fails", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    mkdirSync(nodePath.join(root, "docs/changelog"), { recursive: true });
    mkdirSync(nodePath.join(root, "apps/landing/src/data"), {
      recursive: true,
    });
    const versionPath = nodePath.join(root, "VERSION");
    const releaseDatesPath = nodePath.join(
      root,
      "apps/landing/src/data/changelog-release-dates.json",
    );
    const nextChangelogPath = nodePath.join(root, "docs/changelog/v1.2.4.md");
    writeFileSync(versionPath, "1.2.3\n");
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.3.md"),
      "# Previous release\n",
    );
    writeFileSync(releaseDatesPath, '{"v1.2.2":"2026-01-01T00:00:00Z"}\n');

    let failed = false;
    expect(() =>
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
        writeFile: (path, contents) => {
          if (path === releaseDatesPath && !failed) {
            failed = true;
            throw new Error("simulated write failure");
          }
          writeFileSync(path, contents);
        },
      }),
    ).toThrow("simulated write failure");

    expect(readFileSync(versionPath, "utf-8")).toBe("1.2.3\n");
    expect(readFileSync(releaseDatesPath, "utf-8")).toBe(
      '{"v1.2.2":"2026-01-01T00:00:00Z"}\n',
    );
    expect(existsSync(nextChangelogPath)).toBe(false);
  });

  test("continues rollback after a persistent restore failure", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    mkdirSync(nodePath.join(root, "docs/changelog"), { recursive: true });
    mkdirSync(nodePath.join(root, "apps/landing/src/data"), {
      recursive: true,
    });
    const releaseDatesPath = nodePath.join(
      root,
      "apps/landing/src/data/changelog-release-dates.json",
    );
    const nextChangelogPath = nodePath.join(root, "docs/changelog/v1.2.4.md");
    writeFileSync(nodePath.join(root, "VERSION"), "1.2.3\n");
    writeFileSync(
      nodePath.join(root, "docs/changelog/v1.2.3.md"),
      "# Previous release\n",
    );
    writeFileSync(releaseDatesPath, "{}\n");

    const originalFailure = new Error("persistent write failure");
    let caught: unknown;
    try {
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
        writeFile: (path, contents) => {
          if (path === releaseDatesPath) {
            throw originalFailure;
          }
          writeFileSync(path, contents);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MaintenanceReleaseError);
    if (!(caught instanceof MaintenanceReleaseError)) {
      throw new Error("Expected maintenance release failure");
    }
    expect(caught.message).toContain("persistent write failure");
    expect(caught.message).toContain(
      "1 rollback operation(s) did not complete",
    );
    expect(caught.cause).toBe(originalFailure);

    expect(existsSync(nextChangelogPath)).toBe(false);
    expect(
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
      }),
    ).toMatchObject({ version: "1.2.4" });
  });

  test("restores attestation and release files as one transaction", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    const manifestPath = nodePath.join(root, "recordings-manifest.json");
    const versionPath = nodePath.join(root, "VERSION");
    const changelogPath = nodePath.join(root, "v1.2.4.md");
    writeFileSync(manifestPath, '{"entries":[]}\n');
    writeFileSync(versionPath, "1.2.3\n");

    expect(() =>
      withFileRollback({
        operation: () => {
          writeFileSync(manifestPath, '{"entries":[{"reviewed":true}]}\n');
          writeFileSync(versionPath, "1.2.4\n");
          writeFileSync(changelogPath, "# Maintenance release\n");
          throw new Error("simulated post-attestation failure");
        },
        paths: [manifestPath, versionPath, changelogPath],
      }),
    ).toThrow("simulated post-attestation failure");

    expect(readFileSync(manifestPath, "utf-8")).toBe('{"entries":[]}\n');
    expect(readFileSync(versionPath, "utf-8")).toBe("1.2.3\n");
    expect(existsSync(changelogPath)).toBe(false);
  });
});

describe("a superseded version's notes folded into the release", () => {
  const MAINTENANCE =
    "# Maintenance release\n\nstella includes reliability and maintenance improvements.\n";
  const bullet = (version: string, summary: string) =>
    `- [@stll/cli](https://github.com/stella/stella/blob/v${version}/packages/cli/CHANGELOG.md): ${summary}`;
  const withPackages = (body: string, ...entries: readonly string[]) =>
    `${body}\n## Packages\n\n${entries.map((entry) => `${entry}\n`).join("")}`;
  const FEATURE =
    '# Table improvements\n\n## Faster table editing.\n\n<video controls src="https://github.com/user-attachments/assets/example"></video>\n';

  const supersededFixture = (root: string, superseded: string) => {
    releaseFixture(
      root,
      `${JSON.stringify({ "v1.2.2": "2026-01-01T00:00:00Z" }, null, 2)}\n`,
    );
    writeFileSync(nodePath.join(root, "docs/changelog/v1.2.3.md"), superseded);
  };

  const releaseGuard = (root: string, version: string) =>
    Bun.spawnSync(
      [
        "bash",
        nodePath.join(import.meta.dirname, "check-release-changelog.sh"),
        "--version",
        version,
      ],
      { cwd: root },
    );

  const changelogFiles = (root: string) =>
    readdirSync(nodePath.join(root, "docs/changelog"));

  const changelog = (root: string, tag: string) =>
    readFileSync(nodePath.join(root, "docs/changelog", `${tag}.md`), "utf-8");

  test("lists the superseded bullets first, on the release tag, once each", () => {
    expect(
      foldSupersededChangelog({
        next: withPackages(
          MAINTENANCE,
          bullet("1.2.4", "Newer."),
          bullet("1.2.4", "Shared."),
        ),
        superseded: withPackages(
          MAINTENANCE,
          bullet("1.2.3", "Older."),
          bullet("1.2.3", "Shared."),
        ),
        supersededVersion: "1.2.3",
        version: "1.2.4",
      }),
    ).toBe(
      withPackages(
        MAINTENANCE,
        bullet("1.2.4", "Older."),
        bullet("1.2.4", "Shared."),
        bullet("1.2.4", "Newer."),
      ),
    );
  });

  test("keeps the heading and media of a superseded note that shows a change", () => {
    expect(
      foldSupersededChangelog({
        next: withPackages(MAINTENANCE, bullet("1.2.4", "Newer.")),
        superseded: FEATURE,
        supersededVersion: "1.2.3",
        version: "1.2.4",
      }),
    ).toBe(withPackages(FEATURE, bullet("1.2.4", "Newer.")));
  });

  test("writes no packages section when neither note has one", () => {
    expect(
      foldSupersededChangelog({
        next: MAINTENANCE,
        superseded: MAINTENANCE,
        supersededVersion: "1.2.3",
        version: "1.2.4",
      }),
    ).toBe(MAINTENANCE);
  });

  test("refuses a packages section it cannot place line by line", () => {
    expect(() =>
      foldSupersededChangelog({
        next: MAINTENANCE,
        superseded: `${withPackages(MAINTENANCE, bullet("1.2.3", "Older."))}\nA closing paragraph.\n`,
        supersededVersion: "1.2.3",
        version: "1.2.4",
      }),
    ).toThrow("cannot fold");
  });

  test("moves the superseded page into the release and removes it", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    supersededFixture(
      root,
      withPackages(MAINTENANCE, bullet("1.2.3", "Older.")),
    );

    expect(
      prepareMaintenanceReleaseFiles({
        previousRelease: { kind: "superseded" },
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
      }),
    ).toEqual({
      changelogPath: "docs/changelog/v1.2.4.md",
      changesets: [],
      foldedChangelogPath: "docs/changelog/v1.2.3.md",
      previousTag: "v1.2.3",
      version: "1.2.4",
    });
    expect(changelogFiles(root)).toEqual(["v1.2.4.md"]);
    expect(changelog(root, "v1.2.4")).toBe(
      withPackages(MAINTENANCE, bullet("1.2.4", "Older.")),
    );
    const guard = releaseGuard(root, "1.2.4");
    expect(guard.stderr.toString()).toBe("");
    expect(guard.exitCode).toBe(0);
  });

  test("carries a superseded feature note through the release guard", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    supersededFixture(root, FEATURE);

    prepareMaintenanceReleaseFiles({
      previousRelease: { kind: "superseded" },
      previousFinalVersion: readFileSync(
        nodePath.join(root, "VERSION"),
        "utf-8",
      ).trim(),
      rootDir: root,
    });
    expect(changelogFiles(root)).toEqual(["v1.2.4.md"]);
    expect(changelog(root, "v1.2.4")).toBe(FEATURE);
    const guard = releaseGuard(root, "1.2.4");
    expect(guard.stderr.toString()).toBe("");
    expect(guard.exitCode).toBe(0);
  });

  test("keeps the page of a tagged previous release", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    supersededFixture(root, FEATURE);

    expect(
      prepareMaintenanceReleaseFiles({
        previousRelease: PUBLISHED,
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
      }),
    ).toMatchObject({ foldedChangelogPath: null });
    expect(changelog(root, "v1.2.3")).toBe(FEATURE);
    expect(changelog(root, "v1.2.4")).toBe(MAINTENANCE);
  });

  test("restores the superseded page when preparation fails", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    const superseded = withPackages(MAINTENANCE, bullet("1.2.3", "Older."));
    supersededFixture(root, superseded);
    const versionPath = nodePath.join(root, "VERSION");

    expect(() =>
      prepareMaintenanceReleaseFiles({
        previousRelease: { kind: "superseded" },
        previousFinalVersion: readFileSync(
          nodePath.join(root, "VERSION"),
          "utf-8",
        ).trim(),
        rootDir: root,
        writeFile: (path, contents) => {
          if (path === versionPath) {
            throw new Error("simulated write failure");
          }
          writeFileSync(path, contents);
        },
      }),
    ).toThrow("simulated write failure");

    expect(changelogFiles(root)).toEqual(["v1.2.3.md"]);
    expect(changelog(root, "v1.2.3")).toBe(superseded);
  });

  // The landing changelog lists every note file and requires a date for each
  // but the newest. Whatever GitHub reports for each previous version, a run
  // of cuts leaves no undated page behind the newest, and a bullet of a
  // superseded version stays on exactly one page.
  test("leaves every page but the newest dated after any run of cuts", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("published", "superseded", "unpromoted"), {
          maxLength: 6,
          minLength: 1,
        }),
        (outcomes) => {
          const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
          roots.push(root);
          supersededFixture(
            root,
            withPackages(MAINTENANCE, bullet("1.2.3", "Original.")),
          );
          for (const kind of outcomes) {
            prepareMaintenanceReleaseFiles({
              previousRelease: kind === "published" ? PUBLISHED : { kind },
              previousFinalVersion: readFileSync(
                nodePath.join(root, "VERSION"),
                "utf-8",
              ).trim(),
              rootDir: root,
            });
          }

          const dates = readReleaseDates(root);
          if (!isReleaseDates(dates)) {
            throw new Error("release dates must be an object");
          }
          const listed = changelogFiles(root)
            .map((file) => file.replace(/\.md$/u, ""))
            .filter((tag) => dates[tag] !== null)
            .toSorted(
              (left, right) =>
                parseStableVersion(right.slice(1)).patch -
                parseStableVersion(left.slice(1)).patch,
            );
          expect(listed.at(0)).toBe(`v1.2.${String(3 + outcomes.length)}`);
          expect(
            listed.slice(1).filter((tag) => typeof dates[tag] !== "string"),
          ).toEqual([]);
          const holding = changelogFiles(root).filter((file) =>
            changelog(root, file.replace(/\.md$/u, "")).includes("Original."),
          );
          expect(holding).toHaveLength(1);
        },
      ),
      propertyConfig({ numRuns: 50 }),
    );
  });
});

const isReleaseDates = (
  value: unknown,
): value is Partial<Record<string, string | null>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CUT_SHA = "d".repeat(40);
const RUN_PREFIX = "https://github.com/stella/stella/actions/runs/";
const STATUSES_PATH = `/commits/${CUT_SHA}/statuses?per_page=100&page=1`;
const SCHEDULED_PR_DEPTH_PATH = `/actions/workflows/main-pr-depth.yml/runs?head_sha=${CUT_SHA}&event=schedule&per_page=1`;
const jobsPath = (runId: number) =>
  `/actions/runs/${String(runId)}/jobs?filter=latest&per_page=100&page=1`;

const commitStatus = (
  context: string,
  state: string,
  runId: number,
  login = "github-actions[bot]",
) => ({
  context,
  creator: { login },
  state,
  target_url: `${RUN_PREFIX}${String(runId)}`,
});

const HEAVY_GREEN = commitStatus("main/heavy", "success", 11);
const PR_DEPTH_GREEN = commitStatus("main/pr-depth", "success", 22);

const job = (
  name: string,
  conclusion: string | null,
  status = "completed",
) => ({
  conclusion,
  name,
  run_attempt: 1,
  status,
});

// Every GitHub read the gate makes, by path; any other read fails the test.
const fakeGitHub = (responses: Record<string, unknown>) => {
  const paths: string[] = [];
  const read = async (path: string): Promise<unknown> => {
    paths.push(path);
    if (!(path in responses)) {
      throw new Error(`Unexpected GitHub read: ${path}`);
    }
    const response = responses[path];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  return Object.assign(read, { paths });
};

// The unmet checks ci-result publishes beside the required-jobs record.
const heavyViolations = (overrides: Record<string, unknown> = {}) => ({
  run_id: 11,
  run_attempt: 1,
  head_sha: CUT_SHA,
  evaluated: true,
  violations: "marketing-screenshots (planned, failure)",
  ...overrides,
});

// The two artifacts ci-result uploads; null stands for unreadable.
const fakeRecord =
  (record: unknown, violations: unknown = heavyViolations()) =>
  async (_runId: string, artifact: string): Promise<unknown> => {
    const found = artifact === "ci-required-summary" ? record : violations;
    if (found === null) {
      throw new Error(`no ${artifact} artifact`);
    }
    return found;
  };

const cutRefusal = async (
  responses: Record<string, unknown>,
  record: unknown = null,
  violations: unknown = heavyViolations(),
): Promise<string> => {
  const written: string[] = [];
  try {
    await assertReleaseCutReady(
      CUT_SHA,
      false,
      { json: fakeGitHub(responses), record: fakeRecord(record, violations) },
      (text) => {
        written.push(text);
      },
    );
  } catch (error) {
    expect(error).toBeInstanceOf(MaintenanceReleaseError);
    expect(written).toEqual([]);
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    `Expected the cut to be refused; it printed ${written.join("")}`,
  );
};

describe("release cut readiness", () => {
  test("cuts when main/heavy and main/pr-depth are green on the commit", async () => {
    const read = fakeGitHub({
      [STATUSES_PATH]: [PR_DEPTH_GREEN, HEAVY_GREEN],
    });
    const written: string[] = [];

    await assertReleaseCutReady(CUT_SHA, false, { json: read }, (text) => {
      written.push(text);
    });

    expect(written).toEqual([
      `maintenance-release: main/heavy and main/pr-depth are green on ${CUT_SHA}\n`,
    ]);
    expect(read.paths).toEqual([STATUSES_PATH]);
  });

  test("refuses a red gate and names its failing jobs and the rerun", async () => {
    const message = await cutRefusal({
      [STATUSES_PATH]: [
        commitStatus("main/heavy", "failure", 11),
        PR_DEPTH_GREEN,
      ],
      [jobsPath(11)]: {
        jobs: [
          job("suites / api-tests (2)", "failure"),
          job("suites / web-tests", "success"),
          job("suites / docker-checks", "skipped"),
          job("suites / e2e", "cancelled"),
          job("status", null, "in_progress"),
        ],
      },
    });

    expect(message).toBe(
      [
        `main is not release-ready at ${CUT_SHA}:`,
        `  main/heavy: failure (status failure) ${RUN_PREFIX}11`,
        "    failing job: suites / api-tests (2) (failure)",
        "    failing job: suites / e2e (cancelled)",
        "    failing job: status (in_progress)",
        `    run it: gh workflow run main-heavy.yml --ref main -f sha=${CUT_SHA}`,
        "Cut from a commit where both are green, or pass --allow-unproven-main to cut anyway.",
      ].join("\n"),
    );
  });

  const MARKETING_JOB = "suites / marketing-screenshots / check";
  const COMPARISON_FAILED_STEPS = [
    { name: "Set up job", conclusion: "success" },
    { name: "Capture marketing screenshots", conclusion: "failure" },
    { name: "Read screenshot comparison phase", conclusion: "success" },
    { name: "Screenshot comparison failed", conclusion: "success" },
  ];
  const marketingJob = (steps: unknown[] = COMPARISON_FAILED_STEPS) => ({
    ...job(MARKETING_JOB, "failure"),
    steps,
  });
  const heavyRecord = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    run_id: 11,
    head_sha: CUT_SHA,
    basis: "evaluated",
    depth: "heavy",
    run_attempt: 1,
    verdict: "failure",
    required: [
      { job: "ci-tests", conclusion: "success" },
      { job: "marketing-screenshots", conclusion: "failure" },
    ],
    ...overrides,
  });
  const heavyRun = (overrides: Record<string, unknown> = {}) => ({
    id: 11,
    html_url: `${RUN_PREFIX}11`,
    repository: { full_name: "stella/stella" },
    path: ".github/workflows/main-heavy.yml",
    head_branch: "main",
    event: "push",
    display_title: `Main heavy suites ${CUT_SHA}`,
    run_attempt: 1,
    head_sha: CUT_SHA,
    status: "completed",
    conclusion: "failure",
    ...overrides,
  });
  type HeavyFailureOptions = { run?: Record<string, unknown>; total?: number };
  const heavyFailure = (
    jobs: unknown[],
    { run = heavyRun(), total = jobs.length }: HeavyFailureOptions = {},
  ) => ({
    [STATUSES_PATH]: [
      commitStatus("main/heavy", "failure", 11),
      PR_DEPTH_GREEN,
    ],
    [jobsPath(11)]: { total_count: total, jobs },
    "/actions/runs/11": run,
  });
  const rollups = [
    job("suites / ci-result", "failure"),
    job("status", "failure"),
  ];

  test("cuts with a warning when main/heavy failed only in the screenshot comparison", async () => {
    const written: string[] = [];
    await assertReleaseCutReady(
      CUT_SHA,
      false,
      {
        json: fakeGitHub(
          heavyFailure([
            job("suites / web-tests", "success"),
            marketingJob(),
            ...rollups,
          ]),
        ),
        record: fakeRecord(heavyRecord()),
      },
      (text) => {
        written.push(text);
      },
    );
    expect(written).toEqual([
      `::warning::maintenance-release: main/heavy failed only in advisory jobs (${MARKETING_JOB}) ${RUN_PREFIX}11\n`,
      `maintenance-release: main/heavy and main/pr-depth are green on ${CUT_SHA}\n`,
    ]);
  });

  test("refuses when another job failed beside marketing screenshots", async () => {
    const message = await cutRefusal(
      heavyFailure([
        marketingJob(),
        job("suites / api-tests (2)", "failure"),
        ...rollups,
      ]),
      heavyRecord(),
    );
    expect(message).toContain("failing job: suites / api-tests (2) (failure)");
  });

  test.each([
    [
      "a skipped planned required job",
      heavyRecord({
        required: [
          { job: "e2e-production-shard", conclusion: "skipped" },
          { job: "marketing-screenshots", conclusion: "failure" },
        ],
      }),
      heavyViolations(),
    ],
    [
      "a folded sub-suite that is not success",
      heavyRecord(),
      heavyViolations({
        violations:
          "marketing-screenshots (planned, failure), api-image-deps (planned, failure)",
      }),
    ],
    [
      "unevaluated violations",
      heavyRecord(),
      heavyViolations({ evaluated: false }),
    ],
    ["an absent violations artifact", heavyRecord(), null],
    [
      "a violations artifact of another run",
      heavyRecord(),
      heavyViolations({ run_id: 12 }),
    ],
    [
      "a violations artifact of another commit",
      heavyRecord(),
      heavyViolations({ head_sha: "e".repeat(40) }),
    ],
    ["an unreadable required-jobs record", null, heavyViolations()],
    ["a record of another run", heavyRecord({ run_id: 12 }), heavyViolations()],
  ])(
    "refuses an advisory failure beside %s",
    async (_label, record, violations) => {
      const message = await cutRefusal(
        heavyFailure([marketingJob(), ...rollups]),
        record,
        violations,
      );
      expect(message).toContain("main/heavy: failure");
    },
  );

  test.each([
    [
      "a seed step",
      [
        { name: "Set up job", conclusion: "success" },
        { name: "Capture marketing screenshots", conclusion: "failure" },
        { name: "Screenshot comparison failed", conclusion: "skipped" },
      ],
    ],
    [
      "an earlier step beside the comparison",
      [
        { name: "Checkout", conclusion: "failure" },
        { name: "Capture marketing screenshots", conclusion: "failure" },
        { name: "Screenshot comparison failed", conclusion: "success" },
      ],
    ],
  ])(
    "refuses a failure in %s inside the screenshots job",
    async (_label, steps) => {
      const message = await cutRefusal(
        heavyFailure([marketingJob(steps), ...rollups]),
        heavyRecord(),
      );
      expect(message).toContain(
        "failing job: suites / marketing-screenshots / check (failure)",
      );
    },
  );

  test("refuses artifacts of attempt 1 when the run is at attempt 2", async () => {
    const message = await cutRefusal(
      heavyFailure([marketingJob(), ...rollups], {
        run: heavyRun({ run_attempt: 2 }),
      }),
      heavyRecord(),
      heavyViolations(),
    );
    expect(message).toContain("main/heavy: failure");
  });

  test("cuts when the jobs and both artifacts are from the run's attempt", async () => {
    const attempt2 = [marketingJob(), ...rollups].map((entry) => ({
      ...entry,
      run_attempt: 2,
    }));
    const written: string[] = [];
    await assertReleaseCutReady(
      CUT_SHA,
      false,
      {
        json: fakeGitHub(
          heavyFailure(attempt2, { run: heavyRun({ run_attempt: 2 }) }),
        ),
        record: fakeRecord(
          heavyRecord({ run_attempt: 2 }),
          heavyViolations({ run_attempt: 2 }),
        ),
      },
      (text) => {
        written.push(text);
      },
    );
    expect(written.join("")).toContain("green on");
  });

  test("refuses a job list from an earlier attempt than the run's", async () => {
    const message = await cutRefusal(
      heavyFailure([marketingJob(), ...rollups], {
        run: heavyRun({ run_attempt: 2 }),
      }),
      heavyRecord({ run_attempt: 2 }),
      heavyViolations({ run_attempt: 2 }),
    );
    expect(message).toContain("main/heavy: failure");
  });

  test("refuses a job count different from total_count", async () => {
    const message = await cutRefusal(
      heavyFailure([marketingJob(), ...rollups], { total: 4 }),
      heavyRecord(),
    );
    expect(message).toContain("main/heavy: failure");
  });

  test.each([
    [
      "a cancelled advisory job",
      [{ ...marketingJob(), conclusion: "cancelled" }, ...rollups],
    ],
    [
      "an unknown job name",
      [{ ...marketingJob(), name: "suites / other-shots / check" }],
    ],
    ["only the aggregates failing", rollups],
  ])("refuses %s", async (_label, jobs) => {
    expect(await cutRefusal(heavyFailure(jobs), heavyRecord())).toContain(
      "main/heavy: failure",
    );
  });

  test.each([
    ["a different workflow", { path: ".github/workflows/ci.yml" }],
    ["a different head_sha", { head_sha: "e".repeat(40) }],
    ["a different title commit", { display_title: "Main heavy suites x" }],
    ["a run that is not completed", { status: "in_progress" }],
    ["a cancelled run", { conclusion: "cancelled" }],
    ["a successful run", { conclusion: "success" }],
    ["another repository", { repository: { full_name: "other/stella" } }],
  ])(
    "refuses an advisory-only status linking to %s",
    async (_label, overrides) => {
      const message = await cutRefusal(
        heavyFailure([marketingJob(), ...rollups], {
          run: heavyRun(overrides),
        }),
        heavyRecord(),
      );
      expect(message).toContain("main/heavy: failure");
    },
  );

  test("an unreadable run is a refusal", async () => {
    const message = await cutRefusal(
      {
        ...heavyFailure([marketingJob(), ...rollups]),
        "/actions/runs/11": new Error("HTTP 502"),
      },
      heavyRecord(),
    );
    expect(message).toContain("main/heavy: failure");
  });

  test("an error status is never advisory", async () => {
    const message = await cutRefusal(
      {
        [STATUSES_PATH]: [
          commitStatus("main/heavy", "error", 11),
          PR_DEPTH_GREEN,
        ],
        [jobsPath(11)]: { total_count: 3, jobs: [marketingJob(), ...rollups] },
      },
      heavyRecord(),
    );
    expect(message).toContain("main/heavy: failure (status error)");
  });

  test("reads only the newest status of each gate", async () => {
    const newerRed = await cutRefusal({
      [STATUSES_PATH]: [
        commitStatus("main/pr-depth", "failure", 23),
        HEAVY_GREEN,
        PR_DEPTH_GREEN,
      ],
      [jobsPath(23)]: { jobs: [job("suites / lint", "failure")] },
    });
    expect(newerRed).toContain("main/pr-depth: failure");
    expect(newerRed).toContain("failing job: suites / lint (failure)");
    expect(newerRed).not.toContain("main/heavy");

    const newerGreen = fakeGitHub({
      [STATUSES_PATH]: [
        HEAVY_GREEN,
        PR_DEPTH_GREEN,
        commitStatus("main/heavy", "failure", 10),
      ],
    });
    await assertReleaseCutReady(
      CUT_SHA,
      false,
      { json: newerGreen },
      () => undefined,
    );
  });

  test("refuses a missing main/heavy status and says how to run it", async () => {
    const message = await cutRefusal({ [STATUSES_PATH]: [PR_DEPTH_GREEN] });

    expect(message).toContain(
      "  main/heavy: missing (no status on the commit)",
    );
    expect(message).toContain(
      `    run it: gh workflow run main-heavy.yml --ref main -f sha=${CUT_SHA}`,
    );
  });

  test("refuses a pending gate", async () => {
    const message = await cutRefusal({
      [STATUSES_PATH]: [
        HEAVY_GREEN,
        commitStatus("main/pr-depth", "pending", 24),
      ],
      [jobsPath(24)]: { jobs: [job("suites / lint", null, "queued")] },
    });

    expect(message).toContain("main/pr-depth: pending (status pending)");
    expect(message).toContain("failing job: suites / lint (queued)");
    expect(message).not.toContain("run it:");
  });

  test("does not take a success reported by anyone but the workflow bot", async () => {
    const message = await cutRefusal({
      [STATUSES_PATH]: [
        HEAVY_GREEN,
        commitStatus("main/pr-depth", "success", 25, "someone"),
      ],
      [jobsPath(25)]: { jobs: [] },
    });

    expect(message).toContain(
      "main/pr-depth: failure (status success set by someone, not github-actions[bot])",
    );
  });

  test("answers a missing main/pr-depth status with its latest scheduled run", async () => {
    const scheduledRun = (status: string, conclusion: string | null) => ({
      workflow_runs: [
        {
          conclusion,
          event: "schedule",
          head_sha: CUT_SHA,
          html_url: `${RUN_PREFIX}30`,
          status,
        },
      ],
    });
    const read = fakeGitHub({
      [STATUSES_PATH]: [HEAVY_GREEN],
      [SCHEDULED_PR_DEPTH_PATH]: scheduledRun("completed", "success"),
    });
    await assertReleaseCutReady(
      CUT_SHA,
      false,
      { json: read },
      () => undefined,
    );
    expect(read.paths).toEqual([STATUSES_PATH, SCHEDULED_PR_DEPTH_PATH]);

    const failed = await cutRefusal({
      [STATUSES_PATH]: [HEAVY_GREEN],
      [SCHEDULED_PR_DEPTH_PATH]: scheduledRun("completed", "failure"),
      [jobsPath(30)]: { jobs: [job("suites / typecheck", "failure")] },
    });
    expect(failed).toContain(
      `main/pr-depth: failure (no status; latest scheduled run completed/failure) ${RUN_PREFIX}30`,
    );
    expect(failed).toContain("failing job: suites / typecheck (failure)");

    const running = await cutRefusal({
      [STATUSES_PATH]: [HEAVY_GREEN],
      [SCHEDULED_PR_DEPTH_PATH]: scheduledRun("in_progress", null),
      [jobsPath(30)]: {
        jobs: [job("suites / typecheck", null, "in_progress")],
      },
    });
    expect(running).toContain("main/pr-depth: pending");

    const none = await cutRefusal({
      [STATUSES_PATH]: [HEAVY_GREEN],
      [SCHEDULED_PR_DEPTH_PATH]: { workflow_runs: [] },
    });
    expect(none).toContain(
      "main/pr-depth: missing (no status and no scheduled run on the commit)",
    );
    expect(none).toContain(
      `run it: gh workflow run main-pr-depth.yml --ref main -f sha=${CUT_SHA}`,
    );
  });

  test("fails closed when GitHub cannot be read", async () => {
    const unreadable = await cutRefusal({
      [STATUSES_PATH]: new Error("HTTP 502"),
    });
    expect(unreadable).toContain("main/heavy: unreadable (HTTP 502)");
    expect(unreadable).toContain("main/pr-depth: unreadable (HTTP 502)");

    const malformed = await cutRefusal({ [STATUSES_PATH]: { statuses: [] } });
    expect(malformed).toContain("main/heavy: unreadable");

    const jobsDown = await cutRefusal({
      [STATUSES_PATH]: [
        commitStatus("main/heavy", "error", 12),
        PR_DEPTH_GREEN,
      ],
      [jobsPath(12)]: new Error("HTTP 500"),
    });
    expect(jobsDown).toContain("main/heavy: failure (status error)");
    expect(jobsDown).toContain("failing job: (jobs unreadable: HTTP 500)");
  });

  test("reads every page of statuses before calling a gate missing", async () => {
    const unrelated = Array.from({ length: 100 }, (_unused, index) =>
      commitStatus(`other/${String(index)}`, "success", 40 + index),
    );
    const read = fakeGitHub({
      [STATUSES_PATH]: unrelated,
      [`/commits/${CUT_SHA}/statuses?per_page=100&page=2`]: [
        HEAVY_GREEN,
        PR_DEPTH_GREEN,
      ],
    });

    await assertReleaseCutReady(
      CUT_SHA,
      false,
      { json: read },
      () => undefined,
    );
    expect(read.paths).toHaveLength(2);
  });

  test("an explicit override prints the same refusal and lets the cut go on", async () => {
    const written: string[] = [];

    await assertReleaseCutReady(
      CUT_SHA,
      true,
      { json: fakeGitHub({ [STATUSES_PATH]: [PR_DEPTH_GREEN] }) },
      (text) => {
        written.push(text);
      },
    );

    expect(written).toEqual([
      [
        "maintenance-release: --allow-unproven-main passed; cutting anyway.",
        `main is not release-ready at ${CUT_SHA}:`,
        "  main/heavy: missing (no status on the commit)",
        `    run it: gh workflow run main-heavy.yml --ref main -f sha=${CUT_SHA}`,
        "",
      ].join("\n"),
    ]);
  });
});
