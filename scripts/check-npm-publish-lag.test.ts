import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  assessPublishLag,
  assessWithRetries,
  classifyPackage,
  laggingPackages,
  newestStableTag,
  parseArgs,
  readPublishablePackages,
  type RegistryFetcher,
  type RegistryView,
  renderLagTable,
  resolveRef,
} from "./check-npm-publish-lag";
import { readNpmReleaseGraph } from "./generate-npm-release-jobs";
import { ALL_PACKAGE_ORDER, npmReleaseJobId } from "./publish-packages";

const cli = { directory: "cli", name: "@stll/cli", version: "3.8.6" };
const found = (
  latest: string | undefined,
  versions: readonly string[],
): RegistryView => ({ kind: "found", latest, versions });

/** A registry stub keyed by package name; unknown names are not visible. */
const registry =
  (views: Readonly<Record<string, RegistryView>>): RegistryFetcher =>
  async (name) =>
    views[name] ?? { kind: "unavailable", reason: "E404" };

describe("classifyPackage", () => {
  test("is current when latest is the repository version", () => {
    expect(classifyPackage(cli, found("3.8.6", ["3.8.6"])).status).toBe(
      "current",
    );
  });

  test("is current when latest moved past the repository version", () => {
    expect(classifyPackage(cli, found("3.9.0", ["3.9.0"])).status).toBe(
      "current",
    );
  });

  // The shape of a release whose publish failed: npm still serves an old CLI.
  test("flags a version npm never received", () => {
    expect(
      classifyPackage(cli, found("1.19.2", ["1.19.1", "1.19.2"])),
    ).toMatchObject({ npmLatest: "1.19.2", status: "unpublished" });
  });

  test("flags a published version that latest does not point at", () => {
    expect(
      classifyPackage(cli, found("1.19.2", ["1.19.2", "3.8.6"])).status,
    ).toBe("latest-behind");
  });

  test("flags a package with only a prerelease placeholder", () => {
    expect(
      classifyPackage(
        { ...cli, version: "0.1.0" },
        found(undefined, ["0.0.1-placeholder.0"]),
      ).status,
    ).toBe("unpublished");
  });

  test("compares versions numerically, not as text", () => {
    expect(
      classifyPackage({ ...cli, version: "0.10.0" }, found("0.9.0", ["0.9.0"]))
        .status,
    ).toBe("unpublished");
    expect(
      classifyPackage({ ...cli, version: "0.9.0" }, found("0.10.0", ["0.10.0"]))
        .status,
    ).toBe("current");
  });

  test("reports a package the registry does not show", () => {
    expect(
      classifyPackage(cli, { kind: "unavailable", reason: "E404" }),
    ).toMatchObject({ detail: "E404", status: "not-visible" });
  });
});

describe("assessPublishLag", () => {
  test("lists every lagging package with what npm serves", async () => {
    const rows = await assessPublishLag(
      [
        cli,
        { directory: "ui", name: "@stll/ui", version: "0.42.1" },
        {
          directory: "stable-stringify",
          name: "@stll/stable-stringify",
          version: "0.2.1",
        },
        { directory: "time", name: "@stll/time", version: "0.3.0" },
      ],
      registry({
        "@stll/cli": found("1.19.2", ["1.19.2"]),
        "@stll/stable-stringify": found("0.2.0", ["0.2.0"]),
        "@stll/ui": found("0.42.1", ["0.42.1"]),
      }),
    );

    expect(laggingPackages(rows).map((row) => [row.name, row.status])).toEqual([
      ["@stll/cli", "unpublished"],
      ["@stll/stable-stringify", "unpublished"],
      ["@stll/time", "not-visible"],
    ]);
    const table = renderLagTable(rows);
    expect(table.split("\n")[0]).toMatch(
      /^package\s+repo\s+npm latest\s+status$/u,
    );
    expect(table).toMatch(/@stll\/cli\s+3\.8\.6\s+1\.19\.2\s+unpublished/u);
    expect(table).toMatch(/@stll\/time\s+0\.3\.0\s+-\s+not-visible \(E404\)/u);
    expect(table).toMatch(/@stll\/ui\s+0\.42\.1\s+0\.42\.1\s+current/u);
  });
});

