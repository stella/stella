import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  type BuiltChunk,
  checkInitialBudget,
  coldLoadHops,
  convertedRouteCount,
  evaluateStartup,
  INITIAL_GROWTH_LIMIT_BYTES,
  initialGzipBytes,
  PENDING_MODULE_LIMIT_BYTES,
  PENDING_ROUTE_ALLOWANCE_BYTES,
  PENDING_SLACK_BYTES,
  type PendingBudget,
  pendingLayer,
  type StartupGraph,
  type StartupLedger,
  startupLedgerKeys,
  StartupLedgerSchema,
  startupPageCode,
  startupSummary,
} from "./bundle-startup-gates";

const chunk = (
  fileName: string,
  modules: Record<string, number>,
  rest: Partial<Omit<BuiltChunk, "fileName" | "modules">> = {},
): BuiltChunk => ({
  fileName,
  gzipBytes: 0,
  codeBytes: Object.values(modules).reduce((sum, bytes) => sum + bytes, 0),
  modules: new Map(Object.entries(modules)),
  staticImports: [],
  dynamicImports: [],
  ...rest,
});

const graphOf = (
  initial: readonly BuiltChunk[],
  lazy: readonly BuiltChunk[] = [],
  rest: Partial<
    Pick<StartupGraph, "routes" | "routeComponentBytes" | "moduleImports">
  > = {},
): StartupGraph => ({
  initialChunks: initial.map((c) => c.fileName),
  chunks: new Map([...initial, ...lazy].map((c) => [c.fileName, c])),
  routes: [],
  routeComponentBytes: new Map(),
  moduleImports: new Map(),
  ...rest,
});

const EMPTY_LEDGER: StartupLedger = { startupPageCode: [], coldLoadHops: [] };

/** A build with no pending views, measured against a total of zero. */
const NO_PENDING: PendingBudget = {
  committed: 0,
  base: null,
  convertedRoutes: null,
};

describe("initial JS ratchet", () => {
  test("sums the gzip of the initial chunks only", () => {
    const graph = graphOf(
      [
        chunk("index-a.js", {}, { gzipBytes: 500 }),
        chunk("vendor-b.js", {}, { gzipBytes: 9000 }),
      ],
      [chunk("route-c.js", {}, { gzipBytes: 100_000 })],
    );

    expect(initialGzipBytes(graph)).toBe(9500);
  });

  test("fails only past the growth limit and prompts past the same shrink", () => {
    const budget = 1_000_000;

    expect(
      checkInitialBudget(budget + INITIAL_GROWTH_LIMIT_BYTES, budget).status,
    ).toBe("ok");
    expect(
      checkInitialBudget(budget + INITIAL_GROWTH_LIMIT_BYTES + 1, budget)
        .status,
    ).toBe("over");
    expect(
      checkInitialBudget(budget - INITIAL_GROWTH_LIMIT_BYTES, budget).status,
    ).toBe("ok");
    expect(
      checkInitialBudget(budget - INITIAL_GROWTH_LIMIT_BYTES - 1, budget)
        .status,
    ).toBe("shrunk");
  });

  test("an over-budget build fails the run; a shrunk one only notices", () => {
    const over = evaluateStartup(
      graphOf([chunk("index-a.js", {}, { gzipBytes: 20_000 })]),
      { initial: 10_000, pending: NO_PENDING },
      EMPTY_LEDGER,
      "rebaseline",
    );
    const shrunk = evaluateStartup(
      graphOf([chunk("index-a.js", {}, { gzipBytes: 1000 })]),
      { initial: 10_000, pending: NO_PENDING },
      EMPTY_LEDGER,
      "rebaseline",
    );

    expect(over.failures.map((f) => f.title)).toEqual([
      "Initial JS over budget",
    ]);
    expect(shrunk.failures).toEqual([]);
    expect(shrunk.notices).toEqual([expect.stringContaining("rebaseline")]);
  });
});

