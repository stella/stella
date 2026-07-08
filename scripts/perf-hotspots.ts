// Perf-debt hotspot report.
//
// Both committed perf baselines (apps/web/e2e/network-baseline.json,
// scripts/bundle-baseline.json) are one-directional guards: a route that
// grows a deeper waterfall, an endpoint that starts issuing more SQL, or a
// bundle chunk that gets heavier fails CI, but a route that was ALREADY slow
// when its baseline was written just sits there, passing forever. The
// baseline records the debt; nothing ever prints it back out. An agent
// fixing an unrelated bug in, say, `/workspaces/$workspaceId` has no way to
// tell that route already carries the deepest waterfall in the app short of
// diffing raw JSON by hand.
//
// This script reads both committed baselines and prints the current worst
// budgets, worst first, so a hotspot is visible before you touch it: fix it,
// then tighten the baseline with the sibling scripts' `rewrite`/write-baseline
// mode (`E2E_NETWORK_BASELINE=rewrite` for the network suite,
// `bun scripts/bundle-baseline.ts --write-baseline` for bundle size) so the
// improvement can never silently regress back up.
//
// Referenced by the /conventions-perf skill. Not wired into CI — the numbers
// only change when a baseline is rewritten, so there is nothing for a
// continuous gate to catch; run this manually when hunting for perf debt to
// pay down.
//
// Modes:
//   bun scripts/perf-hotspots.ts          ranked text report
//   bun scripts/perf-hotspots.ts --json   same ranking as JSON

import { readFileSync } from "node:fs";
import path from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");

const NETWORK_BASELINE_REL = "apps/web/e2e/network-baseline.json";
const NETWORK_BASELINE_PATH = path.resolve(REPO_ROOT, NETWORK_BASELINE_REL);
const BUNDLE_BASELINE_REL = "scripts/bundle-baseline.json";
const BUNDLE_BASELINE_PATH = path.resolve(SCRIPTS_DIR, "bundle-baseline.json");

// How many rows each ranked section prints.
const LIMIT = 10;

// --- Baseline shapes ---------------------------------------------------------
// Mirrors apps/web/e2e/helpers/network.ts's NetworkBaselineEntry /
// NetworkBaseline and scripts/bundle-baseline.ts's Sizes: this script only
// reads the committed JSON, so it declares the subset of each shape it
// consumes rather than importing across the e2e/scripts boundary.

type NetworkBaselineEntry = {
  depth: number;
  requests: string[];
  requestCounts?: Record<string, number>;
  dbQueries?: Record<string, number>;
};
type NetworkBaseline = Record<string, NetworkBaselineEntry>;

type BundleBaseline = Record<string, number>;

// --- Loading ------------------------------------------------------------

type LoadResult<T> = { ok: true; data: T } | { ok: false; error: string };

const loadJson = <T>(absPath: string, relPath: string): LoadResult<T> => {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch {
    return { ok: false, error: `Missing baseline file: ${relPath}` };
  }
  try {
    const data: T = JSON.parse(raw);
    return { ok: true, data };
  } catch {
    return { ok: false, error: `Could not parse ${relPath} as JSON` };
  }
};

// --- Ranking --------------------------------------------------------------

type DbQueryHotspot = { route: string; endpoint: string; queries: number };

// Flattens every route's dbQueries map into (route, endpoint) rows so the
// worst individual budget surfaces regardless of which route it lives on.
const dbQueryHotspots = (
  network: NetworkBaseline,
  limit: number,
): DbQueryHotspot[] => {
  const rows: DbQueryHotspot[] = [];
  for (const [route, entry] of Object.entries(network)) {
    for (const [endpoint, queries] of Object.entries(entry.dbQueries ?? {})) {
      rows.push({ route, endpoint, queries });
    }
  }
  rows.sort((a, b) => b.queries - a.queries);
  return rows.slice(0, limit);
};

type RouteDepth = { route: string; depth: number };

const depthHotspots = (
  network: NetworkBaseline,
  limit: number,
): RouteDepth[] => {
  const rows = Object.entries(network).map(([route, entry]) => ({
    route,
    depth: entry.depth,
  }));
  rows.sort((a, b) => b.depth - a.depth);
  return rows.slice(0, limit);
};

