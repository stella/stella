import { describe, expect, test } from "bun:test";
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
import path from "node:path";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

import {
  checkChangesetPackages,
  decideChangesetGate,
  findCatalogInputs,
  withoutReleasedPackages,
  isChangesetEntry,
  loadChangesetPolicy,
  parseChangesetPolicy,
  parseReleasePathspec,
  readChangesetDiff,
} from "./changeset-guard";
import {
  flattenWorkflowSteps,
  workflowJobSteps,
  workflowStepByName,
} from "./workflow-steps";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POLICY_FILE = "scripts/changeset-policy.json";
const WORKFLOW_FILE = ".github/workflows/ci.yml";
const TREE_SUFFIX = "/**";
/** What `bun run changeset --empty` writes: no frontmatter, no summary. */
const EMPTY_CHANGESET = "---\n---\n";
const CHANGESET_POLICY_ACTION = "changeset-policy";
const CHANGESET_POLICY_PIN = new RegExp(
  `${CHANGESET_POLICY_ACTION}@[0-9a-f]{40} # v(\\d+)\\.(\\d+)\\.(\\d+)`,
  "u",
);
/** The first shared-gate version that reads a renamed entry as an added one. */
const MINIMUM_CHANGESET_POLICY_VERSION = [1, 7, 1];
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
const workflow = Bun.YAML.parse(readFile(WORKFLOW_FILE));
const restSteps = workflowJobSteps(workflow, "ci-checks-rest");

const git = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString();
};

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
  return workspaces.toSorted();
};

const gatedWorkspaces = (): string[] =>
  [
    ...new Set(
      policy.releasePaths.map((pathspec) =>
        pathspec.split("/").slice(0, 2).join("/"),
      ),
    ),
  ].toSorted();

const CHANGESET_GATE_FIRST_STEP = "Load release policy";
const CHANGESET_GATE_LAST_STEP =
  "Changeset present for published package changes";

/** The changeset gate's steps in the ci-checks-rest job, first through last. */
const changesetJob = (): Record<string, unknown>[] => {
  const first = workflowStepByName(restSteps, CHANGESET_GATE_FIRST_STEP);
  const last = workflowStepByName(restSteps, CHANGESET_GATE_LAST_STEP);
  const start = restSteps.indexOf(first);
  const end = restSteps.indexOf(last);
  expect(end).toBeGreaterThan(start);
  return restSteps.slice(start, end + 1);
};

