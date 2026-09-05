// Typecheck-cost baseline guard.
//
// Type-instantiation cost in hot generic paths (the Eden treaty surface,
// TanStack route trees, query options) is treated as a budget by the repo
// conventions — prefer `satisfies` over annotation, pass `from` to router
// hooks, `select` on queries — but nothing measures it. What silently rots is
// the compiler's workload: one annotation-heavy pattern or an inference
// explosion in a widely-instantiated generic lands as "typecheck got slow"
// weeks later, with no diff to point at. Lint and tests see none of it.
//
// This runs the native tsc (tsgo, via packages/scripts/src/tsc-native.ts)
// with --extendedDiagnostics and --singleThreaded per project, then guards the
// deterministic size counters against a committed baseline. Native tsc uses
// independent checker-local caches in parallel mode and assigns files to those
// checkers by position. Adding an otherwise inert root file can repartition the
// project and change aggregate Types/Instantiations substantially, so parallel
// diagnostics are unsuitable as a comparable cost metric. Memory and time
// fields still wobble; they are printed for context but never gated.
//
// Modes:
//   bun scripts/typecheck-baseline.ts                  report per-project counters
//   bun scripts/typecheck-baseline.ts --write-baseline regenerate the baseline
//   bun scripts/typecheck-baseline.ts --check          CI gate (exit 1 on regression)
//   bun scripts/typecheck-baseline.ts --self-test      prove parser + comparison logic
//
// CI-only by design: it re-runs full typechecks (tens of seconds), too slow
// for the local lint/pre-commit loop. Wired into .github/workflows/ci.yml as
// its own typecheck-baseline job, parallel to the turbo typecheck job.

import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BASELINE_PATHS } from "./baseline-paths";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const BASELINE_REL = BASELINE_PATHS.typecheck;
const BASELINE_PATH = path.resolve(REPO_ROOT, BASELINE_REL);
const TSC_NATIVE = "packages/scripts/src/tsc-native.ts";
const WRITE_HINT = "bun scripts/typecheck-baseline.ts --write-baseline";
const COLD_MEASUREMENT_FLAGS = ["--incremental", "false"] as const;
const MEASUREMENT_FLAGS = [
  "--noEmit",
  "--extendedDiagnostics",
  "--singleThreaded",
  ...COLD_MEASUREMENT_FLAGS,
] as const;
const CLI_MODES = [
  { flag: "--check", mode: "check" },
  { flag: "--self-test", mode: "self-test" },
  { flag: "--write-baseline", mode: "write-baseline" },
] as const;
const CLI_MODE_FLAGS = CLI_MODES.map(({ flag }) => flag);

type CliMode = "report" | (typeof CLI_MODES)[number]["mode"];
type CliParseResult =
  | { ok: true; mode: CliMode }
  | { ok: false; error: string };

