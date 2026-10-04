// Enumerate failure-as-empty sites with the production rule and hold them to
// an exact-set baseline that only shrinks, like the query-state baseline: new
// sites fail, migrated sites must be removed, and the committed key set may
// not grow against the base revision. The adapter read-fault baseline (driven
// by read-fault-guard.test.ts) is held to the same no-growth rule here.
//
// Check:      bun scripts/failure-as-empty-baseline.ts --check
// Regenerate: bun scripts/failure-as-empty-baseline.ts --write
//   (drops migrated entries; seeds a reason per new key only while the base
//   revision has no committed baseline)
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
const BASELINE = BASELINE_PATHS.failureAsEmpty;
const FAULT_BASELINE = BASELINE_PATHS.caseLawReadFault;
const RULE = "no-failure-as-empty";
const SOURCE_PATTERNS = [
  "apps/api/src/**/*.ts",
  "packages/*/src/**/*.ts",
  "packages/*/src/**/*.tsx",
];
const TEST_SOURCE =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|__tests__|__fixtures__)\/)/u;
// A site needs one of these tokens; other files cannot match the rule.
const CANDIDATE = /\bcatch\b|\.ok\b|\bstatus(?:Code)?\b|\bisErr(?:or)?\b/u;
const ADAPTERS = "apps/api/src/handlers/case-law/ingestion/adapters/";

const OUTPUT = v.object({
  diagnostics: v.array(
    v.object({
      code: v.string(),
      message: v.string(),
      filename: v.string(),
    }),
  ),
});
const BASELINE_SCHEMA = v.object({
  entries: v.record(v.string(), v.pipe(v.string(), v.nonEmpty())),
});
const FAULT_BASELINE_SCHEMA = v.object({
  rows: v.record(v.string(), v.pipe(v.string(), v.nonEmpty())),
});
const KEY = /Failure-as-empty site: (?<key>.+)\.$/u;

export const failureAsEmptyCensus = (): string[] => {
  const directory = mkdtempSync(path.join(tmpdir(), "failure-as-empty-"));
  const config = path.join(directory, "oxlint.config.ts");
  const report = path.join(directory, "report.json");
  const sources = Bun.spawnSync(["git", "ls-files", "--", ...SOURCE_PATTERNS], {
    cwd: ROOT,
  });
  if (sources.exitCode !== 0) {
    panic("Cannot enumerate failure-as-empty source files");
  }
  for (const file of sources.stdout.toString().trim().split("\n")) {
    if (!file || TEST_SOURCE.test(file) || file.endsWith(".d.ts")) {
      continue;
    }
    const source = readFileSync(path.join(ROOT, file), "utf-8");
    if (!CANDIDATE.test(source)) {
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
        "failure-census-directive",
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
      ".",
    ],
    { cwd: directory, stdout: Bun.file(report), stderr: "pipe" },
  );
  const output = readFileSync(report, "utf-8");
  rmSync(directory, { recursive: true, force: true });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    panic(`Failure-as-empty census failed: ${result.stderr.toString()}`);
  }
  if (!output.trim()) {
    panic(
      `Failure-as-empty census produced no report: ${result.stderr.toString()}`,
    );
  }
  return v
    .parse(OUTPUT, JSON.parse(output))
    .diagnostics.map((diagnostic) => {
      if (!diagnostic.code.startsWith(`${RULE}(`)) {
        panic(`Unexpected failure-as-empty diagnostic: ${diagnostic.code}`);
      }
      return (
        KEY.exec(diagnostic.message)?.groups?.["key"] ??
        panic(`Failure-as-empty diagnostic has no key: ${diagnostic.message}`)
      );
    })
    .toSorted();
};

type BaselineComparison = {
  observed: readonly string[];
  recorded: readonly string[];
  committed: readonly string[] | null;
};