describe("changeset gate decision", () => {
  test("fails a release-gated runtime change that adds no changeset", () => {
    expect(decide(["packages/ui/src/button.tsx"])).toEqual({
      status: "missing",
      releaseFiles: ["packages/ui/src/button.tsx"],
      catalogInputs: [],
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
      catalogInputs: [],
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

describe("changeset package relevance", () => {
  const entry = (names: readonly string[]) => ({
    file: ".changeset/change.md",
    contents: `---\n${names.map((name) => `"${name}": patch`).join("\n")}\n---\n\nA public change.\n`,
  });

  test("requires path evidence for every named package across the release policy", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...policy.packageFiles),
        fc.constantFrom(...policy.packageFiles),
        (changedManifest, namedManifest) => {
          const changedDirectory = path.posix.dirname(changedManifest);
          const namedDirectory = path.posix.dirname(namedManifest);
          const name = `@stll/${path.posix.basename(namedDirectory)}`;
          const options = {
            changedFiles: [`${changedDirectory}/src/change.ts`],
            entries: [entry([name])],
            policy,
          };
          if (changedDirectory !== namedDirectory) {
            expect(() => checkChangesetPackages(options)).toThrow(
              `.changeset/change.md: ${name}`,
            );
            return;
          }
          checkChangesetPackages(options);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("rejects an unrelated member of a multi-package changeset", () => {
    expect(() =>
      checkChangesetPackages({
        changedFiles: ["packages/cli/src/main.ts"],
        entries: [entry(["@stll/cli", "@stll/business-registries"])],
        policy,
      }),
    ).toThrow(".changeset/change.md: @stll/business-registries");
  });

  test("requires relevant paths even when the PR has no gated changes", () => {
    for (const changedFiles of [
      [],
      ["docs/releases.md"],
      ["packages/cli/CHANGELOG.md"],
    ]) {
      expect(() =>
        checkChangesetPackages({
          changedFiles,
          entries: [entry(["@stll/cli"])],
          policy,
        }),
      ).toThrow("bun run changeset --empty");
    }
  });

  test("does not infer public impact from source paths or require names in an empty entry", () => {
    checkChangesetPackages({
      changedFiles: ["packages/cli/src/comment-only.ts"],
      entries: [
        entry(["@stll/cli"]),
        { file: ".changeset/empty.md", contents: EMPTY_CHANGESET },
      ],
      policy,
    });
    checkChangesetPackages({ changedFiles: [], entries: [entry([])], policy });
    expect(() =>
      checkChangesetPackages({
        changedFiles: [],
        entries: [entry(["@stll/unknown"])],
        policy,
      }),
    ).toThrow("outside the release policy: @stll/unknown");
  });

  test("checks edits as well as additions at HEAD, while allowing consumed version entries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stella-package-relevance-"));
    try {
      mkdirSync(path.join(root, "scripts"));
      mkdirSync(path.join(root, ".changeset"));
      mkdirSync(path.join(root, "packages/cli/src"), { recursive: true });
      for (const file of [
        "changeset-guard.ts",
        "changeset-entry.ts",
        "changeset-policy.json",
      ]) {
        writeFileSync(
          path.join(root, "scripts", file),
          readFile(`scripts/${file}`),
        );
      }
      const entryPath = path.join(root, ".changeset/change.md");
      writeFileSync(entryPath, entry(["@stll/cli"]).contents);
      writeFileSync(
        path.join(root, "packages/cli/src/main.ts"),
        "export const version = 1;\n",
      );
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.com"]);
      git(root, ["config", "user.name", "Test"]);
      git(root, ["add", "."]);
      git(root, ["commit", "--no-gpg-sign", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]).trim();
      const check = () =>
        Bun.spawnSync(
          [
            "bun",
            "scripts/changeset-guard.ts",
            "--base",
            base,
            "--packages-only",
          ],
          { cwd: root },
        );
      writeFileSync(entryPath, entry(["@stll/cli", "@stll/ui"]).contents);
      git(root, ["add", "."]);
      git(root, ["commit", "--no-gpg-sign", "-m", "edit entry"]);
      // A worktree-only correction must not hide the committed mistake.
      writeFileSync(entryPath, EMPTY_CHANGESET);
      const edited = check();
      expect(edited.exitCode).toBe(1);
      expect(edited.stderr.toString()).toContain(
        ".changeset/change.md: @stll/ui",
      );
      // No version tag or version commit: the diff alone decides, visibly.
      expect(edited.stderr.toString()).toContain(
        "@stll/ui: no published version reference resolved",
      );
      rmSync(entryPath);
      writeFileSync(
        path.join(root, "packages/cli/package.json"),
        '{"version":"1.0.1"}',
      );
      git(root, ["add", "."]);
      git(root, ["commit", "--no-gpg-sign", "-m", "consume entry"]);
      expect(check().exitCode).toBe(0);
      writeFileSync(
        path.join(root, ".changeset/new.md"),
        entry(["@stll/ui"]).contents,
      );
      git(root, ["add", "."]);
      git(root, ["commit", "--no-gpg-sign", "-m", "add unrelated entry"]);
      const added = check();
      expect(added.exitCode).toBe(1);
      expect(added.stderr.toString()).toContain(".changeset/new.md: @stll/ui");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("catalog versions a published package ships", () => {
  const DOCX_UTILS = "@stll/docx-utils";
  const DOCX_MANIFEST = "packages/docx-utils/package.json";
  const REFERENCE = "@stll/docx-utils@0.1.2";
  const ENTRY_FILE = ".changeset/change.md";
  const entry = (names: readonly string[]) => ({
    file: ENTRY_FILE,
    contents: `---\n${names.map((name) => `"${name}": patch`).join("\n")}\n---\n\nShip the catalog version.\n`,
  });
  const rootManifest = (jszip: string, react = "^19.2.8"): string =>
    JSON.stringify({
      name: "stella",
      private: true,
      workspaces: ["packages/*"],
      catalog: { jszip, tsdown: "0.1.0" },
      catalogs: { react19: { react } },
    });
  const manifests = new Map([
    [
      DOCX_MANIFEST,
      JSON.stringify({
        name: DOCX_UTILS,
        version: "0.1.2",
        dependencies: { jszip: "catalog:" },
        devDependencies: { tsdown: "catalog:" },
      }),
    ],
    [
      "packages/ui/package.json",
      JSON.stringify({
        name: "@stll/ui",
        version: "1.0.0",
        peerDependencies: { react: "catalog:react19" },
      }),
    ],
  ]);
  const jszipBump = findCatalogInputs({
    policy,
    manifests,
    before: rootManifest("3.10.1"),
    after: rootManifest("3.10.2"),
  });

  test("reads default and named catalog entries from the shipped sections", () => {
    expect(jszipBump).toEqual([
      {
        packageName: DOCX_UTILS,
        field: "dependencies",
        dependency: "jszip",
        entry: "jszip@catalog:",
      },
    ]);
    expect(
      findCatalogInputs({
        policy,
        manifests,
        before: rootManifest("3.10.1", "^19.2.7"),
        after: rootManifest("3.10.1"),
      }),
    ).toEqual([
      {
        packageName: "@stll/ui",
        field: "peerDependencies",
        dependency: "react",
        entry: "react@catalog:react19",
      },
    ]);
  });

  test("a catalog bump the range already released needs no changeset", () => {
    expect(withoutReleasedPackages(jszipBump, new Set([DOCX_UTILS]))).toEqual(
      [],
    );
    expect(withoutReleasedPackages(jszipBump, new Set(["@stll/ui"]))).toEqual(
      jszipBump,
    );
  });

  test("rejects a shipped catalog bump that no changeset names, naming the package and entry", () => {
    const changedFiles = ["package.json", "bun.lock"];
    for (const entries of [
      [],
      [{ file: ".changeset/empty.md", contents: EMPTY_CHANGESET }],
    ]) {
      expect(() =>
        checkChangesetPackages({
          changedFiles,
          entries,
          policy,
          catalogInputs: jszipBump,
        }),
      ).toThrow(`${DOCX_UTILS}: jszip@catalog:`);
      expect(() =>
        checkChangesetPackages({
          changedFiles,
          entries,
          policy,
          catalogInputs: jszipBump,
        }),
      ).toThrow("bun run changeset");
    }
    expect(
      decideChangesetGate({
        changedFiles,
        addedFiles: [],
        releasePaths: policy.releasePaths,
        catalogInputs: jszipBump,
      }),
    ).toEqual({
      status: "missing",
      releaseFiles: [],
      catalogInputs: jszipBump,
    });
  });

  test("accepts the same bump with a changeset for that package", () => {
    const changedFiles = ["package.json", "bun.lock", ENTRY_FILE];
    expect(
      checkChangesetPackages({
        changedFiles,
        entries: [entry([DOCX_UTILS])],
        policy,
        catalogInputs: jszipBump,
      }),
    ).toEqual([]);
    expect(
      decideChangesetGate({
        changedFiles,
        addedFiles: [ENTRY_FILE],
        releasePaths: policy.releasePaths,
        catalogInputs: jszipBump,
      }).status,
    ).toBe("satisfied");
  });

  test("requires nothing for a devDependency or a package that is private or outside the release policy", () => {
    const inputs = findCatalogInputs({
      policy,
      manifests: new Map([
        [
          DOCX_MANIFEST,
          JSON.stringify({
            name: DOCX_UTILS,
            devDependencies: { jszip: "catalog:" },
          }),
        ],
        [
          "packages/ui/package.json",
          JSON.stringify({
            name: "@stll/ui",
            private: true,
            dependencies: { jszip: "catalog:" },
          }),
        ],
        [
          "apps/web/package.json",
          JSON.stringify({
            name: "@stll/web",
            dependencies: { jszip: "catalog:" },
          }),
        ],
      ]),
      before: rootManifest("3.10.1"),
      after: rootManifest("3.10.2"),
    });
    expect(inputs).toEqual([]);
    expect(
      checkChangesetPackages({
        changedFiles: ["package.json"],
        entries: [],
        policy,
        catalogInputs: inputs,
      }),
    ).toEqual([]);
    expect(
      decideChangesetGate({
        changedFiles: ["package.json"],
        addedFiles: [],
        releasePaths: policy.releasePaths,
        catalogInputs: inputs,
      }),
    ).toEqual({ status: "not-required" });
  });

  test("accepts a changeset-only diff for a package whose shipped catalog version changed since its last publish", () => {
    expect(
      checkChangesetPackages({
        changedFiles: [ENTRY_FILE],
        entries: [entry([DOCX_UTILS])],
        policy,
        published: new Map([
          [
            DOCX_UTILS,
            {
              reference: REFERENCE,
              changedFiles: ["packages/docx-utils/CHANGELOG.md"],
              catalogInputs: jszipBump,
            },
          ],
        ]),
      }),
    ).toEqual([`${DOCX_UTILS}: changed since ${REFERENCE}: jszip@catalog:.`]);
  });

  test("rejects a package with no release input changed since its last publish", () => {
    expect(() =>
      checkChangesetPackages({
        changedFiles: [ENTRY_FILE],
        entries: [entry([DOCX_UTILS])],
        policy,
        published: new Map([
          [
            DOCX_UTILS,
            {
              reference: REFERENCE,
              // Ungated files of the package, and a catalog left as it was.
              changedFiles: [
                "packages/docx-utils/CHANGELOG.md",
                "packages/docx-utils/vitest.config.ts",
              ],
              catalogInputs: findCatalogInputs({
                policy,
                manifests,
                before: rootManifest("3.10.2"),
                after: rootManifest("3.10.2"),
              }),
            },
          ],
        ]),
      }),
    ).toThrow(`${ENTRY_FILE}: ${DOCX_UTILS}`);
  });

  test("falls back to the diff, with a note, when no published reference resolves", () => {
    const note = `${DOCX_UTILS}: no published version reference resolved; checked this diff only.`;
    const published = new Map([[DOCX_UTILS, null]]);
    expect(() =>
      checkChangesetPackages({
        changedFiles: [ENTRY_FILE],
        entries: [entry([DOCX_UTILS])],
        policy,
        published,
      }),
    ).toThrow(note);
    expect(
      checkChangesetPackages({
        changedFiles: ["packages/docx-utils/src/index.ts", ENTRY_FILE],
        entries: [entry([DOCX_UTILS])],
        policy,
        published,
      }),
    ).toEqual([note]);
  });
});

describe("the diff the gate decides on", () => {
  test("counts a renamed empty changeset as a new entry", () => {
    // A maintenance release commit deletes the previous release's empty entry
    // and adds a byte-identical one under the next version's name. Git reads
    // that pair as one rename, so a rename-blind query sees no added entry and
    // the guard refuses the release commit.
    const root = mkdtempSync(path.join(tmpdir(), "stella-changeset-guard-"));
    try {
      mkdirSync(path.join(root, ".changeset"), { recursive: true });
      mkdirSync(path.join(root, "packages/ui"), { recursive: true });
      writeFileSync(path.join(root, ".changeset/README.md"), "# Changesets\n");
      writeFileSync(
        path.join(root, ".changeset/release-v1.2.3.md"),
        EMPTY_CHANGESET,
      );
      writeFileSync(
        path.join(root, "packages/ui/package.json"),
        '{"name":"@stll/ui","version":"1.2.3"}\n',
      );
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "test@example.com"]);
      git(root, ["config", "user.name", "Test"]);
      git(root, ["add", "."]);
      git(root, ["commit", "--no-gpg-sign", "-m", "base"]);
      const mergeBase = git(root, ["rev-parse", "HEAD"]).trim();

      git(root, [
        "mv",
        ".changeset/release-v1.2.3.md",
        ".changeset/release-v1.2.4.md",
      ]);
      writeFileSync(
        path.join(root, "packages/ui/package.json"),
        '{"name":"@stll/ui","version":"1.2.4"}\n',
      );
      git(root, ["add", "."]);
      git(root, ["commit", "--no-gpg-sign", "-m", "release v1.2.4"]);

      // The regression only means anything while git still pairs the two
      // entries as a rename.
      expect(
        git(root, [
          "diff",
          "--name-status",
          "--find-renames",
          mergeBase,
          "HEAD",
          "--",
          ".changeset/*.md",
        ]),
      ).toMatch(/^R/mu);

      expect(
        decideChangesetGate({
          ...readChangesetDiff({ mergeBase, root }),
          releasePaths: policy.releasePaths,
        }),
      ).toEqual({
        status: "satisfied",
        changesets: [".changeset/release-v1.2.4.md"],
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
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
    expect(policy.releasePaths).toContain("packages/cli/capabilities/**");
  });

  test("declares the same packages to the changesets entry validator", () => {
    expect([...policy.packageFiles].toSorted()).toEqual(
      gatedWorkspaces().map((workspace) => `${workspace}/package.json`),
    );
  });
});

/** Negative when `version` precedes `minimum`, zero when they are equal. */
const compareVersions = (
  version: readonly number[],
  minimum: readonly number[],
): number => {
  for (const [index, part] of version.entries()) {
    const floor = minimum[index] ?? 0;
    if (part !== floor) {
      return part - floor;
    }
  }
  return 0;
};

const expectChangesetConditions = (gate: unknown) => {
  const steps = v.parse(
    v.array(v.object({ name: v.string(), if: v.string() })),
    flattenWorkflowSteps(gate),
  );
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) {
    const suffix =
      step.name === CHANGESET_GATE_LAST_STEP
        ? " && steps.policy.outcome == 'success'"
        : "";
    expect(step.if, step.name).toBe(
      `\${{ !cancelled() && steps.checkout.outcome == 'success' && (github.event_name == 'pull_request')${suffix} }}`,
    );
  }
};

describe("workflow and pre-push read the same policy", () => {
  test("the workflow gate feeds every list from the policy file", () => {
    const policyRun = workflowStepByName(
      changesetJob(),
      CHANGESET_GATE_FIRST_STEP,
    )["run"];
    expect(policyRun).toContain(POLICY_FILE);
    for (const key of ["releasePaths", "generatedPaths", "packageFiles"]) {
      expect(policyRun).toContain(`.${key}[]`);
    }
  });

  test("pins the shared gate to a version that reads renames as this guard does", () => {
    // The shared action counted a renamed changeset entry as no entry at all
    // until this version, so an older pin would refuse a release commit that
    // pre-push accepts. Dependabot rewrites the comment with the SHA, so the
    // comment is the readable side of the pin; it may only move forward.
    const pin = CHANGESET_POLICY_PIN.exec(readFile(WORKFLOW_FILE));
    if (pin === null) {
      throw new Error(
        `${WORKFLOW_FILE} must pin ${CHANGESET_POLICY_ACTION} to a 40-character SHA commented with its version.`,
      );
    }
    const pinned = [pin.at(1), pin.at(2), pin.at(3)].map(Number);
    expect(
      compareVersions(pinned, MINIMUM_CHANGESET_POLICY_VERSION),
    ).toBeGreaterThanOrEqual(0);
  });

  test("the workflow gate inlines no pathspecs of its own", () => {
    // A second copy of the list in the workflow is exactly the drift this
    // guard exists to prevent: CI would gate paths pre-push does not.
    expect(Bun.YAML.stringify(changesetJob())).not.toMatch(
      /^\s+(?:apps|packages)\//mu,
    );
  });

  test("CI runs the same package relevance check without replacing the shared presence gate", () => {
    expect(
      workflowStepByName(restSteps, "Changeset packages match changed files")[
        "run"
      ],
    ).toBe('bun scripts/changeset-guard.ts --base "$BASE_SHA" --packages-only');
  });

  test("every changeset gate step runs on pull requests, before any install", () => {
    const gate = changesetJob();
    expectChangesetConditions(gate);
    const lastGate = workflowStepByName(restSteps, CHANGESET_GATE_LAST_STEP);
    const install = workflowStepByName(restSteps, "Install dependencies");
    expect(restSteps.indexOf(lastGate)).toBeLessThan(
      restSteps.indexOf(install),
    );
  });

  test("a wrapped changeset gate cannot drop its pull-request scope", () => {
    const gate = changesetJob();
    const first = workflowStepByName(gate, CHANGESET_GATE_FIRST_STEP);
    const firstCondition = first["if"];
    if (typeof firstCondition !== "string") {
      throw new TypeError("Changeset gate steps must have conditions");
    }
    const changed = gate.map((step) =>
      step === first
        ? {
            ...step,
            if: firstCondition.replace(
              " && (github.event_name == 'pull_request')",
              "",
            ),
          }
        : step,
    );
    expect(changed).not.toEqual(gate);
    expect(() => expectChangesetConditions([{ parallel: changed }])).toThrow(
      CHANGESET_GATE_FIRST_STEP,
    );
  });

  test("pre-push runs the guard", () => {
    expect(readFile("lefthook.yml")).toContain("scripts/changeset-guard.ts");
  });
});
