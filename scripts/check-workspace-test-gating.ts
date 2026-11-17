#!/usr/bin/env bun

// Fails when a workspace test file runs in no gating CI job.
//
// Gating CI runs `turbo run test` over every workspace package that has a
// `test` script (scripts/test-shards.ts partitions them; its test proves no
// package falls out). A test file inside a package therefore runs only when
// that script collects it: a package without the script, a `bun test` whose
// path filters or ignore patterns miss the file, or a package runner that
// skips its directory leaves the file unrun, and nothing reports it.
//
// The rule is deliberately narrow. A tracked `*.test.ts(x)` under apps/* or
// packages/* is collected when its package's `test` script, followed through
// `bun run <script>` and the package runners below, reaches a plain `bun test`
// invocation that selects it. Every other command earns no credit, so a file
// collected some other way is listed rather than assumed. The list must name
// exactly the uncollected files: an unlisted one fails, and so does a listed
// file that is now collected or gone. It also only shrinks: `--base` refuses
// any entry the base revision's list does not have (scripts/ledger-membership.ts),
// so a new test file has to be collected, not listed. A renamed file keeps its
// entry.
//
// Root scripts/**/*.test.ts are out of scope: scripts/run-unlisted-script-tests.ts
// runs every one that no workflow step names.
//
//   bun scripts/check-workspace-test-gating.ts                exact list
//   bun scripts/check-workspace-test-gating.ts --base <ref>   CI: also only shrinks

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import { listApiTestPaths } from "../apps/api/scripts/api-test-plan";
import { planTestRuns } from "../apps/web/scripts/test-run-plan";
import {
  parseReasonedLedger,
  relocateLedgerEntries,
  runLedgerMembershipGuard,
} from "./ledger-membership";
import ungated from "./ungated-workspace-tests-ledger.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const UNGATED_LEDGER = "scripts/ungated-workspace-tests-ledger.json";

const WORKSPACE_TEST_FILE = /^(?:apps|packages)\/[^/]+\/.+\.test\.tsx?$/u;
const MAX_SCRIPT_DEPTH = 4;

/** `bun test` options whose value may follow as the next argument. */
const BUN_TEST_VALUE_OPTIONS = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--retry",
  "-r",
  "--preload",
  "--seed",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
  "--path-ignore-patterns",
  "--max-concurrency",
  "--shard",
  "--timings",
]);

/** A test selection: `bun test` arguments, or an explicit file list. */
type Collector =
  | { readonly type: "bun-test"; readonly args: readonly string[] }
  | { readonly type: "files"; readonly files: ReadonlySet<string> };

export type WorkspacePackage = {
  /** Repository-relative directory, e.g. `packages/errors`. */
  readonly dir: string;
  readonly scripts: Readonly<Record<string, string>>;
};

/**
 * Package runners that select test files themselves. Each returns the
 * selection exactly as its runner computes it on a full run.
 */
const PACKAGE_RUNNERS = new Map<
  string,
  (packageRoot: string) => readonly Collector[]
>([
  [
    "apps/api: bun scripts/run-tests.ts",
    (packageRoot) => [
      { type: "files", files: new Set(listApiTestPaths(packageRoot)) },
    ],
  ],
  [
    "apps/web: bun scripts/run-tests.ts",
    () =>
      planTestRuns({
        argv: [],
        pathKind: () => "missing",
        testFilesIn: () => [],
      }).runs.map(({ args }): Collector => ({ type: "bun-test", args })),
  ],
]);

/** Splits on whitespace, honouring single and double quotes. */
const shellWords = (command: string): readonly string[] =>
  [...command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );

/**
 * A segment earns credit only as a plain command: any pipe, list, redirect,
 * subshell or substitution could mask its exit status or change what it runs.
 */
