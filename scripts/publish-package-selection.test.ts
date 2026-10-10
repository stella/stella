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
      "The reusable workflow verifies that a resumed artifact comes from this",
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