describe("pending layer", () => {
  test("caps each eager pending view", () => {
    const graph = graphOf([
      chunk("vendor-a.js", {
        "src/routes/a.pending.tsx": PENDING_MODULE_LIMIT_BYTES,
        "src/routes/b.pending.tsx": PENDING_MODULE_LIMIT_BYTES + 1,
      }),
    ]);
    const layer = pendingLayer(graph);

    expect(layer.oversized.map((m) => m.module)).toEqual([
      "src/routes/b.pending.tsx",
    ]);
    expect(layer.totalBytes).toBe(2 * PENDING_MODULE_LIMIT_BYTES + 1);
  });

  test("counts the routes a change took off the exceptions list", () => {
    const base = ["routes/a.tsx", "routes/b.tsx", "routes/c.tsx"];

    expect(convertedRouteCount(base, ["routes/c.tsx"])).toBe(2);
    // A route the change adds back, or one the base never listed, earns nothing.
    expect(convertedRouteCount(base, [...base, "routes/d.tsx"])).toBe(0);
  });
  test("a pending view in a lazy chunk costs the startup nothing", () => {
    const graph = graphOf(
      [chunk("vendor-a.js", { "src/shell.tsx": 1000 })],
      [chunk("route-b.js", { "src/routes/b.pending.tsx": 50_000 })],
    );

    expect(pendingLayer(graph).modules).toEqual([]);
  });
});

describe("page code at startup", () => {
  test("flags page modules, shared route code and eager route components", () => {
    const graph = graphOf(
      [
        chunk("vendor-a.js", {
          "src/routes/law/coverage.page.tsx": 2000,
          "src/routes/law/-coverage/coverage-page.tsx": 1500,
          "src/routes/contacts.tsx?tsr-shared=1": 300,
          "src/routes/contacts.tsx": 900,
          "src/routes/statutes.tsx": 11_000,
          "src/routes/law/coverage.pending.tsx": 800,
          "src/features/settings/settings-page.tsx": 700,
          "src/routes/empty.page.tsx": 0,
        }),
      ],
      [],
      { routeComponentBytes: new Map([["src/routes/statutes.tsx", 10_500]]) },
    );

    expect(startupPageCode(graph)).toEqual([
      {
        kind: "route-component",
        module: "src/routes/statutes.tsx",
        bytes: 10_500,
      },
      {
        kind: "page-module",
        module: "src/routes/law/coverage.page.tsx",
        bytes: 2000,
      },
      {
        kind: "page-module",
        module: "src/routes/law/-coverage/coverage-page.tsx",
        bytes: 1500,
      },
      {
        kind: "tsr-shared",
        module: "src/routes/contacts.tsx?tsr-shared=1",
        bytes: 300,
      },
    ]);
  });

  test("the same modules in a lazy route chunk are not startup code", () => {
    const graph = graphOf(
      [chunk("vendor-a.js", { "src/routes/law/coverage.tsx": 400 })],
      [
        chunk("coverage-b.js", {
          "src/routes/law/coverage.page.tsx": 20_000,
          "src/routes/law/coverage.tsx?tsr-shared=1": 300,
          "src/routes/law/coverage.tsx?tsr-split=component": 120,
        }),
      ],
    );

    expect(startupPageCode(graph)).toEqual([]);
  });
});

