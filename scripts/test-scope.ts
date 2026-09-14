#!/usr/bin/env bun

// Prints the Turbo filter arguments for a scoped `test` run.
//
// `--affected` selects a package only when its own files, or a workspace
// dependency's files, changed. A suite that reads another package's files
// through the filesystem is therefore invisible to a change in what it asserts
// on. turbo.json declares those reads as `$TURBO_ROOT$` inputs of the package's
// `test` task (see scripts/check-test-input-coverage.ts); this script turns the
// declarations into selection.
//
// `--affected` itself cannot be widened, because `--affected --filter=X`
// intersects. Explicit filters union, so the affected set is passed as filters
// instead: the git range carries reverse dependants, `turbo ls --affected`
// carries the working-tree changes the range cannot see, and the declared test
// inputs add the packages that read the changed file from outside.
//
//   bun run test -- --concurrency=2 $(bun scripts/test-scope.ts --base origin/main)
//   --filter=...[origin/main...HEAD] --filter=@stll/web --filter=@stll/scripts

import { panic } from "better-result";
import path from "node:path";

import {
  matchesRootInput,
  readTestInputs,
} from "./check-test-input-coverage.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_BASE = "origin/main";

const run = (
  command: readonly string[],
  env?: Record<string, string | undefined>,
): string => {
  const result = Bun.spawnSync([...command], {
    cwd: REPO_ROOT,
    ...(env === undefined ? {} : { env }),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `Command failed (${result.exitCode}): ${command.join(" ")}\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

const mergeBase = (base: string): string => {
  const resolved = run(["git", "merge-base", base, "HEAD"]).trim();
  if (resolved === "") {
    panic(`Could not find merge base for ${base}`);
  }
  return resolved;
};

/**
 * Committed changes since the merge base plus the working tree, because
 * `--affected` counts uncommitted and untracked files too and a local `verify`
 * run has to scope the same way CI does.
 */
const changedPaths = (base: string): readonly string[] => [
  ...new Set(
    [
      run(["git", "diff", "--name-only", "-z", mergeBase(base), "HEAD"]),
      run(["git", "diff", "--name-only", "-z", "HEAD"]),
      run(["git", "ls-files", "--others", "--exclude-standard", "-z"]),
    ]
      .flatMap((output) => output.split("\0"))
      .filter((file) => file !== ""),
  ),
];

type TurboPackages = {
  packages?: {
    items?: { name?: unknown }[];
  };
};

/**
 * Turbo owns what "affected" means — global dependencies, the lockfile, reverse
 * dependants — so the set is read back from Turbo rather than recomputed here.
 */
const affectedPackages = (base: string): readonly string[] => {
  const output = run(
    ["bun", "--bun", "turbo", "ls", "--affected", "--output=json"],
    {
      ...process.env,
      TURBO_SCM_BASE: mergeBase(base),
      TURBO_SCM_HEAD: "HEAD",
    },
  );
  const jsonStart = output.indexOf("{");
  if (jsonStart === -1) {
    panic("Turbo affected output did not contain JSON");
  }
  const parsed: TurboPackages = JSON.parse(output.slice(jsonStart));
  const items = parsed.packages?.items;
  if (!Array.isArray(items)) {
    panic("Turbo affected output did not contain package items");
  }
  return items.map(({ name }) => {
    if (typeof name !== "string") {
      panic("Turbo affected output contained a package without a name");
    }
    return name;
  });
};

export const scopeFilters = ({
  affected,
  base,
  changed,
  testInputs,
}: {
  readonly affected: readonly string[];
  readonly base: string;
  readonly changed: readonly string[];
  readonly testInputs: ReadonlyMap<string, readonly string[]>;
}): readonly string[] => {
  const packages = new Set(affected);
  for (const [packageName, inputs] of testInputs) {
    if (
      inputs.some((input) =>
        changed.some((file) => matchesRootInput(file, input)),
      )
    ) {
      packages.add(packageName);
    }
  }
  return [
    `--filter=...[${base}...HEAD]`,
    ...[...packages].toSorted().map((packageName) => `--filter=${packageName}`),
  ];
};

const parseBase = (args: readonly string[]): string => {
  if (args.length === 0) {
    return DEFAULT_BASE;
  }
  const [flag, value] = args;
  if (flag !== "--base" || value === undefined || args.length > 2) {
    panic("Usage: bun scripts/test-scope.ts [--base <ref>]");
  }
  return value;
};

if (import.meta.main) {
  const base = parseBase(process.argv.slice(2));
  process.stdout.write(
    `${scopeFilters({
      affected: affectedPackages(base),
      base,
      changed: changedPaths(base),
      testInputs: readTestInputs(REPO_ROOT),
    }).join(" ")}\n`,
  );
}
