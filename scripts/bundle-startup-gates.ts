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
//      each stays within PENDING_MODULE_LIMIT_BYTES. Their sum is a ratchet
//      tied to route coverage: against the `pending` total the base branch
//      commits, a change may add PENDING_ROUTE_ALLOWANCE_BYTES for each route
//      it removes from the pending-component exceptions list
//      (.oxlint-plugins/route-pending-component-exceptions.json), plus
//      PENDING_SLACK_BYTES. A change that commits a higher `pending` than
//      its base re-anchors the total, which, as for `initial`, its pull
//      request has to justify. The initial JS ratchet (gate 1) counts the
//      pending layer too and stays binding.
//   3. No page code at startup: no page module, no `?tsr-shared=1` module and
//      no route-file code that only the route's `component` reaches in the
//      initial chunks (see STARTUP_KINDS).
//   4. No extra cold-load hop: the chunk holding a route's page is one of the
//      route's manifest preloads, so the document links it at once instead
//      of the browser discovering it after the route chunk ran. An import()
//      counts wherever the route's code issues it: the route file, its split
//      component, and every app module the component reaches statically (its
//      page module and what that imports).
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
/** What converting one route to its own loading view may add. */
export const PENDING_ROUTE_ALLOWANCE_BYTES = 2 * 1024;
/** Growth any change may add to the pending layer, routes or not. */
export const PENDING_SLACK_BYTES = 1024;

/** A module's minified size in one chunk, keyed by its app-relative id. */
export type BuiltChunk = {
  fileName: string;
  gzipBytes: number;
  /** Minified size: the chunk's length in UTF-8 bytes. */
  codeBytes: number;
  /** Module id (app-relative path, query kept) to minified UTF-8 bytes. */
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
  /**
   * App module id to the app modules it imports statically, type-only
   * imports left out.
   */
  moduleImports: ReadonlyMap<string, readonly string[]>;
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
  };
};

/** What the pending total is measured against. */
export type PendingBudget = {
  /** The `pending` total the checked tree commits. */
  committed: number;
  /** The `pending` total the base branch commits; null when it has none. */
  base: number | null;
  /**
   * Routes the change removed from the pending-component exceptions list
   * against the base branch; null when the base list could not be read.
   */
  convertedRoutes: number | null;
};

export type PendingBudgetResult = {
  /** over: past the limit. unrecorded: grown within it, but the tree does not
   *  commit the new total yet. shrunk: well below the committed total. */
  status: "ok" | "over" | "unrecorded" | "shrunk";
  measured: number;
  /** The total the growth is measured from: the base's, else the tree's. */
  anchor: number;
  /** What the converted routes and the slack allow on top of the anchor. */
  allowance: number;
  convertedRoutes: number;
  limit: number;
  /** The tree commits a total past what its base and its allowance give: a
   *  deliberate re-anchor, which its pull request justifies. */
  reanchored: boolean;
};

/** The growth `convertedRoutes` routes and the slack allow. */
export const pendingAllowanceBytes = (convertedRoutes: number): number =>
  PENDING_ROUTE_ALLOWANCE_BYTES * convertedRoutes + PENDING_SLACK_BYTES;

/** Routes in the base list that the checked list no longer names. */
export const convertedRouteCount = (
  baseExceptions: readonly string[],
  exceptions: readonly string[],
): number => {
  const current = new Set(exceptions);
  return new Set(baseExceptions.filter((route) => !current.has(route))).size;
};

