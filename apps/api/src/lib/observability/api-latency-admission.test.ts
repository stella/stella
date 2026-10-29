import { afterEach, describe, expect, test } from "bun:test";

import {
  API_LATENCY_ADMISSION,
  createApiLatencyAdmission,
  getApiLatencyAdmission,
} from "@/api/lib/observability/api-latency-admission";
import {
  emitRequestDurationMetric,
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";

afterEach(resetMetricLineSinkForTesting);

const fixture = () => {
  let time = 0;
  const admission = createApiLatencyAdmission({ now: () => time });
  return {
    admission,
    advance: (ms: number) => {
      time += ms;
    },
    record: (durations: number[]) => {
      for (const durationMs of durations) {
        admission.observe("crud", durationMs);
      }
    },
  };
};

describe("API latency admission", () => {
  test("holds without sufficient fresh CRUD evidence and never admits other request classes", () => {
    const { admission, record } = fixture();
    expect(admission.read()).toEqual({
      status: "hold",
      reason: "insufficient-samples",
      p95Ms: null,
      samples: 0,
    });
    for (let index = 0; index < API_LATENCY_ADMISSION.minSamples; index += 1) {
      for (const requestClass of ["ai", "search", "batch", "stream"] as const) {
        admission.observe(requestClass, 1);
      }
    }
    expect(admission.read().status).toBe("hold");
    record(
      Array.from({ length: API_LATENCY_ADMISSION.minSamples - 1 }, () => 1),
    );
    expect(admission.read().status).toBe("hold");
    record([1]);
    expect(admission.read()).toEqual({
      status: "admit",
      p95Ms: 1,
      samples: 20,
    });
  });

  test("brakes on nearest-rank p95 and resumes only when the slow samples age out", () => {
    const { admission, record, advance } = fixture();
    record(Array.from({ length: 18 }, () => 10));
    record([API_LATENCY_ADMISSION.maxP95Ms + 1, 10_000]);
    expect(admission.read()).toEqual({
      status: "hold",
      reason: "p95-exceeded",
      p95Ms: API_LATENCY_ADMISSION.maxP95Ms + 1,
      samples: 20,
    });
    advance(API_LATENCY_ADMISSION.windowMs);
    expect(admission.read()).toEqual({
      status: "hold",
      reason: "stale",
      p95Ms: null,
      samples: 0,
    });
    record(Array.from({ length: 20 }, () => API_LATENCY_ADMISSION.maxP95Ms));
    expect(admission.read()).toEqual({
      status: "admit",
      p95Ms: API_LATENCY_ADMISSION.maxP95Ms,
      samples: 20,
    });
  });

  test("freshness applies to every sample rather than the latest completion", () => {
    const { admission, record, advance } = fixture();
    record(Array.from({ length: 20 }, () => 10));
    advance(API_LATENCY_ADMISSION.windowMs);
    record([10]);
    expect(admission.read()).toEqual({
      status: "hold",
      reason: "insufficient-samples",
      p95Ms: null,
      samples: 1,
    });
  });

  test("the retained sample count stays bounded and the window follows recent completions", () => {
    const { admission, record } = fixture();
    record(
      Array.from({ length: API_LATENCY_ADMISSION.maxSamples }, () => 10_000),
    );
    expect(admission.read().status).toBe("hold");
    record(
      Array.from({ length: API_LATENCY_ADMISSION.maxSamples * 2 }, () => 10),
    );
    expect(admission.read()).toEqual({
      status: "admit",
      p95Ms: 10,
      samples: API_LATENCY_ADMISSION.maxSamples,
    });
  });

  test("request completion metrics feed the task's latency brake", () => {
    setMetricLineSinkForTesting(() => {});
    // Fill the bounded ring so the assertion cannot depend on another test's samples.
    for (let index = 0; index < API_LATENCY_ADMISSION.maxSamples; index += 1) {
      emitRequestDurationMetric({
        requestClass: "crud",
        durationMs: 10_000,
        statusCode: 200,
        route: "/fixture",
      });
    }
    expect(getApiLatencyAdmission().read()).toEqual({
      status: "hold",
      reason: "p95-exceeded",
      p95Ms: 10_000,
      samples: API_LATENCY_ADMISSION.maxSamples,
    });
  });
});
