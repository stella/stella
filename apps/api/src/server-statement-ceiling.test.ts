import { expect, test } from "bun:test";

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
import api from "@/api/server";

test("mounted read and write requests retain their canonical statement ceiling scope", async () => {
  const requestHooks = api.event.request;
  const originalLength = requestHooks?.length ?? 0;
  api.onRequest(({ request }) => {
    if (
      request.headers.get("x-statement-ceiling-probe") !== "mounted-request"
    ) {
      return undefined;
    }
    queryCountLogger.logQuery("select 1", []);
    return {
      scope: activeStatementCeiling(),
      count: currentQueryCount(),
    };
  });
  api.compile();
  try {
    const routes = api.routes.filter(
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
      const response = await api.handle(
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
  } finally {
    api.event.request?.splice(originalLength);
    api.compile();
  }
});

test("statement allowances name registered routes, queues and scheduler tasks", () => {
  for (const key of Object.keys(ledger.request)) {
    const separator = key.indexOf(" ");
    const method = key.slice(0, separator);
    const path = key.slice(separator + 1);
    expect(
      api.routes.some(
        (route) =>
          route.path === path &&
          (route.method === method || route.method === "ALL"),
      ),
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