export const checkPendingBudget = (
  measured: number,
  budget: PendingBudget,
): PendingBudgetResult => {
  const convertedRoutes = budget.convertedRoutes ?? 0;
  const allowance = pendingAllowanceBytes(convertedRoutes);
  const anchor = budget.base ?? budget.committed;
  // A change records the total it measures. Recording more than its base and
  // allowance give is the re-anchor a pull request justifies, as for
  // `initial`; recording less is always allowed and changes nothing here,
  // since growth counts from the base.
  const reanchored =
    budget.base !== null && budget.committed > anchor + allowance;
  const limit = reanchored
    ? budget.committed + PENDING_SLACK_BYTES
    : anchor + allowance;
  const result = {
    measured,
    anchor,
    allowance,
    convertedRoutes,
    limit,
    reanchored,
  };
  if (measured > limit) {
    return { status: "over", ...result };
  }
  if (measured > budget.committed + PENDING_SLACK_BYTES) {
    return { status: "unrecorded", ...result };
  }
  if (measured < budget.committed - PENDING_SLACK_BYTES) {
    return { status: "shrunk", ...result };
  }
  return { status: "ok", ...result };
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
 * The chunks an `import()` of `target` fetches late: the target and,
 * transitively, the chunks it imports or re-exports statically, stopping at
 * chunks the document already preloads (whose own static imports the
 * manifest preloads with them).
 */
const lateChunks = (
  graph: StartupGraph,
  target: string,
  preloaded: ReadonlySet<string>,
): BuiltChunk[] => {
  const late: BuiltChunk[] = [];
  const visited = new Set<string>();
  const pending = [target];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file) || preloaded.has(file)) {
      continue;
    }
    visited.add(file);
    const chunk = graph.chunks.get(file);
    if (chunk !== undefined) {
      late.push(chunk);
      pending.push(...chunk.staticImports);
    }
  }
  return late;
};

/** The page or split component module a late chunk holds for a route. */
const pageModuleIn = (
  chunk: BuiltChunk,
  routeFile: string,
): string | undefined =>
  [...chunk.modules.keys()]
    .toSorted(byCodeUnit)
    .find((id) => isSplitComponentModule(id, routeFile) || isPageModule(id));

/**
 * The modules whose `import()` is the route's own: the route file and its
 * split modules, and every module its split component reaches through static
 * imports, which holds the page module and everything the page imports.
 */
export const routeModules = (
  graph: StartupGraph,
  route: Pick<StartupRoute, "filePath">,
): Set<string> => {
  const owned = new Set<string>();
  const pending: string[] = [];
  for (const chunk of graph.chunks.values()) {
    for (const id of chunk.modules.keys()) {
      if (modulePath(id) === route.filePath && !owned.has(id)) {
        owned.add(id);
        if (isSplitComponentModule(id, route.filePath)) {
          pending.push(id);
        }
      }
    }
  }
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const imported of graph.moduleImports.get(id) ?? []) {
      if (!owned.has(imported)) {
        owned.add(imported);
        pending.push(imported);
      }
    }
  }
  return owned;
};

