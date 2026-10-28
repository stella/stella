import { describe, expect, test } from "bun:test";

import { loadChangesetPolicy } from "./changeset-guard";
import { publishedPackageNames } from "./check-published-package-lists";
import {
  changedPathsCommand,
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
    expect(workflow).toContain('pkgs=("$MANUAL_PACKAGE")');
    expect(workflow).toContain(
      "Recovery is\n          # always one named non-CLI package",
    );
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