describe("cold-load hops", () => {
  const routeChunk = (dynamicImports: BuiltChunk["dynamicImports"]) =>
    chunk(
      "vendor-a.js",
      { "src/routes/cases.tsx": 900, "src/routes/other.tsx": 900 },
      { dynamicImports },
    );
  const page = chunk("cases-page-b.js", {
    "src/routes/cases/-cases-page.tsx": 60_000,
  });
  const split = chunk("cases-c.js", {
    "src/routes/cases.tsx?tsr-split=component": 200,
  });
  const editor = chunk("editor-d.js", {
    "src/features/editor/editor.tsx": 90_000,
  });

  test("a page loaded with import() outside the route's preloads is a hop", () => {
    const graph = graphOf(
      [
        routeChunk([
          { target: "cases-page-b.js", importer: "src/routes/cases.tsx" },
        ]),
      ],
      [page],
      {
        routes: [
          { id: "/cases", filePath: "src/routes/cases.tsx", preloads: [] },
        ],
      },
    );

    expect(coldLoadHops(graph)).toEqual([
      {
        route: "/cases",
        chunk: "cases-page-b.js",
        module: "src/routes/cases/-cases-page.tsx",
        bytes: 60_000,
      },
    ]);
  });

  test("the same import is no hop once the route preloads the page chunk", () => {
    const graph = graphOf(
      [
        routeChunk([
          { target: "cases-page-b.js", importer: "src/routes/cases.tsx" },
        ]),
      ],
      [page],
      {
        routes: [
          {
            id: "/cases",
            filePath: "src/routes/cases.tsx",
            preloads: ["cases-page-b.js"],
          },
        ],
      },
    );

    expect(coldLoadHops(graph)).toEqual([]);
  });

  test("a split component chunk missing from the preloads is a hop", () => {
    const graph = graphOf(
      [
        routeChunk([
          { target: "cases-c.js", importer: "src/routes/cases.tsx" },
        ]),
      ],
      [split],
      {
        routes: [
          { id: "/cases", filePath: "src/routes/cases.tsx", preloads: [] },
        ],
      },
    );

    expect(coldLoadHops(graph).map((hop) => hop.module)).toEqual([
      "src/routes/cases.tsx?tsr-split=component",
    ]);
  });

  test("a hop through a re-export facade names the chunk holding the page", () => {
    const facade = chunk(
      "cases-page-facade-e.js",
      {},
      { staticImports: ["cases-page-b.js"] },
    );
    const graph = graphOf(
      [
        routeChunk([
          {
            target: "cases-page-facade-e.js",
            importer: "src/routes/cases.tsx",
          },
        ]),
      ],
      [facade, page],
      {
        routes: [
          { id: "/cases", filePath: "src/routes/cases.tsx", preloads: [] },
        ],
      },
    );

    expect(coldLoadHops(graph).map((hop) => hop.chunk)).toEqual([
      "cases-page-b.js",
    ]);
  });

  test("a page behind a wrapper chunk or a chain of facades is still a hop", () => {
    // The target has code of its own and imports the page chunk statically.
    const wrapper = chunk(
      "cases-entry-f.js",
      { "src/features/cases/entry.ts": 300 },
      { staticImports: ["cases-facade-g.js"] },
    );
    const facadeOne = chunk(
      "cases-facade-g.js",
      {},
      {
        staticImports: ["cases-facade-h.js"],
      },
    );
    const facadeTwo = chunk(
      "cases-facade-h.js",
      {},
      {
        staticImports: ["cases-page-b.js", "cases-entry-f.js"],
      },
    );
    const graph = graphOf(
      [
        routeChunk([
          { target: "cases-entry-f.js", importer: "src/routes/cases.tsx" },
        ]),
      ],
      [wrapper, facadeOne, facadeTwo, page],
      {
        routes: [
          { id: "/cases", filePath: "src/routes/cases.tsx", preloads: [] },
        ],
      },
    );

    expect(coldLoadHops(graph).map((hop) => hop.chunk)).toEqual([
      "cases-page-b.js",
    ]);
  });

  test("the walk stops at a chunk the document already preloads", () => {
    const wrapper = chunk(
      "cases-entry-f.js",
      { "src/features/cases/entry.ts": 300 },
      { staticImports: ["vendor-a.js"] },
    );
    const shell = chunk(
      "vendor-a.js",
      { "src/routes/cases.tsx": 900, "src/routes/law/coverage.page.tsx": 2000 },
      {
        dynamicImports: [
          { target: "cases-entry-f.js", importer: "src/routes/cases.tsx" },
        ],
      },
    );
    const graph = graphOf([shell], [wrapper], {
      routes: [
        {
          id: "/cases",
          filePath: "src/routes/cases.tsx",
          preloads: ["vendor-a.js"],
        },
      ],
    });

    // The preloaded shell holds a page module, but nothing waits for it.
    expect(coldLoadHops(graph)).toEqual([]);
  });

  describe("an import() in the page or what it imports", () => {
    const pageModule = "src/routes/-cases.page.tsx";
    const helper = "src/routes/-cases/member-loader.ts";
    const unrelated = "src/routes/-other.page.tsx";
    const memberPage = chunk("cases-member-f.js", {
      "src/routes/-cases/member-page.tsx": 40_000,
    });
    const componentChunk = (
      imports: BuiltChunk["dynamicImports"],
    ): BuiltChunk =>
      chunk(
        "cases-c.js",
        {
          "src/routes/cases.tsx?tsr-split=component": 200,
          [pageModule]: 3000,
          [helper]: 300,
          [unrelated]: 3000,
        },
        { dynamicImports: imports },
      );
    const routes = [
      {
        id: "/cases",
        filePath: "src/routes/cases.tsx",
        preloads: ["cases-c.js"],
      },
    ];
    const moduleImports = new Map([
      ["src/routes/cases.tsx?tsr-split=component", [pageModule]],
      [pageModule, [helper]],
    ]);

    test("from the page module is a hop", () => {
      const graph = graphOf(
        [],
        [
          componentChunk([
            { target: "cases-member-f.js", importer: pageModule },
          ]),
          memberPage,
        ],
        { routes, moduleImports },
      );

      expect(coldLoadHops(graph).map((hop) => hop.module)).toEqual([
        "src/routes/-cases/member-page.tsx",
      ]);
    });

    test("from a module the page imports statically is a hop", () => {
      const graph = graphOf(
        [],
        [
          componentChunk([{ target: "cases-member-f.js", importer: helper }]),
          memberPage,
        ],
        { routes, moduleImports },
      );

      expect(coldLoadHops(graph).map((hop) => hop.route)).toEqual(["/cases"]);
    });

    test("from a page the component does not reach is not this route's hop", () => {
      const graph = graphOf(
        [],
        [
          componentChunk([
            { target: "cases-member-f.js", importer: unrelated },
          ]),
          memberPage,
        ],
        { routes, moduleImports },
      );

      expect(coldLoadHops(graph)).toEqual([]);
    });
  });

  test("a lazy feature and another route's import are not this route's page", () => {
    const graph = graphOf(
      [
        routeChunk([
          {
            target: "editor-d.js",
            importer: "src/routes/cases.tsx?tsr-split=component",
          },
          { target: "cases-page-b.js", importer: "src/routes/other.tsx" },
          { target: "cases-page-b.js", importer: undefined },
        ]),
      ],
      [page, editor],
      {
        routes: [
          { id: "/cases", filePath: "src/routes/cases.tsx", preloads: [] },
        ],
      },
    );

    expect(coldLoadHops(graph)).toEqual([]);
  });
});