const SHELL_CONTROL = /[|;&<>()`$\\]/u;

/** The collectors a package script reaches through `&&`-chained commands. */
export const scriptCollectors = (
  pkg: WorkspacePackage,
  scriptName: string,
  packageRoot: string,
  depth = 0,
): readonly Collector[] => {
  const command = pkg.scripts[scriptName];
  if (command === undefined || depth > MAX_SCRIPT_DEPTH) {
    return [];
  }
  return command.split("&&").flatMap((rawSegment): readonly Collector[] => {
    const segment = rawSegment.trim();
    if (SHELL_CONTROL.test(segment.replaceAll(/'[^']*'/gu, "''"))) {
      return [];
    }
    const runner = PACKAGE_RUNNERS.get(`${pkg.dir}: ${segment}`);
    if (runner !== undefined) {
      return runner(packageRoot);
    }
    const words = shellWords(segment);
    if (words[0] !== "bun") {
      return [];
    }
    if (words[1] === "test") {
      return [{ type: "bun-test", args: words.slice(2) }];
    }
    if (words[1] === "run" && words.length === 3 && words[2] !== undefined) {
      return scriptCollectors(pkg, words[2], packageRoot, depth + 1);
    }
    return [];
  });
};

/**
 * Whether `bun test <args>`, run in the package root, collects `file` (a
 * package-relative path). Bun skips hidden directories and node_modules,
 * treats a `./` argument as a path prefix and any other positional argument
 * as a substring of the relative path, and drops `--path-ignore-patterns`
 * globs.
 */
export const bunTestCollects = (
  args: readonly string[],
  file: string,
): boolean => {
  if (
    file
      .split("/")
      .some((part) => part.startsWith(".") || part === "node_modules")
  ) {
    return false;
  }
  const filters: string[] = [];
  const ignores: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-")) {
      const equals = arg.indexOf("=");
      const option = equals === -1 ? arg : arg.slice(0, equals);
      const inline = equals === -1 ? undefined : arg.slice(equals + 1);
      const value =
        inline ??
        (BUN_TEST_VALUE_OPTIONS.has(option) ? args[++index] : undefined);
      if (option === "--path-ignore-patterns" && value !== undefined) {
        ignores.push(value);
      }
      continue;
    }
    filters.push(arg);
  }
  if (ignores.some((pattern) => new Bun.Glob(pattern).match(file))) {
    return false;
  }
  return (
    filters.length === 0 ||
    filters.some((filter) =>
      filter.startsWith("./")
        ? file === filter.slice(2) ||
          file.startsWith(`${filter.slice(2).replace(/\/$/u, "")}/`)
        : file.includes(filter),
    )
  );
};

const collects = (collector: Collector, file: string): boolean =>
  collector.type === "files"
    ? collector.files.has(file)
    : bunTestCollects(collector.args, file);

/** Every tracked workspace test file no package `test` script collects. */
export const uncollectedTestFiles = ({
  files,
  packages,
  collectorsFor,
}: {
  readonly files: readonly string[];
  readonly packages: readonly WorkspacePackage[];
  readonly collectorsFor: (pkg: WorkspacePackage) => readonly Collector[];
}): readonly string[] => {
  const byDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
  const collectors = new Map<string, readonly Collector[]>();
  return files
    .filter((file) => WORKSPACE_TEST_FILE.test(file))
    .filter((file) => {
      const dir = file.split("/").slice(0, 2).join("/");
      const pkg = byDir.get(dir);
      if (pkg === undefined) {
        return true;
      }
      const own = collectors.get(dir) ?? collectorsFor(pkg);
      collectors.set(dir, own);
      const relative = file.slice(dir.length + 1);
      return !own.some((collector) => collects(collector, relative));
    })
    .toSorted();
};

type LedgerEntry = { readonly id: string; readonly reason: string };

/** The list must name exactly the uncollected files, each with a reason. */
export const ledgerFindings = (
  ledger: readonly LedgerEntry[],
  uncollected: readonly string[],
): readonly string[] => {
  const listed = new Set(ledger.map((entry) => entry.id));
  const actual = new Set(uncollected);
  return [
    ...uncollected
      .filter((file) => !listed.has(file))
      .map(
        (file) =>
          `${file} runs in no gating job: make its package's \`test\` script collect it, or list it in ${UNGATED_LEDGER} with a reason.`,
      ),
    ...ledger
      .filter((entry) => !actual.has(entry.id))
      .map(
        (entry) =>
          `${entry.id} is listed in ${UNGATED_LEDGER} but is now collected or gone: remove its entry.`,
      ),
    ...ledger
      .filter((entry) => entry.reason.trim().length === 0)
      .map((entry) => `${entry.id} has no reason in ${UNGATED_LEDGER}.`),
    ...ledger
      .filter(
        (entry, index) =>
          ledger.findIndex((other) => other.id === entry.id) !== index,
      )
      .map((entry) => `${entry.id} is listed twice in ${UNGATED_LEDGER}.`),
  ];
};

const trackedFiles = (): readonly string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "apps", "packages"], {
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return panic(`git ls-files failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().split("\0").filter(Boolean);
};

const readWorkspacePackages = (
  files: readonly string[],
): readonly WorkspacePackage[] =>
  files
    .filter((file) => /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(file))
    .map((file) => {
      const manifest: { scripts?: Record<string, string> } = JSON.parse(
        readFileSync(path.join(REPO_ROOT, file), "utf-8"),
      );
      return { dir: path.dirname(file), scripts: manifest.scripts ?? {} };
    });

export const checkWorkspaceTestGating = (): readonly string[] => {
  const files = trackedFiles();
  const uncollected = uncollectedTestFiles({
    files,
    packages: readWorkspacePackages(files),
    collectorsFor: (pkg) =>
      scriptCollectors(pkg, "test", path.join(REPO_ROOT, pkg.dir)),
  });
  return ledgerFindings(ungated, uncollected);
};

/** Refuses any list entry the base revision's list does not have. */
export const checkUngatedLedgerMembership = ({
  args,
  repoRoot = REPO_ROOT,
  log,
  error,
}: {
  readonly args: readonly string[];
  readonly repoRoot?: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
}): number =>
  runLedgerMembershipGuard({
    ledgerRel: UNGATED_LEDGER,
    repoRoot,
    parseLedger: parseReasonedLedger,
    normalizeBaseEntries: (options) =>
      relocateLedgerEntries({ ...options, repoRoot }),
    label: "ungated-workspace-tests",
    remediation:
      "make the package's `test` script collect the file instead of listing it",
    args,
    log,
    error,
  });

if (import.meta.main) {
  const findings = checkWorkspaceTestGating();
  if (findings.length > 0) {
    console.error(findings.join("\n"));
    process.exit(1);
  }
  console.log(
    `Workspace test gating OK (${ungated.length} listed uncollected files).`,
  );
  const args = process.argv.slice(2);
  if (args.includes("--base")) {
    process.exit(
      checkUngatedLedgerMembership({
        args,
        log: console.log,
        error: console.error,
      }),
    );
  }
}
