// Enumerate query bindings with the production rule. Like the silent-drop
// guard, compare exact sets: both new violations and stale entries fail.
// Regenerate after migrating entries: bun scripts/query-data-state-baseline.ts --write.
import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import { BASELINE_PATHS } from "./baseline-paths.ts";
import { exactSetDifference, ruleCensusDiagnostics } from "./rule-census.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = BASELINE_PATHS.queryDataState;
const RULE = "query-data-requires-state";
const BASELINE_SCHEMA = v.object({
  entries: v.record(v.string(), v.pipe(v.string(), v.nonEmpty())),
});
const KEY = /Query binding: (?<key>.+)\.$/u;

export const queryStateCensus = () => {
  const sources = Bun.spawnSync(
    ["git", "ls-files", "--", "apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    { cwd: ROOT },
  );
  if (sources.exitCode !== 0) {
    panic("Cannot enumerate web query source files");
  }
  const files = sources.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf-8");
      return (
        source.includes("@tanstack/react-query") ||
        source.includes("use-chrome-query")
      );
    });
  return ruleCensusDiagnostics({
    rule: RULE,
    files,
    lintTarget: "apps/web/src",
    label: "query-state",
  })
    .map((diagnostic) => {
      const key = KEY.exec(diagnostic.message)?.groups?.["key"];
      if (!key) {
        panic(
          `Query state diagnostic has no binding key: ${diagnostic.message}`,
        );
      }
      return {
        key,
        file: diagnostic.filename,
        line:
          diagnostic.labels.at(0)?.span.line ??
          panic("Query state diagnostic has no source location"),
      };
    })
    .toSorted((left, right) => compareCodeUnit(left.key, right.key));
};

if (import.meta.main) {
  const observed = queryStateCensus().map(({ key }) => key);
  const baseline = v.parse(
    BASELINE_SCHEMA,
    JSON.parse(readFileSync(path.join(ROOT, BASELINE), "utf-8")),
  );
  // The observed set alone cannot prevent someone growing the JSON alongside
  // a new violation. Compare committed base keys before accepting the head.
  const explicitBase = process.env["BASE_SHA"];
  const mergeBase = Bun.spawnSync(
    explicitBase
      ? ["git", "rev-parse", "--verify", `${explicitBase}^{commit}`]
      : ["git", "merge-base", "HEAD", "origin/main"],
    { cwd: ROOT },
  );
  if (mergeBase.exitCode !== 0) {
    panic("Cannot resolve the query state baseline base revision");
  }
  const baseRevision = mergeBase.stdout.toString().trim();
  const basePath = Bun.spawnSync(
    ["git", "ls-tree", "--name-only", baseRevision, "--", BASELINE],
    { cwd: ROOT },
  );
  if (basePath.exitCode !== 0) {
    panic("Cannot inspect the committed query state baseline");
  }
  let committed: string[] | null = null;
  if (basePath.stdout.toString().trim()) {
    const baseFile = Bun.spawnSync(
      ["git", "show", `${baseRevision}:${BASELINE}`],
      { cwd: ROOT },
    );
    if (baseFile.exitCode !== 0) {
      panic("Cannot read the committed query state baseline");
    }
    const base = v.parse(
      BASELINE_SCHEMA,
      JSON.parse(baseFile.stdout.toString()),
    );
    committed = Object.keys(base.entries);
  }
  const difference = exactSetDifference({
    observed,
    recorded: Object.keys(baseline.entries),
    committed,
  });
  if (
    difference.added.length > 0 ||
    difference.duplicates.length > 0 ||
    difference.grown.length > 0
  ) {
    process.stderr.write(
      `Query state baseline cannot grow.\n${difference.added.map((key) => `New: ${key}`).join("\n")}\n${difference.duplicates.map((key) => `Duplicate key: ${key}`).join("\n")}\n${difference.grown.map((key) => `Added baseline key: ${key}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  if (process.argv.includes("--write")) {
    const entries = Object.fromEntries(
      observed.map((key) => [key, baseline.entries[key]]),
    );
    writeFileSync(
      path.join(ROOT, BASELINE),
      `${JSON.stringify({ entries }, null, 2)}\n`,
    );
  } else if (difference.stale.length > 0) {
    process.stderr.write(
      `Remove migrated query state entries with bun scripts/query-data-state-baseline.ts --write:\n${difference.stale.join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Query state baseline: ${String(observed.length)} bindings, exact set verified.\n`,
  );
}
