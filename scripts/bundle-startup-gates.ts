// Startup bundle gates: what a cold visit downloads before the first paint.
//
// The initial graph is the Start manifest's `__root__` preloads: the client
// entry and every chunk it imports statically. Those chunks hold the route
// tree, so every route file and everything a route file imports is paid on
// every cold visit, whichever page the visitor opened. Four gates keep that
// graph to the shell and the loading views:
//
//   1. Initial JS ratchet: the gzip of the initial chunks stays within
//      INITIAL_GROWTH_LIMIT_BYTES of the committed budget.
//   2. Pending layer: `*.pending.tsx` loading views are eager by design, so
//      each stays small and so does their sum.
//   3. No page code at startup: no page module, no `?tsr-shared=1` module and
//      no route-file code that only the route's `component` reaches in the
//      initial chunks (see STARTUP_KINDS).
//   4. No extra cold-load hop: the chunk holding a route's page is one of the
//      route's manifest preloads, so the document links it at once instead
//      of the browser discovering it after the route chunk ran.
//
// Gates 3 and 4 share a shrink-only ledger: a listed offender passes, a new
// one fails, and a listed one that stopped offending fails until its line is
// deleted. The ledger can only get shorter.
//
// The gates are pure functions over a StartupGraph; bundle-startup-build.ts
// reads one from a production build.

import * as v from "valibot";

export const INITIAL_GROWTH_LIMIT_BYTES = 8 * 1024;
export const PENDING_MODULE_LIMIT_BYTES = 6 * 1024;
export const PENDING_TOTAL_LIMIT_BYTES = 150 * 1024;

/** A module's minified size in one chunk, keyed by its app-relative id. */
export type BuiltChunk = {
  fileName: string;
  gzipBytes: number;
  /** Minified size: the chunk's length in UTF-16 code units. */
  codeBytes: number;
  /** Module id (app-relative path, query kept) to minified code units. */
  modules: ReadonlyMap<string, number>;
  /** Chunk file names this one imports or re-exports statically. */
  staticImports: readonly string[];
  /** Chunks this one loads with `import()`, and the module that does. */
  dynamicImports: readonly { target: string; importer: string | undefined }[];
};

export type StartupRoute = {
  id: string;
  /** App-relative route file, as the route tree records it. */
  filePath: string;
  /** Chunk file names the document preloads for this route. */
  preloads: readonly string[];
};

export type StartupGraph = {
  /** Chunk file names of the `__root__` preloads. */
  initialChunks: readonly string[];
  chunks: ReadonlyMap<string, BuiltChunk>;
  routes: readonly StartupRoute[];
  /**
   * Route file to the initial-chunk bytes that map to the top-level
   * declarations its route's `component` refers to.
   */
  routeComponentBytes: ReadonlyMap<string, number>;
};

// --- Module classification ---------------------------------------------------

const modulePath = (id: string): string => {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
};

const moduleQuery = (id: string): URLSearchParams => {
  const query = id.indexOf("?");
  return new URLSearchParams(query === -1 ? "" : id.slice(query + 1));
};

// Module paths, chunk names and route ids are not language: compare them by
// code unit so the order is the same on every machine.
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const isPendingModule = (id: string): boolean =>
  modulePath(id).endsWith(".pending.tsx");

/**
 * A page module: `x.page.tsx`, the convention for a route's page, or a
 * route-local `-x-page.tsx` page that predates it. Both are a route's whole
 * screen, which only that route's own chunk should carry.
 */
export const isPageModule = (id: string): boolean => {
  const file = modulePath(id);
  if (file.endsWith(".page.tsx")) {
    return true;
  }
  return file.startsWith("src/routes/") && file.endsWith("-page.tsx");
};

const isSharedRouteModule = (id: string): boolean =>
  moduleQuery(id).has("tsr-shared");

const isSplitComponentModule = (id: string, routeFile: string): boolean =>
  modulePath(id) === routeFile &&
  (moduleQuery(id).get("tsr-split") ?? "").split("---").includes("component");

// --- Gate 1: initial JS ratchet ----------------------------------------------

export const initialGzipBytes = (graph: StartupGraph): number =>
  graph.initialChunks.reduce(
    (sum, file) => sum + (graph.chunks.get(file)?.gzipBytes ?? 0),
    0,
  );

export type InitialBudgetResult =
  | { status: "ok" | "shrunk"; measured: number; budget: number }
  | { status: "over"; measured: number; budget: number };

