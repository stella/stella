#!/usr/bin/env bun

// Local mirror of the CI changeset gate.
//
// CI fails a pull request that touches a release-gated package's runtime files
// without adding a `.changeset/*.md` entry, but only once the whole workflow
// has run. This runs the same rule at pre-push, in about the time one
// `git diff` takes, and prints the remedy instead of a red check.
//
// Single source of truth: scripts/changeset-policy.json holds the pathspecs.
// The workflow feeds them to the shared changeset-policy action; this script
// matches them locally. Neither side owns a private copy, so they cannot
// drift.
//
// The shared action additionally validates entry shape (frontmatter package
// names, a non-empty summary) and recognizes the generated version pull
// request. Both stay there: the first is cheap for CI to own once, the second
// can only happen on a bot branch. This guard covers the failure a developer
// actually hits — a release-gated change with no new changeset.
//
//   bun scripts/changeset-guard.ts [--base origin/main]

import { readFileSync } from "node:fs";
import path from "node:path";

// This module is also imported by the no-install Dependabot autofix runner.
class ChangesetPolicyError extends Error {
  readonly _tag = "ChangesetPolicyError";

  constructor(message: string) {
    super(message);
    this.name = "ChangesetPolicyError";
  }
}

const panic = (message: string): never => {
  throw new ChangesetPolicyError(message);
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POLICY_FILE = "scripts/changeset-policy.json";
const DEFAULT_BASE = "origin/main";
const CHANGESET_DIRECTORY = ".changeset/";
const CHANGESET_EXTENSION = ".md";
/** Changesets ships this file; it is documentation, never a release entry. */
const CHANGESET_README = ".changeset/README.md";
const CHANGESET_PATHSPEC = ".changeset/*.md";
/** Keep the pre-push failure to three lines, however large the diff is. */
const PREVIEW_LIMIT = 3;

export type ChangesetPolicy = {
  readonly releasePaths: readonly string[];
  readonly generatedPaths: readonly string[];
  readonly packageFiles: readonly string[];
};

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isChangesetPolicy = (value: unknown): value is ChangesetPolicy =>
  typeof value === "object" &&
  value !== null &&
  "releasePaths" in value &&
  isStringArray(value.releasePaths) &&
  "generatedPaths" in value &&
  isStringArray(value.generatedPaths) &&
  "packageFiles" in value &&
  isStringArray(value.packageFiles);

export const parseChangesetPolicy = (text: string): ChangesetPolicy => {
  const parsed: unknown = JSON.parse(text);
  if (!isChangesetPolicy(parsed)) {
    panic(
      `${POLICY_FILE} must hold releasePaths, generatedPaths and packageFiles as string arrays.`,
    );
  }
  return parsed;
};

export const loadChangesetPolicy = (
  root: string = REPO_ROOT,
): ChangesetPolicy =>
  parseChangesetPolicy(readFileSync(path.join(root, POLICY_FILE), "utf-8"));

/** The `directory/**` suffix, the only wildcard the policy file may use. */
const TREE_SUFFIX = "/**";
const WILDCARD = /[*?[\]]/u;

type ReleaseMatcher =
  | { readonly type: "file"; readonly file: string }
  | { readonly type: "tree"; readonly prefix: string };

/**
 * Git resolves the policy pathspecs in CI, this matcher resolves them locally,
 * so the supported syntax is deliberately tiny: a literal path, or a directory
 * followed by `/**`. Anything else fails loudly here rather than matching
 * differently on the two sides.
 */
export const parseReleasePathspec = (pathspec: string): ReleaseMatcher => {
  const isTree = pathspec.endsWith(TREE_SUFFIX);
  const literal = isTree ? pathspec.slice(0, -TREE_SUFFIX.length) : pathspec;
  if (literal.length === 0 || WILDCARD.test(literal)) {
    panic(
      `Unsupported release pathspec '${pathspec}'. Use a literal path or 'directory/**'.`,
    );
  }
  return isTree
    ? { type: "tree", prefix: `${literal}/` }
    : { type: "file", file: literal };
};

const matchesRelease = (matcher: ReleaseMatcher, file: string): boolean => {
  switch (matcher.type) {
    case "file":
      return file === matcher.file;
    case "tree":
      return file.startsWith(matcher.prefix);
    default: {
      const unreachable: never = matcher;
      return unreachable;
    }
  }
};

export const isChangesetEntry = (file: string): boolean =>
  file.startsWith(CHANGESET_DIRECTORY) &&
  file.endsWith(CHANGESET_EXTENSION) &&
  file !== CHANGESET_README;

export type ChangesetVerdict =
  | { readonly status: "not-required" }
  | { readonly status: "satisfied"; readonly changesets: readonly string[] }
  | { readonly status: "missing"; readonly releaseFiles: readonly string[] };

type ChangesetGateInput = {
  readonly changedFiles: readonly string[];
  readonly addedFiles: readonly string[];
  readonly releasePaths: readonly string[];
};

/**
 * The whole rule: a release-gated file in the diff needs a newly added
 * changeset entry. The entry's contents are deliberately not read — an empty
 * changeset (`bun run changeset --empty`) is how an intentional no-release
 * change is recorded, and it must pass exactly like a versioning one.
 */
export const decideChangesetGate = ({
  changedFiles,
  addedFiles,
  releasePaths,
}: ChangesetGateInput): ChangesetVerdict => {
  const matchers = releasePaths.map(parseReleasePathspec);
  const releaseFiles = changedFiles.filter((file) =>
    matchers.some((matcher) => matchesRelease(matcher, file)),
  );
  if (releaseFiles.length === 0) {
    return { status: "not-required" };
  }

  const changesets = addedFiles.filter(isChangesetEntry);
  if (changesets.length > 0) {
    return { status: "satisfied", changesets };
  }
  return { status: "missing", releaseFiles };
};

const preview = (files: readonly string[]): string => {
  const shown = files.slice(0, PREVIEW_LIMIT).join(", ");
  const remaining = files.length - PREVIEW_LIMIT;
  return remaining > 0 ? `${shown} (+${remaining} more)` : shown;
};

export const report = (verdict: ChangesetVerdict): number => {
  switch (verdict.status) {
    case "not-required":
      process.stdout.write("changeset-guard: no release-gated changes.\n");
      return 0;
    case "satisfied":
      process.stdout.write(
        `changeset-guard: release-gated changes carry a changeset (${preview(verdict.changesets)}).\n`,
      );
      return 0;
    case "missing":
      process.stderr.write(
        "changeset-guard: release-gated files changed with no new changeset; CI fails on this.\n" +
          `  changed: ${preview(verdict.releaseFiles)}\n` +
          "  fix: bun run changeset (add --empty for an intentional no-release change)\n",
      );
      return 1;
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
};

type GitRun = { readonly ok: boolean; readonly stdout: string };

const git = (args: readonly string[]): GitRun => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString() };
};

