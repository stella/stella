// Passive regression fixture for `failure-sink-handle/failure-sink-handle`.

import { failureSink } from "@/api/lib/observability/failure";
import type { FailureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const workerFailed = failureSink({ event: "worker.failed", expected: [] });

export const SINKS = {
  worker: failureSink({ event: "worker.sink", expected: [] }),
};

const pickSink = (): FailureSink => SINKS.worker;

export const inlineHandle = (error: unknown): void => {
  // oxlint-disable-next-line failure-sink-handle/failure-sink-handle -- x2: fixture proves an inline handle is rejected, at the call and at its creation
  observeFailure(error, { sink: failureSink({ event: "x", expected: [] }) });
};

export const computedHandle = (error: unknown): void => {
  // oxlint-disable-next-line failure-sink-handle/failure-sink-handle -- fixture proves a computed handle is rejected
  observeFailure(error, { sink: pickSink() });
  // oxlint-disable-next-line failure-sink-handle/failure-sink-handle -- fixture proves a member handle is rejected
  observeFailure(error, { sink: SINKS.worker });
};

export const handleInFunction = (): FailureSink =>
  // oxlint-disable-next-line failure-sink-handle/failure-sink-handle -- fixture proves a handle is created at module scope only
  failureSink({ event: "per.call", expected: [] });

export const namedHandle = (error: unknown): void => {
  // expect-clean: failure-sink-handle/failure-sink-handle
  observeFailure(error, { sink: workerFailed });
};