export const checkInitialBudget = (
  measured: number,
  budget: number,
): InitialBudgetResult => {
  if (measured > budget + INITIAL_GROWTH_LIMIT_BYTES) {
    return { status: "over", measured, budget };
  }
  if (measured < budget - INITIAL_GROWTH_LIMIT_BYTES) {
    return { status: "shrunk", measured, budget };
  }
  return { status: "ok", measured, budget };
};

// --- Initial modules -----------------------------------------------------------

/** Every module in the initial chunks with its summed minified size. */
export const initialModules = (graph: StartupGraph): Map<string, number> => {
  const modules = new Map<string, number>();
  for (const file of graph.initialChunks) {
    for (const [id, bytes] of graph.chunks.get(file)?.modules ?? []) {
      modules.set(id, (modules.get(id) ?? 0) + bytes);
    }
  }
  return modules;
};

// --- Gate 2: pending layer -------------------------------------------------------

export type PendingLayer = {
  modules: readonly { module: string; bytes: number }[];
  totalBytes: number;
  oversized: readonly { module: string; bytes: number }[];
  overTotal: boolean;
};

export const pendingLayer = (graph: StartupGraph): PendingLayer => {
  const modules = [...initialModules(graph)]
    .filter(([id]) => isPendingModule(id))
    .map(([module, bytes]) => ({ module, bytes: Math.round(bytes) }))
    .toSorted((a, b) => b.bytes - a.bytes || byCodeUnit(a.module, b.module));
  const totalBytes = modules.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    modules,
    totalBytes,
    oversized: modules.filter(
      (entry) => entry.bytes > PENDING_MODULE_LIMIT_BYTES,
    ),
    overTotal: totalBytes > PENDING_TOTAL_LIMIT_BYTES,
  };
};

// --- Gate 3: no page code at startup ---------------------------------------------

/**
 * - page-module: a `x.page.tsx` (or route-local `-x-page.tsx`) module.
 * - tsr-shared: the module the route code splitter makes of code both the
 *   lazy component and an eager route option use.
 * - route-component: the part of a route file its `component` refers to.
 */
export const STARTUP_KINDS = [
  "page-module",
  "tsr-shared",
  "route-component",
] as const;
export type StartupKind = (typeof STARTUP_KINDS)[number];

export type StartupOffender = {
  kind: StartupKind;
  module: string;
  bytes: number;
};

export const startupPageCode = (graph: StartupGraph): StartupOffender[] => {
  const offenders: StartupOffender[] = [];
  for (const [module, rawBytes] of initialModules(graph)) {
    const bytes = Math.round(rawBytes);
    if (bytes === 0) {
      continue;
    }
    if (isSharedRouteModule(module)) {
      offenders.push({ kind: "tsr-shared", module, bytes });
    } else if (isPageModule(module)) {
      offenders.push({ kind: "page-module", module, bytes });
    }
  }
  for (const [module, rawBytes] of graph.routeComponentBytes) {
    const bytes = Math.round(rawBytes);
    if (bytes > 0) {
      offenders.push({ kind: "route-component", module, bytes });
    }
  }
  return offenders.toSorted(
    (a, b) => b.bytes - a.bytes || byCodeUnit(a.module, b.module),
  );
};

// --- Gate 4: no extra cold-load hop ----------------------------------------------

export type ColdLoadHop = {
  route: string;
  /** The chunk the route loads with `import()` that holds its page. */
  chunk: string;
  /** The page or split component module in that chunk. */
  module: string;
  /** Minified size of the late chunk. */
  bytes: number;
};

/**
 * The chunks an `import()` of `target` fetches for its code: the target, or,
 * when the target is a re-export facade with no modules of its own, the
 * chunks it re-exports.
 */
const lateChunks = (graph: StartupGraph, target: string): BuiltChunk[] => {
  const chunk = graph.chunks.get(target);
  if (chunk === undefined) {
    return [];
  }
  if (chunk.modules.size > 0) {
    return [chunk];
  }
  return chunk.staticImports.flatMap((file) => {
    const reexported = graph.chunks.get(file);
    return reexported === undefined ? [] : [reexported];
  });
};

