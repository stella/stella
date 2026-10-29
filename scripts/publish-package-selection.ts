import { fail as panic } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { readNpmReleaseGraph } from "./generate-npm-release-jobs";
import { ALL_PACKAGE_ORDER, LIBRARY_PACKAGE_ORDER } from "./publish-packages";

type PublishEvent = "push" | "workflow_run" | "workflow_dispatch";

type PublishPackageSelectionOptions = {
  eventName: PublishEvent;
  manualPackage: string;
  changedPaths: readonly string[];
  readManifest?: (directory: string) => string;
};

const isKnownPackage = (
  packageName: string,
): packageName is (typeof ALL_PACKAGE_ORDER)[number] =>
  ALL_PACKAGE_ORDER.some((knownPackage) => knownPackage === packageName);

type ExpandPublishPackagesOptions = {
  selected: readonly string[];
  graph: ReturnType<typeof readNpmReleaseGraph>;
};

export const expandPublishPackages = ({
  selected,
  graph,
}: ExpandPublishPackagesOptions): readonly string[] => {
  const packages = new Map(graph.map((pkg) => [pkg.directory, pkg]));
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (directory: string) => {
    if (visited.has(directory)) {
      return;
    }
    const pkg = packages.get(directory);
    if (pkg === undefined) {
      panic(`Unknown package '${directory}'.`);
    }
    visited.add(directory);
    for (const dependency of pkg.dependencies) {
      visit(dependency);
    }
    ordered.push(directory);
  };
  for (const directory of selected) {
    visit(directory);
  }
  return ordered;
};

const readSourceManifest = (directory: string) =>
  readFileSync(
    path.join(process.cwd(), "packages", directory, "package.json"),
    "utf-8",
  );

export const selectPublishPackages = ({
  eventName,
  manualPackage,
  changedPaths,
  readManifest = readSourceManifest,
}: PublishPackageSelectionOptions): readonly string[] => {
  if (eventName === "workflow_run") {
    return ["cli"];
  }

  if (eventName === "workflow_dispatch") {
    if (manualPackage === "all") {
      return ALL_PACKAGE_ORDER;
    }

    if (!isKnownPackage(manualPackage)) {
      panic(`Unknown package '${manualPackage}'.`);
    }

    return expandPublishPackages({
      selected: [manualPackage],
      graph: readNpmReleaseGraph({ readManifest }),
    });
  }

  const changed = new Set(changedPaths);
  const selected = LIBRARY_PACKAGE_ORDER.filter((packageName) =>
    changed.has(`packages/${packageName}/CHANGELOG.md`),
  );

  if (selected.length === 0) {
    panic(
      "Push release contains no changed library changelog; refusing an empty publish.",
    );
  }

  return selected;
};

const FULL_SHA = /^[0-9a-f]{40}$/u;
const NO_COMMIT = /^0{40}$/u;

/**
 * The paths one push changed. A merge queue can land several commits in one
 * push, and the version commit is not necessarily the last: diffing only HEAD
 * would then miss its changelogs and publish nothing. With the push's `before`
 * SHA the whole pushed range counts; without one (a new branch, or a manual
 * run) only HEAD does.
 */
export const changedPathsCommand = (
  pushBefore: string | undefined,
): readonly string[] =>
  pushBefore !== undefined &&
  FULL_SHA.test(pushBefore) &&
  !NO_COMMIT.test(pushBefore)
    ? ["git", "diff", "--name-only", pushBefore, "HEAD", "--", "packages"]
    : [
        "git",
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "HEAD",
        "--",
        "packages",
      ];

if (import.meta.main) {
  const eventName = Bun.argv.at(2);
  const manualPackage = Bun.argv.at(3) ?? "all";
  if (
    eventName !== "push" &&
    eventName !== "workflow_run" &&
    eventName !== "workflow_dispatch"
  ) {
    panic(`Unsupported event '${eventName ?? ""}'.`);
  }

  if (eventName === "workflow_dispatch" && manualPackage !== "all") {
    const sourceRoot = Bun.argv.at(4) ?? process.cwd();
    for (const packageName of selectPublishPackages({
      eventName,
      manualPackage,
      changedPaths: [],
      readManifest: (directory) =>
        readFileSync(
          path.join(sourceRoot, "packages", directory, "package.json"),
          "utf-8",
        ),
    })) {
      console.log(packageName);
    }
    process.exit(0);
  }

  const changedPaths = Bun.spawnSync(
    [...changedPathsCommand(process.env["PUSH_BEFORE"])],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (changedPaths.exitCode !== 0) {
    panic(new TextDecoder().decode(changedPaths.stderr));
  }

  const paths = new TextDecoder()
    .decode(changedPaths.stdout)
    .split("\n")
    .filter((changedPath) => changedPath.length > 0);
  for (const packageName of selectPublishPackages({
    eventName,
    manualPackage,
    changedPaths: paths,
  })) {
    console.log(packageName);
  }
}