const parseCliMode = (args: readonly string[]): CliParseResult => {
  if (args.length === 0) {
    return { ok: true, mode: "report" };
  }
  const argument = args.at(0);
  const selected = CLI_MODES.find(({ flag }) => flag === argument);
  if (args.length === 1 && selected !== undefined) {
    return { ok: true, mode: selected.mode };
  }
  return {
    ok: false,
    error:
      "typecheck-baseline: expected no arguments or exactly one of " +
      `${CLI_MODE_FLAGS.join(", ")}; received ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
  };
};

// One entry per tsconfig project the repo typechecks in CI. Fixed schema
// (like bundle-baseline's GROUP_KEYS): a new project must be added here
// deliberately, and a stale baseline key is a guarded event, not noise.
//
// Scope is deliberately the two hot apps plus the web e2e project, not every
// workspace: packages are leaves whose types are instantiated inside the app
// checks (a package-level explosion surfaces in the consumer's counters),
// and each additional project adds a full typecheck to the guard's CI cost.
// Add a project only when its own check time becomes a pain point.
const PROJECTS = [
  { id: "api", project: "apps/api" },
  { id: "web", project: "apps/web" },
  { id: "web-e2e", project: "apps/web/e2e/tsconfig.json" },
] as const;

type ProjectId = (typeof PROJECTS)[number]["id"];

// The gated counters. In single-threaded mode both are fully deterministic for
// a given commit and lockfile; growth here is type work, not checker-pool
// partition noise.
const GATED_FIELDS = ["types", "instantiations"] as const;

type GatedField = (typeof GATED_FIELDS)[number];
type Counters = Record<GatedField, number>;
type Baseline = Record<ProjectId, Counters>;

// A project may grow by up to this factor before CI fails. Normal feature
// work adds types; this guard exists to catch explosions (an inference
// blow-up multiplies instantiations, it does not add 3%), so the headroom is
// generous enough that routine PRs never think about it.
const HEADROOM = 1.05;
// For small projects (web-e2e) a percentage alone is twitchy: a handful of
// new e2e specs could trip 5%. Allow at least this much absolute growth; a
// real explosion adds millions of instantiations and still fails.
const HEADROOM_FLOOR: Counters = {
  types: 20_000,
  instantiations: 100_000,
};
// Below this factor the win is worth locking in: prompt (do not fail) to
// re-baseline so the improvement can never silently regress back.
const RATCHET_DOWN = 0.95;

// --- Running tsc -------------------------------------------------------------

// tsc processes are memory-hungry; run projects strictly one at a time, same
// reason scripts/verify.sh serializes typecheck tasks (--concurrency=1). The
// measurement itself also uses one checker so its counters remain comparable.
type RunResult =
  | { ok: true; diagnostics: string }
  | { ok: false; error: string };

const runProject = (project: string): RunResult => {
  const proc = Bun.spawnSync(
    [process.execPath, TSC_NATIVE, "-p", project, ...MEASUREMENT_FLAGS],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const stdout = proc.stdout.toString();
  if (proc.exitCode !== 0) {
    return {
      ok: false,
      error:
        `tsc failed for ${project} (exit ${proc.exitCode}). The baseline guard\n` +
        "only measures a GREEN typecheck; fix the type errors first (`bun run\n" +
        `typecheck\`), then re-run this guard.\n\n${stdout}${proc.stderr.toString()}`,
    };
  }
  return { ok: true, diagnostics: stdout };
};

// --- Parsing -----------------------------------------------------------------
// --extendedDiagnostics emits `Label:   value` lines; sizes are plain
// integers, memory has a K suffix, times an s suffix.

const diagnosticField = (diagnostics: string, label: string): number | null => {
  const match = new RegExp(`^${label}:\\s+([\\d.]+)`, "mu").exec(diagnostics);
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  return Number(raw);
};

type ParseResult =
  | { ok: true; counters: Counters }
  | { ok: false; error: string };

const parseCounters = (diagnostics: string, project: string): ParseResult => {
  const types = diagnosticField(diagnostics, "Types");
  const instantiations = diagnosticField(diagnostics, "Instantiations");
  if (types === null || instantiations === null) {
    return {
      ok: false,
      error:
        `Could not find Types/Instantiations in --extendedDiagnostics output\n` +
        `for ${project}. Did the tsgo output format change? Output was:\n\n${diagnostics}`,
    };
  }
  return { ok: true, counters: { types, instantiations } };
};

// Context printed alongside the gated counters; never compared.
const ungatedSummary = (diagnostics: string): string => {
  const files = diagnosticField(diagnostics, "Files");
  const lines = diagnosticField(diagnostics, "Lines");
  const check = diagnosticField(diagnostics, "Check time");
  const memory = diagnosticField(diagnostics, "Memory used");
  const memoryMib = memory === null ? "?" : `${Math.round(memory / 1024)} MiB`;
  return `${files ?? "?"} files, ${lines ?? "?"} lines, check ${check ?? "?"}s, ${memoryMib}`;
};

// --- Measurement -------------------------------------------------------------

type Measured = { id: ProjectId; counters: Counters; context: string };
type MeasureResult =
  | { ok: true; measured: Measured[] }
  | { ok: false; error: string };

const measureAll = (): MeasureResult => {
  const measured: Measured[] = [];
  for (const { id, project } of PROJECTS) {
    console.log(`  typechecking ${project} ...`);
    const run = runProject(project);
    if (!run.ok) {
      return { ok: false, error: run.error };
    }
    const parsed = parseCounters(run.diagnostics, project);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    measured.push({
      id,
      counters: parsed.counters,
      context: ungatedSummary(run.diagnostics),
    });
  }
  return { ok: true, measured };
};

// --- Baseline IO -------------------------------------------------------------

const emptyCounters = (): Counters => ({ types: 0, instantiations: 0 });

