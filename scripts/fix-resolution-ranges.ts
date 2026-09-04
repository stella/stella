#!/usr/bin/env bun
// Raises a root `resolutions`/`overrides` pin that sits below a dependent's
// declared floor to the lowest version every dependent accepts, so the
// resolution-range guard never leaves a Dependabot bun update red for a human
// to hand-edit.
//
// Runs to a bounded fixed point. Raising pin A and regenerating the lockfile
// republishes A's own metadata, which can expose a floor for another pinned
// package B that no earlier pass could see; one repair pass would leave that
// cascade for the guard to fail on. Each pass therefore rewrites the pins,
// refreshes bun.lock, and re-reads the graph until nothing is left to raise.
// The pass cap keeps a pathological graph from looping in CI.
//
// Refuses to write when no single version satisfies the dependents: a real
// conflict is a decision, not a mechanical bump.

import path from "node:path";

import {
  analyzeResolutionRanges,
  applyOverridePins,
  loadResolutionGraph,
  planResolutionRepairs,
} from "./resolution-ranges";

const ROOT = path.resolve(import.meta.dir, "..");
const DEFAULT_MAX_PASSES = 4;
const PASS_BOUNDS = { max: 10, min: 1 } as const;

class ResolutionFixError extends Error {
  readonly _tag = "ResolutionFixError";

  constructor(message: string) {
    super(message);
    this.name = "ResolutionFixError";
  }
}

/**
 * Re-resolves bun.lock against the rewritten pins. `--lockfile-only` keeps the
 * pass from materializing dependencies and `--ignore-scripts` from running any
 * hook the update carries.
 */
const installLockfileOnly = (root: string): void => {
  const result = Bun.spawnSync(
    ["bun", "--no-env-file", "install", "--lockfile-only", "--ignore-scripts"],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) {
    throw new ResolutionFixError(
      `bun install --lockfile-only failed with exit code ${String(result.exitCode)}`,
    );
  }
};

export type RefreshLockfile = (root: string) => Promise<void> | void;

export type FixResolutionRangesOptions = {
  readonly maxPasses?: number;
  /** Seam for tests: the real hook re-resolves bun.lock with bun install. */
  readonly refresh?: RefreshLockfile;
  readonly root: string;
};

export const runFixResolutionRanges = async ({
  maxPasses = DEFAULT_MAX_PASSES,
  refresh = installLockfileOnly,
  root,
}: FixResolutionRangesOptions): Promise<number> => {
  // One pass per call rather than a loop: the passes are strictly sequential
  // (each reads the lockfile the previous one refreshed) and the cap bounds
  // the depth.
  const runPass = async (pass: number): Promise<number> => {
    const { declared, rootManifest } = await loadResolutionGraph(root);
    const violations = analyzeResolutionRanges({ declared, rootManifest });
    if (violations.length === 0) {
      process.stdout.write(
        `resolution-range fix: every pin meets its dependents' floors after ${String(pass)} pass(es).\n`,
      );
      return 0;
    }

    const repairs = planResolutionRepairs({ declared, violations });
    const conflicts = repairs.filter((repair) => repair.status === "conflict");
    if (conflicts.length > 0) {
      const lines = [
        "resolution-range fix: no single version satisfies every dependent.",
        "",
      ];
      for (const { blockedBy, packageName, pinned, target } of conflicts) {
        lines.push(
          `  - ${packageName} is pinned to ${pinned}; raising it to ${target} would break:`,
        );
        for (const { declaredBy, range } of blockedBy) {
          lines.push(`      ${declaredBy} requires "${range}"`);
        }
      }
      lines.push(
        "",
        "Resolve the conflicting requirements by hand; nothing was written.",
        "",
      );
      process.stderr.write(lines.join("\n"));
      return 1;
    }

    if (pass >= maxPasses) {
      process.stderr.write(
        [
          `resolution-range fix: still repairing after ${String(maxPasses)} pass(es), giving up.`,
          "",
          ...violations.map(
            ({ floor, packageName, pinned }) =>
              `  - ${packageName} is pinned to ${pinned} and wants ${floor}`,
          ),
          "",
          "Each pass exposed another floor; resolve the cascade by hand.",
          "",
        ].join("\n"),
      );
      return 1;
    }

    const raises = repairs.filter((repair) => repair.status === "raise");
    const manifestPath = path.join(root, "package.json");
    const before = await Bun.file(manifestPath).text();
    const after = applyOverridePins(
      before,
      raises.map(({ kind, packageName, to }) => ({
        kind,
        packageName,
        version: to,
      })),
    );
    await Bun.write(manifestPath, after);
    process.stdout.write(
      `${raises
        .map(
          ({ from, kind, packageName, requiredBy: [binding], to }) =>
            `resolution-range fix: raised ${kind}.${packageName} ${from} -> ${to} (${binding.declaredBy} requires "${binding.range}").`,
        )
        .join("\n")}\n`,
    );
    // Refresh before the next read: a raised pin republishes that package's own
    // metadata, which is where a further floor can appear.
    await refresh(root);
    return runPass(pass + 1);
  };

  return runPass(0);
};

const parseMaxPasses = (args: readonly string[]): number => {
  if (args.length === 0) {
    return DEFAULT_MAX_PASSES;
  }
  const [flag, value, ...rest] = args;
  if (flag !== "--max-passes" || value === undefined || rest.length > 0) {
    throw new ResolutionFixError(
      "Usage: fix-resolution-ranges.ts [--max-passes <1-10>]",
    );
  }
  const maxPasses = Number(value);
  if (
    !Number.isInteger(maxPasses) ||
    maxPasses < PASS_BOUNDS.min ||
    maxPasses > PASS_BOUNDS.max
  ) {
    throw new ResolutionFixError(`--max-passes must be 1-10, got ${value}`);
  }
  return maxPasses;
};

if (import.meta.main) {
  process.exit(
    await runFixResolutionRanges({
      maxPasses: parseMaxPasses(process.argv.slice(2)),
      root: ROOT,
    }),
  );
}
