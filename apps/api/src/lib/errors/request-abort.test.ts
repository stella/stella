import { UnhandledException } from "better-result";
import { describe, expect, test } from "bun:test";

import { readFailureBrand } from "@stll/errors";

import { requestAbortRefusal } from "@/api/lib/errors/request-abort";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

describe("requestAbortRefusal", () => {
  test("a failure carrying the request's own abort reason is the caller's", () => {
    const controller = new AbortController();
    controller.abort();
    const refusal = requestAbortRefusal(
      controller.signal,
      new UnhandledException({ cause: controller.signal.reason }),
    );

    expect(refusal?.status).toBe(400);
    expect(refusal?.code).toBe("request_aborted");
    expect(readFailureBrand(refusal)).toEqual({
      reason: "client_disconnected",
      source: "instance",
    });
  });

  test("a live request never reads a failure as its cancellation", () => {
    const controller = new AbortController();
    expect(
      requestAbortRefusal(
        controller.signal,
        new UnhandledException({
          cause: new DOMException("The operation was aborted.", "AbortError"),
        }),
      ),
    ).toBeNull();
  });

  test("another abort keeps its grade after the request was cancelled", () => {
    const controller = new AbortController();
    controller.abort();
    const deadline = AbortSignal.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    expect(
      requestAbortRefusal(
        controller.signal,
        new UnhandledException({ cause: deadline.reason }),
      ),
    ).toBeNull();
  });

  test.each([400, 409, 429] as const)(
    "a cancellation whose reason is a typed %s refusal keeps that refusal",
    (status) => {
      const controller = new AbortController();
      controller.abort(new HandlerError({ status, message: "Disconnected" }));
      expect(
        requestAbortRefusal(
          controller.signal,
          new UnhandledException({ cause: controller.signal.reason }),
        ),
      ).toBeNull();
    },
  );

  test("a cause cycle ends the walk", () => {
    const controller = new AbortController();
    controller.abort();
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    first.cause = second;
    expect(requestAbortRefusal(controller.signal, first)).toBeNull();
  });
});
