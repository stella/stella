import { expect, test } from "bun:test";

import { apiPipeline } from "@/api/api-pipeline";
import { apiRoutes } from "@/api/api-routes";
import { createHttpApp } from "@/api/http/app";
import { toResponse } from "@/api/http/respond";
import type { Middleware } from "@/api/http/route";
import { BULLMQ_QUEUE_HOSTS } from "@/api/lib/bullmq-queue";
import {
  currentQueryCount,
  queryCountLogger,
} from "@/api/lib/db-query-counter";
import {
  activeStatementCeiling,
  statementCeilingMeasurements,
} from "@/api/lib/db/statement-ceiling";
import ledger from "@/api/lib/db/statement-ceiling.json";
import { REGISTERED_SCHEDULER_TASK_NAMES } from "@/api/lib/scheduler/registry";
import { serveForTest } from "@/api/tests/helpers/test-server";

test("mounted read and write requests retain their canonical statement ceiling scope", async () => {
  const probe: Middleware = async ({ request, set }, inner) => {
    if (
      request.headers.get("x-statement-ceiling-probe") !== "mounted-request"
    ) {
      return await inner();
    }
    queryCountLogger.logQuery("select 1", []);
    return toResponse(
      { scope: activeStatementCeiling(), count: currentQueryCount() },
      set,
    );
  };
  await using server = serveForTest(
    createHttpApp({
      // Probe within the production request scope, before admission or auth.
      middleware: apiPipeline.flatMap((middleware, index) =>
        index === 0 ? [middleware, probe] : [middleware],
      ),
      routes: apiRoutes,
    }),
  );
  const routes = apiRoutes.filter(
    ({ method, path }) =>
      path.startsWith("/v1/contacts") &&
      (method === "GET" ||
        method === "POST" ||
        method === "PATCH" ||
        method === "DELETE"),
  );
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    // Concrete parameter values must share the declared route's identity.
    const path = route.path.replace(/:[^/]+/gu, "ceiling-probe");
    const response = await server.fetch(
      new Request(`http://localhost${path}`, {
        method: route.method,
        headers: { "x-statement-ceiling-probe": "mounted-request" },
      }),
    );
    expect(await response.json()).toEqual({
      scope: { kind: "request", key: `${route.method} ${route.path}` },
      count: 1,
    });
    expect(
      statementCeilingMeasurements()[`request ${route.method} ${route.path}`],
    ).toBe(1);
  }
});

test("statement allowances name registered routes, queues and scheduler tasks", () => {
  for (const key of Object.keys(ledger.request)) {
    const separator = key.indexOf(" ");
    const method = key.slice(0, separator);
    const path = key.slice(separator + 1);
    expect(
      apiRoutes.some((route) => route.path === path && route.method === method),
      `Stale request allowance: ${key}`,
    ).toBe(true);
  }
  for (const name of Object.keys(ledger.worker)) {
    expect(name in BULLMQ_QUEUE_HOSTS, `Stale worker allowance: ${name}`).toBe(
      true,
    );
  }
  for (const name of Object.keys(ledger.scheduler)) {
    expect(
      REGISTERED_SCHEDULER_TASK_NAMES.has(name),
      `Stale scheduler allowance: ${name}`,
    ).toBe(true);
  }
});
