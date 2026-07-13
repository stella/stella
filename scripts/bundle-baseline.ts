// Web bundle-size baseline guard.
//
// The web app is a TanStack Start build: the client entry is a tiny bootstrap
// that preloads a handful of shared vendor chunks (react, tanstack, editor),
// and everything else is a lazy route/locale/worker chunk. What silently rots
// is the SIZE of those chunks — a heavy dependency that escapes its
// manualChunks bucket and lands in the entry (paid on every cold visit), or a
// route chunk that quietly doubles. Typecheck and lint see none of it.
//
// This measures the gzipped size of every client JS asset, groups them the way
// the build's manualChunks names them (apps/web/vite.config.ts), and guards a
// committed baseline so that a size regression fails CI while an improvement
// just prompts you to ratchet the baseline down.
//
// Modes:
//   bun scripts/bundle-baseline.ts                 report groups + gzip sizes
//   bun scripts/bundle-baseline.ts --write-baseline regenerate the baseline
//   bun scripts/bundle-baseline.ts --check          CI gate (exit 1 on regression)
//   bun scripts/bundle-baseline.ts --self-test      prove the comparison logic fires
//
// CI-only by design: it needs a completed `bun --filter @stll/web build` first,
// so it is too slow for the local lint/pre-commit loop. Wired into
// .github/workflows/ci.yml's web-build job, right after "Build web".

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const BASELINE_PATH = path.resolve(SCRIPTS_DIR, "bundle-baseline.json");
const BASELINE_REL = "scripts/bundle-baseline.json";
const ASSETS_REL = "apps/web/dist/client/assets";
const ASSETS_DIR = path.resolve(REPO_ROOT, ASSETS_REL);
const WRITE_HINT = "bun scripts/bundle-baseline.ts --write-baseline";

// A chunk may grow by up to this factor over its baseline before CI fails.
// Content hashes churn, minifier output drifts release to release, and CI's
// build inlines a slightly different `import.meta.env` than a developer's local
// build (CI copies apps/web/.env.example; a dev .env may carry extra VITE_*
// values). 3% absorbs that noise while still catching a real dependency leak.
const HEADROOM = 1.03;
// For small chunks a percentage is too twitchy: the 1.2 KiB entry bootstrap
// would fail on a single extra preload line (~30 bytes). Allow at least this
// many bytes of absolute growth; a real dependency leak adds tens of KiB and
// still trips the guard.
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
// the guard forces a deliberate baseline update.
const VENDOR_GROUPS = [
  "vendor-react",
  "vendor-tanstack",
  "vendor-tanstack-server-fn",
  "vendor-anonymize-data",
  "wasm-vendor",
  "vendor-graphs",
  "vendor-editor",
] as const;

// The full, fixed set of baseline keys. Keeping it fixed (rather than "whatever
// chunks happened to exist") gives the baseline a stable schema and makes a
// newly-appearing vendor chunk a visible, guarded event.
const GROUP_KEYS = [
  "entry",
  ...VENDOR_GROUPS,
  "routes",
  "largest-route",
  "total",
] as const;

type GroupKey = (typeof GROUP_KEYS)[number];
type VendorGroup = (typeof VENDOR_GROUPS)[number];
type Sizes = Record<GroupKey, number>;

// --- Classification ---------------------------------------------------------
// Entry = the client bootstrap (`index-<hash>.js`, the __root__ script that
// calls hydrateRoot) plus the Rolldown module runtime (`rolldown-runtime-<hash>
// .js`) it imports. Both are loaded on every cold visit and are neither a
// vendor chunk nor a route chunk. A heavy dep escaping manualChunks lands here.
const ENTRY_RE = new RegExp(`^(?:index|rolldown-runtime)-${HASH}\\.js$`, "u");

const vendorRe = (name: VendorGroup): RegExp =>
  new RegExp(`^${name}-${HASH}\\.js$`, "u");

