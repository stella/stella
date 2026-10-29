import { describe, expect, test } from "bun:test";

import { FetchBoundaryError } from "@stll/errors";
import type { FailureGrade, FailureReason } from "@stll/errors";
import {
  INGESTION_STOP_KIND,
  type IngestionStopKind,
} from "@stll/legal-atlas/ingestion-cycle";

import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";

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

const EXPECTED_GRADING = {
  source_unreachable: { grade: "transient", reason: "upstream_unavailable" },
  publisher_refusal: { grade: "anticipated", reason: "publisher_refused" },
  adapter_error: { grade: "defect", reason: "tagged_failure" },
  deadline: { grade: "defect", reason: "timeout_unbounded" },
  internal_error: { grade: "defect", reason: "tagged_failure" },
} as const satisfies Record<
  IngestionStopKind,
  { grade: FailureGrade; reason: FailureReason }
>;

const expectGrading = (error: AdapterFetchError) => {
  expect(
    gradeFailure(
      readEvidence(error),
      failureSink({ event: "ingestion.test", expected: [] }),
    ),
  ).toMatchObject(EXPECTED_GRADING[error.stopKind]);
};

describe("ingestion failure kinds", () => {
  for (const stopKind of Object.values(INGESTION_STOP_KIND)) {
    test(`grades declared ${stopKind} outcomes through the real grader`, () => {
      expectGrading(
        new AdapterFetchError({
          adapterKey: "pl-tk",
          cursor: null,
          message: "Page failed",
          stopKind,
        }),
      );
    });
  }

  for (const httpStatus of [
    401, 403, 429, 408, 500, 502, 503, 504, 200, 400, 404,
  ]) {
    test(`classifies HTTP ${httpStatus} at the ingestion boundary`, () => {
      let expected: IngestionStopKind = "adapter_error";
      if (httpStatus >= 500 || httpStatus === 408 || httpStatus < 300) {
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
      expectGrading(error);
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

  test.each([
    {
      shape: "statusless retry failure",
      cause: new FetchBoundaryError({
        url: "https://example.com",
        message: "Fetch failed after retries",
      }),
    },
    {
      shape: "empty reply after TLS",
      cause: Object.assign(new TypeError("Empty reply from server"), {
        code: "ECONNRESET",
      }),
    },
    {
      shape: "TLS close during body read",
      cause: Object.assign(new TypeError("message omitted"), {
        code: "ERR_TLS_CONNECTION_CLOSED",
      }),
    },
  ])("classifies $shape through every adapter wrapper", ({ cause }) => {
    expectGrading(adapterError(cause));
    expectGrading(adapterError(new Error("Retry failed", { cause })));
    expect(adapterError(cause).stopKind).toBe("source_unreachable");
    expect(adapterError(new Error("Retry failed", { cause })).stopKind).toBe(
      "source_unreachable",
    );
    expect(ingestionStopKindOf(cause, "adapter")).toBe("source_unreachable");
    expect(ingestionStopKindOf(cause)).toBe("internal_error");
  });

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
    expect(
      adapterError(
        new FetchBoundaryError({
          url: "https://example.com",
          message: "Request failed",
          cause: callerAbort,
        }),
      ).stopKind,
    ).toBe("deadline");
    const connectTimeout = Object.assign(new TypeError("message omitted"), {
      code: "ETIMEDOUT",
    });
    expect(adapterError(connectTimeout).stopKind).toBe("source_unreachable");
  });

  test("internal write and database failures do not become adapter defects", () => {
    const databaseTimeout = new TimeoutError({
      message: "Database budget exceeded",
      label: "write",
      timeoutMs: 1, // timeout under test
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
