import { expect, test } from "bun:test";

import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";

import {
  createClientTelemetryRoute,
  WEB_HANG_REPORT_LIMIT,
  WEB_HANG_REPORT_MAX_BYTES,
} from "./routes";

const reportRequest = (body: unknown, signedIn = false) =>
  new Request("http://localhost/v1/client-telemetry/web-page-hang", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signedIn
        ? { cookie: "better-auth.session_token=browser-session" }
        : {}),
    },
    body: JSON.stringify(body),
  });

test("hang reports accept either lifecycle phase anonymously or with a session and emit one bounded counter", async () => {
  const lines: string[] = [];
  const context = new InMemoryRateLimitContext();
  const app = createClientTelemetryRoute({
    ...WEB_HANG_REPORT_LIMIT,
    context,
    generator: () => "hang-report-test",
  });
  setMetricLineSinkForTesting((line) => {
    if (line.includes('"WebPageHangSuspected":1')) {
      lines.push(line);
    }
  });
  try {
    for (const signedIn of [false, true]) {
      for (const phase of ["boot", "session"]) {
        const previousLines = lines.length;
        const response = await app.handle(reportRequest({ phase }, signedIn));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ accepted: true });
        expect(lines.length).toBe(previousLines + 1);
        expect(JSON.parse(lines.at(-1) ?? "null")).toEqual({
          phase,
          WebPageHangSuspected: 1,
          _aws: {
            Timestamp: expect.any(Number),
            CloudWatchMetrics: [
              {
                Namespace: "Stella/Api",
                Dimensions: [["phase"]],
                Metrics: [{ Name: "WebPageHangSuspected", Unit: "Count" }],
              },
            ],
          },
        });
      }
    }
    for (const body of [
      {},
      { phase: "unknown" },
      { phase: "boot", url: "private" },
      { phase: 1 },
      null,
    ]) {
      context.reset();
      const previousLines = lines.length;
      const response = await app.handle(reportRequest(body));
      expect(response.status).toBe(422);
      expect(lines.length).toBe(previousLines);
    }
  } finally {
    resetMetricLineSinkForTesting();
    context.kill();
  }
});

test("hang reports bound actual request bytes even without Content-Length", async () => {
  const lines: string[] = [];
  const context = new InMemoryRateLimitContext();
  const app = createClientTelemetryRoute({
    ...WEB_HANG_REPORT_LIMIT,
    context,
    generator: () => "hang-report-size-test",
  });
  setMetricLineSinkForTesting((line) => lines.push(line));
  try {
    const request = new Request(
      "http://localhost/v1/client-telemetry/web-page-hang",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${" ".repeat(WEB_HANG_REPORT_MAX_BYTES)}{"phase":"boot"}`,
      },
    );
    expect(request.headers.has("content-length")).toBe(false);
    const response = await app.handle(request);
    expect(response.status).toBe(413);
    expect(
      lines.filter((line) => line.includes('"WebPageHangSuspected":1')),
    ).toHaveLength(0);
  } finally {
    resetMetricLineSinkForTesting();
    context.kill();
  }
});

test("hang reports stop emitting after the address budget is exhausted", async () => {
  const lines: string[] = [];
  const context = new InMemoryRateLimitContext();
  const app = createClientTelemetryRoute({
    ...WEB_HANG_REPORT_LIMIT,
    context,
    generator: () => "hang-report-limited-test",
  });
  setMetricLineSinkForTesting((line) => lines.push(line));
  try {
    for (let report = 0; report < WEB_HANG_REPORT_LIMIT.max; report += 1) {
      expect((await app.handle(reportRequest({ phase: "boot" }))).status).toBe(
        200,
      );
    }
    expect((await app.handle(reportRequest({ phase: "session" }))).status).toBe(
      429,
    );
    expect(
      lines.filter((line) => line.includes('"WebPageHangSuspected":1')),
    ).toHaveLength(WEB_HANG_REPORT_LIMIT.max);
  } finally {
    resetMetricLineSinkForTesting();
    context.kill();
  }
});
