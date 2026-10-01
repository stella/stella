import { describe, expect, spyOn, test } from "bun:test";

import {
  DOCUMENT_FETCH_EVENT,
  type DocumentStageObserver,
  type DocumentTelemetryObserverFailure,
} from "./document-fetch-diagnostics.js";
import {
  createSafeDocumentStageObserver,
  observeDocumentStageSafely,
} from "./document-stage-observer.js";

const observation = {
  event: DOCUMENT_FETCH_EVENT.window,
  aggregation: "page",
  source: "cz-ns",
  backlog: 1,
  attempted: 1,
  filled: 0,
  failed: 1,
  window_seconds: 1,
} as const;

describe("document telemetry containment", () => {
  const failures: {
    name: string;
    observe: DocumentStageObserver;
    reason: DocumentTelemetryObserverFailure["reason"];
  }[] = [
    {
      name: "synchronous throw",
      observe: () => {
        throw new Error("private payload");
      },
      reason: "exception",
    },
    {
      name: "rejected promise",
      observe: async () => {
        throw new Error("private payload");
      },
      reason: "exception",
    },
    {
      name: "never resolving promise",
      observe: async () => await new Promise<void>(() => {}),
      reason: "timeout",
    },
  ];

  for (const { name, observe, reason } of failures) {
    test(`${name} reports one typed failure and completes`, async () => {
      const reported: DocumentTelemetryObserverFailure[] = [];
      await observeDocumentStageSafely({
        observation,
        observe,
        observer: "callback",
        timeoutMs: 5,
        reportFailure: (failure) => {
          reported.push(failure);
        },
      });
      expect(reported).toEqual([
        {
          event: DOCUMENT_FETCH_EVENT.observerFailed,
          source: observation.source,
          observer: "callback",
          reason,
        },
      ]);
    });
  }

  test("successful asynchronous delivery is awaited without a failure event", async () => {
    const delivered: string[] = [];
    await observeDocumentStageSafely({
      observation,
      observer: "builtin",
      observe: async () => {
        await Promise.resolve();
        delivered.push("delivered");
      },
      reportFailure: () => {
        delivered.push("failed");
      },
    });
    expect(delivered).toEqual(["delivered"]);
  });

  test("safe observer wrapping is idempotent", () => {
    const safe = createSafeDocumentStageObserver(() => {});
    expect(createSafeDocumentStageObserver(safe)).toBe(safe);
  });

  for (const { name, observe: reportFailure } of failures) {
    test(`a failure reporter with ${name} cannot propagate or hang`, async () => {
      const fallback = spyOn(process.stderr, "write").mockImplementation(
        () => true,
      );
      try {
        await observeDocumentStageSafely({
          observation,
          observer: "builtin",
          timeoutMs: 5,
          observe: () => {
            throw new Error("private payload");
          },
          reportFailure: async () => {
            await reportFailure(observation);
          },
        });
        expect(fallback).toHaveBeenCalledTimes(1);
        expect(fallback.mock.calls.at(0)?.at(0)).toBe(
          `${JSON.stringify({
            event: DOCUMENT_FETCH_EVENT.observerFailed,
            source: observation.source,
            observer: "builtin",
            reason: "exception",
          })}\n`,
        );
      } finally {
        fallback.mockRestore();
      }
    });
  }
});