export const failureAsEmptyDifference = ({
  observed,
  recorded,
  committed,
}: BaselineComparison) => {
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

/** The reason a seeded entry carries: who migrates it, and to what. */
export const seededReason = (key: string): string =>
  key.startsWith(ADAPTERS)
    ? "Case-law publisher read pending migration to readPublisher."
    : "Existing site pending review: return a ReadOutcome or propagate the failure.";

const git = (args: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return result.exitCode === 0 ? result.stdout.toString() : null;
};

/** The committed keys at the base revision, or null when it has no file. */
const committedKeys = (
  baseRevision: string,
  file: string,
  keysOf: (json: unknown) => string[],
): string[] | null => {
  const listed = git(["ls-tree", "--name-only", baseRevision, "--", file]);
  if (listed === null) {
    return panic(`Cannot inspect the committed ${file}`);
  }
  if (!listed.trim()) {
    return null;
  }
  const content =
    git(["show", `${baseRevision}:${file}`]) ??
    panic(`Cannot read the committed ${file}`);
  return keysOf(JSON.parse(content));
};

if (import.meta.main) {
  const explicitBase = process.env["BASE_SHA"];
  const baseRevision = (
    git(
      explicitBase
        ? ["rev-parse", "--verify", `${explicitBase}^{commit}`]
        : ["merge-base", "HEAD", "origin/main"],
    ) ?? panic("Cannot resolve the failure-as-empty baseline base revision")
  ).trim();

  // The read-fault rows are observed by their test; here they may only shrink.
  const faultRows = Object.keys(
    v.parse(
      FAULT_BASELINE_SCHEMA,
      JSON.parse(readFileSync(path.join(ROOT, FAULT_BASELINE), "utf-8")),
    ).rows,
  );
  const committedFaultRows = committedKeys(
    baseRevision,
    FAULT_BASELINE,
    (json) => Object.keys(v.parse(FAULT_BASELINE_SCHEMA, json).rows),
  );
  const grownFaultRows =
    committedFaultRows === null
      ? []
      : faultRows.filter((key) => !committedFaultRows.includes(key));

  const observed = failureAsEmptyCensus();
  const baseline = v.parse(
    BASELINE_SCHEMA,
    JSON.parse(readFileSync(path.join(ROOT, BASELINE), "utf-8")),
  );
  const committed = committedKeys(baseRevision, BASELINE, (json) =>
    Object.keys(v.parse(BASELINE_SCHEMA, json).entries),
  );
  const difference = failureAsEmptyDifference({
    observed,
    recorded: Object.keys(baseline.entries),
    committed,
  });
  const seeding = process.argv.includes("--write") && committed === null;
  if (
    (!seeding && difference.added.length > 0) ||
    difference.duplicates.length > 0 ||
    difference.grown.length > 0 ||
    grownFaultRows.length > 0
  ) {
    process.stderr.write(
      `Failure-as-empty baselines cannot grow. Return a ReadOutcome or propagate the failure.\n${[
        ...difference.added.map((key) => `New: ${key}`),
        ...difference.duplicates.map((key) => `Duplicate key: ${key}`),
        ...difference.grown.map((key) => `Added baseline key: ${key}`),
        ...grownFaultRows.map((key) => `Added read-fault row: ${key}`),
      ].join("\n")}\n`,
    );
    process.exit(1);
  }
  if (process.argv.includes("--write")) {
    const entries = Object.fromEntries(
      [...new Set(observed)].map((key) => [
        key,
        baseline.entries[key] ?? seededReason(key),
      ]),
    );
    writeFileSync(
      path.join(ROOT, BASELINE),
      `${JSON.stringify({ entries }, null, 2)}\n`,
    );
  } else if (difference.stale.length > 0) {
    process.stderr.write(
      `Remove migrated failure-as-empty entries with bun scripts/failure-as-empty-baseline.ts --write:\n${difference.stale.join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Failure-as-empty baseline: ${String(observed.length)} sites, exact set verified; read-fault rows: ${String(faultRows.length)}.\n`,
  );
}
