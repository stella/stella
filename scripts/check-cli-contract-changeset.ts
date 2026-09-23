#!/usr/bin/env bun

// A generated CLI contract change must ship with the CLI. The broad changeset
// gate intentionally accepts an empty changeset for unrelated release work;
// this narrower guard is the contract-specific backstop.

import path from "node:path";

import { isChangesetEntry } from "./changeset-guard";
import {
  CLI_CONTRACT_SURFACE_PATHS,
  canonicalJson,
  canonicalSurfacePart,
  compareStableVersions,
  changesetNamesCli,
} from "./check-cli-release-coupling";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_PACKAGE = "packages/cli";
const CHANGESET_DIRECTORY = ".changeset";

class CliContractChangesetError extends Error {
  readonly _tag = "CliContractChangesetError";

  constructor(message: string) {
    super(message);
    this.name = "CliContractChangesetError";
  }
}

const panic = (message: string): never => {
  throw new CliContractChangesetError(message);
};

export type CliContractChangeInput = {
  readonly changedFiles: readonly string[];
  readonly cliChangesets: readonly string[];
  readonly baseCliVersion: string;
  readonly headCliVersion: string;
};

export type CliContractChangeVerdict =
  | { readonly status: "not-required" }
  | {
      readonly status: "satisfied-changeset";
      readonly changesets: readonly string[];
    }
  | {
      readonly status: "satisfied-version";
      readonly baseVersion: string;
      readonly headVersion: string;
    }
  | { readonly status: "missing"; readonly changedParts: readonly string[] };

const changedContractParts = (
  changedFiles: readonly string[],
): readonly string[] =>
  changedFiles
    .filter(
      (file) =>
        file === `${CLI_PACKAGE}/capability-catalog.json` ||
        file.startsWith(`${CLI_PACKAGE}/src/generated/`),
    )
    .map((file) => file.slice(`${CLI_PACKAGE}/`.length));

