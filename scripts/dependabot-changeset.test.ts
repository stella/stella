import { afterEach, describe, expect, test } from "bun:test";
import { strictEqual } from "node:assert";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  decideDependabotChangeset,
  renderChangeset,
  runDependabotChangeset,
} from "./dependabot-changeset";

const policy = {
  releasePaths: [
    "packages/workspace-ui/package.json",
    "packages/workspace-ui/README.md",
    "packages/workspace-ui/src/**",
    "packages/ui/package.json",
    "packages/ui/README.md",
    "packages/ui/src/**",
  ],
  generatedPaths: [],
  packageFiles: [
    "packages/workspace-ui/package.json",
    "packages/ui/package.json",
  ],
} as const;

const workspaceUiManifest = "packages/workspace-ui/package.json";
const uiManifest = "packages/ui/package.json";

type ManifestFixture = {
  readonly packagePath: string;
  readonly base: string;
  readonly head: string;
};

const manifest = ({ packagePath, base, head }: ManifestFixture) => ({
  packagePath,
  base,
  head,
});

const json = (value: unknown): string => JSON.stringify(value);

const basePackage = {
  name: "@stll/workspace-ui",
  version: "0.6.2",
  dependencies: { "@stll/ui": "workspace:^", "tailwind-merge": "^3.6.0" },
  peerDependencies: { react: ">=19" },
  devDependencies: { "@tanstack/react-table": "9.2.2" },
};

const devBump = {
  ...basePackage,
  devDependencies: { "@tanstack/react-table": "9.2.3" },
};

const runtimeBump = {
  ...basePackage,
  dependencies: { ...basePackage.dependencies, "tailwind-merge": "^3.7.0" },
};

const decide = (
  input: Partial<Parameters<typeof decideDependabotChangeset>[0]> = {},
) =>
  decideDependabotChangeset({
    policy,
    changedFiles: [],
    addedChangesetFiles: [],
    manifests: [],
    ...input,
  });

const decideSingle = (head: unknown) =>
  decide({
    changedFiles: [workspaceUiManifest],
    manifests: [
      manifest({
        packagePath: workspaceUiManifest,
        base: json(basePackage),
        head: json(head),
      }),
    ],
  });

