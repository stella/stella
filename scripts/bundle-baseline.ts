// Web bundle-size guard.
//
// The web app is a TanStack Start build. The client entry is a tiny bootstrap;
// what a cold visit really pays for is the Start manifest's `__root__`
// preloads: the entry and the chunks it imports statically, the largest of
// which (`vendor-tanstack`) carries the route tree and every route file. What
// silently rots is that initial graph: a page or a dependency that lands in
// it is paid on every cold visit, whichever page the visitor opened.
// Typecheck and lint see none of it.
//
// --check blocks on the startup gates (scripts/bundle-startup-gates.ts): the
// gzip of the initial chunks against the committed `initial` budget, the size
// of the eager pending views, page code in the initial chunks, and pages a
// route loads outside its manifest preloads. Worker-only groups appearing in
// the main bundle block too, because their budget is exactly zero. The
// duplicate-content guard (--check-duplicates) is a separate, blocking check:
// a chunk that carries the same large block twice is a build defect, not
// growth to weigh against a budget.
//
// The per-group gzip sizes, grouped the way apps/web/vite.config.ts's
// manualChunks names them, are a report: the default mode prints them against
// the committed numbers and scripts/perf-hotspots.ts ranks them. They do not
// gate; the initial graph is the number that does.
//
// Modes:
//   bun scripts/bundle-baseline.ts                    report groups + gzip sizes
//   bun scripts/bundle-baseline.ts --write-baseline    regenerate the groups and the initial budget
//   bun --preload ./scripts/offline-network-preload.ts scripts/bundle-baseline.ts --check
//                                                     startup gates + worker-only groups (blocking)
//   bun scripts/bundle-baseline.ts --check-duplicates  duplicate-content guard (blocking)
//   bun scripts/bundle-baseline.ts --self-test         prove the comparison logic fires
//
// CI-only by design: it needs a completed `bun --filter @stll/web build` first,
// so it is too slow for the local lint/pre-commit loop. Wired into
// .github/workflows/ci.yml's web-build job, right after "Build web".

import { panic } from "better-result";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { MCP_APPS } from "../packages/mcp-apps/src/manifest";
import { BASELINE_PATHS } from "./baseline-paths";
import { readStartupGraph } from "./bundle-startup-build";
import {
  evaluateStartup,
  initialGzipBytes,
  StartupLedgerSchema,
  startupSummary,
} from "./bundle-startup-gates";
import { assertOfflineCheckPreload } from "./offline-check-startup";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const BASELINE_REL = BASELINE_PATHS.bundle;
const BASELINE_PATH = path.resolve(REPO_ROOT, BASELINE_REL);
const DIST_REL = "apps/web/dist";
const DIST_DIR = path.resolve(REPO_ROOT, DIST_REL);
const ASSETS_REL = `${DIST_REL}/client/assets`;
const ASSETS_DIR = path.resolve(REPO_ROOT, ASSETS_REL);
const LEDGER_REL = "scripts/bundle-startup-ledger.json";
const LEDGER_PATH = path.resolve(REPO_ROOT, LEDGER_REL);
const SCAN_ENGINE_WASM = path.resolve(
  REPO_ROOT,
  "packages/scan-engine/generated/scan_engine_bg.wasm",
);
const WRITE_HINT = "bun scripts/bundle-baseline.ts --write-baseline";

// The MCP app budgets (--mcp-apps) may grow by up to this factor over their
// baseline before the check fails, or by HEADROOM_FLOOR_BYTES for a small
// one. The report mode uses the same tolerance to mark a group as grown.
const HEADROOM = 1.03;
const HEADROOM_FLOOR_BYTES = 1024;
// Below this factor the win is worth locking in: prompt (do not fail) to
// re-baseline so the lower size can never silently regress back up.
const RATCHET_DOWN = 0.97;