export const coldLoadHops = (graph: StartupGraph): ColdLoadHop[] => {
  const hops: ColdLoadHop[] = [];
  for (const route of graph.routes) {
    const preloaded = new Set(route.preloads);
    const seen = new Set<string>();
    const owned = routeModules(graph, route);
    for (const chunk of graph.chunks.values()) {
      for (const { target, importer } of chunk.dynamicImports) {
        if (importer === undefined || !owned.has(importer)) {
          continue;
        }
        for (const late of lateChunks(graph, target, preloaded)) {
          const page = pageModuleIn(late, route.filePath);
          if (page === undefined || seen.has(late.fileName)) {
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
    (a, b) => byCodeUnit(a.route, b.route) || byCodeUnit(a.module, b.module),
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
  coldLoadHops: v.array(
    v.strictObject({
      route: v.string(),
      /** The late page module; a chunk hash churns, this does not. */
      module: v.string(),
      reason,
    }),
  ),
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

/** One exception per route and late page, so a second late page is new. */
export const hopKey = (entry: { route: string; module: string }): string =>
  `${entry.route} ${entry.module}`;

/**
 * Every exception the ledger grants, as the identities the gates match on.
 * scripts/check-bundle-startup-ledger.ts compares them with the merge base:
 * an identity the base did not grant fails, so the ledger only shrinks.
 */
export const startupLedgerKeys = (ledger: StartupLedger): string[] => [
  ...ledger.startupPageCode.map((entry) => `page-code ${startupKey(entry)}`),
  ...ledger.coldLoadHops.map((entry) => `cold-load-hop ${hopKey(entry)}`),
];

export const reconcileStartupPageCode = (
  offenders: readonly StartupOffender[],
  ledger: StartupLedger,
): LedgerVerdict<StartupOffender> =>
  reconcile(offenders, startupKey, ledger.startupPageCode.map(startupKey));

export const reconcileColdLoadHops = (
  hops: readonly ColdLoadHop[],
  ledger: StartupLedger,
): LedgerVerdict<ColdLoadHop> =>
  reconcile(hops, hopKey, ledger.coldLoadHops.map(hopKey));

// --- Evaluation ----------------------------------------------------------------------

export type GateFailure = { title: string; message: string };

export type StartupEvaluation = {
  initial: InitialBudgetResult;
  pending: PendingLayer;
  pendingBudget: PendingBudgetResult;
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
/** What the startup totals are measured against. */
export type StartupBudget = {
  /** The committed gzip budget of the initial chunks. */
  initial: number;
  pending: PendingBudget;
};

export const evaluateStartup = (
  graph: StartupGraph,
  { initial: budget, pending: pendingBudgetInput }: StartupBudget,
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
  const pendingBudget = checkPendingBudget(
    pending.totalBytes,
    pendingBudgetInput,
  );
  const routes = (count: number) => `${count} route${count === 1 ? "" : "s"}`;
  const allowanceText = `${kib(pendingBudget.allowance)} (${routes(pendingBudget.convertedRoutes)} removed from the pending-component exceptions × ${kib(PENDING_ROUTE_ALLOWANCE_BYTES)} + ${kib(PENDING_SLACK_BYTES)})`;
  if (pendingBudget.status === "over") {
    failures.push({
      title: "Pending layer grew past its allowance",
      message: `The pending views put ${kib(pendingBudget.measured)} minified into the initial chunks, ${kib(pendingBudget.measured - pendingBudget.anchor)} over the ${kib(pendingBudget.anchor)} the base commits; this change may add ${allowanceText}. Trim the loading views, or re-anchor \`pending\` with \`${writeHint}\` and state why, as for \`initial\`.`,
    });
  } else if (pendingBudget.status === "unrecorded") {
    failures.push({
      title: "Pending layer total not recorded",
      message: `The pending views put ${kib(pendingBudget.measured)} minified into the initial chunks, within this change's allowance of ${allowanceText}, but \`pending\` still records ${kib(pendingInputCommitted(pendingBudgetInput))}. Run \`${writeHint}\` and commit it, so the next change is measured from here.`,
    });
  } else if (pendingBudget.status === "shrunk") {
    notices.push(
      `The pending views shrank to ${kib(pendingBudget.measured)} minified from the committed ${kib(pendingInputCommitted(pendingBudgetInput))}. Run \`${writeHint}\` and commit the lower total.`,
    );
  }
  if (pendingBudget.reanchored) {
    notices.push(
      `\`pending\` is re-anchored to ${kib(pendingInputCommitted(pendingBudgetInput))} from the base's ${kib(pendingBudget.anchor)}: state in the pull request why every cold visit should pay for it, as for \`initial\`.`,
    );
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
  for (const key of hops.stale) {
    failures.push({
      title: "Ledger line no longer offends",
      message: `${key}: the route no longer loads that page outside its preloads. ${LEDGER_HINT}`,
    });
  }

  return {
    initial,
    pending,
    pendingBudget,
    pageCode,
    hops,
    failures,
    notices,
  };
};

// A re-anchored limit is the committed total plus the slack, not the base's
// anchor plus the route allowance, so the row names the limit the gate used.
const pendingLimitText = (budget: PendingBudgetResult): string =>
  budget.reanchored
    ? `${kib(budget.limit)} (re-anchored from ${kib(budget.anchor)})`
    : `${kib(budget.anchor)} + ${kib(budget.allowance)} (${budget.convertedRoutes} route(s) converted)`;

const pendingInputCommitted = (budget: PendingBudget): number =>
  budget.committed;

/** The job summary: one row per gate, then every offender. */
export const startupSummary = (evaluation: StartupEvaluation): string => {
  const { initial, pending, pendingBudget, pageCode, hops } = evaluation;
  const result = (ok: boolean): string => (ok ? "pass" : "**fail**");
  const lines = [
    "### Startup bundle gates",
    "",
    "| Gate | Measured | Limit | Result |",
    "| --- | ---: | ---: | --- |",
    `| Initial JS (gzip) | ${kib(initial.measured)} | ${kib(initial.budget)} + ${kib(INITIAL_GROWTH_LIMIT_BYTES)} | ${result(initial.status !== "over")} |`,
    `| Pending layer (minified) | ${kib(pending.totalBytes)} in ${pending.modules.length} module(s) | ${pendingLimitText(pendingBudget)}, ${kib(PENDING_MODULE_LIMIT_BYTES)} each | ${result(pending.oversized.length === 0 && pendingBudget.status !== "over" && pendingBudget.status !== "unrecorded")} |`,
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
