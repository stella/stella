import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("no-raw-route-query-client", () => {
  test("reports route loader client calls", async () => {
    expect(
      await lintSingleRule(
        "no-raw-route-query-client",
        "const route = { loader: () => qc.ensureQueryData(options), beforeLoad: () => context.queryClient.prefetchQuery(options) };",
      ),
    ).toEqual([1, 1]);
  });
  test("reports imported generic helpers through aliases", async () => {
    expect(
      await lintSingleRule(
        "no-raw-route-query-client",
        'import { ensureCriticalQueryData as ensure } from "@/lib/react-query";\nconst route = { loader: () => ensure(qc, options) };',
      ),
    ).toEqual([2]);
  });
  test("reports pending component subscriptions through aliases", async () => {
    expect(
      await lintSingleRule(
        "no-raw-route-query-client",
        'import { useQuery as read } from "@tanstack/react-query";\nfunction Pending() { return read(options); }\nconst route = { pendingComponent: Pending };',
      ),
    ).toEqual([2]);
  });
  test("accepts route freshness helpers and synchronous cache reads", async () => {
    expect(
      await lintSingleRule(
        "no-raw-route-query-client",
        "const route = { loader: () => ensureRouteQueryData(qc, options), pendingComponent: () => qc.getQueryData(key) };",
      ),
    ).toEqual([]);
  });
  test("accepts client use and subscriptions outside route lifecycle", async () => {
    expect(
      await lintSingleRule(
        "no-raw-route-query-client",
        'import { useQuery } from "@tanstack/react-query";\nfunction Page() { qc.fetchQuery(options); return useQuery(options); }',
      ),
    ).toEqual([]);
  });
});
