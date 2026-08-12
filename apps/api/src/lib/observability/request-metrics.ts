import { env } from "@/api/env";

/**
 * Per-request latency, split by request class, emitted as a CloudWatch
 * Embedded Metric Format (EMF) line on stdout.
 *
 * Why EMF on stdout rather than the structured `logger`: the OTel logs
 * pipeline has no exporter wired (see `otel.ts`), so `logger.info`
 * records never leave the process. EMF instead rides the container's
 * stdout into the awslogs driver, where CloudWatch auto-extracts the
 * embedded metric — no agent, no metric filter, no log exporter needed.
 *
 * The `class` dimension is the whole point: it lets the p95 latency
 * alarm watch `class=crud` in isolation, so an inherently multi-second
 * synchronous AI endpoint (template field suggestions, chat, summaries)
 * cannot trip an SLO meant for CRUD. A separate, looser alarm watches
 * `class=ai`. Keeping `class` the only dimension caps this at two
 * extracted metrics regardless of route cardinality; `http.route` and
 * `http.status_code` ride along as queryable properties, not dimensions.
 */

const METRIC_NAMESPACE = "Stella/Api";
const METRIC_NAME = "RequestDuration";

export type RequestClass = "ai" | "crud";

type EmitRequestDurationMetricInput = {
  durationMs: number;
  requestClass: RequestClass;
  statusCode: number;
  route: string;
};

/**
 * Build the EMF record. Pure (caller supplies the timestamp) so the
 * structure that CloudWatch silently depends on — and silently drops
 * when malformed — is testable without env or stdout.
 */
export const buildRequestDurationRecord = ({
  durationMs,
  requestClass,
  statusCode,
  route,
  timestamp,
}: EmitRequestDurationMetricInput & { timestamp: number }) => ({
  _aws: {
    Timestamp: timestamp,
    CloudWatchMetrics: [
      {
        Namespace: METRIC_NAMESPACE,
        Dimensions: [["class"]],
        Metrics: [{ Name: METRIC_NAME, Unit: "Milliseconds" }],
      },
    ],
  },
  class: requestClass,
  [METRIC_NAME]: Math.round(durationMs),
  "http.route": route,
  "http.status_code": statusCode,
});

export const emitRequestDurationMetric = (
  input: EmitRequestDurationMetricInput,
): void => {
  // Only deployed environments ship logs to CloudWatch; locally this
  // would be noise on the dev server's stdout.
  if (env.isDev) {
    return;
  }

  const record = buildRequestDurationRecord({
    ...input,
    timestamp: Date.now(),
  });

  process.stdout.write(`${JSON.stringify(record)}\n`);
};
