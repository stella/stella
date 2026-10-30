import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  assessPublishLag,
  assessWithRetries,
  classifyPackage,
  laggingPackages,
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

describe("promoted reference release resolution", () => {
  type RunGit = NonNullable<Parameters<typeof resolveRef>[1]>;
  const DATES = "apps/landing/src/data/changelog-release-dates.json";
  const T = "2026-10-01T10:00:00Z";

  /** A git stub: VERSION and the manifest per ref, plus the tag list. */
  const stubGit = ({
    versions = { HEAD: "0.9.72" },
    manifest,
    tags = ["v0.9.69", "v0.9.70", "v0.9.71", "v0.9.72-rc.1"],
  }: {
    versions?: Record<string, string>;
    manifest: string | undefined;
    tags?: readonly string[];
  }): RunGit => {
    const ok = (stdout: string) => ({ ok: true, stdout, stderr: "" });
    return (command) => {
      const [, verb, target] = command;
      if (verb === "tag") {
        return ok(tags.join("\n"));
      }
      if (verb === "show" && target !== undefined) {
        const [ref, file] = target.split(":");
        const version = ref === undefined ? undefined : versions[ref];
        if (file === "VERSION" && version !== undefined) {
          return ok(`${version}\n`);
        }
        if (file === DATES && manifest !== undefined) {
          return ok(manifest);
        }
      }
      return { ok: false, stdout: "", stderr: "missing" };
    };
  };
  const manifestOf = (entries: Record<string, unknown>) =>
    JSON.stringify({ _note: "n", ...entries });
  const previous = (runGit: RunGit) =>
    resolveRef(parseArgs(["--previous-release-of", "HEAD"]), runGit);

  test("a newest final recorded as unpromoted (null) is skipped", () => {
    const manifest = manifestOf({
      "v0.9.69": T,
      "v0.9.70": T,
      "v0.9.71": null,
    });
    expect(previous(stubGit({ manifest }))).toBe("v0.9.70");
  });

  test("a newest final absent from the manifest is skipped", () => {
    const manifest = manifestOf({ "v0.9.69": T, "v0.9.70": T });
    expect(previous(stubGit({ manifest }))).toBe("v0.9.70");
  });

  test("a promoted newest final is the reference", () => {
    const manifest = manifestOf({ "v0.9.70": T, "v0.9.71": T });
    expect(previous(stubGit({ manifest }))).toBe("v0.9.71");
  });

  test("the bound is strict and versions compare numerically", () => {
    const manifest = manifestOf({ "v0.9.9": T, "v0.9.10": T, "v0.9.72": T });
    const tags = ["v0.9.9", "v0.9.10", "v0.9.72"];
    expect(previous(stubGit({ manifest, tags }))).toBe("v0.9.10");
  });

  test("reads VERSION and the manifest at the provided ref", () => {
    const manifest = manifestOf({ "v0.9.69": T, "v0.9.70": T, "v0.9.71": T });
    expect(
      resolveRef(
        parseArgs(["--previous-release-of", "release/sibling"]),
        stubGit({ manifest, versions: { "release/sibling": "0.9.71" } }),
      ),
    ).toBe("v0.9.70");
  });

  test("fails closed with no promoted final below the bound", () => {
    const manifest = manifestOf({ "v0.9.70": null, "v0.9.72": T });
    expect(() => previous(stubGit({ manifest }))).toThrow(
      /no promoted release below 0\.9\.72/u,
    );
  });

  test("fails closed on an invalid or unreadable manifest", () => {
    for (const [manifest, message] of [
      ["not json", /not valid JSON/u],
      ["[]", /must be an object/u],
      [manifestOf({ "v0.9.70": "yesterday" }), /invalid publication time/u],
      [manifestOf({ "v0.9.70": 5 }), /invalid publication time/u],
      [manifestOf({ "not-a-tag": T }), /invalid stable release ref/u],
      [undefined, /cannot read/u],
    ] as const) {
      expect(() => previous(stubGit({ manifest }))).toThrow(message);
    }
  });

  test("fails closed when the promoted release has no tag", () => {
    const manifest = manifestOf({ "v0.9.70": T });
    expect(() => previous(stubGit({ manifest, tags: ["v0.9.69"] }))).toThrow(
      /no tag/u,
    );
  });

  test("the cut path resolves the newest promoted final below the cut version", () => {
    const manifest = manifestOf({ "v0.9.70": T, "v0.9.71": null });
    const runGit = stubGit({ manifest, versions: {} });
    expect(
      resolveRef(parseArgs(["--promoted-release-below", "0.9.72"]), runGit),
    ).toBe("v0.9.70");
    expect(() => parseArgs(["--promoted-release-below", "latest"])).toThrow(
      /X\.Y\.Z/u,
    );
  });

  test("explicit ref semantics do not read VERSION, the manifest or tags", () => {
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
      parseArgs(["--promoted-release-below", "1.2.3", "--ref", "HEAD"]),
    ).toThrow(/exactly one/u);
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
      promotedReleaseBelow: undefined,
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