export const coldLoadHops = (graph: StartupGraph): ColdLoadHop[] => {
  const hops: ColdLoadHop[] = [];
  for (const route of graph.routes) {
    const preloaded = new Set(route.preloads);
    const seen = new Set<string>();
    for (const chunk of graph.chunks.values()) {
      for (const { target, importer } of chunk.dynamicImports) {
        if (importer === undefined || modulePath(importer) !== route.filePath) {
          continue;
        }
        for (const late of lateChunks(graph, target)) {
          if (preloaded.has(late.fileName) || seen.has(late.fileName)) {
            continue;
          }
          const page = [...late.modules.keys()].find(
            (id) =>
              isSplitComponentModule(id, route.filePath) || isPageModule(id),
          );
          if (page === undefined) {
            continue;
          }
          seen.add(late.fileName);
          hops.push({
            route: route.id,
            chunk: late.fileName,
            module: page,
            bytes: late.codeBytes,
          });
        }
      }
    }
  }
  return hops.toSorted(
    (a, b) => byCodeUnit(a.route, b.route) || byCodeUnit(a.chunk, b.chunk),
  );
};

// --- Shrink-only ledger ------------------------------------------------------------

const reason = v.pipe(v.string(), v.trim(), v.minLength(1));

export const StartupLedgerSchema = v.strictObject({
  startupPageCode: v.array(
    v.strictObject({
      kind: v.picklist(STARTUP_KINDS),
      module: v.string(),
      reason,
    }),
  ),
  coldLoadHops: v.array(v.strictObject({ route: v.string(), reason })),
});
export type StartupLedger = v.InferOutput<typeof StartupLedgerSchema>;

export type LedgerVerdict<T> = {
  /** Offenders the ledger does not list: each fails the gate. */
  unlisted: readonly T[];
  /** Ledger lines that no longer offend: each fails until deleted. */
  stale: readonly string[];
  /** Listed offenders, still allowed. */
  listed: readonly T[];
};

const reconcile = <T>(
  offenders: readonly T[],
  offenderKey: (offender: T) => string,
  ledgerKeys: readonly string[],
): LedgerVerdict<T> => {
  const allowed = new Set(ledgerKeys);
  const offending = new Set(offenders.map(offenderKey));
  return {
    unlisted: offenders.filter(
      (offender) => !allowed.has(offenderKey(offender)),
    ),
    listed: offenders.filter((offender) => allowed.has(offenderKey(offender))),
    stale: ledgerKeys.filter((key) => !offending.has(key)),
  };
};

export const startupKey = (entry: { kind: string; module: string }): string =>
  `${entry.kind} ${entry.module}`;

export const reconcileStartupPageCode = (
  offenders: readonly StartupOffender[],
  ledger: StartupLedger,
): LedgerVerdict<StartupOffender> =>
  reconcile(offenders, startupKey, ledger.startupPageCode.map(startupKey));

export const reconcileColdLoadHops = (
  hops: readonly ColdLoadHop[],
  ledger: StartupLedger,
): LedgerVerdict<ColdLoadHop> =>
  reconcile(
    hops,
    (hop) => hop.route,
    ledger.coldLoadHops.map((entry) => entry.route),
  );

// --- Evaluation ----------------------------------------------------------------------

export type GateFailure = { title: string; message: string };

export type StartupEvaluation = {
  initial: InitialBudgetResult;
  pending: PendingLayer;
  pageCode: LedgerVerdict<StartupOffender>;
  hops: LedgerVerdict<ColdLoadHop>;
  failures: readonly GateFailure[];
  /** Not failures: a ratchet the budget can take. */
  notices: readonly string[];
};

const kib = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;

const LEDGER_HINT =
  "Delete its line from scripts/bundle-startup-ledger.json: the ledger only shrinks.";

