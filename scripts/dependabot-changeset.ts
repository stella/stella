#!/usr/bin/env bun

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
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
const OUTPUT_PATH = /^\.changeset\/dependabot-dependencies-[1-9]\d*\.md$/u;
const DEV_DEPENDENCY_FIELD = "devDependencies";
const ELIGIBLE_FIELDS = new Set([
  DEV_DEPENDENCY_FIELD,
  "dependencies",
  "optionalDependencies",
]);
// A caret or tilde range, or an exact version, over a plain semver triple.
// Anything else (`catalog:`, `workspace:`, `>=`, `*`) has no single floor to
// compare, so the fixer leaves it to a human.
const RANGE_FLOOR =
  /^[\^~]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
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

type DependabotChangesetInput = {
  readonly policy: ChangesetPolicy;
  readonly changedFiles: readonly string[];
  readonly addedChangesetFiles: readonly string[];
  readonly manifests: readonly ManifestPair[];
};

type RefusalReason =
  | "major-change"
  | "unsupported-range"
  | "dependency-set-change"
  | "peer-change"
  | "source-change"
  | "mixed-change"
  | "format-only"
  | "malformed-manifest"
  | "manifest-change";

export type DependencyUpdate = {
  readonly name: string;
  readonly range: string;
};

/**
 * One published package's share of the changeset. `updates` lists the
 * runtime floors the bump moved; an empty list means only devDependencies
 * changed and the package needs no version bump.
 */
export type ChangesetEntry = {
  readonly packageName: string;
  readonly updates: readonly DependencyUpdate[];
};

export type DependabotChangesetDecision =
  | { readonly status: "create"; readonly entries: readonly ChangesetEntry[] }
  | {
      readonly status: "noop";
      readonly reason: "no-release-paths" | "existing-changeset";
    }
  | { readonly status: "refuse"; readonly reason: RefusalReason };

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type DependencyMap = Readonly<Record<string, string>>;

const asDependencyMap = (value: unknown): DependencyMap | null => {
  if (value === undefined) {
    return {};
  }
  if (!isJsonObject(value)) {
    return null;
  }
  const entries = Object.entries(value).flatMap(([name, range]) =>
    typeof range === "string" ? [[name, range] as const] : [],
  );
  if (entries.length !== Object.keys(value).length) {
    return null;
  }
  return Object.fromEntries(entries);
};

const parseManifest = (text: string): JsonObject | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isJsonObject(parsed) ? parsed : null;
};

type RangeFloor = { readonly major: number; readonly minor: number };

const parseRangeFloor = (range: string): RangeFloor | null => {
  const match = RANGE_FLOOR.exec(range);
  if (match === null) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
};

// Caret semantics make a minor step breaking below 1.0.0, so the move that
// is compatible at `^3.6.0` → `^3.7.0` is not at `^0.6.0` → `^0.7.0`.
const isCompatibleFloorMove = (base: RangeFloor, head: RangeFloor): boolean =>
  base.major === head.major && (base.major !== 0 || base.minor === head.minor);

type RuntimeUpdates =
  | { readonly status: "ok"; readonly updates: readonly DependencyUpdate[] }
  | { readonly status: "refuse"; readonly reason: RefusalReason };

const diffRuntimeDependencies = (
  base: DependencyMap,
  head: DependencyMap,
): RuntimeUpdates => {
  const names = new Set([...Object.keys(base), ...Object.keys(head)]);
  const updates: DependencyUpdate[] = [];
  for (const name of names) {
    const baseRange = base[name];
    const headRange = head[name];
    if (baseRange === undefined || headRange === undefined) {
      return { status: "refuse", reason: "dependency-set-change" };
    }
    if (baseRange === headRange) {
      continue;
    }
    const baseFloor = parseRangeFloor(baseRange);
    const headFloor = parseRangeFloor(headRange);
    if (baseFloor === null || headFloor === null) {
      return { status: "refuse", reason: "unsupported-range" };
    }
    if (!isCompatibleFloorMove(baseFloor, headFloor)) {
      return { status: "refuse", reason: "major-change" };
    }
    updates.push({ name, range: headRange });
  }
  return { status: "ok", updates };
};

type ManifestInspection =
  | { readonly status: "eligible"; readonly entry: ChangesetEntry }
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
  if (changedKeys.includes("peerDependencies")) {
    return { status: "refuse", reason: "peer-change" };
  }
  if (changedKeys.some((key) => !ELIGIBLE_FIELDS.has(key))) {
    return { status: "refuse", reason: "manifest-change" };
  }

  const updates: DependencyUpdate[] = [];
  for (const field of changedKeys) {
    const baseMap = asDependencyMap(baseManifest[field]);
    const headMap = asDependencyMap(headManifest[field]);
    if (baseMap === null || headMap === null) {
      return { status: "refuse", reason: "malformed-manifest" };
    }
    if (field === DEV_DEPENDENCY_FIELD) {
      continue;
    }
    const runtime = diffRuntimeDependencies(baseMap, headMap);
    if (runtime.status === "refuse") {
      return runtime;
    }
    updates.push(...runtime.updates);
  }
  return { status: "eligible", entry: { packageName, updates } };
};