// Returns the group a client JS file belongs to. Everything that is not the
// entry or a named vendor chunk (route chunks, locale chunks, workers, the big
// lazy `global-*` chunk, pdf/katex, ...) falls into the catch-all "routes".
const classifyChunk = (fileName: string): "entry" | VendorGroup | "routes" => {
  if (ENTRY_RE.test(fileName)) {
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
// Sizes without a cast; a new GROUP_KEYS entry fails compilation here.
const emptySizes = (): Sizes => ({
  entry: 0,
  "vendor-react": 0,
  "vendor-tanstack": 0,
  "vendor-tanstack-server-fn": 0,
  "vendor-anonymize-data": 0,
  "wasm-vendor": 0,
  "vendor-graphs": 0,
  "vendor-editor": 0,
  routes: 0,
  "largest-route": 0,
  total: 0,
});

const gzipSize = (absPath: string): number =>
  Bun.gzipSync(readFileSync(absPath)).length;

type MeasureResult = { ok: true; sizes: Sizes } | { ok: false; error: string };

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
  let largestRoute = 0;

  for (const file of files) {
    const gz = gzipSize(path.join(assetsDir, file));
    sizes.total += gz;
    const group = classifyChunk(file);
    if (group === "routes") {
      sizes.routes += gz;
      largestRoute = Math.max(largestRoute, gz);
      continue;
    }
    sizes[group] += gz;
  }
  sizes["largest-route"] = largestRoute;

  return { ok: true, sizes };
};

// --- Baseline IO ------------------------------------------------------------

// Alphabetical key order keeps the committed JSON diff-stable. Spelled out for
// the same no-cast reason as emptySizes.
const sortedSizes = (sizes: Sizes): Sizes => ({
  entry: sizes.entry,
  "largest-route": sizes["largest-route"],
  routes: sizes.routes,
  total: sizes.total,
  "vendor-anonymize-data": sizes["vendor-anonymize-data"],
  "vendor-editor": sizes["vendor-editor"],
  "vendor-graphs": sizes["vendor-graphs"],
  "vendor-react": sizes["vendor-react"],
  "vendor-tanstack": sizes["vendor-tanstack"],
  "vendor-tanstack-server-fn": sizes["vendor-tanstack-server-fn"],
  "wasm-vendor": sizes["wasm-vendor"],
});

const writeBaseline = (sizes: Sizes): void => {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(sortedSizes(sizes), null, 2)}\n`,
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

const baselineExists = (): boolean => {
  try {
    readFileSync(BASELINE_PATH, "utf-8");
    return true;
  } catch {
    return false;
  }
};

// --- Comparison (the guarded logic the self-test exercises) -----------------

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

type GroupDiff = {
  key: GroupKey;
  status: GroupStatus;
  current: number;
  baseline: number;
};

const diffAll = (current: Sizes, baseline: Sizes): GroupDiff[] =>
  GROUP_KEYS.map((key) => ({
    key,
    status: compareGroup(current[key], baseline[key]),
    current: current[key],
    baseline: baseline[key],
  }));

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

const perfMeaning = (key: GroupKey): string => {
  if (key === "entry") {
    return "the entry chunk is paid on every cold visit; a heavy dep leaking out of manualChunks into the entry is the classic cause";
  }
  if (key === "total") {
    return "total client JS shipped across the app";
  }
  if (key === "vendor-tanstack-server-fn") {
    return "the TanStack Start client runtime, loaded only by routes that call server functions";
  }
  if (key === "routes" || key === "largest-route") {
    return "lazy route/locale/worker chunk weight, loaded on navigation";
  }
  return "a shared vendor chunk preloaded alongside the entry";
};

// --- Modes ------------------------------------------------------------------

const runReport = (): number => {
  const measured = measure(ASSETS_DIR);
  if (!measured.ok) {
    console.error(measured.error);
    return 1;
  }
  const hasBaseline = baselineExists();
  const baseline = hasBaseline ? readBaseline() : emptySizes();

  console.log(`bundle sizes (gzipped) — ${ASSETS_REL}\n`);
  for (const key of GROUP_KEYS) {
    const size = measured.sizes[key];
    const suffix = hasBaseline
      ? `  (baseline ${kib(baseline[key])}, ${pct(size, baseline[key])})`
      : "";
    console.log(`  ${key.padEnd(20)} ${kib(size).padStart(12)}${suffix}`);
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
  writeBaseline(measured.sizes);
  console.log(`Wrote bundle baseline to ${BASELINE_REL}:`);
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
  if (!baselineExists()) {
    console.error(
      `Missing ${BASELINE_REL}. Seed it with \`${WRITE_HINT}\` and commit it\n` +
        "before enabling the check.",
    );
    return 1;
  }

  const baseline = readBaseline();
  const diffs = diffAll(measured.sizes, baseline);
  const regressions = diffs.filter((d) => d.status === "regressed");
  const drops = diffs.filter((d) => d.status === "dropped");

  for (const d of drops) {
    console.log(
      `bundle: ${d.key} shrank ${kib(d.baseline)} -> ${kib(d.current)} ` +
        `(${pct(d.current, d.baseline)}). Nice — run \`${WRITE_HINT}\` and ` +
        `commit ${BASELINE_REL} to ratchet it down.`,
    );
  }

  if (regressions.length === 0) {
    console.log(
      `bundle --check: OK. ${GROUP_KEYS.length} group(s) within ` +
        `${Math.round((HEADROOM - 1) * 100)}% of baseline.`,
    );
    return 0;
  }

  console.error("\nbundle --check: chunk group(s) grew past the baseline:\n");
  for (const d of regressions) {
    const delta = d.current - d.baseline;
    console.error(
      `  ${d.key}: ${kib(d.baseline)} -> ${kib(d.current)} ` +
        `(+${kib(delta)}, ${pct(d.current, d.baseline)})`,
    );
    console.error(`      ${perfMeaning(d.key)}.`);
  }
  console.error(
    `\nAllowed headroom is ${Math.round((HEADROOM - 1) * 100)}% over baseline. ` +
      "Find what grew (run\n" +
      "`ANALYZE=1 bun --filter @stll/web build` for the visualizer treemap) and\n" +
      "trim it, or, if the growth is genuinely justified, run\n" +
      `\`${WRITE_HINT}\` and commit ${BASELINE_REL} with a rationale in your PR.`,
  );
  return 1;
};

