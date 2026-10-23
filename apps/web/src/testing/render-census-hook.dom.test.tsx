import type * as ReactApi from "react";
import type * as ReactDomApi from "react-dom";
import type * as ReactDomClientApi from "react-dom/client";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import type { RouteNetworkMetrics } from "../../e2e/helpers/network";
import { parseRenderCensus } from "../../e2e/helpers/render-census";
import {
  installRenderCommitHook,
  RENDER_CENSUS_GLOBAL,
} from "../../e2e/helpers/render-census-hook";
import { compareRouteScale } from "../../e2e/helpers/route-scale";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
afterAll(unregisterDomEnvironment);

// React registers with the hook when its renderer module first evaluates, so
// the hook goes in before either build loads.
installRenderCommitHook(RENDER_CENSUS_GLOBAL);
const readCensus = () =>
  parseRenderCensus(Reflect.get(globalThis, RENDER_CENSUS_GLOBAL));

const requireFromHere = createRequire(import.meta.url);
const reactDomRoot = path.dirname(
  requireFromHere.resolve("react-dom/package.json"),
);
// The renderer's own `react` and `react-dom`, so hooks and flushSync share
// its internals whichever build is loaded.
const requireFromReactDom = createRequire(
  path.join(reactDomRoot, "package.json"),
);
const React: typeof ReactApi = requireFromReactDom("react");
const { flushSync }: typeof ReactDomApi = requireFromReactDom("react-dom");

type ReactDomClient = typeof ReactDomClientApi;
// The route walk measures the production build; local runs use development.
const BUILDS = {
  production: "cjs/react-dom-client.production.js",
  development: "cjs/react-dom-client.development.js",
} as const;
const loadClient = (file: string): ReactDomClient =>
  requireFromReactDom(path.join(reactDomRoot, file));
const clients = Object.entries(BUILDS).map(
  ([build, file]) => [build, loadClient(file)] as const,
);

// Host elements only, built outside render: the development `react` would
// otherwise ask the production renderer for an owner it does not track.
const list = (rows: number) =>
  React.createElement(
    "ul",
    null,
    Array.from({ length: rows }, (_, index) =>
      React.createElement("li", { key: index }, `row ${String(index)}`),
    ),
  );

type Root = ReturnType<ReactDomClient["createRoot"]>;
type Mount = (root: Root, rows: number) => void;

// One commit renders every row.
const batched: Mount = (root, rows) => {
  flushSync(() => {
    root.render(list(rows));
  });
};

// The list commits once per row it adds.
const perRow: Mount = (root, rows) => {
  for (let shown = 1; shown <= rows; shown += 1) {
    flushSync(() => {
      root.render(list(shown));
    });
  }
};

/** Commits the census counts while `mount` renders `rows` rows. */
const countCommits = (client: ReactDomClient, mount: Mount, rows: number) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = client.createRoot(container);
  const before = readCensus().commits;
  mount(root, rows);
  const commits = readCensus().commits - before;
  expect(container.querySelectorAll("li")).toHaveLength(rows);
  root.unmount();
  container.remove();
  return commits;
};

const routeRenders = (client: ReactDomClient, mount: Mount) => ({
  renderers: readCensus().renderers,
  commits: countCommits(client, mount, 10),
  dataCommits: countCommits(client, mount, 10),
  roundCommits: [0],
});

const network: RouteNetworkMetrics = {
  requests: ["GET /v1/entities"],
  requestCounts: { "GET /v1/entities": 1 },
  depth: 1,
  depthChain: [["GET /v1/entities"]],
  dbQueries: { "GET /v1/entities": 3 },
  missingDbQueryCounts: {},
  transactions: { "GET /v1/entities": 1 },
  missingTransactionCounts: {},
  responseSizes: { "GET /v1/entities": 2048 },
  missingResponseSizeCounts: {},
  requestCosts: {
    "GET /v1/entities": [
      { dbQueries: 3, transactions: 1, responseBytes: 2048 },
    ],
  },
};

describe("render census hook", () => {
  test("both React builds register with the hook", () => {
    expect(readCensus().renderers).toBe(clients.length);
  });

  for (const [build, client] of clients) {
    describe(`${build} build`, () => {
      test("counts every commit of the root", () => {
        expect(countCommits(client, batched, 10)).toBe(1);
        expect(countCommits(client, perRow, 10)).toBe(10);
      });

      test("a list that commits once per row fails the tenfold comparison", () => {
        const compare = (mount: Mount) => {
          const small = routeRenders(client, mount);
          const large = {
            ...small,
            commits: countCommits(client, mount, 100),
            dataCommits: countCommits(client, mount, 100),
          };
          return compareRouteScale({
            route: "/$workspaceId/entities",
            small: network,
            large: network,
            renders: { small, large },
            ledger: [],
          });
        };
        expect(compare(batched)).toEqual([]);
        const problems = compare(perRow).join("\n");
        expect(problems).toContain("renderCommits $route: small=10, large=100");
        expect(problems).toContain("dataRenderCommits $route");
      });
    });
  }
});
