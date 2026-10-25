/**
 * A 5xx built from its cause, through a real `Bun.serve` and the production
 * lifecycle stages: the cause's record carries the request id the completion
 * record carries, the completion record grades the answer by that cause, and
 * the unobserved 5xx grade never fires. A 5xx built without one is enforced:
 * logged at its grade's severity with no shadow flag, and captured.
 */

import { Result } from "better-result";
import { SQL } from "bun";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { Middleware, RouteDefinition } from "@/api/http/route";
import { status } from "@/api/http/status";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { defineEndpoint } from "@/api/lib/endpoints";
import { searchIndexUnavailableResponse } from "@/api/lib/legal-search/search-index-unavailable";
import {
  flushFailureObservations,
  resetFailureObservationsForTesting,
} from "@/api/lib/observability/failure-shadow";
import type { LogRecord } from "@/api/lib/observability/logger";
import { openRequestContext } from "@/api/lib/observability/request-context";
import {
  errorBoundary,
  requestCompletion,
} from "@/api/lib/observability/request-lifecycle";
import { runWithRequestScope } from "@/api/lib/observability/request-scope";
import { ActionSizeError } from "@/api/lib/rate-limit/action-size-limits";
import { tenantActionAdmission } from "@/api/lib/rate-limit/tenant-action-boundary";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "health_infra" },
  cache: { kind: "none" },
} satisfies PublicHandlerConfig;

const requestScope: Middleware = async (_ctx, inner) =>
  await runWithRequestScope(async () => {
    openRequestContext();
    return await inner();
  });

const LIFECYCLE: readonly Middleware[] = [
  requestScope,
  requestCompletion,
  errorBoundary,
];

// The forced fault: the index's database went away mid-read.
const indexFailover = (): Error =>
  new DrizzleQueryError(
    "select 1",
    [],
    new SQL.PostgresError(
      "terminating connection due to administrator command",
      {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "57P01",
        detail: "",
        hint: "",
        severity: "FATAL",
      },
    ),
  );

// A member route is a tenant action, so the admission boundary decides it.
const memberRoute: RouteDefinition = {
  access: "member",
  config: {},
  run: async () => await Promise.resolve({ value: "served" }),
};

const servers: TestServer[] = [];
const serve = (
  middleware: readonly Middleware[],
  table: Parameters<typeof routes>[0],
) => {
  const server = serveForTest(
    createHttpApp({ middleware, routes: routes(table) }),
  );
  servers.push(server);
  return server;
};
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const handlerServer = serve(LIFECYCLE, {
  "/v1/contacts/search": {
    GET: createSafePublicHandler(config, async function* () {
      return Result.ok(searchIndexUnavailableResponse(indexFailover()));
    }),
  },
  "/v1/signals/count": {
    GET: defineEndpoint.public({}, () =>
      status(502, { message: "Bad gateway" }),
    ),
  },
});

const unconfiguredServer = serve(
  [
    ...LIFECYCLE,
    tenantActionAdmission({
      enabled: () => true,
      policy: () =>
        Result.err(
          new ActionSizeError({
            message: "Unconfigured",
            reason: "configuration",
          }),
        ),
    }),
  ],
  { "/v1/mcp/connections": { GET: memberRoute } },
);

const recordNamed = (
  records: readonly LogRecord[],
  message: string,
): LogRecord | undefined =>
  records.find((record) => record.message === message);

describe("a server error answer", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    resetFailureObservationsForTesting();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
    resetFailureObservationsForTesting();
  });

  test.each([
    {
      name: "a handler's 503 from a forced index failover",
      server: () => handlerServer,
      path: "/v1/contacts/search",
      status: 503,
      sink: "legal_search.index_unavailable",
      reason: "pg_connection_lifecycle",
    },
    {
      name: "a stage's 503 for an unconfigured action size policy",
      server: () => unconfiguredServer,
      path: "/v1/mcp/connections",
      status: 503,
      sink: "action_size.unconfigured",
      reason: "tagged_failure",
    },
  ])("logs the cause of $name with the request id", async (served) => {
    const response = await served
      .server()
      .fetch(`http://localhost${served.path}`);
    expect(response.status).toBe(served.status);

    const completion = recordNamed(logs.records, "request.completed");
    const requestId = completion?.attributes?.["request.id"];
    expect(requestId).toMatch(/^req_[0-9a-f]{32}$/u);

    const cause = recordNamed(logs.records, served.sink);
    expect(cause?.attributes?.["request.id"]).toBe(requestId);
    expect(cause?.attributes?.["failure.reason"]).toBe(served.reason);
    expect(cause?.attributes?.["failure.sink"]).toBe(served.sink);

    // The completion record grades the answer by the observed cause.
    expect(completion?.attributes?.["failure.reason"]).toBe(served.reason);

    logs.records.length = 0;
    flushFailureObservations();
    expect(
      logs.records
        .filter((record) => record.message === "failure.observed")
        .map((record) => record.attributes?.["failure.reason"]),
    ).not.toContain("unobserved_5xx");
  });

  test("a 5xx built without its cause is enforced, not shadowed", async () => {
    const response = await handlerServer.fetch(
      "http://localhost/v1/signals/count",
    );
    expect(response.status).toBe(502);

    const completion = recordNamed(logs.records, "request.completed");
    expect(completion?.severityText).toBe("ERROR");
    expect(completion?.attributes?.["failure.reason"]).toBe("unobserved_5xx");
    expect(completion?.attributes?.["failure.policy"]).toBe("grade");
    expect(completion?.attributes?.["failure.shadow"]).toBeUndefined();
    expect(completion?.attributes?.["request.id"]).toMatch(
      /^req_[0-9a-f]{32}$/u,
    );
    expect(analytics.exceptions()).toHaveLength(1);
  });
});
