// Enumerate query bindings with the production rule. Like the silent-drop
// guard, compare exact sets: both new violations and stale entries fail.
// Regenerate after migrating entries: bun scripts/query-data-state-baseline.ts --write.
import { panic } from "better-result";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { BASELINE_PATHS } from "./baseline-paths.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = BASELINE_PATHS.queryDataState;
const RULE = "query-data-requires-state";
const OUTPUT = v.object({
  diagnostics: v.array(
    v.object({
      code: v.string(),
      message: v.string(),
      filename: v.string(),
      labels: v.array(v.object({ span: v.object({ line: v.number() }) })),
    }),
  ),
});
const BASELINE_SCHEMA = v.object({
  entries: v.record(v.string(), v.pipe(v.string(), v.nonEmpty())),
});
const KEY = /Query binding: (?<key>.+)\.$/u;

export const queryStateCensus = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "query-state-census-"));
  const config = path.join(directory, "oxlint.config.ts");
  const report = path.join(directory, "report.json");
  const sources = Bun.spawnSync(
    ["rg", "--files", "apps/web/src", "-g", "*.ts", "-g", "*.tsx"],
    { cwd: ROOT },
  );
  if (sources.exitCode !== 0) {
    panic("Cannot enumerate web query source files");
  }
  for (const file of sources.stdout.toString().trim().split("\n")) {
    const source = readFileSync(path.join(ROOT, file), "utf-8");
    if (
      !source.includes("@tanstack/react-query") &&
      !source.includes("use-chrome-query")
    ) {
      continue;
    }
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    // Suppressions must not remove entries from the enumerating pass. Renaming
    // directive tokens preserves syntax and source locations in scratch copies.
    writeFileSync(
      destination,
      source.replaceAll(
        /\b(?:oxlint|eslint)-(?:disable|enable)\b/gu,
        "query-census-directive",
      ),
    );
  }
  writeFileSync(
    config,
    `export default ${JSON.stringify({ categories: { correctness: "off" }, jsPlugins: [path.join(ROOT, ".oxlint-plugins", `${RULE}.ts`)], rules: { [`${RULE}/${RULE}`]: ["error", { census: true }] } })};\n`,
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      path.join(ROOT, "node_modules/oxlint/bin/oxlint"),
      "-c",
      config,
      "--format=json",
      "apps/web/src",
    ],
    { cwd: directory, stdout: Bun.file(report), stderr: "pipe" },
  );
  const output = readFileSync(report, "utf-8");
  rmSync(directory, { recursive: true, force: true });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(`Query state census failed: ${result.stderr.toString()}`);
  }
  if (!output.trim()) {
    panic(`Query state census produced no report: ${result.stderr.toString()}`);
  }
  const diagnostics = v.parse(OUTPUT, JSON.parse(output)).diagnostics;
  return diagnostics
    .map((diagnostic) => {
      if (!diagnostic.code.startsWith(`${RULE}(`)) {
        panic(`Unexpected query state diagnostic: ${diagnostic.code}`);
      }
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
    .toSorted((left, right) => left.key.localeCompare(right.key));
};

type QueryStateBaselineComparison = {
  observed: readonly string[];
  recorded: readonly string[];
  committed: readonly string[] | null;
};

export const queryStateBaselineDifference = ({
  observed,
  recorded,
  committed,
}: QueryStateBaselineComparison) => {
  const actual = new Set(observed);
  const expected = new Set(recorded);
  return {
    added: [...actual].filter((key) => !expected.has(key)).toSorted(),
    stale: [...expected].filter((key) => !actual.has(key)).toSorted(),
    duplicates: observed.filter(
      (key, index) => observed.indexOf(key) !== index,
    ),
    grown:
      committed === null
        ? []
        : recorded.filter((key) => !committed.includes(key)).toSorted(),
  };
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
  const difference = queryStateBaselineDifference({
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
