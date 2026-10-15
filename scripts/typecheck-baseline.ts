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
// with --extendedDiagnostics and --singleThreaded per project. CI compares the
// deterministic size counters with the merge base; nightly checks the committed
// cumulative budget. Native tsc uses independent checker-local caches in
// parallel mode and assigns files to checkers by position. Adding an otherwise
// inert root file can repartition the project and change aggregate
// Types/Instantiations substantially, so parallel
// diagnostics are unsuitable as a comparable cost metric. Memory and time
// fields still wobble; they are printed for context but never gated.
//
// Modes:
//   bun scripts/typecheck-baseline.ts                  report per-project counters
//   bun scripts/typecheck-baseline.ts --write-baseline regenerate the baseline
//   bun scripts/typecheck-baseline.ts --check          cumulative budget gate
//   bun scripts/typecheck-baseline.ts --measure ROOT FILE  write a measurement
//   bun scripts/typecheck-baseline.ts --check-delta FILE  gate against that measurement
//   bun scripts/typecheck-baseline.ts --self-test      prove parser + comparison logic
//
// Full measurements run in CI and the admitted workflow-derived verify command,
// outside the lint/pre-commit loop. CI owns a separate baseline job.

import { panic } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const CLI_MODE_FLAGS = [
  ...CLI_MODES.map(({ flag }) => flag),
  "--measure ROOT FILE",
  "--check-delta FILE",
];

type CliMode = "report" | (typeof CLI_MODES)[number]["mode"];
type CliParseResult =
  | { ok: true; mode: CliMode }
  | { ok: true; mode: "measure"; root: string; file: string }
  | { ok: true; mode: "check-delta"; file: string }
  | { ok: false; error: string };

