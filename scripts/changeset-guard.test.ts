import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { propertyConfig } from "@stll/property-testing";

import {
  decideChangesetGate,
  isChangesetEntry,
  loadChangesetPolicy,
  parseChangesetPolicy,
  parseReleasePathspec,
} from "./changeset-guard";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POLICY_FILE = "scripts/changeset-policy.json";
const WORKFLOW_FILE = ".github/workflows/ci.yml";
const TREE_SUFFIX = "/**";
/** Release metadata that belongs to the repository, not to one package. */
const REPO_LEVEL_GENERATED = new Set(["bun.lock"]);

const policy = loadChangesetPolicy();

const decide = (
  changedFiles: readonly string[],
  addedFiles: readonly string[] = [],
) =>
  decideChangesetGate({
    changedFiles,
    addedFiles,
    releasePaths: policy.releasePaths,
  });

/** One concrete file per policy pathspec, so every entry is exercised. */
const sampleFile = (pathspec: string): string =>
  pathspec.endsWith(TREE_SUFFIX)
    ? `${pathspec.slice(0, -TREE_SUFFIX.length)}/sample.ts`
    : pathspec;

const GATED_FILES = policy.releasePaths.map(sampleFile);

// Directories no policy pathspec covers: whatever is appended stays ungated.
const UNGATED_PREFIXES = [
  "apps/web/src/",
  "apps/api/src/",
  "packages/locales/src/",
  "packages/ui/test-fixtures/",
  "docs/",
  ".github/workflows/",
] as const;

/** File and changeset names: any slug, none of them special to the gate. */
const SLUG = fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/u);

const readFile = (relativePath: string): string =>
  readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");

/** Published package name of a manifest, or null when it is private. */
const publishedName = (relativePath: string): string | null => {
  const parsed: unknown = JSON.parse(readFile(relativePath));
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  if ("private" in parsed && parsed.private === true) {
    return null;
  }
  if (!("name" in parsed) || typeof parsed.name !== "string") {
    return null;
  }
  return parsed.name;
};

const ignoredPackages = (): ReadonlySet<string> => {
  const parsed: unknown = JSON.parse(readFile(".changeset/config.json"));
  if (typeof parsed !== "object" || parsed === null || !("ignore" in parsed)) {
    throw new Error(".changeset/config.json must declare `ignore`.");
  }
  const { ignore } = parsed;
  if (!Array.isArray(ignore)) {
    throw new TypeError(".changeset/config.json `ignore` must be an array.");
  }
  return new Set(
    ignore.filter(
      (entry: unknown): entry is string => typeof entry === "string",
    ),
  );
};

/** Workspaces changesets would version: published and not ignored. */
const releasableWorkspaces = (): string[] => {
  const ignored = ignoredPackages();
  const workspaces: string[] = [];
  for (const manifest of new Bun.Glob(
    "{apps,packages}/*/package.json",
  ).scanSync({
    cwd: REPO_ROOT,
  })) {
    const name = publishedName(manifest);
    if (name !== null && !ignored.has(name)) {
      workspaces.push(path.posix.dirname(manifest.split(path.sep).join("/")));
    }
  }
  return workspaces.sort();
};

const gatedWorkspaces = (): string[] =>
  [
    ...new Set(
      policy.releasePaths.map((pathspec) =>
        pathspec.split("/").slice(0, 2).join("/"),
      ),
    ),
  ].sort();

/** The `changeset:` job block of the workflow, without the jobs that follow. */
const changesetJob = (): string => {
  const lines = readFile(WORKFLOW_FILE).split("\n");
  const start = lines.indexOf("  changeset:");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/u.test(line));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
};

describe("changeset gate decision", () => {
  test("fails a release-gated runtime change that adds no changeset", () => {
    expect(decide(["packages/ui/src/button.tsx"])).toEqual({
      status: "missing",
      releaseFiles: ["packages/ui/src/button.tsx"],
    });
  });

  test("passes once the change adds a changeset", () => {
    expect(
      decide(
        ["packages/ui/src/button.tsx"],
        [".changeset/lucky-pandas-wave.md"],
      ),
    ).toEqual({
      status: "satisfied",
      changesets: [".changeset/lucky-pandas-wave.md"],
    });
  });

  test("passes on an empty changeset, an intentional no-release change", () => {
    // `bun run changeset --empty` writes an entry with no release frontmatter.
    // The gate never reads an entry's contents, so it cannot tell the two
    // apart — which is what makes the empty entry a usable escape hatch.
    expect(
      decide(GATED_FILES, [".changeset/vacuous-throw-sweep-no-release.md"])
        .status,
    ).toBe("satisfied");
  });

  test("passes a change to a package outside the release gate", () => {
    expect(
      decide([
        "packages/locales/src/cs.ts",
        "apps/web/src/routes/index.tsx",
        "docs/changelog/v0.7.15.md",
      ]),
    ).toEqual({ status: "not-required" });
  });

  test("gates a colocated test under a published src/**, as the workflow does", () => {
    // No runtime-only filter exists: the pathspecs are the whole rule, and
    // `packages/ui/src/**` covers the tests that live beside the source.
    expect(decide(["packages/ui/src/button.test.tsx"]).status).toBe("missing");
  });

  test("leaves a published package's ungated files alone", () => {
    expect(
      decide(["packages/ui/CHANGELOG.md", "packages/ui/vitest.config.ts"]),
    ).toEqual({ status: "not-required" });
  });

  test("does not accept the changesets README as an entry", () => {
    expect(
      decide(["packages/cli/src/main.ts"], [".changeset/README.md"]).status,
    ).toBe("missing");
    expect(isChangesetEntry(".changeset/README.md")).toBe(false);
    expect(isChangesetEntry(".changeset/config.json")).toBe(false);
    expect(isChangesetEntry(".changeset/brave-cats-run.md")).toBe(true);
  });

  test("reports every gated file it saw, deletions included", () => {
    expect(
      decide(["packages/cli/README.md", "packages/cli/src/gone.ts"]),
    ).toEqual({
      status: "missing",
      releaseFiles: ["packages/cli/README.md", "packages/cli/src/gone.ts"],
    });
  });

  test("adding any changeset entry flips a failing verdict to a passing one", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...GATED_FILES), { minLength: 1 }),
        fc.array(fc.tuple(fc.constantFrom(...UNGATED_PREFIXES), SLUG)),
        SLUG,
        (gated, ungated, slug) => {
          const changedFiles = [
            ...gated,
            ...ungated.map(([prefix, name]) => `${prefix}${name}.ts`),
          ];
          expect(decide(changedFiles).status).toBe("missing");
          expect(decide(changedFiles, [`.changeset/${slug}.md`]).status).toBe(
            "satisfied",
          );
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("never asks for a changeset when nothing gated changed", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...UNGATED_PREFIXES), SLUG)),
        (ungated) => {
          expect(
            decide(ungated.map(([prefix, name]) => `${prefix}${name}.ts`))
              .status,
          ).toBe("not-required");
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });
});

