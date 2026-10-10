// Merge bar freshness: refuse to run a bar that is not the one on main.
//
// The bar is a local script, so a checkout that stopped following main keeps
// running whatever version it last pulled, with every bug main has since
// fixed. Before reading anything, the bar fetches origin main and compares the
// blobs of its own sources (the static import closure of merge-bar.ts plus the
// shell scripts that closure names) with origin/main's. Working-tree content
// is hashed, so an uncommitted edit counts as a difference: an edited bar is
// not the reviewed bar.
//
// One difference is allowed: a branch that contains origin/main and commits
// its own change to the bar (developing the bar itself). Everything main has
// fixed is then present, and the difference is the branch's reviewed diff.
//
// A failed fetch refuses: a bar whose freshness is unknown must not arm.

import { panic } from "better-result";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const MAIN_REF = "refs/remotes/origin/main";
const FETCH_TIMEOUT_MS = 20_000;
const SHELL_SCRIPT_SUFFIX = ".sh";

/**
 * `*.sh` names a source mentions (e.g. `scripts/detect-e2e-changes.sh` gives
 * `detect-e2e-changes.sh`). Splitting on non-name characters keeps this linear;
 * a `[\w-]+\.sh` scan would rescan long word runs from every position.
 */
const shellScriptNames = (source: string) =>
  source.split(/[^\w.-]+/u).flatMap((token) => {
    if (!token.endsWith(SHELL_SCRIPT_SUFFIX)) {
      return [];
    }
    const stemStart =
      token.lastIndexOf(".", token.length - SHELL_SCRIPT_SUFFIX.length - 1) + 1;
    const name = token.slice(stemStart);
    return name.length > SHELL_SCRIPT_SUFFIX.length ? [name] : [];
  });
const LS_TREE_LINE_PATTERN = /^\d+ blob ([0-9a-f]+)\t(.+)$/u;

type BarFile = {
  path: string;
  // Blob hashes: the working tree's, then HEAD's and origin/main's (null
  // where that tree lacks the path).
  local: string;
  head: string | null;
  main: string | null;
};

type FetchOutcome = { type: "fetched" } | { type: "failed"; detail: string };

type HeadSituation = { type: "detached" } | { type: "branch"; name: string };

export type BarFreshnessInput = {
  repositoryRoot: string;
  fetch: FetchOutcome;
  files: readonly BarFile[];
  head: HeadSituation;
  headContainsMain: boolean;
};

type BarFreshnessVerdict =
  | { type: "current" }
  | { type: "branch-bar"; message: string }
  | { type: "refuse"; message: string };