const parseCliMode = (args: readonly string[]): CliParseResult => {
  if (args.length === 0) {
    return { ok: true, mode: "report" };
  }
  const argument = args.at(0);
  const firstPath = args.at(1);
  const secondPath = args.at(2);
  const selected = CLI_MODES.find(({ flag }) => flag === argument);
  if (args.length === 1 && selected !== undefined) {
    return { ok: true, mode: selected.mode };
  }
  if (
    args.length === 3 &&
    argument === "--measure" &&
    firstPath !== undefined &&
    secondPath !== undefined
  ) {
    return { ok: true, mode: "measure", root: firstPath, file: secondPath };
  }
  if (
    args.length === 2 &&
    argument === "--check-delta" &&
    firstPath !== undefined
  ) {
    return { ok: true, mode: "check-delta", file: firstPath };
  }
  return {
    ok: false,
    error:
      "typecheck-baseline: expected no arguments or one of " +
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

// A project may grow by up to this factor before the gate fails. Normal feature
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

const runProject = (project: string, repoRoot: string): RunResult => {
  const proc = Bun.spawnSync(
    [process.execPath, TSC_NATIVE, "-p", project, ...MEASUREMENT_FLAGS],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
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

// A project the change adds does not exist at its merge base; with
// absentAsEmpty the base measurement records it as zero instead of failing.
const measureAll = (
  repoRoot = REPO_ROOT,
  absentAsEmpty = false,
): MeasureResult => {
  const measured: Measured[] = [];
  for (const { id, project } of PROJECTS) {
    if (absentAsEmpty && !existsSync(path.join(repoRoot, project))) {
      console.log(`  ${project} is absent; recording zero`);
      continue;
    }
    console.log(`  typechecking ${project} ...`);
    const run = runProject(project, repoRoot);
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

const writeBaseline = (measured: Measured[], file = BASELINE_PATH): void => {
  // Spelled out per project so the committed JSON has a stable key order.
  const baseline: Record<string, Counters> = {};
  for (const { id } of PROJECTS) {
    const entry = measured.find((m) => m.id === id);
    baseline[id] = entry?.counters ?? emptyCounters();
  }
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
};

const readBaseline = (file = BASELINE_PATH): Baseline => {
  const parsed: Record<string, Partial<Counters>> = JSON.parse(
    readFileSync(file, "utf-8"),
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

// The single definition of "the gate fires above this". The drift report
// below reads the same function, so the headroom it prints can never disagree
// with the headroom that fails the build.
const gateLimit = (field: GatedField, baseline: number): number =>
  Math.max(baseline * HEADROOM, baseline + HEADROOM_FLOOR[field]);

export const compareField = (
  field: GatedField,
  current: number,
  baseline: number,
): FieldStatus => {
  if (baseline === 0) {
    // No baseline for this project yet (new PROJECTS entry): any measured
    // work must be acknowledged with a --write-baseline.
    return current > 0 ? "regressed" : "ok";
  }
  if (current > gateLimit(field, baseline)) {
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

export const diffAll = (
  measured: readonly Measured[],
  baseline: Baseline,
): FieldDiff[] => {
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

// A project with no base measurement is new in the change: the delta gate has
// nothing to compare it with, so only the committed budget covers it.
export const deltaDiffs = (
  measured: readonly Measured[],
  base: Baseline,
): FieldDiff[] =>
  diffAll(
    measured.filter(
      ({ id }) => base[id].types > 0 || base[id].instantiations > 0,
    ),
    base,
  );

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

// --- Baseline drift ------------------------------------------------------------
// The nightly gate reports the committed baseline's age and tightest remaining
// headroom so cumulative growth remains visible between baseline refreshes.

type BaselineAge = { sha: string; date: string; commits: number };

const gitOutput = (
  args: readonly string[],
  repoRoot = REPO_ROOT,
): string | null => {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    return null;
  }
  const output = proc.stdout.toString().trim();
  return output === "" ? null : output;
};

// Null whenever git cannot answer (no repository, shallow clone, export
// tarball): the headroom line still prints, only without the age.
export const readBaselineAge = (repoRoot = REPO_ROOT): BaselineAge | null => {
  if (
    gitOutput(["rev-parse", "--is-shallow-repository"], repoRoot) !== "false"
  ) {
    return null;
  }
  const written = gitOutput(
    ["log", "--format=%H %cs", "-1", "--", BASELINE_REL],
    repoRoot,
  );
  const fields = written?.split(" ");
  const sha = fields?.at(0);
  const date = fields?.at(1);
  if (sha === undefined || date === undefined) {
    return null;
  }
  // Number(null) is 0, so a failed rev-list would read as a fresh baseline:
  // reject the absent output before converting it.
  const counted = gitOutput(["rev-list", "--count", `${sha}..HEAD`], repoRoot);
  if (counted === null) {
    return null;
  }
  const commits = Number(counted);
  if (!Number.isFinite(commits)) {
    return null;
  }
  return { sha: sha.slice(0, 10), date, commits };
};

type Headroom = {
  id: ProjectId;
  field: GatedField;
  left: number;
  allowance: number;
};

const tightestHeadroom = (
  measured: readonly Measured[],
  baseline: Baseline,
): Headroom | null => {
  let tightest: Headroom | null = null;
  for (const m of measured) {
    for (const field of GATED_FIELDS) {
      const base = baseline[m.id][field];
      if (base === 0) {
        continue;
      }
      const limit = gateLimit(field, base);
      const candidate = {
        id: m.id,
        field,
        left: limit - m.counters[field],
        allowance: limit - base,
      };
      const tighter =
        tightest === null ||
        candidate.left / candidate.allowance <
          tightest.left / tightest.allowance;
      if (tighter) {
        tightest = candidate;
      }
    }
  }
  return tightest;
};

const formatDriftLine = (
  age: BaselineAge | null,
  tightest: Headroom | null,
): string | null => {
  if (tightest === null) {
    return null;
  }
  const consumed =
    ((tightest.allowance - tightest.left) / tightest.allowance) * 100;
  const ageText =
    age === null
      ? BASELINE_REL
      : `${BASELINE_REL} is ${n(age.commits)} commit(s) old ` +
        `(${age.sha}, ${age.date})`;
  return (
    `typecheck-baseline: ${ageText}; tightest headroom is ${tightest.id} ` +
    `${tightest.field}, ${n(Math.round(tightest.left))} of ` +
    `${n(Math.round(tightest.allowance))} left (${consumed.toFixed(1)}% ` +
    "consumed, main's own growth included)."
  );
};

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

const runMeasure = (root: string, file: string): number => {
  const result = measureAll(path.resolve(root), true);
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  writeBaseline(result.measured, file);
  console.log(`Wrote typecheck measurement to ${file}`);
  return 0;
};

const runDelta = (file: string): number => {
  const base = readBaseline(file);
  const result = measureAll();
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }

  const diffs = deltaDiffs(result.measured, base);
  for (const m of result.measured) {
    console.log(formatCheckMeasurement(m, base));
  }
  for (const d of diffs.filter((diff) => diff.status === "dropped")) {
    console.log(
      `typecheck-baseline: ${d.id} ${d.field} shrank ${n(d.baseline)} -> ` +
        `${n(d.current)} (${pct(d.current, d.baseline)}).`,
    );
  }
  const regressions = diffs.filter((diff) => diff.status === "regressed");
  if (regressions.length === 0) {
    console.log(
      "typecheck-baseline --check-delta: OK. Change is within headroom.",
    );
    return 0;
  }

  console.error(
    "\ntypecheck-baseline --check-delta: this change grew compiler workload past its base:",
  );
  for (const d of regressions) {
    console.error(
      `  ${d.id} ${d.field}: ${n(d.baseline)} -> ${n(d.current)} ` +
        `(${pct(d.current, d.baseline)})`,
    );
  }
  console.error(
    `\nAllowed growth is ${Math.round((HEADROOM - 1) * 100)}% or the field's ` +
      "absolute floor, whichever is larger. Review the added type work.",
  );
  return 1;
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

  const drift = formatDriftLine(
    readBaselineAge(),
    tightestHeadroom(result.measured, baseline),
  );
  if (drift !== null) {
    console.log(drift);
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
        "their cumulative budgets.",
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
  const measureMode = parseCliMode(["--measure", "/base", "/output.json"]);
  if (
    !measureMode.ok ||
    measureMode.mode !== "measure" ||
    measureMode.root !== "/base" ||
    measureMode.file !== "/output.json"
  ) {
    failures.push("CLI parser did not select measure mode with its paths");
  }
  const deltaMode = parseCliMode(["--check-delta", "/base.json"]);
  if (
    !deltaMode.ok ||
    deltaMode.mode !== "check-delta" ||
    deltaMode.file !== "/base.json"
  ) {
    failures.push("CLI parser did not select delta mode with its path");
  }
  if (parseCliMode(["--measure", "/base"]).ok) {
    failures.push("CLI parser accepted an incomplete measure mode");
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

  // The headroom the drift line prints is the gate's own limit: exactly at it
  // still passes, one past it fails. This is what keeps the report honest if
  // HEADROOM or the floor ever moves.
  const typesLimit = gateLimit("types", 1_000_000);
  if (compareField("types", typesLimit, 1_000_000) !== "ok") {
    failures.push("the gate fired at the limit the drift line calls zero left");
  }
  if (compareField("types", typesLimit + 1, 1_000_000) !== "regressed") {
    failures.push("the gate did not fire one past its own limit");
  }

  const tightest = tightestHeadroom(measured, baseline);
  if (tightest === null) {
    failures.push("tightestHeadroom picked nothing, want web.instantiations");
  } else if (tightest.id !== "web" || tightest.field !== "instantiations") {
    failures.push(
      `tightestHeadroom picked ${tightest.id}.${tightest.field}, want web.instantiations`,
    );
  }
  const driftLine = formatDriftLine(
    { sha: "a8c9cf89ef", date: "2026-09-07", commits: 302 },
    tightest,
  );
  const expectedDriftLine =
    `typecheck-baseline: ${BASELINE_REL} is 302 commit(s) old ` +
    "(a8c9cf89ef, 2026-09-07); tightest headroom is web instantiations, " +
    "-23,000,000 of 1,000,000 left (2400.0% consumed, main's own growth " +
    "included).";
  if (driftLine !== expectedDriftLine) {
    failures.push(`drift line mismatch (got ${String(driftLine)})`);
  }
  // No git (shallow clone, tarball): the headroom still reports, ageless.
  if (formatDriftLine(null, tightest)?.includes("commit(s) old") !== false) {
    failures.push("drift line claimed an age without git");
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
    case "measure":
      return runMeasure(parsed.root, parsed.file);
    case "check-delta":
      return runDelta(parsed.file);
    default: {
      parsed satisfies never;
      return panic(`Unhandled mode: ${JSON.stringify(parsed)}`);
    }
  }
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
