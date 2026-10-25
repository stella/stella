/**
 * The whole HTTP lifecycle, through a real `Bun.serve`: the safe handler, the
 * error boundary and the completion stage, with every record, capture and
 * metric line they produce, and the exact bytes of every answer.
 *
 * The response fixtures were recorded against the request pipeline as it
 * answered before failures were graded, so shadow grading is proven not to
 * touch a single response byte.
 */

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
} from "better-auth/api";
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
import * as v from "valibot";

import { createHttpApp } from "@/api/http/app";
import type { HttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { Middleware, RouteDefinition } from "@/api/http/route";
import { status } from "@/api/http/status";
import { resetCaptureWindows } from "@/api/lib/analytics/capture";
import {
  resetAnalyticsForTesting,
  setAnalyticsForTesting,
} from "@/api/lib/analytics/client";
import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { AUTH_API_PATH } from "@/api/lib/auth/auth-paths";
import {
  createAuthRefusalLogPlugin,
  markAuthRequestRoute,
} from "@/api/lib/auth/auth-request-observability";
import { defineEndpoint } from "@/api/lib/endpoints";
import {
  DatabaseError,
  DatabaseRlsError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import {
  flushFailureObservations,
  resetFailureObservationsForTesting,
} from "@/api/lib/observability/failure-shadow";
import type { LogRecord } from "@/api/lib/observability/logger";
import { openRequestContext } from "@/api/lib/observability/request-context";
import {
  errorBoundary,
  flushAnalytics,
  requestCompletion,
} from "@/api/lib/observability/request-lifecycle";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
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

const pgFailover = (): Error =>
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

const rlsDenied = createSafePublicHandler(config, async function* () {
  return Result.err(new DatabaseRlsError({ message: "row denied" }));
});

const upstreamDown = createSafePublicHandler(config, async function* () {
  return Result.err(
    new HandlerError({
      status: 502,
      code: "upstream_unavailable",
      message: "The registry is not answering right now.",
    }),
  );
});

const databaseFailover = createSafePublicHandler(config, async function* () {
  return Result.err(
    new DatabaseError({ message: "query failed", cause: pgFailover() }),
  );
});

const driftedBody = (): { ok: string } => JSON.parse('{"unexpected":true}');

/**
 * The request scope and receipt id, opened outside the completion stage as
 * the production pipeline opens them.
 */
const requestScope: Middleware = async (_ctx, inner) =>
  await runWithRequestScope(async () => {
    openRequestContext();
    return await inner();
  });

/** The lifecycle stages in their production order. */
const LIFECYCLE: readonly Middleware[] = [
  requestScope,
  requestCompletion,
  errorBoundary,
];

const servers: TestServer[] = [];
const serve = (app: HttpApp): TestServer => {
  const server = serveForTest(app);
  servers.push(server);
  return server;
};
afterAll(async () => {
  await Promise.all(servers.map(async (server) => await server.stop()));
});

const failoverEndpoint = (): RouteDefinition =>
  defineEndpoint.public({}, () => {
    throw pgFailover();
  });

// Use registered CRUD patterns so these fixture handlers also cross the
// production classification boundary. Their responses remain test-owned.
const lifecycleServer = serve(
  createHttpApp({
    middleware: LIFECYCLE,
    routes: routes({
      "/v1/contacts/": { GET: rlsDenied },
      "/v1/notifications/": { GET: upstreamDown },
      "/v1/signals/": { GET: databaseFailover },
      "/v1/signals/count": {
        GET: defineEndpoint.public({}, () =>
          status(502, { message: "Bad gateway" }),
        ),
      },
      "/v1/contacts/search": { GET: failoverEndpoint() },
      "/v1/signals/requests": {
        POST: defineEndpoint.public(
          { body: v.object({ name: v.string() }) },
          () => "ok",
        ),
      },
      "/v1/auth/capabilities": {
        GET: defineEndpoint.public(
          { response: { 200: v.object({ ok: v.string() }) } },
          () => driftedBody(),
        ),
      },
    }),
  }),
);

type AuthHandler = { handler: (request: Request) => Promise<Response> };

/** Better Auth mounted the way the API mounts it: one wildcard route. */
const serveAuth = (auth: AuthHandler): TestServer =>
  serve(
    createHttpApp({
      middleware: LIFECYCLE,
      routes: routes({
        [`${AUTH_API_PATH}/*`]: {
          GET: defineEndpoint.public(
            { bodyMode: "none" },
            async ({ request }) => await auth.handler(request),
          ),
        },
      }),
    }),
  );

type LifecycleCase = {
  readonly name: string;
  readonly request: () => Request;
  readonly status: number;
  /** Recorded before grading existed; byte-for-byte. */
  readonly body: string;
  /** Message, severity and failure fields of every record, in order. */
  readonly records: readonly (readonly [
    string,
    string,
    Record<string, unknown>,
  ])[];
  readonly captures: number;
  readonly metricReasons: readonly string[];
};

const get = (path: string) => () => new Request(`http://localhost${path}`);
const post = (path: string, body: string) => () =>
  new Request(`http://localhost${path}`, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const shadow = (grade: string, reason: string) => ({
  "failure.grade": grade,
  "failure.reason": reason,
  "failure.shadow": "true",
});

const CASES: readonly LifecycleCase[] = [
  {
    name: "an RLS denial is answered 400 and graded a defect",
    request: get("/v1/contacts/"),
    status: 400,
    body: '{"code":"access_denied","message":"Access denied"}',
    records: [
      ["request.failed", "WARN", shadow("defect", "rls_denied")],
      ["request.completed", "WARN", shadow("defect", "rls_denied")],
    ],
    captures: 1,
    metricReasons: [],
  },
  {
    name: "an unavailable upstream is answered 502 and graded transient",
    request: get("/v1/notifications/"),
    status: 502,
    body: '{"code":"upstream_unavailable","message":"The registry is not answering right now."}',
    records: [
      ["request.failed", "ERROR", shadow("transient", "upstream_unavailable")],
      [
        "request.completed",
        "ERROR",
        shadow("transient", "upstream_unavailable"),
      ],
    ],
    captures: 0,
    metricReasons: ["upstream_unavailable"],
  },
  {
    name: "a database failover is answered 500 and graded transient",
    request: get("/v1/signals/"),
    status: 500,
    body: '{"code":"internal_server_error","message":"Internal server error"}',
    records: [
      [
        "request.failed",
        "ERROR",
        shadow("transient", "pg_connection_lifecycle"),
      ],
      [
        "request.completed",
        "ERROR",
        shadow("transient", "pg_connection_lifecycle"),
      ],
    ],
    captures: 0,
    metricReasons: ["pg_connection_lifecycle"],
  },
  {
    name: "a 502 a handler built without its cause is enforced as unobserved",
    request: get("/v1/signals/count"),
    status: 502,
    body: '{"message":"Bad gateway"}',
    records: [
      [
        "request.completed",
        "ERROR",
        {
          "failure.grade": "defect",
          "failure.reason": "unobserved_5xx",
          "failure.shadow": undefined,
        },
      ],
    ],
    captures: 1,
    metricReasons: [],
  },
  {
    name: "a failover thrown past the safe handler reaches the error boundary",
    request: get("/v1/contacts/search"),
    status: 500,
    body: '{"message":"Internal server error"}',
    records: [
      [
        "request.failed",
        "ERROR",
        shadow("transient", "pg_connection_lifecycle"),
      ],
    ],
    captures: 0,
    metricReasons: ["pg_connection_lifecycle"],
  },
  {
    name: "a rejected body is the caller's",
    request: post("/v1/signals/requests", JSON.stringify({ name: 42 })),
    status: 422,
    body: '{"message":"Invalid request","code":"validation","issues":[{"field":"name","constraint":"invalid"}]}',
    records: [
      ["request.failed", "WARN", shadow("client", "request_validation")],
    ],
    captures: 0,
    metricReasons: [],
  },
  {
    name: "an unparseable body is the caller's",
    request: post("/v1/signals/requests", "{"),
    status: 400,
    body: '{"message":"Malformed request"}',
    records: [
      ["request.failed", "WARN", shadow("client", "request_malformed")],
    ],
    captures: 0,
    metricReasons: [],
  },
  {
    name: "an unrouted path is the caller's",
    request: get("/nowhere"),
    status: 404,
    body: '{"message":"Not found"}',
    records: [["request.failed", "WARN", shadow("client", "route_not_found")]],
    captures: 0,
    metricReasons: [],
  },
  {
    name: "a response that breaks its own schema is the handler's",
    request: get("/v1/auth/capabilities"),
    status: 500,
    body: '{"message":"Internal server error"}',
    // The answer is checked against its schema inside the error boundary, so
    // the request has one record, the failure, and never a 200 before it.
    records: [
      ["request.failed", "ERROR", shadow("defect", "response_invalid")],
    ],
    captures: 1,
    metricReasons: [],
  },
];

type FailureView = [string, string, Record<string, unknown>];

const failureView = (record: LogRecord): FailureView => {
  const attributes = record.attributes ?? {};
  return [
    record.message,
    record.severityText,
    {
      "failure.grade": attributes["failure.grade"],
      "failure.reason": attributes["failure.reason"],
      "failure.shadow": attributes["failure.shadow"],
    },
  ];
};

const metricRecords = (
  lines: readonly string[],
  metric: string,
): Record<string, unknown>[] =>
  lines
    .map((line): Record<string, unknown> => JSON.parse(line))
    .filter((record) => metric in record);

describe("the request lifecycle", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;
  let metricLines: string[];

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    metricLines = [];
    setMetricLineSinkForTesting((line) => {
      metricLines.push(line);
    });
    resetFailureObservationsForTesting();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
    resetMetricLineSinkForTesting();
    resetFailureObservationsForTesting();
  });

  test("framework errors retain declared route scope across moved source lines", async () => {
    let sourceLine = 10;
    const fail = () => {
      const error = new Error("Framework handler failed");
      error.stack = `Error: Framework handler failed\n    at sharedOperation (/app/operation.ts:${sourceLine}:9)`;
      throw error;
    };
    const app = serve(
      createHttpApp({
        middleware: LIFECYCLE,
        routes: routes({
          "/first/:id": { GET: defineEndpoint.public({}, fail) },
          "/second/:id": { GET: defineEndpoint.public({}, fail) },
        }),
      }),
    );
    for (const path of ["/first/private-first", "/second/private-second"]) {
      const response = await app.fetch(
        new Request(`https://example.test${path}`),
      );
      expect(response.status).toBe(500);
    }
    const original = analytics.exceptions();
    expect(original).toHaveLength(2);
    const first = original.at(0)?.properties["$exception_fingerprint"];
    expect(first).toContain("/first/:id");
    expect(original.at(1)?.properties["$exception_fingerprint"]).toContain(
      "/second/:id",
    );
    expect(first).not.toBe(
      original.at(1)?.properties["$exception_fingerprint"],
    );
    sourceLine += 50;
    resetCaptureWindows();
    await app.fetch(new Request("https://example.test/first/private-third"));
    const shifted = analytics.exceptions();
    expect(shifted).toHaveLength(3);
    expect(shifted.at(2)?.properties["$exception_fingerprint"]).toBe(first);
    expect(shifted.at(2)?.properties["error.frame"]).not.toBe(
      shifted.at(0)?.properties["error.frame"],
    );
    expect(JSON.stringify(shifted)).not.toContain("private-first");
    expect(JSON.stringify(shifted)).not.toContain("private-second");
    expect(JSON.stringify(shifted)).not.toContain("private-third");
  });

  test("nested server-side auth calls cannot replace the outer HTTP route", async () => {
    const visitedPaths: (string | undefined)[] = [];
    const auth = betterAuth({
      baseURL: "http://localhost:3001",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          visitedPaths.push(ctx.path);
          markAuthRequestRoute(ctx);
          await Promise.resolve();
        }),
      },
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      plugins: [
        {
          id: "nested-auth-fixture",
          endpoints: {
            nestedAuth: createAuthEndpoint(
              "/outer/:id",
              { method: "GET" },
              async () => {
                await nestedCall();
                throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
              },
            ),
          },
        },
      ],
    });
    const nestedCall = async (): Promise<void> => {
      await auth.api.getSession({ headers: new Headers() });
    };
    const server = serveAuth(auth);

    const response = await server.fetch(
      "http://localhost/api/auth/outer/fixture-id",
    );
    expect(response.status).toBe(400);
    expect(visitedPaths).toEqual(["/outer/:id", "/get-session"]);
    expect(
      logs.records.find(({ message }) => message === "request.completed")
        ?.attributes?.["http.route"],
    ).toBe("/api/auth/outer/:id");
    expect(
      metricRecords(metricLines, "RequestDuration").at(0)?.["http.route"],
    ).toBe("/api/auth/outer/:id");

    logs.records.length = 0;
    await server.fetch("http://localhost/api/auth/get-session");
    expect(
      logs.records.find(({ message }) => message === "request.completed")
        ?.attributes?.["http.route"],
    ).toBe("/api/auth/get-session");
  });

  test.each(["before", "handler"] as const)(
    "identifies %s auth refusals by registered template and receipt without request data",
    async (refusalSource) => {
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        hooks: {
          before: createAuthMiddleware(async (ctx) => {
            markAuthRequestRoute(ctx);
            if (refusalSource === "before") {
              throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
            }
            await Promise.resolve();
          }),
        },
        database: memoryAdapter({
          user: [],
          session: [],
          account: [],
          verification: [],
        }),
        plugins: [
          createAuthRefusalLogPlugin(createAuthMiddleware),
          {
            id: "refused-auth-fixture",
            endpoints: {
              refusedToken: createAuthEndpoint(
                "/fixture/:id",
                { method: "GET" },
                () => {
                  throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
                },
              ),
            },
          },
        ],
      });
      const server = serveAuth(auth);
      const response = await server.fetch(
        "http://localhost/api/auth/fixture/private-id?token=private-token",
      );
      expect(response.status).toBe(400);
      const completion = logs.records.find(
        ({ message }) => message === "request.completed",
      );
      const refusal = logs.records.find(
        ({ message }) => message === "auth.request_refused",
      );
      expect(completion?.attributes?.["http.route"]).toBe(
        "/api/auth/fixture/:id",
      );
      expect(completion?.attributes?.["request.id"]).toMatch(
        /^req_[0-9a-f]{32}$/u,
      );
      if (refusalSource === "handler") {
        expect(refusal?.attributes?.["auth.path"]).toBe("/fixture/:id");
        expect(refusal?.attributes?.["request.id"]).toBe(
          completion?.attributes?.["request.id"],
        );
      }
      const serialized = JSON.stringify({ records: logs.records, metricLines });
      expect(serialized).not.toContain("private-id");
      expect(serialized).not.toContain("private-token");
      expect(
        metricRecords(metricLines, "RequestDuration").at(0)?.["http.route"],
      ).toBe("/api/auth/fixture/:id");

      // A path no auth endpoint registers is named by the mounted wildcard.
      logs.records.length = 0;
      await server.fetch(
        "http://localhost/api/auth/unregistered/private-other",
      );
      expect(
        logs.records.find(({ message }) => message === "request.completed")
          ?.attributes?.["http.route"],
      ).toBe(`${AUTH_API_PATH}/*`);
      expect(JSON.stringify(logs.records)).not.toContain("private-other");
    },
  );

  test("records final bounded responses once, including pre-dispatch refusals", async () => {
    for (const mode of [
      "read",
      "mutation",
      "request_refusal",
      "configuration",
    ] as const) {
      logs.records.length = 0;
      metricLines.length = 0;
      // A member route is a tenant action; the fixture answers without a
      // caller check, so only the admission boundary decides.
      const connections: RouteDefinition = {
        access: "member",
        config: {},
        run: async () => await Promise.resolve({ value: "é".repeat(300) }),
      };
      const server = serve(
        createHttpApp({
          middleware: [
            ...LIFECYCLE,
            tenantActionAdmission({
              enabled: () => true,
              policy: () =>
                mode === "configuration"
                  ? Result.err(
                      new ActionSizeError({
                        message: "Unconfigured",
                        reason: "configuration",
                      }),
                    )
                  : Result.ok({
                      requestBytes: 1,
                      responseBytes: 512,
                      pageSize: 3,
                    }),
            }),
          ],
          routes: routes({
            "/v1/mcp/connections": { GET: connections, POST: connections },
          }),
        }),
      );
      const response = await server.fetch(
        "http://localhost/v1/mcp/connections",
        {
          method: mode === "read" ? "GET" : "POST",
          ...(mode === "request_refusal" ? { body: "body" } : {}),
        },
      );
      const expectedByMode = {
        read: 413,
        mutation: 200,
        request_refusal: 413,
        configuration: 503,
      } as const;
      const expected = expectedByMode[mode];
      expect(response.status).toBe(expected);
      const completions = logs.records.filter(
        (record) => record.message === "request.completed",
      );
      expect(completions).toHaveLength(1);
      expect(completions.at(0)?.attributes?.["http.status_code"]).toBe(
        expected,
      );
      const durations = metricRecords(metricLines, "RequestDuration");
      expect(durations).toHaveLength(1);
      expect(durations.at(0)?.["http.status_code"]).toBe(expected);
      expect(metricRecords(metricLines, "ActionResponseOversize")).toHaveLength(
        mode === "mutation" ? 1 : 0,
      );
      if (mode === "mutation") {
        expect(await response.json()).toEqual({ value: "é".repeat(300) });
      }
    }
  });

  test.each(CASES.map((lifecycle) => [lifecycle.name, lifecycle] as const))(
    "%s",
    async (_name, lifecycle) => {
      const response = await lifecycleServer.fetch(lifecycle.request());

      expect(response.status).toBe(lifecycle.status);
      expect(await response.text()).toBe(lifecycle.body);
      expect(logs.records.map(failureView)).toEqual(
        lifecycle.records.map(([message, severity, fields]): FailureView => [
          message,
          severity,
          fields,
        ]),
      );
      expect(analytics.exceptions()).toHaveLength(lifecycle.captures);
      expect(
        metricRecords(metricLines, "RequestTransientFailures").map(
          (record) => record["reason"],
        ),
      ).toEqual([...lifecycle.metricReasons]);
      for (const record of logs.records) {
        expect(record.attributes?.["observability.unowned"]).toBeUndefined();
      }
    },
  );

  test("the aggregate counts each observation under the channel it used", async () => {
    await lifecycleServer.fetch(get("/v1/contacts/")());
    await lifecycleServer.fetch(get("/v1/notifications/")());
    await lifecycleServer.fetch(get("/v1/signals/count")());
    logs.records.length = 0;

    flushFailureObservations();

    expect(
      logs.records.map(({ attributes }) => [
        attributes?.["failure.sink"],
        attributes?.["failure.reason"],
        attributes?.["failure.legacy_channel"],
        attributes?.["occurrences"],
      ]),
    ).toEqual([
      ["request.handler_failed", "rls_denied", "log_warn_and_capture", 1],
      [
        "request.handler_failed",
        "upstream_unavailable",
        "log_error_and_capture",
        1,
      ],
      ["request.completed", "unobserved_5xx", "log_error_and_capture", 1],
    ]);
  });

  test("a failing exception tracker cannot replace the answer", async () => {
    resetCaptureWindows();
    setAnalyticsForTesting({
      capture: () => {
        throw new TypeError("tracker down");
      },
      identifyOrganizationGroup: () => undefined,
      flush: async () => await Promise.resolve(),
    });
    try {
      const response = await lifecycleServer.fetch(get("/v1/contacts/")());

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        '{"code":"access_denied","message":"Access denied"}',
      );
      expect(
        logs.records
          .filter(({ message }) => message === "observability.emit_failed")
          .map(({ attributes }) => attributes?.["observability.stage"]),
      ).toEqual(["capture"]);
    } finally {
      resetAnalyticsForTesting();
      resetCaptureWindows();
    }
  });

  test("measures a declared route under its class on the completion and error paths", async () => {
    // Mounted the way the API mounts it, under a prefix, so the stages see the
    // same full route pattern the class map keys.
    const server = serve(
      createHttpApp({
        middleware: LIFECYCLE,
        routes: routes(
          {
            "/decisions/:decisionId/citations/summary": {
              GET: defineEndpoint.public({}, () => "ok"),
            },
            "/sitemap/shards": { GET: failoverEndpoint() },
          },
          { prefix: "/v1/case" },
        ),
      }),
    );

    await server.fetch(get("/v1/case/decisions/d1/citations/summary")());
    await server.fetch(get("/v1/case/sitemap/shards")());

    expect(
      metricRecords(metricLines, "RequestDuration").map((record) => [
        record["http.route"],
        record["class"],
        "_aws" in record,
      ]),
    ).toEqual([
      ["/v1/case/decisions/:decisionId/citations/summary", "search", true],
      ["/v1/case/sitemap/shards", "batch", false],
    ]);
  });

  test("a failed analytics flush is logged and never captured", async () => {
    setAnalyticsForTesting({
      capture: (params) => {
        analytics.events.push(params);
      },
      identifyOrganizationGroup: () => undefined,
      flush: async () => {
        await Promise.resolve();
        throw new TypeError("flush failed");
      },
    });

    await flushAnalytics("/v1/contacts/");

    expect(analytics.events).toEqual([]);
    expect(
      logs.records.map(({ message, severityText }) => [message, severityText]),
    ).toEqual([["analytics.flush.failed", "ERROR"]]);
  });
});
