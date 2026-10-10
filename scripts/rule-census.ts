// Shared census and exact-set comparison for baselines enumerated by an
// oxlint rule in census mode (query-data-state, failure-as-empty). The census
// lints scratch copies with suppression directives renamed, so a suppression
// cannot hide an entry from the enumerating pass.
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

const ROOT = path.resolve(import.meta.dir, "..");

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

type RuleCensusOptions = {
  /** The rule id, also the plugin file name under `.oxlint-plugins/`. */
  rule: string;
  /** Repository-relative files to copy into the scratch tree. */
  files: readonly string[];
  /** The path oxlint lints, relative to the scratch tree. */
  lintTarget: string;
  /** Names the census in temp directories and failure messages. */
  label: string;
};

export type RuleCensusDiagnostic = v.InferOutput<
  typeof OUTPUT
>["diagnostics"][number];

/** Every diagnostic the rule reports in census mode over `files`. */
export const ruleCensusDiagnostics = ({
  rule,
  files,
  lintTarget,
  label,
}: RuleCensusOptions): RuleCensusDiagnostic[] => {
  const directory = mkdtempSync(path.join(tmpdir(), `${label}-census-`));
  const config = path.join(directory, "oxlint.config.ts");
  const report = path.join(directory, "report.json");
  for (const file of files) {
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    // Renaming directive tokens preserves syntax and source locations.
    writeFileSync(
      destination,
      readFileSync(path.join(ROOT, file), "utf-8").replaceAll(
        /\b(?:oxlint|eslint)-(?:disable|enable)\b/gu,
        "census-directive",
      ),
    );
  }
  writeFileSync(
    config,
    `export default ${JSON.stringify({ categories: { correctness: "off" }, jsPlugins: [path.join(ROOT, ".oxlint-plugins", `${rule}.ts`)], rules: { [`${rule}/${rule}`]: ["error", { census: true }] } })};\n`,
  );
  const { result, output } = (() => {
    try {
      const spawned = Bun.spawnSync(
        [
          process.execPath,
          "--bun",
          path.join(ROOT, "node_modules/oxlint/bin/oxlint"),
          "-c",
          config,
          "--format=json",
          lintTarget,
        ],
        { cwd: directory, stdout: Bun.file(report), stderr: "pipe" },
      );
      return { result: spawned, output: readFileSync(report, "utf-8") };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })();
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(`${label} census failed: ${result.stderr.toString()}`);
  }
  if (!output.trim()) {
    panic(`${label} census produced no report: ${result.stderr.toString()}`);
  }
  const { diagnostics } = v.parse(OUTPUT, JSON.parse(output));
  for (const diagnostic of diagnostics) {
    if (!diagnostic.code.startsWith(`${rule}(`)) {
      panic(`Unexpected ${label} diagnostic: ${diagnostic.code}`);
    }
  }
  return diagnostics;
};

type ExactSetComparison = {
  observed: readonly string[];
  recorded: readonly string[];
  committed: readonly string[] | null;
};

/**
 * How an observed key set differs from the recorded baseline, and which
 * recorded keys the committed base revision lacks (the baseline grew).
 */
export const exactSetDifference = ({
  observed,
  recorded,
  committed,
}: ExactSetComparison) => {
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
