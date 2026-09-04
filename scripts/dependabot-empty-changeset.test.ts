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
  decideDependabotEmptyChangeset,
  runDependabotEmptyChangeset,
} from "./dependabot-empty-changeset";

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
  dependencies: { "@stll/ui": "workspace:^" },
  peerDependencies: { react: ">=19" },
  devDependencies: { "@tanstack/react-table": "9.2.2" },
};

const decide = (
  input: Partial<Parameters<typeof decideDependabotEmptyChangeset>[0]> = {},
) =>
  decideDependabotEmptyChangeset({
    policy,
    changedFiles: [],
    addedChangesetFiles: [],
    manifests: [],
    ...input,
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

type GitFixtureChange = "bump" | "added" | "deleted" | "executable";

type GitFixture = {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly output: string;
};

const makeGitFixture = (change: GitFixtureChange): GitFixture => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-dependabot-empty-"));
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
    devDependencies: { vitest: "^3.0.0" },
  };
  const headManifest = {
    ...baseManifest,
    devDependencies: { vitest: "^3.1.0" },
  };
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
    output: ".changeset/dependabot-dev-dependencies-123.md",
  };
};

const runFixture = (fixture: GitFixture) =>
  runDependabotEmptyChangeset(
    [
      "--base",
      fixture.base,
      "--head",
      fixture.head,
      "--output",
      fixture.output,
    ],
    fixture.root,
  );

describe("Dependabot empty changeset decision", () => {
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

  test("creates one empty changeset for semantic devDependency-only manifest changes", () => {
    const head = {
      ...basePackage,
      devDependencies: { "@tanstack/react-table": "9.2.3" },
    };

    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: json(head),
          }),
        ],
      }),
    ).toEqual({
      status: "create",
      packages: ["@stll/workspace-ui"],
    });
  });

  test("derives all eligible published package names from the policy manifests", () => {
    const uiBase = { ...basePackage, name: "@stll/ui" };
    const uiHead = {
      ...uiBase,
      devDependencies: { ...uiBase.devDependencies, react: "19.1.0" },
    };

    expect(
      decide({
        changedFiles: [workspaceUiManifest, uiManifest],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: json({
              ...basePackage,
              devDependencies: {
                "@tanstack/react-table": "9.2.3",
              },
            }),
          }),
          manifest({
            packagePath: uiManifest,
            base: json(uiBase),
            head: json(uiHead),
          }),
        ],
      }),
    ).toEqual({
      status: "create",
      packages: ["@stll/workspace-ui", "@stll/ui"],
    });
  });

  test.each([
    [
      "runtime dependency changes",
      {
        ...basePackage,
        dependencies: { "@stll/ui": "workspace:^", zod: "^4.0.0" },
      },
      "runtime-change",
    ],
    [
      "peer dependency changes",
      { ...basePackage, peerDependencies: { react: ">=20" } },
      "peer-change",
    ],
    ["source changes", basePackage, "source-change"],
  ] as const)("refuses %s", (_label, head, reason) => {
    const changedFiles =
      reason === "source-change"
        ? [workspaceUiManifest, "packages/workspace-ui/src/table.tsx"]
        : [workspaceUiManifest];

    expect(
      decide({
        changedFiles,
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: json(head),
          }),
        ],
      }),
    ).toEqual({ status: "refuse", reason });
  });

  test("refuses a group mixing an eligible devDependency change with a runtime change", () => {
    const runtimeBase = { ...basePackage, name: "@stll/ui" };
    const runtimeHead = {
      ...runtimeBase,
      dependencies: { ...runtimeBase.dependencies, zod: "^4.0.0" },
    };

    expect(
      decide({
        changedFiles: [workspaceUiManifest, uiManifest],
        manifests: [
          manifest({
            packagePath: workspaceUiManifest,
            base: json(basePackage),
            head: json({
              ...basePackage,
              devDependencies: {
                "@tanstack/react-table": "9.2.3",
              },
            }),
          }),
          manifest({
            packagePath: uiManifest,
            base: json(runtimeBase),
            head: json(runtimeHead),
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
            head: json({
              ...basePackage,
              devDependencies: {
                "@tanstack/react-table": "9.2.3",
              },
            }),
          }),
        ],
      }),
    ).toEqual({ status: "refuse", reason: "source-change" });
  });
});

describe("Dependabot empty changeset CLI boundary", () => {
  test.each([
    ".changeset/../outside.md",
    ".changeset/dependabot-dev-dependencies-0.md",
    ".changeset/dependabot-dev-dependencies-not-a-number.md",
  ])("rejects an invalid output path: %s", (output) => {
    expect(() =>
      runDependabotEmptyChangeset([
        "--base",
        "0".repeat(40),
        "--head",
        "1".repeat(40),
        "--output",
        output,
      ]),
    ).toThrow(/invalid empty changeset output path/iu);
  });

  test("writes exactly an empty changeset for an eligible devDependency bump", () => {
    const fixture = makeGitFixture("bump");

    expect(runFixture(fixture)).toBe(0);
    expect(readFileSync(path.join(fixture.root, fixture.output), "utf-8")).toBe(
      "---\n---\n",
    );
  });

  test("rejects a checked-out repository whose HEAD differs from --head", () => {
    const fixture = makeGitFixture("bump");

    expect(() =>
      runDependabotEmptyChangeset(
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
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "keep this file\n");

    expect(() => runFixture(fixture)).toThrow(/overwrite/u);
    expect(readFileSync(outputPath, "utf-8")).toBe("keep this file\n");
  });

  test("refuses to follow a symlink at the output path", () => {
    const fixture = makeGitFixture("bump");
    const outputPath = path.join(fixture.root, fixture.output);
    const targetPath = path.join(fixture.root, "target.md");
    mkdirSync(path.dirname(outputPath), { recursive: true });
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