// Rolldown names emitted chunks `<name>-<hash>.js` with an 8-char content hash.
// Anchoring the hash length lets us match a named chunk exactly (`index`,
// `vendor-react`) without a route chunk that merely starts with the same text
// sneaking in.
const HASH = "[A-Za-z0-9_-]{8}";

// Named vendor chunks, exactly as apps/web/vite.config.ts's manualChunks emits
// them. `vendor-tanstack-server-fn` is route-lazy so a public server function
// does not inflate the core TanStack chunk preloaded on every visit. Two
// groups (vendor-anonymize-data, wasm-vendor) currently have no
// client-graph chunk because those deps load inside web workers, not the main
// bundle; they are tracked at 0 so that if one ever leaks into the client graph
// the guard fails.
const VENDOR_GROUPS = [
  "vendor-react",
  "vendor-tanstack",
  "vendor-tanstack-server-fn",
  "vendor-anonymize-data",
  "wasm-vendor",
  "vendor-graphs",
  "vendor-editor",
  "vendor-icons",
  "vendor-base-ui",
] as const;

// The full, fixed set of group keys. Keeping it fixed (rather than "whatever
// chunks happened to exist") gives the baseline a stable schema and makes a
// newly-appearing vendor chunk a visible event in the report.
const GROUP_KEYS = [
  "entry",
  "scan-engine-wasm",
  ...VENDOR_GROUPS,
  "routes",
  "largest-route",
  "total",
] as const;

type GroupKey = (typeof GROUP_KEYS)[number];
type VendorGroup = (typeof VENDOR_GROUPS)[number];
type Sizes = Record<GroupKey, number>;

const WORKER_ONLY_GROUPS = [
  "vendor-anonymize-data",
  "wasm-vendor",
] as const satisfies readonly GroupKey[];
type WorkerOnlyGroup = (typeof WORKER_ONLY_GROUPS)[number];
const WORKER_ENTRY = "apps/web/src/workers/anonymize-chat-worker.ts";

// --- Classification ---------------------------------------------------------
// Entry = the client bootstrap (`index-<hash>.js`, the __root__ script that
// calls hydrateRoot) plus the Rolldown module runtime (`rolldown-runtime-<hash>
// .js`) it imports. Both are loaded on every cold visit and are neither a
// vendor chunk nor a route chunk.
const INDEX_RE = new RegExp(`^index-${HASH}\\.js$`, "u");
const RUNTIME_RE = new RegExp(`^rolldown-runtime-${HASH}\\.js$`, "u");

const vendorRe = (name: VendorGroup): RegExp =>
  new RegExp(`^${name}-${HASH}\\.js$`, "u");

// Returns the group a client JS file belongs to. Everything that is not the
// entry or a named vendor chunk (route chunks, locale chunks, workers, the big
// lazy `global-*` chunk, pdf/katex, ...) falls into the catch-all "routes".
const classifyChunk = (
  fileName: string,
  source = "",
): "entry" | VendorGroup | "routes" => {
  // Plugins may also emit `index-<hash>.js` assets (the anonymize WASM glue
  // does this). The real client bootstrap imports the named React vendor
  // chunk, which distinguishes it from those unrelated index assets.
  if (
    RUNTIME_RE.test(fileName) ||
    (INDEX_RE.test(fileName) && source.includes("vendor-react-"))
  ) {
    return "entry";
  }
  for (const name of VENDOR_GROUPS) {
    if (vendorRe(name).test(fileName)) {
      return name;
    }
  }
  return "routes";
};

// --- Measurement ------------------------------------------------------------

// Spelled out (not built in a loop) so the object is type-checked against
// Sizes without a cast; a new GROUP_KEYS entry fails compilation here. Keys
// are alphabetical because this literal's order is also the committed JSON's
// key order (see sortedSizes).
const emptySizes = (): Sizes => ({
  entry: 0,
  "largest-route": 0,
  routes: 0,
  "scan-engine-wasm": 0,
  total: 0,
  "vendor-anonymize-data": 0,
  "vendor-base-ui": 0,
  "vendor-editor": 0,
  "vendor-graphs": 0,
  "vendor-icons": 0,
  "vendor-react": 0,
  "vendor-tanstack": 0,
  "vendor-tanstack-server-fn": 0,
  "wasm-vendor": 0,
});

