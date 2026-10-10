/**
 * The whole HTTP lifecycle, through a real Elysia app: the safe handler, the
 * error hook and the completion hook, with every record, capture and metric
 * line they produce, and the exact bytes of every answer.
 *
 * The response fixtures were recorded against the request pipeline as it
 * answered before failures were graded, so shadow grading is proven not to
 * touch a single response byte.
 */

import { Result } from "better-result";
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { Elysia, status, t } from "elysia";

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
import { initRequestContext } from "@/api/lib/observability/request-context";
import {
  answerRequestError,
  completeRequest,
  flushAnalytics,
  withFinalResponseCompletion,
} from "@/api/lib/observability/request-lifecycle";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { ActionSizeError } from "@/api/lib/rate-limit/action-size-limits";
import { runTenantHttpAction } from "@/api/lib/rate-limit/tenant-action-boundary";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const config = {
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

const buildApp = () =>
  new Elysia()
    .onRequest(({ request }) => {
      initRequestContext(request);
    })
    .onError((context) => answerRequestError(context))
    .onAfterHandle(async (context) => await completeRequest(context))
    .get("/rls", rlsDenied.handler)
    .get("/upstream", upstreamDown.handler)
    .get("/failover", databaseFailover.handler)
    .get("/direct-502", () => status(502, { message: "Bad gateway" }))
    .get("/throws", () => {
      throw pgFailover();
    })
    .post("/typed-body", () => "ok", {
      body: t.Object({ name: t.String() }),
    })
    .get("/typed-response", () => driftedBody(), {
      response: t.Object({ ok: t.String() }),
    });

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

const ungraded = {
  "failure.grade": undefined,
  "failure.reason": undefined,
  "failure.shadow": undefined,
};

const CASES: readonly LifecycleCase[] = [
  {
    name: "an RLS denial is answered 400 and graded a defect",
    request: get("/rls"),
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
    request: get("/upstream"),
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
    captures: 1,
    metricReasons: ["upstream_unavailable"],
  },
  {
    name: "a database failover is answered 500 and graded transient",
    request: get("/failover"),
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
    captures: 1,
    metricReasons: ["pg_connection_lifecycle"],
  },
  {
    name: "a 502 a handler returned itself is counted as unobserved",
    request: get("/direct-502"),
    status: 502,
    body: '{"message":"Bad gateway"}',
    records: [
      ["request.completed", "ERROR", shadow("defect", "unobserved_5xx")],
    ],
    captures: 0,
    metricReasons: [],
  },
  {
    name: "a failover thrown past the safe handler reaches the error hook",
    request: get("/throws"),
    status: 500,
    body: '{"message":"Internal server error"}',
    records: [
      [
        "request.failed",
        "ERROR",
        shadow("transient", "pg_connection_lifecycle"),
      ],
    ],
    captures: 1,
    metricReasons: ["pg_connection_lifecycle"],
  },
  {
    name: "a rejected body is the caller's",
    request: post("/typed-body", JSON.stringify({ name: 42 })),
    status: 422,
    body: '{"message":"Invalid request"}',
    records: [
      ["request.failed", "WARN", shadow("client", "request_validation")],
    ],
    captures: 0,
    metricReasons: [],
  },
  {
    name: "an unparseable body is the caller's",
    request: post("/typed-body", "{"),
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
    request: get("/typed-response"),
    status: 500,
    body: '{"message":"Internal server error"}',
    // The completion hook runs before the response schema is checked, so the
    // handler's 200 is recorded first; that ordering predates grading.
    records: [
      ["request.completed", "INFO", ungraded],
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

  test("records final bounded responses once, including pre-dispatch refusals", async () => {
    for (const mode of [
      "read",
      "mutation",
      "request_refusal",
      "configuration",
    ] as const) {
      logs.records.length = 0;
      metricLines.length = 0;
      const method = mode === "read" ? "GET" : "POST";
      const request = new Request("http://localhost/action", {
        method,
        ...(mode === "request_refusal" ? { body: "body" } : {}),
      });
      const app = new Elysia()
        .onRequest(({ request: received }) => initRequestContext(received))
        .onAfterHandle(async (context) => await completeRequest(context))
        .all("/action", () => ({ value: "é".repeat(300) }));
      const response = await withFinalResponseCompletion(request, async () =>
        runTenantHttpAction(request, {
          enabled: true,
          isTenantAction: () => true,
          policy: () =>
            mode === "configuration"
              ? Result.err(
                  new ActionSizeError({
                    message: "Unconfigured",
                    reason: "configuration",
                  }),
                )
              : Result.ok({ requestBytes: 1, responseBytes: 512, pageSize: 3 }),
          handleRequest: async (received) => app.handle(received),
          decorateRefusal: (refusal, received) => {
            initRequestContext(received);
            return refusal;
          },
        }),
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
      const metrics = metricLines.map((line) => JSON.parse(line));
      expect(
        metrics.filter((record) => "RequestDuration" in record),
      ).toHaveLength(1);
      expect(
        metrics.find((record) => "RequestDuration" in record)?.[
          "http.status_code"
        ],
      ).toBe(expected);
      expect(
        metrics.filter((record) => "ActionResponseOversize" in record),
      ).toHaveLength(mode === "mutation" ? 1 : 0);
      if (mode === "mutation") {
        expect(await response.json()).toEqual({ value: "é".repeat(300) });
      }
    }
  });

  test.each(CASES.map((lifecycle) => [lifecycle.name, lifecycle] as const))(
    "%s",
    async (_name, lifecycle) => {
      const response = await buildApp().handle(lifecycle.request());

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
        metricLines
          .map((line) => JSON.parse(line))
          .filter((record) => "RequestTransientFailures" in record)
          .map((record) => record.reason),
      ).toEqual([...lifecycle.metricReasons]);
      for (const record of logs.records) {
        expect(record.attributes?.["observability.unowned"]).toBeUndefined();
      }
    },
  );

  test("the aggregate counts each observation under the channel it used", async () => {
    const app = buildApp();
    await app.handle(get("/rls")());
    await app.handle(get("/upstream")());
    await app.handle(get("/direct-502")());
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
      ["request.completed", "unobserved_5xx", "log_error", 1],
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
      const response = await buildApp().handle(get("/failover")());

      expect(response.status).toBe(500);
      expect(await response.text()).toBe(
        '{"code":"internal_server_error","message":"Internal server error"}',
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
    // Mounted the way the server mounts it: a `/v1` group around a prefixed
    // plugin, so the hooks see the same full route pattern the class map keys.
    const app = new Elysia()
      .onRequest(({ request }) => {
        initRequestContext(request);
      })
      .onError((context) => answerRequestError(context))
      .onAfterHandle(async (context) => await completeRequest(context))
      .group("/v1", (versioned) =>
        versioned.use(
          new Elysia({ prefix: "/case" })
            .get("/decisions/:decisionId/citations/summary", () => "ok")
            .get("/sitemap/shards", () => {
              throw pgFailover();
            }),
        ),
      );

    await app.handle(get("/v1/case/decisions/d1/citations/summary")());
    await app.handle(get("/v1/case/sitemap/shards")());

    expect(
      metricLines
        .map((line) => JSON.parse(line))
        .filter((record) => "RequestDuration" in record)
        .map((record) => [
          record["http.route"],
          record.class,
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

    await flushAnalytics("/rls");

    expect(analytics.events).toEqual([]);
    expect(
      logs.records.map(({ message, severityText }) => [message, severityText]),
    ).toEqual([["analytics.flush.failed", "ERROR"]]);
  });
});
