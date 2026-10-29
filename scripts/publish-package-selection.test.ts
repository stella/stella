import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadChangesetPolicy } from "./changeset-guard";
import { publishedPackageNames } from "./check-published-package-lists";
import { readNpmReleaseGraph } from "./generate-npm-release-jobs";
import {
  changedPathsCommand,
  expandPublishPackages,
  selectPublishPackages,
} from "./publish-package-selection";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

const workspaceDependencies = async (
  packageName: string,
): Promise<readonly string[]> => {
  const manifest: unknown = await Bun.file(
    new URL(`../packages/${packageName}/package.json`, import.meta.url),
  ).json();
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("dependencies" in manifest) ||
    typeof manifest.dependencies !== "object" ||
    manifest.dependencies === null
  ) {
    return [];
  }
  return Object.keys(manifest.dependencies).flatMap((name) =>
    name.startsWith("@stll/") ? [name.slice("@stll/".length)] : [],
  );
};

const dependencyGroups = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const packageManifest = async (packageName: string): Promise<unknown> =>
  await Bun.file(
    new URL(`../packages/${packageName}/package.json`, import.meta.url),
  ).json();

const manifestName = (manifest: unknown): string | null =>
  typeof manifest === "object" &&
  manifest !== null &&
  "name" in manifest &&
  typeof manifest.name === "string"
    ? manifest.name
    : null;

const isPrivateManifest = (manifest: unknown): boolean =>
  typeof manifest === "object" &&
  manifest !== null &&
  "private" in manifest &&
  manifest.private === true;

const isPublishedManifest = (manifest: unknown): boolean =>
  typeof manifest === "object" &&
  manifest !== null &&
  "publishConfig" in manifest &&
  typeof manifest.publishConfig === "object" &&
  manifest.publishConfig !== null &&
  !isPrivateManifest(manifest);

const manifestDependencies = (manifest: unknown): readonly string[] => {
  if (typeof manifest !== "object" || manifest === null) {
    return [];
  }
  return dependencyGroups.flatMap((group) => {
    const dependencies: unknown = Reflect.get(manifest, group);
    if (typeof dependencies !== "object" || dependencies === null) {
      return [];
    }
    return Object.keys(dependencies);
  });
};

