#!/usr/bin/env bun

// Hold new CLI changesets until the open release merges and its VERSION is
// tagged. They then belong to the next release. Pull request runs only warn.

import path from "node:path";

import { isChangesetEntry } from "./changeset-guard";
import { changesetNamesCli } from "./check-cli-release-coupling";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");
const CHANGESET_DIRECTORY = ".changeset";

class ReleaseCliChangesetHoldError extends Error {
  readonly _tag = "ReleaseCliChangesetHoldError";

  constructor(message: string) {
    super(message);
    this.name = "ReleaseCliChangesetHoldError";
  }
}

const panic = (message: string): never => {
  throw new ReleaseCliChangesetHoldError(message);
};

export type ReleaseHoldEvent = "pull_request" | "merge_group";

type ReleaseVersionState = "pending" | "tagged";

export type ReleaseHoldInput = {
  readonly addedCliChangesets: readonly string[];
  readonly event: ReleaseHoldEvent;
  readonly isReleasePullRequest: boolean;
  readonly openReleases: number;
  readonly versionState: ReleaseVersionState;
};

export type ReleaseHoldVerdict =
  | { readonly status: "clear" }
  | {
      readonly status: "hold" | "warn";
      readonly changesets: readonly string[];
    };

export const decideReleaseHold = ({
  addedCliChangesets,
  event,
  isReleasePullRequest,
  openReleases,
  versionState,
}: ReleaseHoldInput): ReleaseHoldVerdict => {
  if (
    isReleasePullRequest ||
    (openReleases === 0 && versionState === "tagged") ||
    addedCliChangesets.length === 0
  ) {
    return { status: "clear" };
  }
  return {
    status: event === "merge_group" ? "hold" : "warn",
    changesets: addedCliChangesets,
  };
};

export const report = (verdict: ReleaseHoldVerdict): number => {
  if (verdict.status === "clear") {
    process.stdout.write(
      "release-cli-changeset-hold: no CLI changeset waits on a release.\n",
    );
    return 0;
  }
  const changesets = verdict.changesets.join(", ");
  if (verdict.status === "warn") {
    process.stdout.write(
      `::warning::release-cli-changeset-hold: a release is open or awaiting its tag and this pull request adds a changeset naming @stll/cli (${changesets}). The merge queue holds it until the release is tagged.\n`,
    );
    return 0;
  }
  process.stderr.write(
    `::error::release-cli-changeset-hold: a release is open or awaiting its tag and this pull request adds a changeset naming @stll/cli (${changesets}). Landing it now would leave the release a CLI change it did not version.\n` +
      "  fix: enqueue this pull request again after the release is tagged; its changeset then goes into the next release.\n",
  );
  return 1;
};

const git = (
  args: readonly string[],
  root: string,
): { readonly ok: boolean; readonly stdout: string } => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
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

/** Changesets this pull request adds or edits that name @stll/cli. */
export const readAddedCliChangesets = (
  root: string,
  base: string,
): readonly string[] => {
  const mergeBase = gitOutput(["merge-base", base, "HEAD"], root).trim();
  if (mergeBase === "") {
    return panic(`git merge-base ${base} HEAD found no common commit`);
  }
  return gitOutput(
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=AM",
      mergeBase,
      "HEAD",
      "--",
      CHANGESET_DIRECTORY,
    ],
    root,
  )
    .split("\0")
    .filter(Boolean)
    .filter(isChangesetEntry)
    .filter((entry) =>
      changesetNamesCli(gitOutput(["show", `HEAD:${entry}`], root)),
    )
    .toSorted();
};

type HoldOptions = {
  readonly root: string;
  readonly base: string;
  readonly event: ReleaseHoldEvent;
  readonly isReleasePullRequest: boolean;
  readonly openReleases: number;
  readonly versionState: ReleaseVersionState;
};

const USAGE =
  "usage: check-release-cli-changeset-hold.ts --event <pull_request|merge_group> " +
  "--open-releases <count> --version-state <pending|tagged> --is-release <true|false> [--base <ref>] [--root <path>]";

const parseEvent = (value: string): ReleaseHoldEvent =>
  value === "pull_request" || value === "merge_group" ? value : panic(USAGE);

const parseCount = (value: string): number =>
  /^\d+$/u.test(value) ? Number(value) : panic(USAGE);

const parseBoolean = (value: string): boolean => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return panic(USAGE);
};

export const parseHoldArgs = (args: readonly string[]): HoldOptions => {
  let root = DEFAULT_ROOT;
  let base = "origin/main";
  let event: ReleaseHoldEvent | null = null;
  let openReleases: number | null = null;
  let versionState: ReleaseVersionState | null = null;
  let isReleasePullRequest: boolean | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? panic(USAGE);
    const value = args.at(index + 1) ?? panic(USAGE);
    switch (flag) {
      case "--root":
        root = path.resolve(value);
        break;
      case "--base":
        base = value;
        break;
      case "--event":
        event = parseEvent(value);
        break;
      case "--open-releases":
        openReleases = parseCount(value);
        break;
      case "--version-state":
        if (value !== "pending" && value !== "tagged") {
          return panic(USAGE);
        }
        versionState = value;
        break;
      case "--is-release":
        isReleasePullRequest = parseBoolean(value);
        break;
      default:
        return panic(USAGE);
    }
  }
  if (
    event === null ||
    openReleases === null ||
    versionState === null ||
    isReleasePullRequest === null
  ) {
    return panic(USAGE);
  }
  return {
    root,
    base,
    event,
    openReleases,
    versionState,
    isReleasePullRequest,
  };
};

const main = (args: readonly string[]): number => {
  const options = parseHoldArgs(args);
  return report(
    decideReleaseHold({
      addedCliChangesets: readAddedCliChangesets(options.root, options.base),
      event: options.event,
      isReleasePullRequest: options.isReleasePullRequest,
      openReleases: options.openReleases,
      versionState: options.versionState,
    }),
  );
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
