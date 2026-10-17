import { expect, test } from "bun:test";

import { collectConformanceTestEvidence } from "./conformance-test-evidence";
import {
  buildResponseConformanceCensus,
  responseConformanceCensusMatches,
} from "./response-conformance-census";
import type { ConformanceSurface } from "./response-conformance-census";

const unresolved = { handler: 0, http: 0, mcp: 0 };
const route = (id: string): ConformanceSurface => ({
  kind: "route",
  id,
  owner: "stella",
  schema: undefined,
  schemaSource: `${id}#hooks.response`,
  httpTests: [],
  handlerTests: [],
  toolTests: [],
});

test("static route exercise counts the union of HTTP and handler channels once", () => {
  const census = buildResponseConformanceCensus(
    [
      { ...route("GET /http"), httpTests: ["http.test.ts"] },
      { ...route("GET /handler"), handlerTests: ["handler.test.ts"] },
      {
        ...route("GET /both"),
        httpTests: ["http.test.ts"],
        handlerTests: ["handler.test.ts"],
      },
      { ...route("GET /tool-only"), toolTests: ["tool.test.ts"] },
      route("GET /none"),
      { ...route("tool"), kind: "mcp", httpTests: ["tool.test.ts"] },
    ],
    unresolved,
  );
  expect(census.counts.routesTotal).toBe(5);
  expect(census.counts.routesExercisedByTests).toBe(3);
  expect(census.counts.routesWithHttpTestCalls).toBe(2);
  expect(census.counts.routesWithHandlerTestCalls).toBe(2);
  expect(census.counts.routesWithoutExecutionEvidence).toBe(5);
  expect(census.runtimeExecutionEvidence).toBe("not-collected");
});

test("an imported endpoint without an invocation gives the census no handler credit", () => {
  const evidence = collectConformanceTestEvidence([
    {
      file: "apps/api/src/tests/fixture.test.ts",
      source:
        'import endpoint from "@/api/handlers/items/read"; // endpoint.handler(context)',
    },
  ]);
  expect(evidence.handlerCalls).toEqual([]);
  const census = buildResponseConformanceCensus(
    [
      {
        ...route("GET /items"),
        handlerTests: evidence.handlerCalls.flatMap((call) => call.tests),
      },
    ],
    evidence.unresolvedCalls,
  );
  expect(census.counts.routesExercisedByTests).toBe(0);
  expect(census.counts.routesWithHandlerTestCalls).toBe(0);
});

test("census freshness ignores formatting and key order but detects content drift", () => {
  const current = {
    counts: { routesTotal: 1 },
    surfaces: [{ id: "GET /items", httpTests: ["items.test.ts"] }],
  };
  const formatted: unknown = JSON.parse(
    '{"surfaces":[{"httpTests":["items.test.ts"],"id":"GET /items"}],"counts":{"routesTotal":1}}',
  );
  expect(responseConformanceCensusMatches(formatted, current)).toBe(true);
  expect(
    responseConformanceCensusMatches(formatted, {
      ...current,
      counts: { routesTotal: 2 },
    }),
  ).toBe(false);
});