/** Runs all four gates; a run passes when `failures` is empty. */
export const evaluateStartup = (
  graph: StartupGraph,
  budget: number,
  ledger: StartupLedger,
  writeHint: string,
): StartupEvaluation => {
  const failures: GateFailure[] = [];
  const notices: string[] = [];

  const initial = checkInitialBudget(initialGzipBytes(graph), budget);
  if (initial.status === "over") {
    failures.push({
      title: "Initial JS over budget",
      message: `The initial chunks are ${kib(initial.measured)} gzip, ${kib(initial.measured - initial.budget)} over the ${kib(initial.budget)} budget (limit +${kib(INITIAL_GROWTH_LIMIT_BYTES)}). Move the new code behind a route, or rebaseline with \`${writeHint}\` and state why every cold visit should pay for it.`,
    });
  } else if (initial.status === "shrunk") {
    notices.push(
      `The initial chunks shrank to ${kib(initial.measured)} gzip from the ${kib(initial.budget)} budget. Run \`${writeHint}\` and commit the lower budget.`,
    );
  }

  const pending = pendingLayer(graph);
  for (const entry of pending.oversized) {
    failures.push({
      title: `Pending view too large: ${entry.module}`,
      message: `${entry.module} puts ${kib(entry.bytes)} minified into the initial chunks; a pending view may use ${kib(PENDING_MODULE_LIMIT_BYTES)}. Keep it to the page's skeleton and import nothing from its page.`,
    });
  }
  if (pending.overTotal) {
    failures.push({
      title: "Pending layer too large",
      message: `The pending views put ${kib(pending.totalBytes)} minified into the initial chunks, over the ${kib(PENDING_TOTAL_LIMIT_BYTES)} total.`,
    });
  }

  const pageCode = reconcileStartupPageCode(startupPageCode(graph), ledger);
  for (const offender of pageCode.unlisted) {
    failures.push({
      title: `Page code at startup: ${offender.module}`,
      message: `${offender.module} (${offender.kind}) puts ${kib(offender.bytes)} minified into the initial chunks. Import the page only from the route's component, and give the pending view its own .pending.tsx module that imports nothing from the page.`,
    });
  }
  for (const key of pageCode.stale) {
    failures.push({
      title: "Ledger line no longer offends",
      message: `${key} no longer puts page code into the initial chunks. ${LEDGER_HINT}`,
    });
  }

  const hops = reconcileColdLoadHops(coldLoadHops(graph), ledger);
  for (const hop of hops.unlisted) {
    failures.push({
      title: `Extra cold-load hop: ${hop.route}`,
      message: `${hop.route} loads ${hop.module} (${hop.chunk}, ${kib(hop.bytes)}) with import() outside its manifest preloads, so a cold visit fetches it only after the route chunk ran. Import the page statically from the route's component and let the router split it.`,
    });
  }
  for (const route of hops.stale) {
    failures.push({
      title: "Ledger line no longer offends",
      message: `${route} no longer loads its page outside its preloads. ${LEDGER_HINT}`,
    });
  }

  return { initial, pending, pageCode, hops, failures, notices };
};

/** The job summary: one row per gate, then every offender. */
export const startupSummary = (evaluation: StartupEvaluation): string => {
  const { initial, pending, pageCode, hops } = evaluation;
  const result = (ok: boolean): string => (ok ? "pass" : "**fail**");
  const lines = [
    "### Startup bundle gates",
    "",
    "| Gate | Measured | Limit | Result |",
    "| --- | ---: | ---: | --- |",
    `| Initial JS (gzip) | ${kib(initial.measured)} | ${kib(initial.budget)} + ${kib(INITIAL_GROWTH_LIMIT_BYTES)} | ${result(initial.status !== "over")} |`,
    `| Pending layer (minified) | ${kib(pending.totalBytes)} in ${pending.modules.length} module(s) | ${kib(PENDING_TOTAL_LIMIT_BYTES)}, ${kib(PENDING_MODULE_LIMIT_BYTES)} each | ${result(pending.oversized.length === 0 && !pending.overTotal)} |`,
    `| Page code at startup | ${pageCode.unlisted.length} new, ${pageCode.listed.length} listed | 0 new | ${result(pageCode.unlisted.length === 0 && pageCode.stale.length === 0)} |`,
    `| Cold-load hops | ${hops.unlisted.length} new, ${hops.listed.length} listed | 0 new | ${result(hops.unlisted.length === 0 && hops.stale.length === 0)} |`,
    "",
  ];
  const rows = [
    ...pageCode.unlisted.map(
      (o) => `| \`${o.module}\` | ${o.kind} | ${kib(o.bytes)} | new |`,
    ),
    ...hops.unlisted.map(
      (h) =>
        `| \`${h.route}\` loads \`${h.module}\` | cold-load hop | ${kib(h.bytes)} | new |`,
    ),
    ...[...pageCode.stale, ...hops.stale].map(
      (key) => `| \`${key}\` | ledger | | stale: delete the line |`,
    ),
    ...pending.oversized.map(
      (p) =>
        `| \`${p.module}\` | pending view | ${kib(p.bytes)} | over the cap |`,
    ),
    ...pageCode.listed.map(
      (o) => `| \`${o.module}\` | ${o.kind} | ${kib(o.bytes)} | listed |`,
    ),
    ...hops.listed.map(
      (h) =>
        `| \`${h.route}\` loads \`${h.module}\` | cold-load hop | ${kib(h.bytes)} | listed |`,
    ),
  ];
  if (rows.length > 0) {
    lines.push(
      "| Offender | Gate | Minified | Ledger |",
      "| --- | --- | ---: | --- |",
      ...rows,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
};
