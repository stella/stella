import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
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

import { parseChangelogMarkdown } from "../apps/landing/src/lib/changelog-markdown";
import { parseChangesetEntry } from "./changeset-entry";
import {
  changesetVersionEnv,
  fetchPublishedAt,
  MaintenanceReleaseError,
  maintenanceChangelog,
  nextPatchVersion,
  parseMaintenanceReleaseOptions,
  parseStableVersion,
  prepareMaintenanceReleaseFiles,
  readPendingChangesets,
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

const failureMessage = async (tag: string): Promise<string> => {
  let publishedAt: string | null;
  try {
    publishedAt = await fetchPublishedAt(tag);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected a failure; read ${String(publishedAt)}`);
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
const previousGhToken = process.env["GH_TOKEN"];
beforeAll(() => {
  process.env["GH_TOKEN"] = "test-token";
});
afterAll(() => {
  if (previousGhToken === undefined) {
    delete process.env["GH_TOKEN"];
  } else {
    process.env["GH_TOKEN"] = previousGhToken;
  }
});

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
      "# Maintenance release\n\nStella includes reliability and maintenance improvements.\n",
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
      "# Maintenance release\n\nStella includes reliability and maintenance improvements.\n\n## Packages\n\n- [@stll/cli](https://github.com/stella/stella/blob/v1.2.4/packages/cli/CHANGELOG.md): Lookup command.\n",
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
        text: "Stella includes reliability and maintenance improvements.",
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
        publishedAt: "2026-02-03T04:05:06Z",
        rootDir: root,
        versionPackages,
      }),
    ).toEqual({
      changelogPath: "docs/changelog/v1.2.4.md",
      changesets: ["cli.md", "empty.md", "ui.md"],
      previousTag: "v1.2.3",
      version: "1.2.4",
    });
    expect(calls).toEqual([root]);
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(
      "# Maintenance release\n\nStella includes reliability and maintenance improvements.\n\n## Packages\n\n- [@stll/cli](https://github.com/stella/stella/blob/v1.2.4/packages/cli/CHANGELOG.md): New `case-law lookup` command: several references per call.\n- [@stll/ui](https://github.com/stella/stella/blob/v1.2.4/packages/ui/CHANGELOG.md): Keep the toolbar in view.\n",
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
        publishedAt: "2026-02-03T04:05:06Z",
        rootDir: root,
        versionPackages,
      }).changesets,
    ).toEqual([]);
    expect(calls).toEqual([]);
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(
      "# Maintenance release\n\nStella includes reliability and maintenance improvements.\n",
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
        publishedAt: "2026-02-03T04:05:06Z",
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
      recordingReviewReason: "Current recordings remain representative.",
    });
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
        publishedAt: "2026-02-03T04:05:06Z",
        rootDir: root,
      }),
    ).toEqual({
      changelogPath: "docs/changelog/v1.2.4.md",
      changesets: [],
      previousTag: "v1.2.3",
      version: "1.2.4",
    });
    expect(readFileSync(nodePath.join(root, "VERSION"), "utf-8")).toBe(
      "1.2.4\n",
    );
    expect(
      readFileSync(nodePath.join(root, "docs/changelog/v1.2.4.md"), "utf-8"),
    ).toBe(
      "# Maintenance release\n\nStella includes reliability and maintenance improvements.\n",
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
      prepareMaintenanceReleaseFiles({ publishedAt: null, rootDir: root }),
    ).toMatchObject({ previousTag: "v1.2.3", version: "1.2.4" });
    expect(readReleaseDates(root)).toEqual({
      "v1.2.2": "2026-01-01T00:00:00Z",
      "v1.2.3": null,
    });
  });

  test("keeps a previous tag already recorded as never promoted", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "stella-release-"));
    roots.push(root);
    releaseFixture(root, `${JSON.stringify({ "v1.2.3": null }, null, 2)}\n`);

    prepareMaintenanceReleaseFiles({
      publishedAt: "2026-02-03T04:05:06Z",
      rootDir: root,
    });
    expect(readReleaseDates(root)).toEqual({ "v1.2.3": null });
  });

  test("reads the publication date of a published release", async () => {
    respondWith(Response.json({ published_at: "2026-02-03T04:05:06Z" }));
    expect(await fetchPublishedAt("v1.2.3")).toBe("2026-02-03T04:05:06Z");
  });

  test("reads a drafted release as never promoted", async () => {
    respondWith(missing(), tagRef(), Response.json([draftRelease]));
    expect(await fetchPublishedAt("v1.2.3")).toBeNull();
  });

  test("reads a release without a publication date as never promoted", async () => {
    respondWith(Response.json({ published_at: null }));
    expect(await fetchPublishedAt("v1.2.3")).toBeNull();
  });

  test("reads a release omitting the publication date as never promoted", async () => {
    respondWith(Response.json({ tag_name: "v1.2.3" }));
    expect(await fetchPublishedAt("v1.2.3")).toBeNull();
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
    expect(await fetchPublishedAt("v1.2.3")).toBeNull();
  });

  test("fails when the previous tag has no release yet", async () => {
    respondWith(missing(), tagRef(), Response.json([{ tag_name: "v1.2.2" }]));
    expect(await failureMessage("v1.2.3")).toContain("has no GitHub release");
  });

  test("fails when the previous tag does not exist", async () => {
    respondWith(missing(), missing());
    expect(await failureMessage("v1.2.3")).toContain("does not exist");
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
        publishedAt: "2026-02-03T04:05:06Z",
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
        publishedAt: "2026-02-03T04:05:06Z",
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
        publishedAt: "2026-02-03T04:05:06Z",
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
        publishedAt: "2026-02-03T04:05:06Z",
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