describe("shrink-only ledger", () => {
  const offending = graphOf(
    [
      chunk(
        "vendor-a.js",
        {
          "src/routes/cases.tsx": 900,
          "src/routes/law/coverage.page.tsx": 2000,
        },
        {
          dynamicImports: [
            { target: "cases-page-b.js", importer: "src/routes/cases.tsx" },
          ],
        },
      ),
    ],
    [chunk("cases-page-b.js", { "src/routes/cases/-cases-page.tsx": 60_000 })],
    {
      routes: [
        { id: "/cases", filePath: "src/routes/cases.tsx", preloads: [] },
      ],
    },
  );
  const ledger: StartupLedger = {
    startupPageCode: [
      {
        kind: "page-module",
        module: "src/routes/law/coverage.page.tsx",
        reason: "pending view imports it",
      },
    ],
    coldLoadHops: [
      {
        route: "/cases",
        module: "src/routes/cases/-cases-page.tsx",
        reason: "hand-written lazy page",
      },
    ],
  };

  test("an exception covers one late page of its route, not a second one", () => {
    const second = graphOf(
      [
        chunk(
          "vendor-a.js",
          {
            "src/routes/cases.tsx": 900,
            "src/routes/law/coverage.page.tsx": 2000,
          },
          {
            dynamicImports: [
              { target: "cases-page-b.js", importer: "src/routes/cases.tsx" },
              { target: "cases-help-c.js", importer: "src/routes/cases.tsx" },
            ],
          },
        ),
      ],
      [
        chunk("cases-page-b.js", {
          "src/routes/cases/-cases-page.tsx": 60_000,
        }),
        chunk("cases-help-c.js", { "src/routes/cases/help.page.tsx": 9000 }),
      ],
      {
        routes: [
          { id: "/cases", filePath: "src/routes/cases.tsx", preloads: [] },
        ],
      },
    );
    const result = evaluateStartup(
      second,
      { initial: 0, pending: NO_PENDING },
      ledger,
      "rebaseline",
    );

    expect(result.hops.listed.map((hop) => hop.module)).toEqual([
      "src/routes/cases/-cases-page.tsx",
    ]);
    expect(result.failures.map((f) => f.title)).toEqual([
      "Extra cold-load hop: /cases",
    ]);
    expect(result.hops.unlisted.map((hop) => hop.module)).toEqual([
      "src/routes/cases/help.page.tsx",
    ]);
  });

  test("the ledger's exceptions keep the identities the gates match on", () => {
    expect(startupLedgerKeys(ledger)).toEqual([
      "page-code page-module src/routes/law/coverage.page.tsx",
      "cold-load-hop /cases src/routes/cases/-cases-page.tsx",
    ]);
    expect(startupLedgerKeys(EMPTY_LEDGER)).toEqual([]);
  });

  test("a listed offender passes and a new one fails", () => {
    const listed = evaluateStartup(
      offending,
      { initial: 0, pending: NO_PENDING },
      ledger,
      "rebaseline",
    );
    const unlisted = evaluateStartup(
      offending,
      { initial: 0, pending: NO_PENDING },
      EMPTY_LEDGER,
      "rebaseline",
    );

    expect(listed.failures).toEqual([]);
    expect(listed.pageCode.listed.map((o) => o.module)).toEqual([
      "src/routes/law/coverage.page.tsx",
    ]);
    expect(unlisted.failures.map((f) => f.title)).toEqual([
      "Page code at startup: src/routes/law/coverage.page.tsx",
      "Extra cold-load hop: /cases",
    ]);
  });

  test("a listed offender that stopped offending fails until its line is deleted", () => {
    const fixed = graphOf([chunk("vendor-a.js", { "src/shell.tsx": 900 })]);
    const result = evaluateStartup(
      fixed,
      { initial: 0, pending: NO_PENDING },
      ledger,
      "rebaseline",
    );

    expect(result.failures.map((f) => f.message)).toEqual([
      expect.stringContaining(
        "page-module src/routes/law/coverage.page.tsx no longer",
      ),
      expect.stringContaining(
        "/cases src/routes/cases/-cases-page.tsx: the route no longer",
      ),
    ]);
  });

  test("an entry without a reason or with an unknown kind is rejected", () => {
    const parse = (entry: unknown) =>
      v.safeParse(StartupLedgerSchema, {
        startupPageCode: [entry],
        coldLoadHops: [],
      }).success;

    expect(
      parse({
        kind: "page-module",
        module: "src/routes/a.page.tsx",
        reason: "why",
      }),
    ).toBe(true);
    expect(
      parse({
        kind: "page-module",
        module: "src/routes/a.page.tsx",
        reason: " ",
      }),
    ).toBe(false);
    expect(
      parse({
        kind: "route-tree",
        module: "src/routes/a.page.tsx",
        reason: "why",
      }),
    ).toBe(false);
  });

  test("the job summary shows the totals and each offender", () => {
    const summary = startupSummary(
      evaluateStartup(
        offending,
        { initial: 0, pending: NO_PENDING },
        EMPTY_LEDGER,
        "rebaseline",
      ),
    );

    expect(summary).toContain(
      "| Page code at startup | 1 new, 0 listed | 0 new | **fail** |",
    );
    expect(summary).toContain(
      "| `src/routes/law/coverage.page.tsx` | page-module | 2.0 KiB | new |",
    );
    expect(summary).toContain(
      "| `/cases` loads `src/routes/cases/-cases-page.tsx` | cold-load hop | 58.6 KiB | new |",
    );
  });
});