// A route's total request count: each observed key counts once unless
// requestCounts records a higher repeat budget for it (mirrors
// requestCountBudget in apps/web/e2e/helpers/network.ts).
const requestTotal = (entry: NetworkBaselineEntry): number => {
  const counts = entry.requestCounts ?? {};
  let total = 0;
  for (const key of entry.requests) {
    total += counts[key] ?? 1;
  }
  return total;
};

type RouteRequestTotal = { route: string; total: number };

const requestCountHotspots = (
  network: NetworkBaseline,
  limit: number,
): RouteRequestTotal[] => {
  const rows = Object.entries(network).map(([route, entry]) => ({
    route,
    total: requestTotal(entry),
  }));
  rows.sort((a, b) => b.total - a.total);
  return rows.slice(0, limit);
};

type BundleGroupSize = { group: string; bytes: number };

const bundleHotspots = (
  bundle: BundleBaseline,
  limit: number,
): BundleGroupSize[] => {
  const rows = Object.entries(bundle).map(([group, bytes]) => ({
    group,
    bytes,
  }));
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows.slice(0, limit);
};

type Hotspots = {
  dbQueries: DbQueryHotspot[];
  waterfallDepth: RouteDepth[];
  requestCounts: RouteRequestTotal[];
  bundleGroups: BundleGroupSize[];
};

const computeHotspots = (
  network: NetworkBaseline,
  bundle: BundleBaseline,
): Hotspots => ({
  dbQueries: dbQueryHotspots(network, LIMIT),
  waterfallDepth: depthHotspots(network, LIMIT),
  requestCounts: requestCountHotspots(network, LIMIT),
  bundleGroups: bundleHotspots(bundle, LIMIT),
});

// --- Formatting -------------------------------------------------------------

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

const rank = (index: number): string => `${index + 1}.`.padEnd(4);

const printReport = (hotspots: Hotspots): void => {
  console.log(
    "perf hotspots — recorded debt in committed baselines (worst first)\n",
  );

  console.log(
    `1) top ${LIMIT} route+endpoint pairs by DB query budget (${NETWORK_BASELINE_REL})`,
  );
  if (hotspots.dbQueries.length === 0) {
    console.log("   (no dbQueries recorded in the baseline)");
  }
  hotspots.dbQueries.forEach((row, index) => {
    console.log(
      `   ${rank(index)} ${`${row.queries} queries`.padEnd(14)} ${row.endpoint}  (${row.route})`,
    );
  });

  console.log(
    `\n2) top ${LIMIT} routes by waterfall depth (${NETWORK_BASELINE_REL})`,
  );
  hotspots.waterfallDepth.forEach((row, index) => {
    console.log(
      `   ${rank(index)} ${`depth ${row.depth}`.padEnd(10)} ${row.route}`,
    );
  });

  console.log(
    `\n3) top ${LIMIT} routes by total request count (${NETWORK_BASELINE_REL})`,
  );
  hotspots.requestCounts.forEach((row, index) => {
    console.log(
      `   ${rank(index)} ${`${row.total} requests`.padEnd(14)} ${row.route}`,
    );
  });

  console.log(
    `\n4) top ${LIMIT} bundle chunk groups by gzip size (${BUNDLE_BASELINE_REL})`,
  );
  hotspots.bundleGroups.forEach((row, index) => {
    console.log(
      `   ${rank(index)} ${kib(row.bytes).padStart(10)}  ${row.group}`,
    );
  });
};

// --- Entry --------------------------------------------------------------

const main = (): number => {
  const networkResult = loadJson<NetworkBaseline>(
    NETWORK_BASELINE_PATH,
    NETWORK_BASELINE_REL,
  );
  if (!networkResult.ok) {
    console.error(networkResult.error);
    return 1;
  }
  const bundleResult = loadJson<BundleBaseline>(
    BUNDLE_BASELINE_PATH,
    BUNDLE_BASELINE_REL,
  );
  if (!bundleResult.ok) {
    console.error(bundleResult.error);
    return 1;
  }

  const hotspots = computeHotspots(networkResult.data, bundleResult.data);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(hotspots, null, 2));
    return 0;
  }

  printReport(hotspots);
  return 0;
};

if (import.meta.main) {
  process.exit(main());
}