export const decideDependabotChangeset = ({
  policy,
  changedFiles,
  addedChangesetFiles,
  manifests,
}: DependabotChangesetInput): DependabotChangesetDecision => {
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
        entries: inspections.map((inspection) => {
          if (inspection.status === "refuse") {
            return panic("eligible manifest set contained a refusal");
          }
          return inspection.entry;
        }),
      };
    }
    default: {
      gate satisfies never;
      throw new DependabotChangesetError(`Unhandled gate: ${String(gate)}`);
    }
  }
};

/**
 * A package whose runtime floor moved gets a patch bump: consumers install a
 * different dependency requirement, and the changelog must record it. A
 * dev-only bump stays an empty changeset.
 */
export const renderChangeset = (entries: readonly ChangesetEntry[]): string => {
  const bumped = entries.filter((entry) => entry.updates.length > 0);
  if (bumped.length === 0) {
    return EMPTY_CHANGESET;
  }
  const frontmatter = bumped
    .map((entry) => `"${entry.packageName}": patch\n`)
    .join("");
  const lines = new Set(
    bumped.flatMap((entry) =>
      entry.updates.map(
        (update) => `Update \`${update.name}\` to \`${update.range}\`.`,
      ),
    ),
  );
  return `---\n${frontmatter}---\n\n${[...lines].join("\n")}\n`;
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
  readonly mode: "write" | "check";
};

const USAGE =
  "Usage: dependabot-changeset.ts --base <sha> --head <sha> --output <path> [--check]";

const parseArgs = (args: readonly string[]): CliOptions => {
  const values = new Map<string, string>();
  let mode: CliOptions["mode"] = "write";
  for (let index = 0; index < args.length; index += 1) {
    const flag = args.at(index);
    if (flag === undefined) {
      break;
    }
    if (flag === "--check") {
      mode = "check";
      continue;
    }
    if (flag !== "--base" && flag !== "--head" && flag !== "--output") {
      return panic(`Unknown argument: ${flag}`);
    }
    index += 1;
    const value = args.at(index);
    if (value === undefined || value === "") {
      return panic(USAGE);
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
    return panic(USAGE);
  }
  if (!OUTPUT_PATH.test(output)) {
    return panic(`Invalid Dependabot changeset output path: ${output}`);
  }
  if (!COMMIT_SHA.test(base) || !COMMIT_SHA.test(head)) {
    return panic("Dependabot changeset refs must be full commit SHAs");
  }
  return { base, head, output, mode };
};

type DecideFromGitOptions = {
  readonly root: string;
  readonly base: string;
  readonly head: string;
};

const decideFromGit = ({
  root,
  base,
  head,
}: DecideFromGitOptions): DependabotChangesetDecision => {
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

  return decideDependabotChangeset({
    policy,
    changedFiles,
    addedChangesetFiles,
    manifests,
  });
};

const describeEntries = (entries: readonly ChangesetEntry[]): string =>
  entries
    .map(
      (entry) =>
        `${entry.packageName} (${entry.updates.length === 0 ? "no bump" : "patch"})`,
    )
    .join(", ");

/**
 * Re-derives the decision from git and requires the working tree to hold
 * exactly its rendering: a regular file with the expected bytes when a
 * changeset is due, nothing at all otherwise. Earlier autofix steps consume
 * PR-controlled inputs, so the pushed changeset is verified against the
 * trusted decision rather than trusted because this script wrote it.
 */
const checkOutput = (
  decision: DependabotChangesetDecision,
  absoluteOutput: string,
): void => {
  const stat = lstatSync(absoluteOutput, { throwIfNoEntry: false });
  if (decision.status !== "create") {
    if (stat !== undefined) {
      panic(`${absoluteOutput} exists but no Dependabot changeset is due`);
    }
    return;
  }
  if (stat === undefined || !stat.isFile()) {
    panic(`${absoluteOutput} is not a regular file`);
  }
  if (
    readFileSync(absoluteOutput, "utf-8") !== renderChangeset(decision.entries)
  ) {
    panic(`${absoluteOutput} does not match the expected Dependabot changeset`);
  }
};

export const runDependabotChangeset = (
  args: readonly string[],
  root: string = REPO_ROOT,
): number => {
  const { base, head, output, mode } = parseArgs(args);
  const decision = decideFromGit({ root, base, head });
  const absoluteOutput = path.join(root, output);

  if (mode === "check") {
    checkOutput(decision, absoluteOutput);
    process.stdout.write(`dependabot changeset: verified ${output}\n`);
    return 0;
  }

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
      if (lstatSync(absoluteOutput, { throwIfNoEntry: false }) !== undefined) {
        panic(`Refusing to overwrite ${output}`);
      }
      writeFileSync(absoluteOutput, renderChangeset(decision.entries), {
        flag: "wx",
      });
      process.stdout.write(
        `dependabot changeset: created ${output} for ${describeEntries(decision.entries)}\n`,
      );
      return 0;
    }
    default: {
      decision satisfies never;
      throw new DependabotChangesetError(
        `Unhandled decision: ${String(decision)}`,
      );
    }
  }
};

if (import.meta.main) {
  process.exit(runDependabotChangeset(process.argv.slice(2)));
}
