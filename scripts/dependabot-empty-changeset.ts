#!/usr/bin/env bun

import { lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  decideChangesetGate,
  isChangesetEntry,
  loadChangesetPolicy,
  type ChangesetPolicy,
} from "./changeset-guard";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const EMPTY_CHANGESET = "---\n---\n";
const OUTPUT_PATH = /^\.changeset\/dependabot-dev-dependencies-[1-9]\d*\.md$/u;
const DEV_DEPENDENCIES = "devDependencies";
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

class DependabotChangesetError extends Error {
  readonly _tag = "DependabotChangesetError";

  constructor(message: string) {
    super(message);
    this.name = "DependabotChangesetError";
  }
}

const panic = (message: string): never => {
  throw new DependabotChangesetError(message);
};

type ManifestPair = {
  readonly packagePath: string;
  readonly base: string;
  readonly head: string;
};

type DependabotEmptyChangesetInput = {
  readonly policy: ChangesetPolicy;
  readonly changedFiles: readonly string[];
  readonly addedChangesetFiles: readonly string[];
  readonly manifests: readonly ManifestPair[];
};

type RefusalReason =
  | "runtime-change"
  | "peer-change"
  | "source-change"
  | "mixed-change"
  | "format-only"
  | "malformed-manifest"
  | "manifest-change";

export type DependabotEmptyChangesetDecision =
  | { readonly status: "create"; readonly packages: readonly string[] }
  | {
      readonly status: "noop";
      readonly reason: "no-release-paths" | "existing-changeset";
    }
  | { readonly status: "refuse"; readonly reason: RefusalReason };

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDependencyMap = (value: unknown): boolean =>
  value === undefined ||
  (isJsonObject(value) &&
    Object.values(value).every((dependency) => typeof dependency === "string"));

const parseManifest = (text: string): JsonObject | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isJsonObject(parsed) ? parsed : null;
};

type ManifestInspection =
  | { readonly status: "eligible"; readonly packageName: string }
  | { readonly status: "refuse"; readonly reason: RefusalReason };

const inspectManifest = ({ base, head }: ManifestPair): ManifestInspection => {
  const baseManifest = parseManifest(base);
  const headManifest = parseManifest(head);
  if (baseManifest === null || headManifest === null) {
    return { status: "refuse", reason: "malformed-manifest" };
  }

  const packageName = headManifest["name"];
  if (typeof packageName !== "string") {
    return { status: "refuse", reason: "malformed-manifest" };
  }

  const keys = new Set([
    ...Object.keys(baseManifest),
    ...Object.keys(headManifest),
  ]);
  const changedKeys = [...keys].filter(
    (key) => !isDeepStrictEqual(baseManifest[key], headManifest[key]),
  );
  if (changedKeys.length === 0) {
    return { status: "refuse", reason: "format-only" };
  }
  if (changedKeys.length === 1 && changedKeys.at(0) === DEV_DEPENDENCIES) {
    if (
      !isDependencyMap(baseManifest[DEV_DEPENDENCIES]) ||
      !isDependencyMap(headManifest[DEV_DEPENDENCIES])
    ) {
      return { status: "refuse", reason: "malformed-manifest" };
    }
    return { status: "eligible", packageName };
  }
  if (changedKeys.includes(DEV_DEPENDENCIES)) {
    return { status: "refuse", reason: "mixed-change" };
  }
  if (changedKeys.includes("peerDependencies")) {
    return { status: "refuse", reason: "peer-change" };
  }
  if (
    changedKeys.some((key) =>
      [
        "dependencies",
        "optionalDependencies",
        "bundledDependencies",
        "bundleDependencies",
      ].includes(key),
    )
  ) {
    return { status: "refuse", reason: "runtime-change" };
  }
  return { status: "refuse", reason: "manifest-change" };
};

export const decideDependabotEmptyChangeset = ({
  policy,
  changedFiles,
  addedChangesetFiles,
  manifests,
}: DependabotEmptyChangesetInput): DependabotEmptyChangesetDecision => {
  const gate = decideChangesetGate({
    changedFiles,
    addedFiles: addedChangesetFiles,
    releasePaths: policy.releasePaths,
  });
  switch (gate.status) {
    case "not-required":
      return { status: "noop", reason: "no-release-paths" };
    case "satisfied":
      return { status: "noop", reason: "existing-changeset" };
    case "missing": {
      const hasNonManifestChange = changedFiles.some(
        (file) =>
          file !== "bun.lock" &&
          file !== "package.json" &&
          !file.endsWith("/package.json") &&
          !isChangesetEntry(file),
      );
      if (hasNonManifestChange) {
        return { status: "refuse", reason: "source-change" };
      }

      const packageFiles = new Set(policy.packageFiles);
      if (gate.releaseFiles.some((file) => !packageFiles.has(file))) {
        return { status: "refuse", reason: "source-change" };
      }

      const manifestByPath = new Map(
        manifests.map((pair) => [pair.packagePath, pair]),
      );
      const inspections = [...new Set(gate.releaseFiles)].map((packagePath) => {
        const pair = manifestByPath.get(packagePath);
        if (pair === undefined) {
          return {
            status: "refuse",
            reason: "malformed-manifest",
          } satisfies ManifestInspection;
        }
        return inspectManifest(pair);
      });
      const refusals = inspections.filter(
        (inspection) => inspection.status === "refuse",
      );
      if (refusals.length > 0) {
        const eligibleCount = inspections.length - refusals.length;
        return {
          status: "refuse",
          reason:
            eligibleCount > 0 || refusals.length > 1
              ? "mixed-change"
              : (refusals.at(0)?.reason ?? "malformed-manifest"),
        };
      }

      return {
        status: "create",
        packages: inspections.map((inspection) => {
          if (inspection.status === "refuse") {
            return panic("eligible manifest set contained a refusal");
          }
          return inspection.packageName;
        }),
      };
    }
    default: {
      gate satisfies never;
      return panic(`Unhandled gate: ${String(gate)}`);
    }
  }
};