const gitPaths = (args: readonly string[]): string[] => {
  const result = git(args);
  if (!result.ok) {
    panic(`git ${args.join(" ")} failed`);
  }
  return result.stdout.split("\0").filter(Boolean);
};

const hasCommit = (ref: string): boolean =>
  git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;

/**
 * A missing base ref is the one case worth a network call: a fresh clone or a
 * worktree that has never fetched. Fetching that one branch without tags keeps
 * it under a second. A stale (but present) base is left alone: it only widens
 * the diff, which can never turn a required changeset into an unrequired one.
 */
const resolveBase = (base: string): string | null => {
  if (hasCommit(base)) {
    return base;
  }
  const separator = base.indexOf("/");
  if (separator <= 0) {
    return null;
  }
  git([
    "fetch",
    "--quiet",
    "--no-tags",
    base.slice(0, separator),
    base.slice(separator + 1),
  ]);
  return hasCommit(base) ? base : null;
};

const parseArgs = (args: readonly string[]): { readonly base: string } => {
  let base = DEFAULT_BASE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--base") {
      panic(`Unknown argument: ${args[index]}`);
    }
    const value = args.at(index + 1);
    if (value === undefined) {
      panic("--base requires a git ref");
    }
    base = value;
    index += 1;
  }
  return { base };
};

const main = (args: readonly string[]): number => {
  const { base } = parseArgs(args);
  const resolved = resolveBase(base);
  if (resolved === null) {
    process.stderr.write(
      `changeset-guard: skipped, ${base} is not available locally.\n`,
    );
    return 0;
  }

  const mergeBase = git(["merge-base", resolved, "HEAD"]).stdout.trim();
  if (mergeBase === "") {
    process.stderr.write(
      `changeset-guard: skipped, no merge base with ${resolved}.\n`,
    );
    return 0;
  }

  return report(
    decideChangesetGate({
      changedFiles: gitPaths([
        "diff",
        "--name-only",
        "-z",
        "--diff-filter=ACMRD",
        mergeBase,
        "HEAD",
      ]),
      addedFiles: gitPaths([
        "diff",
        "--name-only",
        "-z",
        "--diff-filter=A",
        mergeBase,
        "HEAD",
        "--",
        CHANGESET_PATHSPEC,
      ]),
      releasePaths: loadChangesetPolicy().releasePaths,
    }),
  );
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
