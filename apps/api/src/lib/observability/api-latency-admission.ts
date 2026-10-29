import { panic } from "better-result";

import type { RequestClass } from "@/api/lib/observability/request-metrics";

export const API_LATENCY_ADMISSION = {
  windowMs: 60_000,
  minSamples: 20,
  maxSamples: 4096,
  maxP95Ms: 500,
} as const;

export type ApiLatencyAdmission =
  | { status: "admit"; p95Ms: number; samples: number }
  | {
      status: "hold";
      reason: "insufficient-samples" | "stale" | "p95-exceeded";
      p95Ms: number | null;
      samples: number;
    };

type ApiLatencyAdmissionOptions = {
  now?: () => number;
};

/**
 * CPU work competes with requests on this task, so admission uses this task's
 * completions. Match the CRUD latency metric: model calls, search, background
 * reads and stream setup have different SLOs. A quiet or new task cannot prove
 * spare latency capacity and holds until it has enough fresh observations.
 */
export const createApiLatencyAdmission = ({
  now = () => performance.now(),
}: ApiLatencyAdmissionOptions = {}) => {
  const times = new Float64Array(API_LATENCY_ADMISSION.maxSamples);
  const durations = new Float64Array(API_LATENCY_ADMISSION.maxSamples);
  let next = 0;
  let count = 0;

  return {
    observe: (requestClass: RequestClass, durationMs: number) => {
      if (requestClass !== "crud") {
        return;
      }
      times[next] = now();
      durations[next] = durationMs;
      next = (next + 1) % API_LATENCY_ADMISSION.maxSamples;
      count = Math.min(count + 1, API_LATENCY_ADMISSION.maxSamples);
    },
    read: (): ApiLatencyAdmission => {
      const cutoff = now() - API_LATENCY_ADMISSION.windowMs;
      const fresh: number[] = [];
      for (let index = 0; index < count; index += 1) {
        const observed = times[index];
        const duration = durations[index];
        if (
          observed !== undefined &&
          duration !== undefined &&
          observed > cutoff
        ) {
          fresh.push(duration);
        }
      }
      if (fresh.length < API_LATENCY_ADMISSION.minSamples) {
        return {
          status: "hold",
          reason:
            count > 0 && fresh.length === 0 ? "stale" : "insufficient-samples",
          p95Ms: null,
          samples: fresh.length,
        };
      }
      fresh.sort((left, right) => left - right);
      const p95Ms =
        fresh.at(Math.ceil(fresh.length * 0.95) - 1) ??
        panic("A populated latency window must have a p95 sample");
      if (p95Ms > API_LATENCY_ADMISSION.maxP95Ms) {
        return {
          status: "hold",
          reason: "p95-exceeded",
          p95Ms,
          samples: fresh.length,
        };
      }
      return { status: "admit", p95Ms, samples: fresh.length };
    },
  };
};

let admission: ReturnType<typeof createApiLatencyAdmission> | undefined;
export const getApiLatencyAdmission = () => {
  admission ??= createApiLatencyAdmission();
  return admission;
};

export const readApiLatencyAdmission = () => getApiLatencyAdmission().read();