describe("pending layer ratchet", () => {
  // Real exception lists: the base branch's, and the change's after it
  // converted `converted` of them.
  const BASE_EXCEPTIONS = [
    "apps/web/src/routes/knowledge/clauses.tsx",
    "apps/web/src/routes/knowledge/index.tsx",
    "apps/web/src/routes/knowledge/route.tsx",
    "apps/web/src/routes/knowledge/styles.tsx",
    "apps/web/src/routes/knowledge/workflows.tsx",
  ];
  const BASE_TOTAL = 200_000;

  /** A startup build whose pending views add up to `total` bytes. */
  const buildWith = (total: number): StartupGraph =>
    graphOf([
      chunk("vendor-a.js", {
        "src/routes/a.pending.tsx": PENDING_MODULE_LIMIT_BYTES,
        "src/shell.pending.tsx": total - PENDING_MODULE_LIMIT_BYTES,
        "src/shell.tsx": 90_000,
      }),
    ]);

  const evaluate = (total: number, converted: number, committed = total) =>
    evaluateStartup(
      buildWith(total),
      {
        initial: 0,
        pending: {
          committed,
          base: BASE_TOTAL,
          convertedRoutes: convertedRouteCount(
            BASE_EXCEPTIONS,
            BASE_EXCEPTIONS.slice(converted),
          ),
        },
      },
      EMPTY_LEDGER,
      "rebaseline",
    );

  const pendingFailures = (result: ReturnType<typeof evaluateStartup>) =>
    result.failures.filter((f) => f.title.startsWith("Pending layer"));

  test("a change that converts N routes may add N times the route allowance and the slack", () => {
    const allowed =
      BASE_TOTAL + 3 * PENDING_ROUTE_ALLOWANCE_BYTES + PENDING_SLACK_BYTES;
    const result = evaluate(allowed, 3);

    expect(result.pendingBudget.convertedRoutes).toBe(3);
    expect(result.pendingBudget.limit).toBe(allowed);
    expect(pendingFailures(result)).toEqual([]);
  });

  test("growth past the allowance fails and names it", () => {
    const limit =
      BASE_TOTAL + 2 * PENDING_ROUTE_ALLOWANCE_BYTES + PENDING_SLACK_BYTES;
    const result = evaluate(limit + 1, 2, BASE_TOTAL);

    expect(pendingFailures(result)).toEqual([
      {
        title: "Pending layer grew past its allowance",
        message: expect.stringContaining(
          "may add 5.0 KiB (2 routes removed from the pending-component exceptions × 2.0 KiB + 1.0 KiB)",
        ),
      },
    ]);
  });

  test("growth with no route converted gets the slack only", () => {
    expect(
      pendingFailures(evaluate(BASE_TOTAL + PENDING_SLACK_BYTES, 0)),
    ).toEqual([]);
    expect(
      pendingFailures(
        evaluate(BASE_TOTAL + PENDING_SLACK_BYTES + 1, 0, BASE_TOTAL),
      ).map((f) => f.title),
    ).toEqual(["Pending layer grew past its allowance"]);
  });

  test("a pure shrink passes and asks for the lower total", () => {
    const result = evaluate(BASE_TOTAL - 10_000, 0, BASE_TOTAL);

    expect(result.pendingBudget.status).toBe("shrunk");
    expect(pendingFailures(result)).toEqual([]);
    expect(result.notices).toEqual([
      expect.stringContaining("shrank to 185.5 KiB"),
    ]);
  });

  test("growth within the allowance the tree does not record fails until it is committed", () => {
    const grown = BASE_TOTAL + PENDING_ROUTE_ALLOWANCE_BYTES;
    const result = evaluate(grown, 1, BASE_TOTAL);

    expect(pendingFailures(result).map((f) => f.title)).toEqual([
      "Pending layer total not recorded",
    ]);
  });

  test("a total the change commits above its base is a re-anchor it has to justify", () => {
    const reanchored = BASE_TOTAL + 50_000;
    const result = evaluate(reanchored, 0, reanchored);

    expect(pendingFailures(result)).toEqual([]);
    expect(result.pendingBudget.reanchored).toBe(true);
    expect(result.notices).toEqual([expect.stringContaining("re-anchored")]);
    expect(startupSummary(result)).toContain(
      "| 245.1 KiB (re-anchored from 195.3 KiB), ",
    );
  });

  test("with no base to read, growth counts from the tree's total with the slack only", () => {
    const missingBase = (total: number) =>
      evaluateStartup(
        buildWith(total),
        {
          initial: 0,
          pending: {
            committed: BASE_TOTAL,
            base: null,
            convertedRoutes: null,
          },
        },
        EMPTY_LEDGER,
        "rebaseline",
      );

    expect(missingBase(BASE_TOTAL + 900).pendingBudget).toMatchObject({
      anchor: BASE_TOTAL,
      allowance: PENDING_SLACK_BYTES,
      status: "ok",
    });
    expect(
      pendingFailures(missingBase(BASE_TOTAL + 5000)).map((f) => f.title),
    ).toEqual(["Pending layer grew past its allowance"]);
  });
});
