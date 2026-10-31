// Materialize only waiver owner blobs before the check's offline preload disables
// subprocesses. A missing path is a new owner; a failed Git read is never absence.
import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";

import { loadWaivers, readTrackedPolicyFiles } from "./dated-waivers";

const git = (args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args]);
  if (result.exitCode !== 0) {
    panic(`Cannot read dated waiver base: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

if (import.meta.main) {
  const [base, trackedPath, changedPath, outputPath] = process.argv.slice(2);
  if (base === undefined || !trackedPath || !changedPath || !outputPath) {
    panic(
      "Usage: dated-waiver-base.ts <base-or-empty> <tracked-files> <changed-files> <output>",
    );
  }
  const changed = new Set(readFileSync(changedPath, "utf-8").split("\0"));
  const sources = new Set(
    loadWaivers(readTrackedPolicyFiles(trackedPath))
      .map(({ source }) => source)
      .filter((source) => changed.has(source)),
  );
  const tracked =
    base !== "" && sources.size > 0
      ? new Set(
          git(["ls-tree", "-r", "--name-only", "-z", base, "--"]).split("\0"),
        )
      : new Set<string>();
  const baseSources = Object.fromEntries(
    [...sources]
      .filter((source) => tracked.has(source))
      .map((source) => [source, git(["show", `${base}:${source}`])]),
  );
  writeFileSync(outputPath, JSON.stringify(baseSources));
}
