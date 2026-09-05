import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { propertyConfig } from "@stll/property-testing";

import {
  fetchPublishedAt,
  MaintenanceReleaseError,
  nextPatchVersion,
  parseMaintenanceReleaseOptions,
  parseStableVersion,
  prepareMaintenanceReleaseFiles,
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