describe("changeset policy file", () => {
  test("rejects a policy that is missing a list", () => {
    expect(() => parseChangesetPolicy(`{"releasePaths": []}`)).toThrow(
      /must hold releasePaths, generatedPaths and packageFiles/u,
    );
    expect(() =>
      parseChangesetPolicy(
        `{"releasePaths": [1], "generatedPaths": [], "packageFiles": []}`,
      ),
    ).toThrow(/must hold releasePaths, generatedPaths and packageFiles/u);
  });

  test("rejects a pathspec the local matcher cannot resolve like git", () => {
    expect(() => parseReleasePathspec("packages/*/src/index.ts")).toThrow(
      /Unsupported release pathspec/u,
    );
    expect(() => parseReleasePathspec("packages/ui/src/*.tsx")).toThrow(
      /Unsupported release pathspec/u,
    );
    expect(parseReleasePathspec("packages/ui/src/**")).toEqual({
      type: "tree",
      prefix: "packages/ui/src/",
    });
    expect(parseReleasePathspec("packages/ui/package.json")).toEqual({
      type: "file",
      file: "packages/ui/package.json",
    });
  });

  test("lists only paths that exist", () => {
    const missing = [...policy.releasePaths, ...policy.packageFiles]
      .map((pathspec) =>
        pathspec.endsWith(TREE_SUFFIX)
          ? pathspec.slice(0, -TREE_SUFFIX.length)
          : pathspec,
      )
      .filter((candidate) => !existsSync(path.join(REPO_ROOT, candidate)));
    expect(missing).toEqual([]);
  });

  test("routes every generated path to a released package or the lockfile", () => {
    // A version pull request may only carry release metadata, so anything
    // listed here that no release can write is a hole in that check. Private
    // workspaces are not versioned (`privatePackages.version: false`) and
    // depend on the released packages through `workspace:*` ranges, so
    // changesets never rewrites one.
    const gated = gatedWorkspaces();
    expect(
      policy.generatedPaths.filter(
        (generated) =>
          !REPO_LEVEL_GENERATED.has(generated) &&
          !gated.some((workspace) => generated.startsWith(`${workspace}/`)),
      ),
    ).toEqual([]);
  });

  test("gates every package changesets would release, and only those", () => {
    expect(gatedWorkspaces()).toEqual(releasableWorkspaces());
  });

  test("gates each released package's manifest, README and sources", () => {
    for (const workspace of gatedWorkspaces()) {
      expect(policy.releasePaths).toContain(`${workspace}/package.json`);
      expect(policy.releasePaths).toContain(`${workspace}/README.md`);
      expect(policy.releasePaths).toContain(`${workspace}/src${TREE_SUFFIX}`);
    }
  });

  test("gates the CLI capability catalog", () => {
    expect(policy.releasePaths).toContain(
      "packages/cli/capability-catalog.json",
    );
  });

  test("declares the same packages to the changesets entry validator", () => {
    expect([...policy.packageFiles].sort()).toEqual(
      gatedWorkspaces().map((workspace) => `${workspace}/package.json`),
    );
  });
});

describe("workflow and pre-push read the same policy", () => {
  test("the workflow job feeds every list from the policy file", () => {
    const job = changesetJob();
    expect(job).toContain(POLICY_FILE);
    for (const key of ["releasePaths", "generatedPaths", "packageFiles"]) {
      expect(job).toContain(`.${key}[]`);
    }
  });

  test("the workflow job inlines no pathspecs of its own", () => {
    // A second copy of the list in the workflow is exactly the drift this
    // guard exists to prevent: CI would gate paths pre-push does not.
    expect(changesetJob()).not.toMatch(/^\s+(?:apps|packages)\//mu);
  });

  test("pre-push runs the guard", () => {
    expect(readFile("lefthook.yml")).toContain("scripts/changeset-guard.ts");
  });
});
