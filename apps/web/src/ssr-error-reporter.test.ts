import { expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";
import {
  createSsrErrorReporter,
  createSsrRouteFailureReporter,
  describeSsrRouteFailure,
} from "@/ssr-error-reporter";

test("SSR diagnostics precede analytics and survive analytics failures", () => {
  const diagnostics: string[] = [];
  const captured: unknown[] = [];
  const renderFailure = new TypeError("Sensitive renderer message");
  const analyticsFailure = new RangeError("Sensitive telemetry message");
  const report = createSsrErrorReporter({
    writeDiagnostic: (line) => {
      diagnostics.push(line);
    },
    captureError: (error) => {
      expect(diagnostics).toHaveLength(1);
      captured.push(error);
      throw analyticsFailure;
    },
  });
  report(renderFailure);
  expect(captured).toEqual([renderFailure]);
  expect(diagnostics.map((line) => JSON.parse(line) as unknown)).toEqual([
    { severity: "ERROR", message: "ssr.response_failed", error: "TypeError" },
    { severity: "ERROR", message: "ssr.telemetry_failed", error: "RangeError" },
  ]);
  expect(diagnostics.join("")).not.toContain("Sensitive");
});

const CASE_ROUTE = "/law/$country/cases/$court/$slug";

const routeFailureLines = (
  options: Parameters<ReturnType<typeof createSsrRouteFailureReporter>>[0],
) => {
  const diagnostics: string[] = [];
  createSsrRouteFailureReporter({
    writeDiagnostic: (line) => {
      diagnostics.push(line);
    },
  })(options);
  return diagnostics;
};

test("a document rendered as a loader failure leaves one structured line", () => {
  // An API read the edge refused before it reached the API: the loader
  // throws and the router renders the error page with a 500, no exception.
  const refused = new APIError({
    message: "Sensitive upstream message",
    status: 403,
  });
  const diagnostics = routeFailureLines({
    matches: [
      { routeId: "__root__", status: "success" },
      { routeId: CASE_ROUTE, status: "error", error: refused },
    ],
    status: 500,
  });

  expect(diagnostics.map((line) => JSON.parse(line) as unknown)).toEqual([
    {
      severity: "ERROR",
      message: "ssr.route_failed",
      route: CASE_ROUTE,
      status: 500,
      error: "ApiError",
      upstreamStatus: 403,
    },
  ]);
  expect(diagnostics.join("")).not.toContain("Sensitive");
});

test("a transport failure names how the read failed", () => {
  const timedOut = new APIError({
    message: "Request timed out",
    status: 0,
    transportKind: "timeout",
  });

  expect(
    describeSsrRouteFailure({
      matches: [{ routeId: CASE_ROUTE, status: "error", error: timedOut }],
      status: 500,
    }),
  ).toEqual({
    route: CASE_ROUTE,
    status: 500,
    error: "ApiError",
    upstreamStatus: 0,
    upstreamTransport: "timeout",
  });
});

test("a server-error document without a failed match is still reported", () => {
  expect(
    describeSsrRouteFailure({
      matches: [{ routeId: CASE_ROUTE, status: "success" }],
      status: 503,
    }),
  ).toEqual({ route: CASE_ROUTE, status: 503, error: "UnknownError" });
});

test("successful, missing and redirected documents leave no line", () => {
  for (const status of [200, 307, 404]) {
    expect(
      routeFailureLines({
        matches: [{ routeId: CASE_ROUTE, status: "notFound" }],
        status,
      }),
    ).toEqual([]);
  }
});