const gzipSize = (absPath: string): number =>
  Bun.gzipSync(readFileSync(absPath)).length;

// --- Duplicated content -----------------------------------------------------
// Rolldown inlines imported constants where they are used, with no size
// limit. A dependency that exports a large data string from its own module
// (tldts' public-suffix label table) was copied into its chunk once per use,
// and gzip cannot fold copies that sit further apart than its 32 KiB window.
// Size budgets only see such a copy as ordinary growth, so this measures it
// directly: every aligned window of a chunk that occurs again later in the
// same chunk counts as duplicated. Real chunks repeat at most ~20 KiB (theme
// strings, numeric tables); a copied data blob is far above the limit.
const DUPLICATE_WINDOW_BYTES = 2048;
const DUPLICATE_LIMIT_BYTES = 32 * 1024;

const duplicatedBytes = (content: Uint8Array): number => {
  const buffer = Buffer.from(
    content.buffer,
    content.byteOffset,
    content.byteLength,
  );
  let duplicated = 0;
  for (
    let start = 0;
    start + 2 * DUPLICATE_WINDOW_BYTES <= buffer.length;
    start += DUPLICATE_WINDOW_BYTES
  ) {
    const window = buffer.subarray(start, start + DUPLICATE_WINDOW_BYTES);
    if (buffer.includes(window, start + DUPLICATE_WINDOW_BYTES)) {
      duplicated += DUPLICATE_WINDOW_BYTES;
    }
  }
  return duplicated;
};

type DuplicatedChunk = { file: string; bytes: number };

type MeasureResult =
  | { ok: true; sizes: Sizes; duplicated: DuplicatedChunk[] }
  | { ok: false; error: string };

const measure = (assetsDir: string): MeasureResult => {
  if (!existsSync(assetsDir)) {
    return {
      ok: false,
      error:
        `No client JS found in ${ASSETS_REL}. Run \`bun --filter @stll/web build\`\n` +
        "first, then re-run this guard against the fresh dist/.",
    };
  }
  const files = [...new Bun.Glob("*.js").scanSync(assetsDir)];
  if (files.length === 0) {
    return {
      ok: false,
      error:
        `No client JS found in ${ASSETS_REL}. Run \`bun --filter @stll/web build\`\n` +
        "first, then re-run this guard against the fresh dist/.",
    };
  }

  const sizes = emptySizes();
  if (!existsSync(SCAN_ENGINE_WASM)) {
    return {
      ok: false,
      error:
        "No committed scan engine WebAssembly found. Run `bun --filter @stll/scan-engine build:wasm` first.",
    };
  }
  sizes["scan-engine-wasm"] = gzipSize(SCAN_ENGINE_WASM);
  let largestRoute = 0;
  const duplicated: DuplicatedChunk[] = [];

  for (const file of files) {
    const absPath = path.join(assetsDir, file);
    const content = readFileSync(absPath);
    const repeated = duplicatedBytes(content);
    if (repeated > DUPLICATE_LIMIT_BYTES) {
      duplicated.push({ file, bytes: repeated });
    }
    const gz = Bun.gzipSync(content).length;
    sizes.total += gz;
    const source = INDEX_RE.test(file) ? content.toString("utf-8") : "";
    const group = classifyChunk(file, source);
    if (group === "routes") {
      sizes.routes += gz;
      largestRoute = Math.max(largestRoute, gz);
      continue;
    }
    sizes[group] += gz;
  }
  sizes["largest-route"] = largestRoute;

  return { ok: true, sizes, duplicated };
};

// --- Baseline IO ------------------------------------------------------------