const writeBaseline = (measured: Measured[]): void => {
  // Spelled out per project so the committed JSON has a stable key order.
  const baseline: Record<string, Counters> = {};
  for (const { id } of PROJECTS) {
    const entry = measured.find((m) => m.id === id);
    baseline[id] = entry?.counters ?? emptyCounters();
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
};

const readBaseline = (): Baseline => {
  const parsed: Record<string, Partial<Counters>> = JSON.parse(
    readFileSync(BASELINE_PATH, "utf-8"),
  );
  const baseline = {
    api: emptyCounters(),
    web: emptyCounters(),
    "web-e2e": emptyCounters(),
  };
  for (const { id } of PROJECTS) {
    baseline[id] = {
      types: parsed[id]?.types ?? 0,
      instantiations: parsed[id]?.instantiations ?? 0,
    };
  }
  return baseline;
};

const baselineExists = (): boolean => {
  try {
    readFileSync(BASELINE_PATH, "utf-8");
    return true;
  } catch {
    return false;
  }
};

// --- Comparison (the guarded logic the self-test exercises) ------------------

type FieldStatus = "ok" | "regressed" | "dropped";

const compareField = (
  field: GatedField,
  current: number,
  baseline: number,
): FieldStatus => {
  if (baseline === 0) {
    // No baseline for this project yet (new PROJECTS entry): any measured
    // work must be acknowledged with a --write-baseline.
    return current > 0 ? "regressed" : "ok";
  }
  if (
    current > Math.max(baseline * HEADROOM, baseline + HEADROOM_FLOOR[field])
  ) {
    return "regressed";
  }
  if (current < baseline * RATCHET_DOWN) {
    return "dropped";
  }
  return "ok";
};

type FieldDiff = {
  id: ProjectId;
  field: GatedField;
  status: FieldStatus;
  current: number;
  baseline: number;
};

const diffAll = (measured: Measured[], baseline: Baseline): FieldDiff[] => {
  const diffs: FieldDiff[] = [];
  for (const m of measured) {
    for (const field of GATED_FIELDS) {
      diffs.push({
        id: m.id,
        field,
        status: compareField(field, m.counters[field], baseline[m.id][field]),
        current: m.counters[field],
        baseline: baseline[m.id][field],
      });
    }
  }
  return diffs;
};

// --- Formatting ---------------------------------------------------------------

const pct = (current: number, baseline: number): string => {
  if (baseline === 0) {
    return current === 0 ? "0%" : "new";
  }
  const delta = ((current - baseline) / baseline) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
};

const n = (value: number): string => value.toLocaleString("en-US");

const formatCheckMeasurement = (m: Measured, baseline: Baseline): string =>
  `typecheck-baseline: ${m.id} types ${n(m.counters.types)} ` +
  `(${pct(m.counters.types, baseline[m.id].types)}), instantiations ` +
  `${n(m.counters.instantiations)} ` +
  `(${pct(m.counters.instantiations, baseline[m.id].instantiations)})`;

// --- Modes --------------------------------------------------------------------

const runReport = (): number => {
  const result = measureAll();
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  const hasBaseline = baselineExists();
  const baseline = hasBaseline ? readBaseline() : null;

  console.log("\ntypecheck cost (tsgo --extendedDiagnostics)\n");
  for (const m of result.measured) {
    console.log(`  ${m.id}  (${m.context})`);
    for (const field of GATED_FIELDS) {
      const b = baseline?.[m.id][field];
      const suffix =
        b === undefined
          ? ""
          : `  (baseline ${n(b)}, ${pct(m.counters[field], b)})`;
      console.log(
        `    ${field.padEnd(16)} ${n(m.counters[field]).padStart(12)}${suffix}`,
      );
    }
  }
  if (!hasBaseline) {
    console.log(`\nNo baseline yet. Seed one with \`${WRITE_HINT}\`.`);
  }
  return 0;
};

const runWrite = (): number => {
  const result = measureAll();
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  writeBaseline(result.measured);
  console.log(`Wrote typecheck baseline to ${BASELINE_REL}:`);
  for (const m of result.measured) {
    console.log(
      `  ${m.id.padEnd(8)} types ${n(m.counters.types).padStart(12)}   instantiations ${n(m.counters.instantiations).padStart(12)}`,
    );
  }
  return 0;
};

const runCheck = (): number => {
  if (!baselineExists()) {
    console.error(
      `Missing ${BASELINE_REL}. Seed it with \`${WRITE_HINT}\` and commit it\n` +
        "before enabling the check.",
    );
    return 1;
  }
  const result = measureAll();
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }

  const baseline = readBaseline();
  const diffs = diffAll(result.measured, baseline);
  const regressions = diffs.filter((d) => d.status === "regressed");
  const drops = diffs.filter((d) => d.status === "dropped");

  for (const m of result.measured) {
    console.log(formatCheckMeasurement(m, baseline));
  }

  for (const d of drops) {
    console.log(
      `typecheck-baseline: ${d.id} ${d.field} shrank ${n(d.baseline)} -> ` +
        `${n(d.current)} (${pct(d.current, d.baseline)}). Nice — run ` +
        `\`${WRITE_HINT}\` and commit ${BASELINE_REL} to lock it in.`,
    );
  }

  if (regressions.length === 0) {
    console.log(
      `typecheck-baseline --check: OK. ${PROJECTS.length} project(s) within ` +
        `${Math.round((HEADROOM - 1) * 100)}% of baseline.`,
    );
    return 0;
  }

  console.error(
    "\ntypecheck-baseline --check: compiler workload grew past the baseline:\n",
  );
  for (const d of regressions) {
    console.error(
      `  ${d.id} ${d.field}: ${n(d.baseline)} -> ${n(d.current)} ` +
        `(${pct(d.current, d.baseline)})`,
    );
  }
  console.error(
    `\nAllowed headroom is ${Math.round((HEADROOM - 1) * 100)}% over baseline. ` +
      "This usually means a new\n" +
      "annotation-heavy or inference-exploding pattern in a hot generic path\n" +
      "(Eden surface, route tree, query options). The usual fixes: validate\n" +
      "with `as const satisfies T` instead of a `: T` annotation, pass `from`\n" +
      "to useParams/useSearch/Link, use `select` on router/query hooks, and\n" +
      "never pass explicit type arguments to inference-driven hooks. If the\n" +
      `growth is genuinely justified, run \`${WRITE_HINT}\`\n` +
      `and commit ${BASELINE_REL} with a rationale in your PR.`,
  );
  return 1;
};