const testRoots: string[] = [];

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const runGit = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  strictEqual(
    result.exitCode,
    0,
    `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
  );
  return result.stdout.toString().trim();
};

type GitFixtureChange =
  | "bump"
  | "runtime-bump"
  | "added"
  | "deleted"
  | "executable";

type GitFixture = {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly output: string;
};

const makeGitFixture = (change: GitFixtureChange): GitFixture => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-dependabot-changeset-"));
  testRoots.push(root);

  const packagePath = "packages/sample/package.json";
  mkdirSync(path.join(root, ".changeset"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "packages/sample"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts/changeset-policy.json"),
    JSON.stringify({
      releasePaths: [packagePath, "packages/sample/src/**"],
      generatedPaths: [],
      packageFiles: [packagePath],
    }),
  );

  const baseManifest = {
    name: "@stll/sample",
    version: "0.1.0",
    dependencies: { zod: "^4.0.0" },
    devDependencies: { vitest: "^3.0.0" },
  };
  const headManifest =
    change === "runtime-bump"
      ? { ...baseManifest, dependencies: { zod: "^4.1.0" } }
      : { ...baseManifest, devDependencies: { vitest: "^3.1.0" } };
  const manifestPath = path.join(root, packagePath);

  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "test@example.com"]);
  runGit(root, ["config", "user.name", "Test"]);

  if (change !== "added") {
    writeFileSync(manifestPath, `${JSON.stringify(baseManifest)}\n`);
  }
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "base"]);
  const base = runGit(root, ["rev-parse", "HEAD"]);

  if (change === "deleted") {
    rmSync(manifestPath);
    runGit(root, ["add", "-u", "."]);
  } else {
    writeFileSync(manifestPath, `${JSON.stringify(headManifest)}\n`);
    if (change === "executable") {
      chmodSync(manifestPath, 0o755);
    }
    runGit(root, ["add", "."]);
    if (change === "executable") {
      runGit(root, ["update-index", "--chmod=+x", packagePath]);
    }
  }
  runGit(root, ["commit", "--quiet", "-m", "head"]);
  const head = runGit(root, ["rev-parse", "HEAD"]);

  return {
    root,
    base,
    head,
    output: ".changeset/dependabot-dependencies-123.md",
  };
};

const runFixture = (fixture: GitFixture, ...extra: readonly string[]) =>
  runDependabotChangeset(
    [
      "--base",
      fixture.base,
      "--head",
      fixture.head,
      "--output",
      fixture.output,
      ...extra,
    ],
    fixture.root,
  );

describe("Dependabot changeset decision", () => {
  test("does nothing when no release-gated path changed", () => {
    expect(
      decide({ changedFiles: ["bun.lock", "apps/web/src/routes.tsx"] }),
    ).toEqual({ status: "noop", reason: "no-release-paths" });
  });

  test("does nothing when a changeset already exists", () => {
    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        addedChangesetFiles: [".changeset/quiet-bears-wave.md"],
      }),
    ).toEqual({ status: "noop", reason: "existing-changeset" });
  });

  test("records no bump for a devDependency-only manifest change", () => {
    expect(decideSingle(devBump)).toEqual({
      status: "create",
      entries: [{ packageName: "@stll/workspace-ui", updates: [] }],
    });
  });

  test("records the moved floor for a same-major runtime dependency bump", () => {
    expect(decideSingle(runtimeBump)).toEqual({
      status: "create",
      entries: [
        {
          packageName: "@stll/workspace-ui",
          updates: [{ name: "tailwind-merge", range: "^3.7.0" }],
        },
      ],
    });
  });

  test("accepts a runtime bump alongside a devDependency bump in one manifest", () => {
    expect(
      decideSingle({
        ...runtimeBump,
        devDependencies: devBump.devDependencies,
      }),
    ).toEqual({
      status: "create",
      entries: [
        {
          packageName: "@stll/workspace-ui",
          updates: [{ name: "tailwind-merge", range: "^3.7.0" }],
        },
      ],
    });
  });

  test("accepts an optionalDependencies bump as a runtime floor move", () => {
    const base = {
      ...basePackage,
      optionalDependencies: { fsevents: "~2.3.2" },
    };
    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(base),
            head: json({
              ...base,
              optionalDependencies: { fsevents: "~2.3.3" },
            }),
          }),
        ],
      }),
    ).toEqual({
      status: "create",
      entries: [
        {
          packageName: "@stll/workspace-ui",
          updates: [{ name: "fsevents", range: "~2.3.3" }],
        },
      ],
    });
  });

  test("derives every eligible published package from the policy manifests", () => {
    const uiBase = { ...basePackage, name: "@stll/ui" };

    expect(
      decide({
        changedFiles: [workspaceUiManifest, uiManifest],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: json(devBump),
          }),
          manifest({
            packagePath: uiManifest,
            base: json(uiBase),
            head: json({ ...runtimeBump, name: "@stll/ui" }),
          }),
        ],
      }),
    ).toEqual({
      status: "create",
      entries: [
        { packageName: "@stll/workspace-ui", updates: [] },
        {
          packageName: "@stll/ui",
          updates: [{ name: "tailwind-merge", range: "^3.7.0" }],
        },
      ],
    });
  });

  test.each([
    [
      "a runtime major bump",
      {
        ...basePackage,
        dependencies: {
          ...basePackage.dependencies,
          "tailwind-merge": "^4.0.0",
        },
      },
      "major-change",
    ],
    [
      "a runtime range the fixer cannot compare",
      {
        ...basePackage,
        dependencies: {
          ...basePackage.dependencies,
          "tailwind-merge": "catalog:",
        },
      },
      "unsupported-range",
    ],
    [
      "an added runtime dependency",
      {
        ...basePackage,
        dependencies: { ...basePackage.dependencies, zod: "^4.0.0" },
      },
      "dependency-set-change",
    ],
    [
      "a removed runtime dependency",
      { ...basePackage, dependencies: { "@stll/ui": "workspace:^" } },
      "dependency-set-change",
    ],
    [
      "peer dependency changes",
      { ...basePackage, peerDependencies: { react: ">=20" } },
      "peer-change",
    ],
    [
      "a manifest field outside the dependency maps",
      { ...basePackage, version: "0.6.3" },
      "manifest-change",
    ],
  ] as const)("refuses %s", (_label, head, reason) => {
    expect(decideSingle(head)).toEqual({ status: "refuse", reason });
  });

  describe("a runtime bump below 1.0.0", () => {
    const base = {
      ...basePackage,
      dependencies: { "@stll/ui": "workspace:^", lib: "^0.6.0" },
    };
    const decideBump = (range: string) =>
      decide({
        changedFiles: [workspaceUiManifest],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(base),
            head: json({
              ...base,
              dependencies: { ...base.dependencies, lib: range },
            }),
          }),
        ],
      });

    test("is a patch changeset when only the patch moves", () => {
      expect(decideBump("^0.6.4")).toEqual({
        status: "create",
        entries: [
          {
            packageName: "@stll/workspace-ui",
            updates: [{ name: "lib", range: "^0.6.4" }],
          },
        ],
      });
    });

    test("is refused when the minor moves", () => {
      expect(decideBump("^0.7.0")).toEqual({
        status: "refuse",
        reason: "major-change",
      });
    });
  });

  test("refuses source changes next to a manifest bump", () => {
    expect(
      decide({
        changedFiles: [
          workspaceUiManifest,
          "packages/workspace-ui/src/table.tsx",
        ],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: json(devBump),
          }),
        ],
      }),
    ).toEqual({ status: "refuse", reason: "source-change" });
  });

  test("refuses a group mixing an eligible bump with a refused one", () => {
    const uiBase = { ...basePackage, name: "@stll/ui" };

    expect(
      decide({
        changedFiles: [workspaceUiManifest, uiManifest],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: json(devBump),
          }),
          manifest({
            packagePath: uiManifest,
            base: json(uiBase),
            head: json({ ...uiBase, peerDependencies: { react: ">=20" } }),
          }),
        ],
      }),
    ).toEqual({ status: "refuse", reason: "mixed-change" });
  });

  test("refuses formatting-only manifest changes", () => {
    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: JSON.stringify(basePackage, null, 2),
          }),
        ],
      }),
    ).toEqual({ status: "refuse", reason: "format-only" });
  });

  test.each([
    [
      "invalid JSON",
      manifest({
        packagePath: workspaceUiManifest,
        base: json(basePackage),
        head: "{",
      }),
    ],
    ["missing manifest pair", undefined],
    [
      "non-string devDependency",
      manifest({
        packagePath: workspaceUiManifest,
        base: json(basePackage),
        head: json({ ...basePackage, devDependencies: { react: 19 } }),
      }),
    ],
    [
      "non-string runtime dependency",
      manifest({
        packagePath: workspaceUiManifest,
        base: json(basePackage),
        head: json({ ...basePackage, dependencies: { "tailwind-merge": 3 } }),
      }),
    ],
  ] as const)("refuses a malformed manifest pair: %s", (_label, pair) => {
    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        manifests: pair === undefined ? [] : [pair],
      }),
    ).toEqual({ status: "refuse", reason: "malformed-manifest" });
  });

  test("refuses non-manifest files even when they are outside release paths", () => {
    expect(
      decide({
        changedFiles: [workspaceUiManifest, "apps/web/src/routes.tsx"],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: json(devBump),
          }),
        ],
      }),
    ).toEqual({ status: "refuse", reason: "source-change" });
  });
});

describe("Dependabot changeset rendering", () => {
  test("renders an empty changeset when no package needs a bump", () => {
    expect(
      renderChangeset([
        { packageName: "@stll/ui", updates: [] },
        { packageName: "@stll/workspace-ui", updates: [] },
      ]),
    ).toBe("---\n---\n");
  });

  test("lists only bumped packages and each moved floor once", () => {
    expect(
      renderChangeset([
        { packageName: "@stll/workspace-ui", updates: [] },
        {
          packageName: "@stll/ui",
          updates: [
            { name: "tailwind-merge", range: "^3.7.0" },
            { name: "clsx", range: "^2.1.2" },
          ],
        },
        {
          packageName: "@stll/chat",
          updates: [{ name: "tailwind-merge", range: "^3.7.0" }],
        },
      ]),
    ).toBe(
      [
        "---",
        '"@stll/ui": patch',
        '"@stll/chat": patch',
        "---",
        "",
        "Update `tailwind-merge` to `^3.7.0`.",
        "Update `clsx` to `^2.1.2`.",
        "",
      ].join("\n"),
    );
  });
});

describe("Dependabot changeset CLI boundary", () => {
  test.each([
    ".changeset/../outside.md",
    ".changeset/dependabot-dev-dependencies-123.md",
    ".changeset/dependabot-dependencies-0.md",
    ".changeset/dependabot-dependencies-not-a-number.md",
  ])("rejects an invalid output path: %s", (output) => {
    expect(() =>
      runDependabotChangeset([
        "--base",
        "0".repeat(40),
        "--head",
        "1".repeat(40),
        "--output",
        output,
      ]),
    ).toThrow(/invalid dependabot changeset output path/iu);
  });

  test("writes exactly an empty changeset for an eligible devDependency bump", () => {
    const fixture = makeGitFixture("bump");

    expect(runFixture(fixture)).toBe(0);
    expect(readFileSync(path.join(fixture.root, fixture.output), "utf-8")).toBe(
      "---\n---\n",
    );
  });

  test("writes a patch changeset for an eligible runtime bump", () => {
    const fixture = makeGitFixture("runtime-bump");

    expect(runFixture(fixture)).toBe(0);
    expect(readFileSync(path.join(fixture.root, fixture.output), "utf-8")).toBe(
      '---\n"@stll/sample": patch\n---\n\nUpdate `zod` to `^4.1.0`.\n',
    );
  });

  test("verifies the written changeset against the recomputed decision", () => {
    const fixture = makeGitFixture("runtime-bump");
    const outputPath = path.join(fixture.root, fixture.output);

    expect(runFixture(fixture)).toBe(0);
    expect(runFixture(fixture, "--check")).toBe(0);

    writeFileSync(outputPath, '---\n"@stll/sample": minor\n---\n');
    expect(() => runFixture(fixture, "--check")).toThrow(/does not match/u);
  });

  test("check mode rejects a changeset that is not due", () => {
    const fixture = makeGitFixture("added");
    const outputPath = path.join(fixture.root, fixture.output);

    expect(runFixture(fixture, "--check")).toBe(0);

    writeFileSync(outputPath, "---\n---\n");
    expect(() => runFixture(fixture, "--check")).toThrow(/no .* is due/u);
  });

  test("check mode rejects a symlink at the output path", () => {
    const fixture = makeGitFixture("bump");
    const outputPath = path.join(fixture.root, fixture.output);
    const targetPath = path.join(fixture.root, "target.md");
    writeFileSync(targetPath, "---\n---\n");
    symlinkSync(targetPath, outputPath);

    expect(() => runFixture(fixture, "--check")).toThrow(/regular file/u);
  });

  test("rejects a checked-out repository whose HEAD differs from --head", () => {
    const fixture = makeGitFixture("bump");

    expect(() =>
      runDependabotChangeset(
        [
          "--base",
          fixture.base,
          "--head",
          fixture.base,
          "--output",
          fixture.output,
        ],
        fixture.root,
      ),
    ).toThrow(/Checked-out HEAD .* does not match/u);
  });

  test("refuses to overwrite an existing output file", () => {
    const fixture = makeGitFixture("bump");
    const outputPath = path.join(fixture.root, fixture.output);
    writeFileSync(outputPath, "keep this file\n");

    expect(() => runFixture(fixture)).toThrow(/overwrite/u);
    expect(readFileSync(outputPath, "utf-8")).toBe("keep this file\n");
  });

  test("refuses to follow a symlink at the output path", () => {
    const fixture = makeGitFixture("bump");
    const outputPath = path.join(fixture.root, fixture.output);
    const targetPath = path.join(fixture.root, "target.md");
    writeFileSync(targetPath, "keep the target\n");
    symlinkSync(targetPath, outputPath);

    expect(() => runFixture(fixture)).toThrow(/overwrite/u);
    expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe("keep the target\n");
  });

  test.each([
    ["added", "added"],
    ["deleted", "deleted"],
    ["executable", "executable mode"],
  ] as const)("refuses a %s manifest without creating output", (change) => {
    const fixture = makeGitFixture(change);

    expect(runFixture(fixture)).toBe(0);
    expect(existsSync(path.join(fixture.root, fixture.output))).toBe(false);
  });
});