// Each field is read only by the modes that consume it, so a mode that
// replaces one field never refuses to run over a damaged value of another.
const readBaselineJson = (): unknown =>
  existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf-8"))
    : {};

const readMcpAppsBudgets = (): Record<string, number> | undefined =>
  v.parse(
    v.object({ mcpApps: v.optional(v.record(v.string(), v.number())) }),
    readBaselineJson(),
  ).mcpApps;

const readInitialBudget = (): number | undefined =>
  v.parse(
    v.object({ initial: v.optional(v.pipe(v.number(), v.integer())) }),
    readBaselineJson(),
  ).initial;

// Copies every GROUP_KEYS value onto emptySizes' (alphabetical) literal, so
// the written file's key set and order come from the one compiler-guarded
// copy. A second spelled-out literal here once silently dropped keys the
// checker knew about; a loop over GROUP_KEYS cannot.
const sortedSizes = (sizes: Sizes): Sizes => {
  const sorted = emptySizes();
  for (const key of GROUP_KEYS) {
    sorted[key] = sizes[key];
  }
  return sorted;
};

const writeBaseline = (sizes: Sizes, initial: number): void => {
  const mcpApps = readMcpAppsBudgets();
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        initial,
        ...sortedSizes(sizes),
        ...(mcpApps === undefined ? {} : { mcpApps }),
      },
      null,
      2,
    )}\n`,
  );
};

const readBaseline = (): Sizes => {
  const parsed: Record<string, number> = JSON.parse(
    readFileSync(BASELINE_PATH, "utf-8"),
  );
  const sizes = emptySizes();
  for (const key of GROUP_KEYS) {
    sizes[key] = parsed[key] ?? 0;
  }
  return sizes;
};

// --- Comparison -------------------------------------------------------------

type GroupStatus = "ok" | "regressed" | "dropped";

const compareGroup = (current: number, baseline: number): GroupStatus => {
  if (baseline === 0) {
    // A group with no baseline size: any bytes appearing is a new chunk that
    // must be acknowledged; staying at 0 is fine.
    return current > 0 ? "regressed" : "ok";
  }
  if (
    current > Math.max(baseline * HEADROOM, baseline + HEADROOM_FLOOR_BYTES)
  ) {
    return "regressed";
  }
  if (current < baseline * RATCHET_DOWN) {
    return "dropped";
  }
  return "ok";
};

// --- Formatting -------------------------------------------------------------

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

const pct = (current: number, baseline: number): string => {
  if (baseline === 0) {
    return current === 0 ? "0%" : "new";
  }
  const delta = ((current - baseline) / baseline) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
};

// --- Modes ------------------------------------------------------------------

const runReport = (): number => {
  const measured = measure(ASSETS_DIR);
  if (!measured.ok) {
    console.error(measured.error);
    return 1;
  }
  const hasBaseline = existsSync(BASELINE_PATH);
  const baseline = hasBaseline ? readBaseline() : emptySizes();

  console.log(`bundle sizes (gzipped) — ${ASSETS_REL}\n`);
  for (const key of GROUP_KEYS) {
    const size = measured.sizes[key];
    const suffix = hasBaseline
      ? `  (baseline ${kib(baseline[key])}, ${pct(size, baseline[key])})`
      : "";
    console.log(`  ${key.padEnd(20)} ${kib(size).padStart(12)}${suffix}`);
  }
  // The group report reads no sourcemap; a build the startup graph cannot be
  // read from still gets it, with the reason the initial line is missing.
  const startup = readStartupGraph(DIST_DIR);
  if (startup.ok) {
    const budget = readInitialBudget();
    const initial = initialGzipBytes(startup.graph);
    console.log(
      `  ${"initial".padEnd(20)} ${kib(initial).padStart(12)}${budget === undefined ? "" : `  (budget ${kib(budget)}, ${pct(initial, budget)})`}`,
    );
  } else {
    console.log(`  ${"initial".padEnd(20)} unavailable: ${startup.error}`);
  }
  if (!hasBaseline) {
    console.log(`\nNo baseline yet. Seed one with \`${WRITE_HINT}\`.`);
  }
  return 0;
};