// --- Self-test ----------------------------------------------------------------
// Prove the two load-bearing pieces without running tsc: the parser extracts
// exact numbers from a REAL captured tsgo output, and the comparison fires on
// an explosion while ignoring routine growth within the headroom.

// Verbatim tsgo 7.0.2 output from
// `-p apps/api --noEmit --extendedDiagnostics --singleThreaded`.
const SELF_TEST_DIAGNOSTICS = [
  "Files:              7107",
  "Lines:           1137044",
  "Identifiers:     1323604",
  "Symbols:         2812488",
  "Types:            911491",
  "Instantiations:  4879903",
  "Memory used:    1719495K",
  "Memory allocs:  15739381",
  "Config time:      0.024s",
  "Parse time:       3.981s",
  "Bind time:        1.482s",
  "Check time:      50.673s",
  "Emit time:        0.006s",
  "Total time:      56.202s",
].join("\n");

const runSelfTest = (): number => {
  const failures: string[] = [];

  const reportMode = parseCliMode([]);
  if (!reportMode.ok || reportMode.mode !== "report") {
    failures.push("CLI parser did not select report mode for no arguments");
  }
  for (const { flag, mode } of CLI_MODES) {
    const parsedMode = parseCliMode([flag]);
    if (!parsedMode.ok || parsedMode.mode !== mode) {
      failures.push(`CLI parser did not select ${mode}`);
    }
    for (const secondFlag of CLI_MODE_FLAGS) {
      if (parseCliMode([flag, secondFlag]).ok) {
        failures.push(
          `CLI parser accepted conflicting modes: ${flag} ${secondFlag}`,
        );
      }
    }
  }
  if (parseCliMode(["--not-a-real-option"]).ok) {
    failures.push("CLI parser accepted an unknown option");
  }

  if (!MEASUREMENT_FLAGS.includes("--singleThreaded")) {
    failures.push("measurement flags allow checker-pool partition noise");
  }
  if (
    !MEASUREMENT_FLAGS.join("\0").includes(COLD_MEASUREMENT_FLAGS.join("\0"))
  ) {
    failures.push("measurement flags allow warm incremental state");
  }

  const parsed = parseCounters(SELF_TEST_DIAGNOSTICS, "apps/api");
  if (!parsed.ok) {
    failures.push("parser rejected a real tsgo diagnostics output");
  } else {
    if (parsed.counters.types !== 911_491) {
      failures.push(`parsed types = ${parsed.counters.types}, want 911491`);
    }
    if (parsed.counters.instantiations !== 4_879_903) {
      failures.push(
        `parsed instantiations = ${parsed.counters.instantiations}, want 4879903`,
      );
    }
  }
  if (diagnosticField(SELF_TEST_DIAGNOSTICS, "Check time") !== 50.673) {
    failures.push("Check time did not parse as 50.673");
  }
  const missing = parseCounters("Files: 12\n", "apps/api");
  if (missing.ok) {
    failures.push("parser accepted output missing Types/Instantiations");
  }

  const expectStatus = (
    label: string,
    field: GatedField,
    current: number,
    baseline: number,
    expected: FieldStatus,
  ) => {
    const actual = compareField(field, current, baseline);
    if (actual !== expected) {
      failures.push(`${label}: compareField = ${actual}, want ${expected}`);
    }
  };
  // An inference explosion (x2) MUST fail.
  expectStatus(
    "explosion",
    "instantiations",
    18_000_000,
    9_000_000,
    "regressed",
  );
  // Routine feature growth inside 5% must pass.
  expectStatus("routine-growth", "instantiations", 9_300_000, 9_000_000, "ok");
  // Small projects get an absolute floor: +15k types on a 100k project is
  // > 5% but under the floor — new specs, not an explosion.
  expectStatus("small-within-floor", "types", 115_000, 100_000, "ok");
  expectStatus("small-past-floor", "types", 130_000, 100_000, "regressed");
  // A real improvement is a ratchet-down prompt, not a failure.
  expectStatus("improvement", "types", 900_000, 1_000_000, "dropped");
  // A new PROJECTS entry with no baseline must be acknowledged.
  expectStatus("new-project", "types", 50_000, 0, "regressed");
  expectStatus("still-empty", "types", 0, 0, "ok");

  // The whole-run diff must isolate the exploding project+field.
  const baseline: Baseline = {
    api: { types: 1_000_000, instantiations: 9_000_000 },
    web: { types: 2_000_000, instantiations: 20_000_000 },
    "web-e2e": { types: 100_000, instantiations: 500_000 },
  };
  const measured: Measured[] = [
    {
      id: "api",
      counters: { types: 1_010_000, instantiations: 9_100_000 },
      context: "",
    },
    {
      id: "web",
      counters: { types: 2_010_000, instantiations: 44_000_000 },
      context: "",
    },
    {
      id: "web-e2e",
      counters: { types: 101_000, instantiations: 505_000 },
      context: "",
    },
  ];
  const regressed = diffAll(measured, baseline).filter(
    (d) => d.status === "regressed",
  );
  if (
    regressed.length !== 1 ||
    regressed.at(0)?.id !== "web" ||
    regressed.at(0)?.field !== "instantiations"
  ) {
    failures.push(
      `diffAll did not isolate the exploding field (got ${regressed
        .map((d) => `${d.id}.${d.field}`)
        .join(", ")})`,
    );
  }

  const measurementLines = measured.map((m) =>
    formatCheckMeasurement(m, baseline),
  );
  const expectedMeasurementLines = [
    "typecheck-baseline: api types 1,010,000 (+1.0%), instantiations 9,100,000 (+1.1%)",
    "typecheck-baseline: web types 2,010,000 (+0.5%), instantiations 44,000,000 (+120.0%)",
    "typecheck-baseline: web-e2e types 101,000 (+1.0%), instantiations 505,000 (+1.0%)",
  ];
  if (
    measurementLines.length !== expectedMeasurementLines.length ||
    measurementLines.some(
      (line, index) => line !== expectedMeasurementLines.at(index),
    )
  ) {
    failures.push(
      `check measurement output mismatch (got ${measurementLines.join(" | ")})`,
    );
  }

  if (failures.length > 0) {
    console.error("typecheck-baseline --self-test: FAIL");
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    return 1;
  }
  console.log("typecheck-baseline --self-test: PASS");
  return 0;
};

// --- Entry --------------------------------------------------------------------

const main = (args: readonly string[]): number => {
  const parsed = parseCliMode(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  switch (parsed.mode) {
    case "report":
      return runReport();
    case "self-test":
      return runSelfTest();
    case "write-baseline":
      return runWrite();
    case "check":
      return runCheck();
    default: {
      parsed.mode satisfies never;
      return panic(`Unhandled mode: ${String(parsed.mode)}`);
    }
  }
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