describe("publish package selection", () => {
  test("publishes exactly the packages the release policy gates", () => {
    const order: readonly string[] = ALL_PACKAGE_ORDER;
    expect(order.toSorted()).toEqual([
      ...publishedPackageNames(loadChangesetPolicy().releasePaths),
    ]);
  });

  test("publishes every package after the published packages it depends on", async () => {
    const order: readonly string[] = ALL_PACKAGE_ORDER;
    const misordered: string[] = [];
    for (const [index, packageName] of order.entries()) {
      for (const dependency of await workspaceDependencies(packageName)) {
        const dependencyIndex = order.indexOf(dependency);
        if (dependencyIndex > index) {
          misordered.push(`${dependency} after ${packageName}`);
        }
      }
    }
    expect(misordered).toEqual([]);
  });

  test("published packages do not depend on private workspace packages", async () => {
    const packageNames = [
      ...new Bun.Glob("*/package.json").scanSync({
        cwd: new URL("../packages", import.meta.url).pathname,
      }),
    ].map((file) => file.slice(0, -"/package.json".length));
    const manifests = await Promise.all(packageNames.map(packageManifest));
    const privateWorkspaceNames = new Set(
      manifests.flatMap((manifest) => {
        const name = manifestName(manifest);
        return name !== null && isPrivateManifest(manifest) ? [name] : [];
      }),
    );
    const violations = manifests.flatMap((manifest) => {
      if (!isPublishedManifest(manifest)) {
        return [];
      }
      const name = manifestName(manifest);
      if (name === null) {
        return ["published package has no name"];
      }
      return manifestDependencies(manifest).flatMap((dependency) =>
        privateWorkspaceNames.has(dependency)
          ? [`${name} depends on private workspace package ${dependency}`]
          : [],
      );
    });
    expect(violations).toEqual([]);
  });

  test("publish workflow delegates push selection to the tested resolver", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(
      'mapfile -t pkgs < <(bun scripts/publish-package-selection.ts "$EVENT_NAME" "$MANUAL_PACKAGE")',
    );
    expect(workflow).not.toContain(
      "pkgs=(auth-model ai-catalog anonymize-chat chat",
    );
    expect(workflow).toContain(
      `if [[ "${String.fromCodePoint(36)}{#pkgs[@]}" -eq 0 ]]; then`,
    );
  });

  test("pushes only packages with a version changelog", () => {
    expect(
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: [
          "packages/ui/CHANGELOG.md",
          "packages/workspace-ui/CHANGELOG.md",
        ],
      }),
    ).toEqual(["ui", "workspace-ui"]);
  });

  test("does not republish a historically tagged but unpublished package", () => {
    expect(
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: ["packages/ui/CHANGELOG.md"],
      }),
    ).not.toContain("chat");
  });

  test("passes only an explicitly requested prior artifact run to the verified recovery path", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("artifact_run_id:");
    expect(workflow).toContain(
      `artifact-run-id: ${String.fromCodePoint(36)}{{ inputs.artifact_run_id || '' }}`,
    );
    expect(workflow).toContain(
      "uses: stella/.github/.github/workflows/npm-independent-release.yml@5764ab66e4df84cfd2e642c7d7e4678261e668f8",
    );
  });

  test("selects an explicit historical recovery package without requiring new tooling in old source", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(
      'elif [[ "$EVENT_NAME" == "workflow_dispatch" && "$MANUAL_PACKAGE" != "all" ]]; then',
    );
    expect(workflow).toContain(
      'selection="$(bun .pack-tooling/scripts/publish-package-selection.ts "$EVENT_NAME" "$MANUAL_PACKAGE" "$GITHUB_WORKSPACE")"',
    );
    for (const script of [
      "publish-package-selection",
      "publish-packages",
      "generate-npm-release-jobs",
    ]) {
      expect(workflow).toContain(`            scripts/${script}.ts`);
    }
  });

  test("a named CLI dispatch includes exactly its transitive workspace dependencies first", async () => {
    const selection = selectPublishPackages({
      eventName: "workflow_dispatch",
      manualPackage: "cli",
      changedPaths: [],
    });
    const expected = new Set(["cli"]);
    const pending = ["cli"];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) {
        break;
      }
      const dependencies = manifestDependencies(
        await packageManifest(directory),
      )
        .filter((name) =>
          ALL_PACKAGE_ORDER.some((known) => name === `@stll/${known}`),
        )
        .map((name) => name.slice("@stll/".length));
      for (const dependency of dependencies) {
        expect(selection.indexOf(dependency)).toBeGreaterThanOrEqual(0);
        expect(selection.indexOf(dependency)).toBeLessThan(
          selection.indexOf(directory),
        );
        if (!expected.has(dependency)) {
          expected.add(dependency);
          pending.push(dependency);
        }
      }
    }
    expect(selection.toSorted()).toEqual([...expected].toSorted());
    expect(selection).toContain("agent-input");
    expect(selection).toContain("stable-stringify");
    expect(new Set(selection).size).toBe(selection.length);
    expect(
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "cli",
        changedPaths: [],
      }),
    ).toEqual(selection);
  });

  test("a leaf dispatch selects only itself and all retains its inventory", () => {
    expect(
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "stable-stringify",
        changedPaths: [],
      }),
    ).toEqual(["stable-stringify"]);
    expect(
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "all",
        changedPaths: [],
      }),
    ).toEqual(ALL_PACKAGE_ORDER);
  });

  test("unknown named selections panic", () => {
    expect(() =>
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "unknown",
        changedPaths: [],
      }),
    ).toThrow("Unknown package 'unknown'");
    expect(() =>
      expandPublishPackages({ selected: ["unknown"], graph: [] }),
    ).toThrow("Unknown package 'unknown'");
  });

  test("current tooling without installed dependencies follows historical source manifests", () => {
    const root = mkdtempSync(path.join(tmpdir(), "publish-source-"));
    try {
      const tooling = path.join(root, "tooling", "scripts");
      const source = path.join(root, "source");
      mkdirSync(tooling, { recursive: true });
      for (const script of [
        "publish-package-selection",
        "publish-packages",
        "generate-npm-release-jobs",
      ]) {
        copyFileSync(
          new URL(`${script}.ts`, import.meta.url),
          path.join(tooling, `${script}.ts`),
        );
      }
      for (const directory of ALL_PACKAGE_ORDER) {
        const manifestDir = path.join(source, "packages", directory);
        mkdirSync(manifestDir, { recursive: true });
        writeFileSync(
          path.join(manifestDir, "package.json"),
          JSON.stringify({
            name: `@stll/${directory}`,
            ...(directory === "cli"
              ? {
                  optionalDependencies: {
                    "@stll/agent-input": "workspace:*",
                    "@stll/stable-stringify": "workspace:*",
                  },
                }
              : {}),
            ...(directory === "agent-input"
              ? {
                  peerDependencies: {
                    "@stll/auth-model": "workspace:*",
                    "@stll/stable-stringify": "workspace:*",
                  },
                }
              : {}),
          }),
        );
      }
      const currentGraph = readNpmReleaseGraph({
        readManifest: (directory) =>
          readFileSync(
            new URL(`../packages/${directory}/package.json`, import.meta.url),
            "utf-8",
          ),
      });
      expect(
        expandPublishPackages({ selected: ["cli"], graph: currentGraph }),
      ).not.toContain("auth-model");
      const result = Bun.spawnSync(
        [
          process.execPath,
          path.join(tooling, "publish-package-selection.ts"),
          "workflow_dispatch",
          "cli",
          source,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(new TextDecoder().decode(result.stderr)).toBe("");
      expect(result.exitCode).toBe(0);
      expect(
        new TextDecoder().decode(result.stdout).trim().split("\n"),
      ).toEqual(["stable-stringify", "auth-model", "agent-input", "cli"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A merge-queue batch pushes several commits at once; the version commit
  // may not be the last one, and its changelogs still have to count.
  test("selects from the whole pushed range when the push names its base", () => {
    const before = "a".repeat(40);
    expect(changedPathsCommand(before)).toEqual([
      "git",
      "diff",
      "--name-only",
      before,
      "HEAD",
      "--",
      "packages",
    ]);
  });

  test("falls back to HEAD alone without a usable push base", () => {
    for (const before of [undefined, "", "0".repeat(40), "HEAD~1", "abc"]) {
      expect(changedPathsCommand(before).slice(0, 2)).toEqual([
        "git",
        "diff-tree",
      ]);
    }
  });

  test("publish workflow hands the push base to the selector", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(
      `PUSH_BEFORE: ${String.fromCodePoint(36)}{{ github.event.before || '' }}`,
    );
  });

  test("keeps workflow-run CLI releases explicit", () => {
    expect(
      selectPublishPackages({
        eventName: "workflow_run",
        manualPackage: "all",
        changedPaths: [],
      }),
    ).toEqual(["cli"]);
  });

  test("rejects a push with no changed library changelog", () => {
    expect(() =>
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: ["packages/chat/src/index.ts"],
      }),
    ).toThrow("no changed library changelog");
  });
});