const runWrite = (): number => {
  const measured = measure(ASSETS_DIR);
  if (!measured.ok) {
    console.error(measured.error);
    return 1;
  }
  const startup = readStartupGraph(DIST_DIR);
  if (!startup.ok) {
    console.error(startup.error);
    return 1;
  }
  const initial = initialGzipBytes(startup.graph);
  writeBaseline(measured.sizes, initial);
  console.log(`Wrote bundle baseline to ${BASELINE_REL}:`);
  console.log(`  ${"initial".padEnd(20)} ${kib(initial).padStart(12)}`);
  for (const key of GROUP_KEYS) {
    console.log(`  ${key.padEnd(20)} ${kib(measured.sizes[key]).padStart(12)}`);
  }
  return 0;
};

const runCheck = (): number => {
  const measured = measure(ASSETS_DIR);
  if (!measured.ok) {
    console.error(measured.error);
    return 1;
  }
  const budget = readInitialBudget();
  if (budget === undefined) {
    console.error(
      `${BASELINE_REL} has no initial budget. Seed it with \`${WRITE_HINT}\` and commit it.`,
    );
    return 1;
  }
  const startup = readStartupGraph(DIST_DIR);
  if (!startup.ok) {
    console.error(startup.error);
    return 1;
  }
  const ledger = v.parse(
    StartupLedgerSchema,
    JSON.parse(readFileSync(LEDGER_PATH, "utf-8")),
  );
  const workerOnly = checkWorkerOnlyGroups(measured.sizes, console.log);
  const evaluation = evaluateStartup(startup.graph, budget, ledger, WRITE_HINT);
  const summary = startupSummary(evaluation);
  console.log(summary);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath !== undefined && summaryPath !== "") {
    appendFileSync(summaryPath, summary);
  }
  for (const notice of evaluation.notices) {
    console.log(`::notice title=Initial JS shrank::${notice}`);
  }
  for (const { title, message } of evaluation.failures) {
    console.log(`::error title=${title}::${message}`);
  }
  if (workerOnly !== 0 || evaluation.failures.length > 0) {
    return 1;
  }
  console.log(
    `bundle --check: OK. Initial JS ${kib(evaluation.initial.measured)} gzip against a ${kib(budget)} budget; no new page code at startup.`,
  );
  return 0;
};

export const checkWorkerOnlyGroups = (
  sizes: Pick<Sizes, WorkerOnlyGroup>,
  log: (line: string) => void,
): number => {
  const leaks = WORKER_ONLY_GROUPS.filter((group) => sizes[group] > 0);
  if (leaks.length === 0) {
    return 0;
  }

  for (const group of leaks) {
    log(
      `::error title=Worker-only bundle group: ${group}::${group} contributes ${kib(sizes[group])} to main-thread chunks. Keep this group out of the main build's manualChunks and import worker-only dependencies from ${WORKER_ENTRY} instead.`,
    );
  }
  return 1;
};

const runCheckDuplicates = (): number => {
  const measured = measure(ASSETS_DIR);
  if (!measured.ok) {
    console.error(measured.error);
    return 1;
  }
  return checkDuplicates(measured.duplicated, console.log);
};

// The blocking duplicate-content guard. A chunk that repeats a large block is
// a build defect, not growth to budget for, so it fails on its own exit path.
const checkDuplicates = (
  duplicated: readonly DuplicatedChunk[],
  log: (line: string) => void,
): number => {
  if (duplicated.length === 0) {
    log(
      `bundle --check-duplicates: OK. No chunk repeats more than ` +
        `${kib(DUPLICATE_LIMIT_BYTES)} of identical content.`,
    );
    return 0;
  }
  log(
    `\nbundle --check-duplicates: chunk(s) repeat more than ${kib(DUPLICATE_LIMIT_BYTES)} of identical content:\n`,
  );
  for (const { file, bytes } of duplicated) {
    log(`  ${file}: ${kib(bytes)} repeated`);
    log(
      `::error title=Bundle duplicate: ${file}::${file} repeats ${kib(bytes)} of identical content.`,
    );
  }
  log(
    "\nA large constant imported from another module is usually inlined at\n" +
      "each use. Keep it a local binding, for example by resolving the\n" +
      "dependency to its prebuilt single-module build.",
  );
  return 1;
};