export const decideCliContractChange = ({
  changedFiles,
  cliChangesets,
  baseCliVersion,
  headCliVersion,
}: CliContractChangeInput): CliContractChangeVerdict => {
  const changedParts = changedContractParts(changedFiles);
  if (changedParts.length === 0) {
    return { status: "not-required" };
  }
  if (cliChangesets.length > 0) {
    return { status: "satisfied-changeset", changesets: cliChangesets };
  }
  if (compareStableVersions(headCliVersion, baseCliVersion) > 0) {
    return {
      status: "satisfied-version",
      baseVersion: baseCliVersion,
      headVersion: headCliVersion,
    };
  }
  return { status: "missing", changedParts };
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

const gitPaths = (args: readonly string[], root: string): string[] => {
  const result = git(args, root);
  if (!result.ok) {
    return panic(`git ${args.join(" ")} failed`);
  }
  return result.stdout.split("\0").filter(Boolean);
};

const readCommittedFile = (root: string, ref: string, file: string): string => {
  const result = git(["show", `${ref}:${file}`], root);
  if (!result.ok) {
    return panic(`${ref}:${file} could not be read`);
  }
  return result.stdout;
};

const readCommittedFileMaybe = (
  root: string,
  ref: string,
  file: string,
): string | null => {
  const result = git(["show", `${ref}:${file}`], root);
  return result.ok ? result.stdout : null;
};

const readHeadCliVersion = (root: string): string => {
  const manifest: unknown = JSON.parse(
    readCommittedFile(root, "HEAD", `${CLI_PACKAGE}/package.json`),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    return panic(`${CLI_PACKAGE}/package.json has no string version`);
  }
  return manifest.version;
};

const readBaseCliVersion = (base: string, root: string): string => {
  const manifest: unknown = JSON.parse(
    readCommittedFile(root, base, `${CLI_PACKAGE}/package.json`),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    return panic(`${base}:${CLI_PACKAGE}/package.json has no string version`);
  }
  return manifest.version;
};

const readCliChangesets = (root: string): readonly string[] =>
  gitPaths(
    ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", CHANGESET_DIRECTORY],
    root,
  )
    .filter(isChangesetEntry)
    .filter((entry) =>
      changesetNamesCli(readCommittedFile(root, "HEAD", entry)),
    )
    .toSorted();

export const generatedContractPaths = (
  root: string,
  ref: string,
): readonly string[] => {
  const generated = gitPaths(
    [
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      ref,
      "--",
      `${CLI_PACKAGE}/src/generated`,
    ],
    root,
  ).filter((file) => file.endsWith(".json") || file.endsWith(".ts"));
  return [
    `${CLI_PACKAGE}/capability-catalog.json`,
    ...generated.filter((file) => !file.endsWith("/cli-version.ts")),
  ];
};

const readSemanticContractChanges = (
  root: string,
  mergeBase: string,
  changedFiles: readonly string[],
  contractPaths: readonly string[],
): readonly string[] =>
  contractPaths.filter((relativePath) => {
    if (!changedFiles.includes(relativePath)) {
      return false;
    }
    const base = readCommittedFileMaybe(root, mergeBase, relativePath);
    const head = readCommittedFileMaybe(root, "HEAD", relativePath);
    if (base === null || head === null) {
      return true;
    }
    const surfacePart = CLI_CONTRACT_SURFACE_PATHS.find(
      (part) => `${CLI_PACKAGE}/${part}` === relativePath,
    );
    if (surfacePart !== undefined) {
      return (
        canonicalSurfacePart(surfacePart, base) !==
        canonicalSurfacePart(surfacePart, head)
      );
    }
    const canonical = (text: string): string =>
      relativePath.endsWith(".json")
        ? canonicalJson(JSON.parse(text) as unknown)
        : text.trim();
    return canonical(base) !== canonical(head);
  });

const report = (verdict: CliContractChangeVerdict): number => {
  switch (verdict.status) {
    case "not-required":
      process.stdout.write(
        "cli-contract-changeset: no CLI contract surface changed.\n",
      );
      return 0;
    case "satisfied-changeset":
      process.stdout.write(
        `cli-contract-changeset: CLI contract changes carry ${verdict.changesets.join(", ")}.\n`,
      );
      return 0;
    case "satisfied-version":
      process.stdout.write(
        `cli-contract-changeset: CLI version advanced from ${verdict.baseVersion} to ${verdict.headVersion}.\n`,
      );
      return 0;
    case "missing":
      process.stderr.write(
        "::error::cli-contract-changeset: generated CLI contract files changed without a CLI changeset or version bump.\n" +
          `  changed: ${verdict.changedParts.join(", ")}\n` +
          "  fix: add a changeset naming @stll/cli, or advance packages/cli/package.json.\n",
      );
      return 1;
    default:
      verdict satisfies never;
      throw new CliContractChangesetError(
        `Unhandled verdict: ${String(verdict)}`,
      );
  }
};

type GuardOptions = { readonly root: string; readonly base: string };

export const runCliContractGuard = ({ root, base }: GuardOptions): number => {
  const mergeBaseResult = git(["merge-base", base, "HEAD"], root);
  if (!mergeBaseResult.ok || mergeBaseResult.stdout.trim() === "") {
    return panic(`git merge-base ${base} HEAD failed`);
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  const contractPaths = [
    ...new Set([
      ...generatedContractPaths(root, mergeBase),
      ...generatedContractPaths(root, "HEAD"),
    ]),
  ];
  const changedFiles = gitPaths(
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=ACMRD",
      mergeBase,
      "HEAD",
    ],
    root,
  );
  return report(
    decideCliContractChange({
      changedFiles: readSemanticContractChanges(
        root,
        mergeBase,
        changedFiles,
        contractPaths,
      ),
      cliChangesets: readCliChangesets(root),
      baseCliVersion: readBaseCliVersion(mergeBase, root),
      headCliVersion: readHeadCliVersion(root),
    }),
  );
};

export const parseCliContractArgs = (args: readonly string[]): GuardOptions => {
  let root = DEFAULT_ROOT;
  let base: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args.at(index + 1);
    if (value === undefined || (flag !== "--base" && flag !== "--root")) {
      return panic(
        "usage: check-cli-contract-changeset.ts --base <ref> [--root <path>]",
      );
    }
    if (flag === "--base") {
      base = value;
    } else {
      root = path.resolve(value);
    }
    index += 1;
  }
  return { root, base: base ?? "origin/main" };
};

const main = (args: readonly string[]): number =>
  runCliContractGuard(parseCliContractArgs(args));

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