// --- Self-test --------------------------------------------------------------
// Prove the two load-bearing pieces: filenames classify into the right group,
// and the comparison fires on an over-budget group while ignoring hash-churn
// noise within the headroom. No build required — pure synthetic inputs.

const runSelfTest = (): number => {
  const failures: string[] = [];

  const expectClass = (fileName: string, expected: string) => {
    const actual = classifyChunk(fileName);
    if (actual !== expected) {
      failures.push(
        `classifyChunk("${fileName}") = ${actual}, want ${expected}`,
      );
    }
  };
  expectClass("index-BUgUF89h.js", "entry");
  expectClass("rolldown-runtime-CJJwijRH.js", "entry");
  expectClass("vendor-react-DTPWpeFk.js", "vendor-react");
  expectClass("vendor-tanstack-C8imk9BY.js", "vendor-tanstack");
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
  // Tiny chunks get an absolute byte floor: +30 bytes on a 1.2 KiB entry is
  // churn, not a leak; a KiB-scale jump past the floor still fails.
  expectStatus("tiny-within-floor", 1276, 1246, "ok");
  expectStatus("tiny-past-floor", 2400, 1246, "regressed");
  // A real shrink is a ratchet-down prompt, not a failure.
  expectStatus("shrank", 90_000, 100_000, "dropped");
  // A tracked group that was 0 (worker-only) leaking bytes into the client
  // graph must be flagged.
  expectStatus("new-chunk", 5000, 0, "regressed");
  expectStatus("still-absent", 0, 0, "ok");

  // The whole-report diff must surface exactly the over-budget group.
  const baseline: Sizes = { ...emptySizes(), entry: 100_000, total: 500_000 };
  const current: Sizes = { ...baseline, entry: 120_000 };
  const regressed = diffAll(current, baseline).filter(
    (d) => d.status === "regressed",
  );
  if (regressed.length !== 1 || regressed[0]?.key !== "entry") {
    failures.push(
      `diffAll did not isolate the over-budget group (got ${regressed
        .map((d) => d.key)
        .join(", ")})`,
    );
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

// --- Entry ------------------------------------------------------------------

const main = (): number => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--write-baseline")) {
    return runWrite();
  }
  if (process.argv.includes("--check")) {
    return runCheck();
  }
  return runReport();
};

if (import.meta.main) {
  process.exit(main());
}