describe("assessWithRetries", () => {
  test("re-reads the registry until a fresh publish appears", async () => {
    const answers = [found("1.19.2", ["1.19.2"]), found("3.8.6", ["3.8.6"])];
    const slept: number[] = [];
    let reads = 0;
    const rows = await assessWithRetries(
      [cli],
      async () => {
        const answer = answers[Math.min(reads, answers.length - 1)];
        reads += 1;
        return answer ?? found(undefined, []);
      },
      {
        attempts: 5,
        intervalMs: 10,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    expect(laggingPackages(rows)).toEqual([]);
    expect(reads).toBe(2);
    expect(slept).toEqual([10]);
  });

  test("gives up after the last attempt and keeps the lag", async () => {
    let reads = 0;
    const rows = await assessWithRetries(
      [cli],
      async () => {
        reads += 1;
        return found("1.19.2", ["1.19.2"]);
      },
      { attempts: 3, intervalMs: 0, sleep: async () => undefined },
    );

    expect(reads).toBe(3);
    expect(laggingPackages(rows).map((row) => row.status)).toEqual([
      "unpublished",
    ]);
  });

  test("does not wait when nothing lags", async () => {
    let slept = false;
    await assessWithRetries(
      [cli],
      registry({ "@stll/cli": found("3.8.6", []) }),
      {
        attempts: 5,
        intervalMs: 10,
        sleep: async () => {
          slept = true;
        },
      },
    );
    expect(slept).toBe(false);
  });
});

describe("readPublishablePackages", () => {
  const manifestFor = (
    directory: string,
    extra: Record<string, unknown> = {},
  ) =>
    JSON.stringify({ name: `@stll/${directory}`, version: "1.0.0", ...extra });

  test("checks every package publish-npm.yml releases by default", () => {
    const packages = readPublishablePackages({
      readManifest: (directory) => manifestFor(directory),
    });
    expect(packages.map((pkg) => pkg.directory)).toEqual([
      ...ALL_PACKAGE_ORDER,
    ]);
  });

  test("narrows to the packages a run published", () => {
    expect(
      readPublishablePackages({
        only: ["cli", "ui"],
        readManifest: (directory) => manifestFor(directory),
      }).map((pkg) => pkg.name),
    ).toEqual(["@stll/ui", "@stll/cli"]);
  });

  test("skips packages that are private or absent at the ref", () => {
    const manifests = new Map<string, string>([
      ["cli", manifestFor("cli")],
      ["ui", manifestFor("ui", { private: true })],
    ]);
    const packages = readPublishablePackages({
      only: ["cli", "ui", "chat"],
      readManifest: (directory) => manifests.get(directory),
    });
    expect(packages.map((pkg) => pkg.directory)).toEqual(["cli"]);
  });

  test("refuses a package publish-npm.yml does not know", () => {
    expect(() =>
      readPublishablePackages({
        only: ["web"],
        readManifest: (directory) => manifestFor(directory),
      }),
    ).toThrow(/unknown package\(s\): web/u);
  });

  test("refuses a manifest without a version", () => {
    expect(() =>
      readPublishablePackages({
        only: ["cli"],
        readManifest: () => JSON.stringify({ name: "@stll/cli" }),
      }),
    ).toThrow(/has no name or version/u);
  });

  // The real manifests: nothing publish-npm.yml releases is marked private,
  // so the default check covers the whole release.
  test("no released package is private in the repository", async () => {
    const manifests = await Promise.all(
      ALL_PACKAGE_ORDER.map(async (directory) =>
        Bun.file(
          new URL(`../packages/${directory}/package.json`, import.meta.url),
        ).text(),
      ),
    );
    const byDirectory = new Map<string, string | undefined>(
      ALL_PACKAGE_ORDER.map((directory, index) => [
        directory,
        manifests[index],
      ]),
    );
    expect(
      readPublishablePackages({
        readManifest: (directory) => byDirectory.get(directory),
      }).length,
    ).toBe(ALL_PACKAGE_ORDER.length);
  });
});

describe("newestStableTag", () => {
  test("skips prereleases and other tags", () => {
    expect(
      newestStableTag(["v3.9.0-rc.1", "@stll/ui@0.42.1", "v3.8.6", "v3.8.5"]),
    ).toBe("v3.8.6");
    expect(newestStableTag(["v1.0.0-beta.1", ""])).toBeUndefined();
    expect(newestStableTag(["v1.2.9", "v1.2.10", "v1.2.3"])).toBe("v1.2.10");
    expect(
      newestStableTag(["v1.2.10", "v1.2.9", "v1.2.11-rc.1"], "1.2.10"),
    ).toBe("v1.2.9");
  });
});

describe("previous final release resolution", () => {
  type RunGit = NonNullable<Parameters<typeof resolveRef>[1]>;
  const withHistory = (check: (runGit: RunGit) => void) => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "stella-npm-previous-final-"),
    );
    const runGit = (command: readonly string[]) => {
      const result = Bun.spawnSync([...command], { cwd: directory });
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    };
    const git = (...args: string[]) => {
      const result = runGit(["git", ...args]);
      expect(result.ok, result.stderr).toBe(true);
      return result.stdout.trim();
    };
    try {
      git("init", "-q", "--initial-branch=main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "commit.gpgsign", "false");
      git("config", "tag.gpgsign", "false");
      writeFileSync(path.join(directory, "VERSION"), "1.2.2\n");
      git("add", "VERSION");
      git("commit", "-qm", "initial final");
      git("tag", "v1.2.2");
      git("switch", "-qc", "release/sibling");
      writeFileSync(path.join(directory, "VERSION"), "1.2.3\n");
      git("commit", "-qam", "sibling final");
      git("tag", "v1.2.3");
      git("switch", "-q", "main");
      writeFileSync(path.join(directory, "VERSION"), "1.2.4\n");
      git("commit", "-qam", "candidate");
      git("tag", "v1.2.4-rc.7");
      expect(
        runGit(["git", "merge-base", "--is-ancestor", "v1.2.3", "HEAD"]).ok,
      ).toBe(false);
      check(runGit);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  test("selects the newest lower final even when it is on a sibling release branch", () => {
    withHistory((runGit) => {
      expect(
        resolveRef(parseArgs(["--previous-release-of", "HEAD"]), runGit),
      ).toBe("v1.2.3");
    });
  });

  test("the candidate's own final tag and newer finals never count as previous", () => {
    withHistory((runGit) => {
      expect(runGit(["git", "tag", "v1.2.4"]).ok).toBe(true);
      expect(runGit(["git", "tag", "v9.0.0"]).ok).toBe(true);
      expect(
        resolveRef(parseArgs(["--previous-release-of", "HEAD"]), runGit),
      ).toBe("v1.2.3");
    });
  });

  test("reads VERSION from the provided ref rather than the current checkout", () => {
    withHistory((runGit) => {
      expect(
        resolveRef(
          parseArgs(["--previous-release-of", "release/sibling"]),
          runGit,
        ),
      ).toBe("v1.2.2");
    });
  });

  test("explicit ref semantics do not read VERSION or search tags", () => {
    expect(
      resolveRef(parseArgs(["--ref", "named-ref"]), () => {
        throw new TypeError("explicit ref must not execute a command");
      }),
    ).toBe("named-ref");
  });
});

describe("parseArgs", () => {
  test("needs exactly one ref source", () => {
    expect(() => parseArgs([])).toThrow(/exactly one/u);
    expect(() =>
      parseArgs(["--ref", "HEAD", "--previous-release-of", "HEAD"]),
    ).toThrow(/exactly one/u);
  });

  test("reads the package list and retry budget", () => {
    expect(
      parseArgs([
        "--ref",
        "abc",
        "--packages",
        "cli, ui",
        "--attempts",
        "10",
        "--interval-seconds",
        "30",
      ]),
    ).toEqual({
      attempts: 10,
      intervalSeconds: 30,
      packages: ["cli", "ui"],
      previousReleaseOf: undefined,
      ref: "abc",
    });
  });

  test("treats an empty package list as all packages", () => {
    expect(parseArgs(["--ref", "abc", "--packages", ""]).packages).toBe(
      undefined,
    );
  });

  test("rejects unknown flags and bad numbers", () => {
    expect(() => parseArgs(["--ref", "abc", "--force", "1"])).toThrow(
      /unknown argument/u,
    );
    expect(() => parseArgs(["--ref", "abc", "--attempts", "0"])).toThrow(
      /positive integer/u,
    );
  });
});

describe("release workflows run the guard", () => {
  const workflow = async (name: string) =>
    Bun.file(new URL(`../.github/workflows/${name}`, import.meta.url)).text();

  test("publish-npm.yml checks npm after publishing", async () => {
    const text = await workflow("publish-npm.yml");
    expect(text).toContain("bun scripts/check-npm-publish-lag.ts");
    const { jobs } = v.parse(
      v.looseObject({
        jobs: v.record(
          v.string(),
          v.looseObject({
            needs: v.optional(v.union([v.string(), v.array(v.string())])),
          }),
        ),
      }),
      Bun.YAML.parse(text),
    );
    const graph = readNpmReleaseGraph({
      readManifest: (directory) =>
        readFileSync(
          path.join(
            import.meta.dirname,
            "..",
            "packages",
            directory,
            "package.json",
          ),
          "utf-8",
        ),
    });
    const needs = (id: string) => {
      const job =
        jobs[id] ?? expect.unreachable(`Missing publishing job: ${id}`);
      return typeof job.needs === "string" ? [job.needs] : (job.needs ?? []);
    };
    for (const { directory, dependencies } of graph) {
      expect(needs(npmReleaseJobId(directory))).toEqual([
        "release-trigger",
        "pack",
        ...dependencies.map(npmReleaseJobId),
      ]);
    }
    expect(needs("release-summary")).toEqual([
      "release-trigger",
      "pack",
      ...graph.map(({ directory }) => npmReleaseJobId(directory)),
    ]);
    expect(needs("verify-npm")).toEqual([
      "release-trigger",
      "pack",
      "release-summary",
    ]);
  });

  test("release-tag.yml refuses a tag while the previous release lags", async () => {
    const text = await workflow("release-tag.yml");
    const guard = text.indexOf(
      "bun scripts/check-npm-publish-lag.ts --previous-release-of HEAD",
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(text.indexOf("git push "));
  });
});