// --- Self-test --------------------------------------------------------------
// Prove the load-bearing pieces without a build: filenames classify into the
// right group, the MCP app comparison fires on an over-budget app while
// ignoring hash-churn noise within the headroom, and the duplicate guard
// fires. The startup gates have their own tests (bundle-startup-*.test.ts).

const runSelfTest = (): number => {
  const failures: string[] = [];

  const expectClass = (fileName: string, expected: string, source = "") => {
    const actual = classifyChunk(fileName, source);
    if (actual !== expected) {
      failures.push(
        `classifyChunk("${fileName}") = ${actual}, want ${expected}`,
      );
    }
  };
  expectClass(
    "index-BUgUF89h.js",
    "entry",
    'import "./vendor-react-DTPWpeFk.js";',
  );
  expectClass("index-D1PgnKxZ.js", "routes", "export class WasmBinding {}");
  expectClass("rolldown-runtime-CJJwijRH.js", "entry");
  expectClass("vendor-react-DTPWpeFk.js", "vendor-react");
  for (const group of VENDOR_GROUPS) {
    expectClass(`${group}-C8imk9BY.js`, group);
  }
  expectClass(
    "vendor-tanstack-server-fn-C8imk9BY.js",
    "vendor-tanstack-server-fn",
  );
  expectClass("vendor-editor-BNV6-MX2.js", "vendor-editor");
  expectClass("vendor-graphs-Bb5OXA3_.js", "vendor-graphs");
  // A route index chunk must NOT be mistaken for the entry, and a locale/route
  // chunk falls into the catch-all bucket.
  expectClass("_viewId.index-Dbyt9A86.js", "routes");
  expectClass("index.module-C5goDZ0H.js", "routes");
  expectClass("global-Dd3chVIF.js", "routes");
  expectClass("ar-CkDpEUW9.js", "routes");

  const expectStatus = (
    label: string,
    current: number,
    baseline: number,
    expected: GroupStatus,
  ) => {
    const actual = compareGroup(current, baseline);
    if (actual !== expected) {
      failures.push(`${label}: compareGroup = ${actual}, want ${expected}`);
    }
  };
  // Over budget by 10% (> 3% headroom) MUST be detected.
  expectStatus("over-budget", 110_000, 100_000, "regressed");
  // Within the 3% headroom (hash/minor churn) must pass.
  expectStatus("within-headroom", 102_000, 100_000, "ok");
  // Tiny budgets get an absolute byte floor: +30 bytes on 1.2 KiB is churn;
  // a KiB-scale jump past the floor still fails.
  expectStatus("tiny-within-floor", 1276, 1246, "ok");
  expectStatus("tiny-past-floor", 2400, 1246, "regressed");
  // A real shrink is a ratchet-down prompt, not a failure.
  expectStatus("shrank", 90_000, 100_000, "dropped");
  // A budget that was 0 gaining bytes must be flagged.
  expectStatus("new-chunk", 5000, 0, "regressed");
  expectStatus("still-absent", 0, 0, "ok");

  // A chunk carrying one large block twice must be flagged; distinct content
  // of the same size must not be.
  let seed = 1;
  const noise = (length: number): Uint8Array =>
    Uint8Array.from({ length }, () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return 32 + (seed % 95);
    });
  const block = noise(48 * 1024);
  const copied = new Uint8Array([...block, ...noise(4096), ...block]);
  if (duplicatedBytes(copied) <= DUPLICATE_LIMIT_BYTES) {
    failures.push(
      `duplicatedBytes missed a copied 48 KiB block (${duplicatedBytes(copied)} bytes)`,
    );
  }
  const distinct = noise(100 * 1024);
  if (duplicatedBytes(distinct) !== 0) {
    failures.push(
      `duplicatedBytes flagged distinct content (${duplicatedBytes(distinct)} bytes)`,
    );
  }
  const flagged: string[] = [];
  if (
    checkDuplicates([{ file: "link-Ds-2pgSG.js", bytes: 65_536 }], (line) => {
      flagged.push(line);
    }) !== 1 ||
    !flagged.some((line) =>
      line.startsWith("::error title=Bundle duplicate: link-Ds-2pgSG.js::"),
    )
  ) {
    failures.push("checkDuplicates did not fail on a repeated block");
  }
  if (
    checkDuplicates([], (line) => {
      flagged.push(line);
    }) !== 0
  ) {
    failures.push("checkDuplicates failed without a repeated block");
  }

  if (failures.length > 0) {
    console.error("bundle --self-test: FAIL");
    for (const f of failures) {
      console.error(`  ${f}`);
    }
    return 1;
  }
  console.log("bundle --self-test: PASS");
  return 0;
};