const quote = (value: string) =>
  /^[\w./@:-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const updateCommand = ({
  repositoryRoot,
  head,
}: Pick<BarFreshnessInput, "repositoryRoot" | "head">) => {
  const git = `git -C ${quote(repositoryRoot)}`;
  switch (head.type) {
    case "detached":
      return `${git} fetch origin main && ${git} switch --detach origin/main`;
    case "branch":
      return head.name === "main"
        ? `${git} pull --ff-only origin main`
        : `${git} fetch origin main && ${git} rebase origin/main`;
    default:
      head satisfies never;
      return panic("Unhandled head situation");
  }
};

export const decideBarFreshness = (
  input: BarFreshnessInput,
): BarFreshnessVerdict => {
  const { repositoryRoot, fetch, files, headContainsMain } = input;
  if (fetch.type === "failed") {
    return {
      type: "refuse",
      message:
        `merge bar: cannot fetch origin main to confirm this bar is current (${fetch.detail}); ` +
        `refusing. Retry once \`git -C ${quote(repositoryRoot)} fetch origin main\` succeeds.`,
    };
  }
  const differing = files.filter((file) => file.local !== file.main);
  if (differing.length === 0) {
    return { type: "current" };
  }
  const listed = differing.map((file) => file.path).join(", ");
  const uncommitted = differing.filter((file) => file.local !== file.head);
  if (uncommitted.length > 0) {
    const stash = `git -C ${quote(repositoryRoot)} stash push --include-untracked -m merge-bar-local -- ${uncommitted.map((file) => quote(file.path)).join(" ")}`;
    const committedStale = differing.some((file) => file.head !== file.main);
    const command =
      committedStale && !headContainsMain
        ? `${stash} && ${updateCommand(input)}`
        : stash;
    return {
      type: "refuse",
      message: `merge bar: sources differ from origin/main (${listed}; uncommitted edits); update first: ${command}`,
    };
  }
  if (headContainsMain) {
    return {
      type: "branch-bar",
      message: `merge bar: running this branch's own ${listed} (HEAD contains origin/main)`,
    };
  }
  return {
    type: "refuse",
    message: `merge bar: sources differ from origin/main (${listed}; stale checkout); update first: ${updateCommand(input)}`,
  };
};

/**
 * Repository-relative paths of the bar's sources: the static import closure
 * of `entry` within the repository, plus every `scripts/*.sh` a source in the
 * closure names (the bar runs those from this checkout).
 */
const barSourcePaths = (root: string, entry: string) => {
  // The resolver returns real paths; relate them to the real root.
  const repositoryRoot = realpathSync(root);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const pending = [entry];
  for (
    let relative = pending.pop();
    relative !== undefined;
    relative = pending.pop()
  ) {
    if (seen.has(relative)) {
      continue;
    }
    seen.add(relative);
    if (!relative.endsWith(".ts")) {
      continue;
    }
    const absolute = path.join(repositoryRoot, relative);
    const source = readFileSync(absolute, "utf-8");
    // The transpiler rejects a shebang line.
    const imports = transpiler.scanImports(source.replace(/^#!.*/u, ""));
    for (const { path: specifier } of imports) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      pending.push(
        repoRelativePath(
          repositoryRoot,
          Bun.resolveSync(specifier, path.dirname(absolute)),
        ),
      );
    }
    for (const name of shellScriptNames(source)) {
      const script = path.join("scripts", name);
      if (existsSync(path.join(repositoryRoot, script))) {
        pending.push(script);
      }
    }
  }
  return [...seen].toSorted();
};

const runGit = (repositoryRoot: string, args: readonly string[]) =>
  Bun.spawnSync(["git", "-C", repositoryRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: FETCH_TIMEOUT_MS,
  });

const readGit = (repositoryRoot: string, args: readonly string[]) => {
  const result = runGit(repositoryRoot, args);
  if (result.exitCode !== 0) {
    panic(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

const readTreeBlobs = (
  repositoryRoot: string,
  treeish: string,
  paths: readonly string[],
) => {
  const blobs = new Map<string, string>();
  for (const line of readGit(repositoryRoot, [
    "ls-tree",
    "--full-tree",
    treeish,
    "--",
    ...paths,
  ]).split("\n")) {
    const match = LS_TREE_LINE_PATTERN.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      blobs.set(match[2], match[1]);
    }
  }
  return blobs;
};

const fetchMain = (repositoryRoot: string): FetchOutcome => {
  const result = runGit(repositoryRoot, [
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/heads/main:${MAIN_REF}`,
  ]);
  if (result.exitCode === 0) {
    return { type: "fetched" };
  }
  const detail =
    result.exitedDueToTimeout === true
      ? `timed out after ${FETCH_TIMEOUT_MS / 1000} s`
      : result.stderr.toString().trim() || `exit ${result.exitCode}`;
  return { type: "failed", detail };
};

type ReadBarFreshnessOptions = {
  repositoryRoot: string;
  entry: string;
};

/** Fetches origin main and reads everything `decideBarFreshness` needs. */
export const readBarFreshness = ({
  repositoryRoot,
  entry,
}: ReadBarFreshnessOptions): BarFreshnessInput => {
  const head: HeadSituation = (() => {
    const branch = runGit(repositoryRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    return branch.exitCode === 0
      ? { type: "branch", name: branch.stdout.toString().trim() }
      : { type: "detached" };
  })();
  const fetch = fetchMain(repositoryRoot);
  if (fetch.type === "failed") {
    return {
      repositoryRoot,
      fetch,
      files: [],
      head,
      headContainsMain: false,
    };
  }
  const paths = barSourcePaths(repositoryRoot, entry);
  const local = readGit(repositoryRoot, ["hash-object", "--", ...paths])
    .trim()
    .split("\n");
  const headBlobs = readTreeBlobs(repositoryRoot, "HEAD", paths);
  const mainBlobs = readTreeBlobs(repositoryRoot, MAIN_REF, paths);
  return {
    repositoryRoot,
    fetch,
    files: paths.map((file, index) => ({
      path: file,
      local: local[index] ?? panic(`git hash-object skipped ${file}`),
      head: headBlobs.get(file) ?? null,
      main: mainBlobs.get(file) ?? null,
    })),
    head,
    headContainsMain:
      runGit(repositoryRoot, ["merge-base", "--is-ancestor", MAIN_REF, "HEAD"])
        .exitCode === 0,
  };
};