type GitResult = { readonly ok: boolean; readonly stdout: string };

const git = (args: readonly string[], root: string): GitResult => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString() };
};

const gitOutput = (args: readonly string[], root: string): string => {
  const result = git(args, root);
  if (!result.ok) {
    return panic(`git ${args.join(" ")} failed`);
  }
  return result.stdout;
};

const gitPaths = (args: readonly string[], root: string): string[] =>
  gitOutput(args, root).split("\0").filter(Boolean);

type ReadRegularBlobOptions = {
  readonly root: string;
  readonly ref: string;
  readonly packagePath: string;
};

const readRegularBlob = ({
  root,
  ref,
  packagePath,
}: ReadRegularBlobOptions): string | null => {
  const entry = gitOutput(["ls-tree", "-z", ref, "--", packagePath], root);
  const mode = entry.slice(0, entry.indexOf(" "));
  if (mode !== "100644") {
    return null;
  }
  return gitOutput(["show", `${ref}:${packagePath}`], root);
};

type CliOptions = {
  readonly base: string;
  readonly head: string;
  readonly output: string;
};

const parseArgs = (args: readonly string[]): CliOptions => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args.at(index);
    const value = args.at(index + 1);
    if (flag === undefined || value === undefined || value === "") {
      return panic(
        "Usage: dependabot-empty-changeset.ts --base <sha> --head <sha> --output <path>",
      );
    }
    switch (flag) {
      case "--base":
      case "--head":
      case "--output":
        break;
      default:
        return panic(`Unknown argument: ${flag}`);
    }
    if (values.has(flag)) {
      return panic(`Duplicate argument: ${flag}`);
    }
    values.set(flag, value);
  }

  const base = values.get("--base");
  const head = values.get("--head");
  const output = values.get("--output");
  if (base === undefined || head === undefined || output === undefined) {
    return panic(
      "Usage: dependabot-empty-changeset.ts --base <sha> --head <sha> --output <path>",
    );
  }
  if (!OUTPUT_PATH.test(output)) {
    return panic(`Invalid empty changeset output path: ${output}`);
  }
  if (!COMMIT_SHA.test(base) || !COMMIT_SHA.test(head)) {
    return panic("Dependabot changeset refs must be full commit SHAs");
  }
  return { base, head, output };
};

export const runDependabotEmptyChangeset = (
  args: readonly string[],
  root: string = REPO_ROOT,
): number => {
  const { base, head, output } = parseArgs(args);
  const checkedOutHead = gitOutput(["rev-parse", "HEAD"], root).trim();
  const exactHead = gitOutput(["rev-parse", `${head}^{commit}`], root).trim();
  if (checkedOutHead !== exactHead) {
    panic(`Checked-out HEAD ${checkedOutHead} does not match ${exactHead}`);
  }
  const exactBase = gitOutput(["rev-parse", `${base}^{commit}`], root).trim();
  const mergeBase = gitOutput(
    ["merge-base", exactBase, exactHead],
    root,
  ).trim();
  if (mergeBase === "") {
    panic(`No merge base between ${exactBase} and ${exactHead}`);
  }

  const changedFiles = gitPaths(
    ["diff", "--name-only", "-z", "--diff-filter=ACMRD", mergeBase, exactHead],
    root,
  );
  const addedChangesetFiles = gitPaths(
    [
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=A",
      mergeBase,
      exactHead,
      "--",
      ".changeset/*.md",
    ],
    root,
  );
  const policy = loadChangesetPolicy(root);
  const changedSet = new Set(changedFiles);
  const manifests = policy.packageFiles.flatMap((packagePath) => {
    if (!changedSet.has(packagePath)) {
      return [];
    }
    const baseManifest = readRegularBlob({
      root,
      ref: mergeBase,
      packagePath,
    });
    const headManifest = readRegularBlob({
      root,
      ref: exactHead,
      packagePath,
    });
    return baseManifest === null || headManifest === null
      ? []
      : [{ packagePath, base: baseManifest, head: headManifest }];
  });

  const decision = decideDependabotEmptyChangeset({
    policy,
    changedFiles,
    addedChangesetFiles,
    manifests,
  });
  switch (decision.status) {
    case "noop":
      process.stdout.write(`dependabot changeset: ${decision.reason}\n`);
      return 0;
    case "refuse":
      process.stdout.write(
        `dependabot changeset: refused ${decision.reason}\n`,
      );
      return 0;
    case "create": {
      const absoluteOutput = path.join(root, output);
      if (lstatSync(absoluteOutput, { throwIfNoEntry: false }) !== undefined) {
        panic(`Refusing to overwrite ${output}`);
      }
      writeFileSync(absoluteOutput, EMPTY_CHANGESET, { flag: "wx" });
      process.stdout.write(
        `dependabot changeset: created ${output} for ${decision.packages.join(", ")}\n`,
      );
      return 0;
    }
    default: {
      decision satisfies never;
      return panic(`Unhandled decision: ${String(decision)}`);
    }
  }
};

if (import.meta.main) {
  process.exit(runDependabotEmptyChangeset(process.argv.slice(2)));
}