// MCP resources are complete HTML documents, so their budgets include fonts,
// styles, catalogues and JavaScript rather than only JavaScript chunk weight.
const runMcpApps = (): number => {
  const measured = new Map(
    MCP_APPS.map(({ directory }) => {
      const file = path.join(
        REPO_ROOT,
        "packages/mcp-apps/src",
        directory,
        "generated/app.html.txt",
      );
      if (!existsSync(file)) {
        panic(`Build MCP app ${directory} before measuring its budget`);
      }
      return [directory, gzipSize(file)] as const;
    }),
  );
  const budgets = readMcpAppsBudgets();
  if (process.argv.includes("--write-baseline")) {
    const baseline = v.parse(
      v.record(v.string(), v.unknown()),
      JSON.parse(readFileSync(BASELINE_PATH, "utf-8")),
    );
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify({ ...baseline, mcpApps: Object.fromEntries(measured) }, null, 2)}\n`,
    );
    console.log(`Wrote ${measured.size} MCP app budgets to ${BASELINE_REL}`);
    return 0;
  }
  const baseline = new Map(Object.entries(budgets ?? {}));
  let regressions = 0;
  for (const [directory, size] of measured) {
    const previous = baseline.get(directory);
    console.log(
      `mcp-app ${directory}: ${size} bytes gzip (baseline ${previous ?? "missing"})`,
    );
    if (!process.argv.includes("--check")) {
      continue;
    }
    if (
      previous === undefined ||
      compareGroup(size, previous) === "regressed"
    ) {
      console.error(`MCP app ${directory} exceeds or lacks its bundle budget`);
      regressions += 1;
    }
    if (previous !== undefined && compareGroup(size, previous) === "dropped") {
      console.log(
        `MCP app ${directory} shrank; ratchet with --mcp-apps --write-baseline`,
      );
    }
  }
  for (const directory of baseline.keys()) {
    if (!MCP_APPS.some((app) => app.directory === directory)) {
      console.error(`MCP app budget ${directory} has no manifest entry`);
      regressions += 1;
    }
  }
  return regressions === 0 ? 0 : 1;
};

// --- Entry ------------------------------------------------------------------

const main = (): number => {
  if (process.argv.includes("--mcp-apps")) {
    return runMcpApps();
  }
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--write-baseline")) {
    return runWrite();
  }
  if (process.argv.includes("--check-duplicates")) {
    return runCheckDuplicates();
  }
  if (process.argv.includes("--check")) {
    return runCheck();
  }
  return runReport();
};

if (import.meta.main) {
  assertOfflineCheckPreload();

  process.exit(main());
}
