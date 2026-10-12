// Shrink-only autofix for committed baselines.
//
// Baselines are decision records, so autofix never writes them in general
// (`autofix-protected-paths.ts`). This is the one narrow exception: when a
// pull request removes code a baseline still lists, the baseline's own writer
// runs, and its result is kept only if it deletes entries or lowers counts.
// Anything that would add or loosen an entry is reverted here and refused
// again by `verify` in the workflow, which compares against the pull
// request's head commit rather than trusting this runner.
//
//   bun scripts/autofix-baseline-prune.ts prune
//   bun autofix-baseline-prune.ts verify --repo <dir> --ref <sha> <path>...
//
// The workflow runs `verify` from the base revision's copy of this file and
// its two imports, in an empty directory with `--no-install --no-env-file`,
// so a pull request cannot change the rules that judge its own baselines.
//
// Only writers whose output is a static scan of committed source are listed:
// nothing that measures builds, timing, registries or a database.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { BASELINE_PATHS } from "./baseline-paths";
import {
  type CollectionPath,
  sameEntries,
  shrinkTextViolations,
} from "./baseline-shrink";

type PrunableBaseline = {
  path: string;
  /** Where the entries live; see `baseline-shrink.ts`. */
  collection: CollectionPath;
};

type BaselineWriter = {
  write: readonly string[];
  baselines: readonly PrunableBaseline[];
};

export const PRUNABLE_BASELINE_WRITERS = [
  {
    write: ["bun", "scripts/check-aggregate-locks.ts", "--generate"],
    baselines: [{ path: BASELINE_PATHS.aggregateLocks, collection: [] }],
  },
  {
    write: ["bun", "scripts/failure-as-empty-baseline.ts", "--write"],
    baselines: [
      { path: BASELINE_PATHS.failureAsEmpty, collection: ["entries"] },
    ],
  },
  {
    write: ["bun", "scripts/query-data-state-baseline.ts", "--write"],
    baselines: [
      { path: BASELINE_PATHS.queryDataState, collection: ["entries"] },
    ],
  },
  {
    write: ["bun", "scripts/sql-perf-baseline.ts", "--write"],
    baselines: [{ path: BASELINE_PATHS.sqlPerf, collection: [] }],
  },
  {
    write: ["bun", "scripts/transfer-read-guard.ts", "--write"],
    baselines: [{ path: BASELINE_PATHS.transferRead, collection: [] }],
  },
  {
    write: ["bun", "scripts/queue-authority.ts", "--write"],
    baselines: [
      { path: BASELINE_PATHS.queueAuthority, collection: ["members"] },
      { path: BASELINE_PATHS.schedulerTaskAuthority, collection: ["members"] },
    ],
  },
] as const satisfies readonly BaselineWriter[];

type RegisteredBaseline =
  (typeof PRUNABLE_BASELINE_WRITERS)[number]["baselines"][number];

export const PRUNABLE_BASELINES: readonly RegisteredBaseline[] =
  PRUNABLE_BASELINE_WRITERS.flatMap(
    ({ baselines }): readonly RegisteredBaseline[] => baselines,
  );

const prunable = (path: string) =>
  PRUNABLE_BASELINES.find((baseline) => baseline.path === path);

/** Violations of replacing `before` with `after` at `path`; empty when allowed. */
export const pruneViolations = (
  path: string,
  before: string,
  after: string,
): string[] => {
  const baseline = prunable(path);
  if (!baseline) {
    return [`${path} is not a shrink-only baseline`];
  }
  return shrinkTextViolations(before, after, baseline.collection);
};

const readText = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf-8") : null;

const prune = () => {
  let pruned = 0;
  for (const writer of PRUNABLE_BASELINE_WRITERS) {
    const before = new Map<string, string | null>(
      writer.baselines.map(({ path }) => [path, readText(path)]),
    );
    const restore = (path: string) => {
      const original = before.get(path);
      if (original !== null && original !== undefined) {
        writeFileSync(path, original);
      }
    };
    if ([...before.values()].some((text) => text === null)) {
      // A missing baseline would make its writer seed one from scratch.
      continue;
    }
    const result = Bun.spawnSync([...writer.write], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      // The writer refused (typically: the code grew past its baseline).
      // Growth is the pull request's to resolve; CI reports it.
      for (const { path } of writer.baselines) {
        restore(path);
      }
      console.log(
        `::notice::${writer.write.join(" ")} did not complete; its baselines are left as committed.`,
      );
      continue;
    }
    for (const { path } of writer.baselines) {
      const original = before.get(path) ?? "";
      const rewritten = readText(path);
      if (rewritten === original) {
        continue;
      }
      const violations =
        rewritten === null
          ? [`${path} was deleted`]
          : pruneViolations(path, original, rewritten);
      if (violations.length > 0) {
        restore(path);
        console.log(
          `::notice::${path} is left as committed: autofix only deletes stale entries (${violations.join("; ")}).`,
        );
        continue;
      }
      if (
        rewritten !== null &&
        sameEntries(JSON.parse(original), JSON.parse(rewritten))
      ) {
        // Only the writer's formatting or order differs: nothing to prune.
        restore(path);
        continue;
      }
      pruned += 1;
      console.log(`Pruned stale entries from ${path}`);
    }
  }
  if (pruned === 0) {
    console.log("No baseline has stale entries");
  }
};

const committedText = (
  repo: string,
  ref: string,
  path: string,
): string | null => {
  const shown = Bun.spawnSync(["git", "-C", repo, "show", `${ref}:${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return shown.exitCode === 0 ? shown.stdout.toString() : null;
};

const verify = (repo: string, ref: string, paths: readonly string[]) => {
  if (!/^[0-9a-f]{40}$/u.test(ref)) {
    console.error("verify needs --ref <full commit sha>");
    return false;
  }
  let valid = true;
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      console.error(`${path} is not a repository path`);
      valid = false;
      continue;
    }
    const before = committedText(repo, ref, path);
    const after = readText(`${repo}/${path}`);
    let violations = [`${path} is not in ${ref}`];
    if (before !== null) {
      violations =
        after === null
          ? [`${path} was deleted`]
          : pruneViolations(path, before, after);
    }
    for (const violation of violations) {
      console.error(violation);
    }
    valid &&= violations.length === 0;
  }
  return valid;
};

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "prune") {
    prune();
  } else if (
    mode === "verify" &&
    args[0] === "--repo" &&
    args[2] === "--ref" &&
    args.length > 4
  ) {
    if (!verify(args[1] ?? "", args[3] ?? "", args.slice(4))) {
      process.exitCode = 1;
    }
  } else {
    console.error(
      "Usage: bun scripts/autofix-baseline-prune.ts prune | verify --repo <dir> --ref <sha> <path>...",
    );
    process.exitCode = 1;
  }
}
