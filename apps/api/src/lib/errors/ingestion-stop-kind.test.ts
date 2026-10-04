import { describe, expect, test } from "bun:test";

import { FetchBoundaryError } from "@stll/errors";
import type { IngestionStopKind } from "@stll/legal-atlas/ingestion-cycle";

import {
  AdapterFetchError,
  ingestionStopKindOf,
  TimeoutError,
} from "./tagged-errors";

const adapterError = (cause: unknown) =>
  new AdapterFetchError({
    adapterKey: "pl-tk",
    cursor: "merits:1,0,0",
    message: "Page failed",
    cause,
  });

describe("ingestion failure kinds", () => {
  for (const httpStatus of [
    401, 403, 429, 408, 500, 502, 503, 504, 200, 400, 404,
  ]) {
    test(`classifies HTTP ${httpStatus} at the ingestion boundary`, () => {
      let expected: IngestionStopKind = "adapter_error";
      if (httpStatus >= 500 || httpStatus === 408) {
        expected = "source_unreachable";
      } else if ([401, 403, 429].includes(httpStatus)) {
        expected = "publisher_refusal";
      }
      const error = new AdapterFetchError({
        adapterKey: "pl-tk",
        cursor: null,
        message: "Publisher response",
        httpStatus,
      });
      expect(error.stopKind).toBe(expected);
      expect(ingestionStopKindOf(new Error("Wrapped", { cause: error }))).toBe(
        expected,
      );
      expect(
        adapterError(
          new FetchBoundaryError({
            url: "https://example.com",
            status: httpStatus,
            message: "Response failed",
          }),
        ).stopKind,
      ).toBe(expected);
    });
  }

  test("a body-read connection reset is a source failure", () => {
    const cause = Object.assign(new TypeError("message omitted"), {
      code: "ConnectionClosed",
    });
    expect(adapterError(cause).stopKind).toBe("source_unreachable");
    expect(ingestionStopKindOf(cause, "adapter")).toBe("source_unreachable");
    expect(ingestionStopKindOf(cause)).toBe("internal_error");
  });

  test("request timeouts are outages while caller aborts remain deadlines", () => {
    const requestTimeout = new DOMException(
      "The operation timed out",
      "TimeoutError",
    );
    expect(adapterError(requestTimeout).stopKind).toBe("source_unreachable");
    expect(ingestionStopKindOf(requestTimeout)).toBe("source_unreachable");
    const callerAbort = new DOMException("Unable to connect", "AbortError");
    expect(adapterError(callerAbort).stopKind).toBe("deadline");
    expect(ingestionStopKindOf(callerAbort)).toBe("deadline");
    const connectTimeout = Object.assign(new TypeError("message omitted"), {
      code: "ETIMEDOUT",
    });
    expect(adapterError(connectTimeout).stopKind).toBe("source_unreachable");
  });

  test("internal write and database failures do not become adapter defects", () => {
    const databaseTimeout = new TimeoutError({
      message: "Database budget exceeded",
      label: "write",
      timeoutMs: 1,
    });
    expect(ingestionStopKindOf(databaseTimeout)).toBe("internal_error");
    expect(adapterError(databaseTimeout).stopKind).toBe("internal_error");
    expect(ingestionStopKindOf(new Error("Storage unavailable"))).toBe(
      "internal_error",
    );
    expect(adapterError(new SyntaxError("Invalid source row")).stopKind).toBe(
      "adapter_error",
    );
  });

  test("preserves an explicit kind through another adapter wrapper", () => {
    const cause = new AdapterFetchError({
      adapterKey: "pl-tk",
      cursor: null,
      message: "Write failed",
      stopKind: "internal_error",
    });
    expect(adapterError(cause).stopKind).toBe("internal_error");
  });
});
