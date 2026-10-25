import { UnhandledException } from "better-result";
import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import fc from "fast-check";

import {
  classifyFailure,
  FAILURE_REASON_GRADE,
  isFailureReason,
} from "@stll/errors";
import { assertProperty } from "@stll/property-testing";

import {
  captureError,
  captureObservedError,
  captureRequestError,
  createErrorCapture,
  resetCaptureWindows,
} from "@/api/lib/analytics/capture";
import { setAnalyticsForTesting } from "@/api/lib/analytics/client";
import {
  ExtractionWorkerError,
  extractionWorkerErrorCode,
  type ExtractionWorkerTermination,
  HandlerError,
  SUBPROCESS_TERMINATION_REASON,
} from "@/api/lib/errors/tagged-errors";
import { ConversionInputError } from "@/api/lib/files/gotenberg";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { exceptionFingerprint } from "@/api/lib/observability/exception-fingerprint";
import { failureSink, gradeFailure } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  enrichRequestContext,
  getRequestFailure,
  openRequestContext,
  runWithRequestIdScope,
} from "@/api/lib/observability/request-context";

const captured: {
  groups?: Record<string, string>;
  properties: Record<string, unknown>;
}[] = [];

const firstExceptionValue = (): string | undefined => {
  const list = captured.at(0)?.properties["$exception_list"];
  if (!Array.isArray(list)) {
    return undefined;
  }
  const entry: unknown = list.at(0);
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const value = Reflect.get(entry, "value");
  return typeof value === "string" ? value : undefined;
};

// The seam, not a module mock: a mock of `analytics/client` is process-wide
// and would swallow `setAnalyticsForTesting` for every test file batched
// with this one.
setAnalyticsForTesting({
  capture: (params) => {
    captured.push({
      ...(params.groups ? { groups: params.groups } : {}),
      properties: params.properties,
    });
  },
  flush: async () => undefined,
  identifyOrganizationGroup: () => undefined,
});

/**
 * Each helper supplies its own symbolic owner, so line moves cannot change
 * grouping while failures from distinct paths remain separate.
 */
const captureFromSiteA = (context?: Record<string, string>): void => {
  captureError(
    new Error("boom"),
    handlerErrorContext("analytics.captureFromSiteA", context),
  );
};

const captureFromSiteB = (): void => {
  captureError(
    new Error("boom"),
    handlerErrorContext("analytics.captureFromSiteB"),
  );
};

/**
 * A query failure as the driver raises it: a wrapper carrying no `code` of
 * its own, over a driver error whose SQLSTATE sits in `errno`. Every
 * occurrence is built on one source line, so two SQLSTATEs from here differ
 * in nothing else — the shape of one call site that fails for unrelated
 * reasons.
 */
const captureQueryFailure = (sqlState: string): void => {
  const driverError = new Error("driver rejected the statement");
  Reflect.set(driverError, "errno", sqlState);
  captureError(
    new Error("query failed", { cause: driverError }),
    handlerErrorContext("analytics.captureQueryFailure"),
  );
};

const errorAt = (className: "Error" | "TypeError", location: string): Error => {
  const error =
    className === "TypeError"
      ? new TypeError("private detail")
      : new Error("private detail");
  error.stack = `${className}: private detail\n    at run (${location})`;
  return error;
};

const extractionError = ({
  exitCode,
  message,
  termination,
  workerErrorClass = null,
}: {
  exitCode: number | null;
  message: string;
  termination: ExtractionWorkerTermination | null;
  workerErrorClass?: string | null;
}): ExtractionWorkerError =>
  new ExtractionWorkerError({
    code: extractionWorkerErrorCode(termination),
    exitCode,
    message,
    mimeType: "application/pdf",
    sizeBytes: 12_345,
    termination,
    workerErrorClass,
  });

beforeEach(() => {
  captured.length = 0;
  resetCaptureWindows();
});

test("bound capture callbacks preserve each caller identity and context", () => {
  const error = new TypeError("callback unavailable");
  const firstOptions = handlerErrorContext("callbacks.first", {
    phase: "read",
  });
  const secondOptions = handlerErrorContext("callbacks.second", {
    phase: "write",
  });
  const first = createErrorCapture(firstOptions);
  const second = createErrorCapture(secondOptions);
  first(error);
  first(error);
  second(error);
  expect(captured).toHaveLength(2);
  expect(
    captured.map(({ properties }) => properties["$exception_fingerprint"]),
  ).toEqual([
    exceptionFingerprint(readEvidence(error), firstOptions),
    exceptionFingerprint(readEvidence(error), secondOptions),
  ]);
  expect(captured.map(({ properties }) => properties["phase"])).toEqual([
    "read",
    "write",
  ]);
});

test("error capture redacts handoff credentials from diagnostic context", () => {
  const code = `sh1_${"a".repeat(43)}`;
  captureError(
    new Error(`Request ${code} refused`),
    handlerErrorContext("analytics.redactsHandoffCredentials", {
      requestId: code,
    }),
  );
  expect(captured).toHaveLength(1);
  expect(captured.at(0)?.properties["requestId"]).toBe("[redacted]");
  expect(JSON.stringify(captured)).not.toContain(code);
});

describe("captureError repeat suppression", () => {
  test("a loop failing at one site reports once, not once per iteration", () => {
    // The shape that motivates the throttle: a held ingestion cursor re-runs
    // every cycle and spends one ingested event per attempt for as long as it
    // stays held. Each iteration builds a fresh Error, as the real loop does.
    for (let i = 0; i < 50; i += 1) {
      captureFromSiteA();
    }

    expect(captured).toHaveLength(1);
  });

  test("varying correlation context does not defeat the throttle", () => {
    // The key excludes caller context on purpose. Each cycle of the case-law
    // pipeline reports the same defect under a fresh sourceId, so a
    // context-sensitive key would suppress nothing in the case that motivated
    // the throttle.
    for (let i = 0; i < 10; i += 1) {
      captureFromSiteA({ sourceId: `source-${i}`, step: "uploadSourceRaw" });
    }

    expect(captured).toHaveLength(1);
  });

  test("distinct defects are never collapsed into one another", () => {
    // Suppression must not hide an unrelated failure that happens to occur
    // while a noisy one is throttled.
    captureFromSiteA();
    captureFromSiteB();

    expect(captured).toHaveLength(2);
  });

  test("one SQLSTATE at a call site does not throttle another", () => {
    // A hot failure must not hide a rarer one raised from the same line: a
    // statement the server cancels and a column the query cannot resolve are
    // different defects that share every other component of the key.
    captureQueryFailure("54000");
    captureQueryFailure("42703");

    expect(captured).toHaveLength(2);
  });

  test("suppressed occurrences are counted onto the next reported event", () => {
    // Nothing is silently swallowed: the rate stays recoverable from the
    // dashboard even though the repeats themselves are not ingested.
    const openedAt = new Date("2026-08-05T12:00:00.000Z");
    setSystemTime(openedAt);

    // One call site for every occurrence, so the window is only reopened by
    // the clock moving past it, never by a different key.
    for (let i = 0; i < 9; i += 1) {
      if (i === 8) {
        setSystemTime(new Date(openedAt.getTime() + 61_000));
      }
      captureFromSiteA();
    }
    setSystemTime();

    expect(captured).toHaveLength(2);
    expect(captured.at(0)?.properties["suppressed_repeats"]).toBeUndefined();
    expect(captured.at(1)?.properties["suppressed_repeats"]).toBe("7");
  });
});

describe("captureError issue grouping", () => {
  test("line shifts share suppression while retaining structural exception values", () => {
    const options = handlerErrorContext("analytics.captureShifted");
    const before = errorAt(
      "Error",
      "apps/api/src/lib/analytics/capture.test.ts:100:2",
    );
    const after = errorAt(
      "Error",
      "apps/api/src/lib/analytics/capture.test.ts:101:2",
    );
    expect(before.stack).not.toBe(after.stack);
    captureError(before, options);
    captureError(after, options);
    expect(captured).toHaveLength(1);
    expect(firstExceptionValue()).toBe(
      "Error unclassified defect at apps/api/src/lib/analytics/capture.test.ts:100:2",
    );
    expect(captured.at(0)?.properties["$exception_fingerprint"]).toBe(
      exceptionFingerprint(readEvidence(after), options),
    );
  });

  test("UnhandledException preserves distinct cause classes before repeat suppression", () => {
    const options = handlerErrorContext("analytics.captureWrappedFailure");
    captureError(
      new UnhandledException({ cause: new TypeError("failure") }),
      options,
    );
    captureError(
      new UnhandledException({ cause: new ReferenceError("failure") }),
      options,
    );
    expect(captured).toHaveLength(2);
    expect(captured.at(0)?.properties["$exception_fingerprint"]).not.toBe(
      captured.at(1)?.properties["$exception_fingerprint"],
    );
  });

  // PostHog groups issues from `$exception_list`; with the message and stack
  // redacted, every event of one class would collapse into a single issue and
  // first-seen automations would never fire again for that class. The
  // explicit fingerprint must therefore separate distinct defects while
  // carrying no message content.
  test("distinct defects produce distinct grouping fingerprints", () => {
    captureFromSiteA();
    captureFromSiteB();

    const fingerprints = captured.map(
      (event) => event.properties["$exception_fingerprint"],
    );
    expect(typeof fingerprints.at(0)).toBe("string");
    expect(fingerprints.at(0)).not.toBe(fingerprints.at(1));
  });

  test("database failures at one call site group by SQLSTATE", () => {
    // A missing column and a violated check constraint are raised from the
    // same line, so class, stable code, and both frames are identical and the
    // SQLSTATE is the only thing that tells the two defects apart.
    captureQueryFailure("42703");
    captureQueryFailure("23514");

    // Both must reach the sink before their fingerprints can be compared: one
    // identity for both would throttle the second away and leave the
    // comparison to pass against a missing event.
    expect(captured).toHaveLength(2);
    const fingerprints = captured.map(
      (event) => event.properties["$exception_fingerprint"],
    );
    expect(fingerprints.at(0)).toContain("42703");
    expect(fingerprints.at(1)).toContain("23514");
    expect(fingerprints.at(0)).not.toBe(fingerprints.at(1));
  });

  test("the grouping fingerprint never carries the error message", () => {
    captureError(
      new Error("Privileged client matter detail"),
      handlerErrorContext("analytics.capture"),
    );

    const fingerprint = captured.at(0)?.properties["$exception_fingerprint"];
    expect(typeof fingerprint).toBe("string");
    expect(fingerprint).not.toContain("Privileged");
  });

  test("renders an actionable value from typed failure fields", () => {
    captureError(
      new HandlerError({
        code: "provider_request_rejected",
        message: "Alex Doe <alex@example.test> privileged document text",
        status: 502,
      }),
      handlerErrorContext("analytics.captureStructural"),
    );

    expect(firstExceptionValue()).toMatch(
      /^HandlerError\[provider_request_rejected\] 502 tagged_failure defect at apps\/api\/src\/lib\/analytics\/capture\.test\.ts:\d+:\d+$/u,
    );
  });

  test("names and separates provider bodies by provider status and code", () => {
    // The shape a provider stream forwards as its run error's raw event: a
    // plain object, so it has no class, code or frame of its own.
    const providerBody = {
      status: 400,
      error: {
        code: "invalid_value",
        message: "Alex Doe <alex@example.test> privileged document text",
        param: "input[3].call_id",
        type: "invalid_request_error",
      },
    };
    classifyFailure(providerBody, "provider_request_rejected");
    const options = handlerErrorContext("analytics.captureProviderBody");
    captureError(providerBody, options);
    captureError(
      {
        status: 429,
        error: {
          code: "rate_limit_exceeded",
          type: "requests",
        },
      },
      options,
    );

    const properties = captured.at(0)?.properties;
    expect(captured).toHaveLength(2);
    expect(firstExceptionValue()).toBe(
      "UnknownError[invalid_value] 400 provider_request_rejected defect",
    );
    expect(properties).toMatchObject({
      "error.provider.code": "invalid_value",
      "error.provider.param": "input[3].call_id",
      "error.provider.status": "400",
      "error.provider.type": "invalid_request_error",
    });
    expect(properties?.["$exception_fingerprint"]).toContain("invalid_value");
    expect(properties?.["$exception_fingerprint"]).toContain("400");
    expect(captured.at(1)?.properties["$exception_fingerprint"]).toContain(
      "rate_limit_exceeded",
    );
    expect(captured.at(1)?.properties["$exception_fingerprint"]).toContain(
      "429",
    );
    expect(properties?.["$exception_fingerprint"]).not.toBe(
      captured.at(1)?.properties["$exception_fingerprint"],
    );
    expect(JSON.stringify(properties)).not.toContain("alex@example.test");
  });

  test("contains throwing provider field getters", () => {
    const providerBody = {
      status: 400,
      error: {
        get code(): string {
          throw new Error("provider getter failed");
        },
        type: "invalid_request_error",
      },
    };

    expect(() =>
      captureError(
        providerBody,
        handlerErrorContext("analytics.captureProviderGetter"),
      ),
    ).not.toThrow();
    expect(captured).toHaveLength(1);
    expect(captured.at(0)?.properties).toMatchObject({
      "error.provider.status": "400",
      "error.provider.type": "invalid_request_error",
    });
  });

  test.each([
    "/workspace/stella/apps/api/src/lib/analytics/capture.ts:319:17",
    "/app/apps/api/src/lib/analytics/capture.ts:319:17",
    "/home/runner/work/stella/stella/apps/api/src/lib/analytics/capture.ts:319:17",
  ])("keeps recognized absolute repository frames from %s", (location) => {
    captureError(
      errorAt("Error", location),
      handlerErrorContext("analytics.captureFrame"),
    );

    expect(firstExceptionValue()).toBe(
      "Error unclassified defect at apps/api/src/lib/analytics/capture.ts:319:17",
    );
  });

  test.each(["Error", "TypeError"] as const)(
    "does not render a class-derived code for %s",
    (className) => {
      captureError(
        errorAt(className, "apps/api/src/lib/analytics/capture.test.ts:1:2"),
        handlerErrorContext("analytics.captureClass"),
      );

      const value = firstExceptionValue();
      expect(value).not.toContain(`[${className}]`);
      expect(value).toBe(
        `${className} unclassified defect at apps/api/src/lib/analytics/capture.test.ts:1:2`,
      );
    },
  );

  test("captured properties never carry arbitrary message text", () => {
    assertProperty(
      "captured properties never carry arbitrary message text",
      fc.property(fc.string(), (message) => {
        captured.length = 0;
        resetCaptureWindows();
        const privateMessage = `Alex Doe <alex@example.test> document ${JSON.stringify(message)}`;
        captureError(
          Object.assign(
            new HandlerError({
              code: "provider_request_rejected",
              message: privateMessage,
              status: 502,
            }),
            { unknownField: privateMessage },
          ),
          handlerErrorContext("analytics.capturePrivate"),
        );

        const properties = captured.at(0)?.properties;
        expect(JSON.stringify(properties)).not.toContain(privateMessage);
      }),
    );
  });
});

describe("captureRequestError organization attribution", () => {
  test("attaches the organization group from the request context", () => {
    const organizationId = "3f6e0a7e-9f6f-4a53-9a3e-2b8f6f0c9d41";
    const request = new Request("https://api.test/internal");
    runWithRequestIdScope(() => {
      openRequestContext();
      enrichRequestContext({ organizationId });

      captureRequestError(new Error("boom"), {
        request,
        scope: {
          type: "request",
          method: request.method,
          routeTemplate: "/capture-test",
        },
        fingerprintKey: "analytics.capture",
      });
    });

    // The group is what PostHog's organization breakdown reads; losing it
    // while organization_id survives as a plain property would go unnoticed.
    expect(captured.at(0)?.groups).toEqual({ organization: organizationId });
  });

  test("stays ungrouped without an organization in the request context", () => {
    const request = new Request("https://api.test/internal");
    runWithRequestIdScope(() => {
      openRequestContext();

      captureRequestError(new Error("boom"), {
        request,
        scope: {
          type: "request",
          method: request.method,
          routeTemplate: "/capture-test",
        },
        fingerprintKey: "analytics.capture",
      });
    });

    expect(captured.at(0)?.groups).toBeUndefined();
  });
});

describe("captureError extraction diagnostics", () => {
  test("attaches safe worker metadata without exposing the error message", () => {
    captureError(
      extractionError({
        exitCode: null,
        message: "Privileged document parser detail",
        termination: {
          reason: SUBPROCESS_TERMINATION_REASON.timeout,
          signalCode: "SIGTERM",
        },
      }),
      handlerErrorContext("analytics.capture", { runId: "run-1" }),
    );

    const properties = captured.at(0)?.properties;
    expect(properties).toMatchObject({
      "error.code": "worker_timeout",
      mimeType: "application/pdf",
      runId: "run-1",
      signalCode: "SIGTERM",
      sizeBytes: "12345",
      terminationReason: "timeout",
    });
    expect(JSON.stringify(properties)).not.toContain("Privileged");
  });

  test("fingerprints parser exits separately from worker termination", () => {
    captureError(
      extractionError({
        exitCode: 1,
        message: "parser failed",
        termination: null,
      }),
      handlerErrorContext("analytics.capture"),
    );
    captureError(
      extractionError({
        exitCode: null,
        message: "worker timed out",
        termination: {
          reason: SUBPROCESS_TERMINATION_REASON.timeout,
          signalCode: "SIGTERM",
        },
      }),
      handlerErrorContext("analytics.capture"),
    );

    expect(captured).toHaveLength(2);
    expect(captured.at(0)?.properties).toMatchObject({
      "error.code": "parser_failed",
      exitCode: "1",
    });
    expect(captured.at(0)?.properties["$exception_fingerprint"]).not.toBe(
      captured.at(1)?.properties["$exception_fingerprint"],
    );
  });

  test("fingerprints distinct parser classes as distinct defects", () => {
    captureError(
      extractionError({
        exitCode: 1,
        message: "parser failed",
        termination: null,
        workerErrorClass: "PdfParseError",
      }),
      handlerErrorContext("analytics.capture"),
    );
    captureError(
      extractionError({
        exitCode: 1,
        message: "parser failed",
        termination: null,
        workerErrorClass: "RangeError",
      }),
      handlerErrorContext("analytics.capture"),
    );

    expect(captured).toHaveLength(2);
    expect(captured.at(0)?.properties).toMatchObject({
      "error.code": "parser_failed:PdfParseError",
      workerErrorClass: "PdfParseError",
    });
    expect(captured.at(0)?.properties["$exception_fingerprint"]).not.toBe(
      captured.at(1)?.properties["$exception_fingerprint"],
    );
  });
});

describe("captureError owned fields", () => {
  test("groups and suppresses by the stable identity", () => {
    const driverError = Object.assign(new Error("driver"), {
      errno: "23505",
      constraint: "users_email_key",
    });
    const error = new Error("query failed", { cause: driverError });

    captureError(error, handlerErrorContext("analytics.capture"));

    expect(captured.at(0)?.properties["$exception_fingerprint"]).toBe(
      exceptionFingerprint(readEvidence(error), {
        fingerprintKey: "analytics.capture",
        scope: { type: "handler", handlerId: "analytics.capture" },
      }),
    );
  });

  test("a context cannot override the identity, the grade or the envelope", () => {
    const spoofed = {
      $exception_fingerprint: "spoofed",
      "error.frame": "spoofed.ts:1:1",
      "failure.grade": "anticipated",
      severity: "INFO",
      entityId: "entity-1",
    };

    captureFromSiteA(spoofed);
    captureFromSiteA({ ...spoofed, "error.frame": "other.ts:2:2" });

    // One event: suppression keys on the real identity, not the context.
    expect(captured).toHaveLength(1);
    const properties = captured.at(0)?.properties ?? {};
    expect(properties["$exception_fingerprint"]).not.toBe("spoofed");
    expect(properties["error.frame"]).not.toBe("spoofed.ts:1:1");
    expect(properties).toMatchObject({
      "failure.grade": "defect",
      "failure.reason": "unclassified",
      "failure.shadow": "true",
      "failure.ctx_rejected": "4",
      entityId: "entity-1",
    });
    expect(properties["severity"]).toBeUndefined();
  });

  test("a request capture records its grade on the request", () => {
    const request = new Request("https://api.test/v1/items");
    const failure = runWithRequestIdScope(() => {
      openRequestContext();

      captureRequestError(
        Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        {
          request,
          scope: {
            type: "request",
            method: request.method,
            routeTemplate: "/capture-test",
          },
          fingerprintKey: "analytics.capture",
        },
      );
      return getRequestFailure();
    });

    expect(failure).toEqual({
      grade: "transient",
      reason: "network_reset",
      sink: "exception.captured",
    });
    expect(captured).toEqual([]);
  });
});

describe("exception capture follows the declared grade", () => {
  const sink = failureSink({ event: "capture.contract", expected: [] });
  for (const [reason, grade] of Object.entries(FAILURE_REASON_GRADE)) {
    test(`${reason} uses the same capture policy in shadow and observed paths`, () => {
      if (!isFailureReason(reason)) {
        throw new TypeError("Failure policy key must be a declared reason");
      }
      const error = classifyFailure(new Error("bounded outcome"), reason);
      const grading = gradeFailure(readEvidence(error), sink);
      expect(grading.grade).toBe(grade);
      const capturePaths = [
        () =>
          captureError(error, handlerErrorContext("analytics.gradeContract")),
        () =>
          captureRequestError(error, {
            ...handlerErrorContext("analytics.gradeContract"),
            request: new Request("http://localhost/"),
          }),
        () =>
          captureObservedError(error, {
            ...handlerErrorContext("analytics.gradeContract"),
            observation: grading,
          }),
      ];
      for (const capture of capturePaths) {
        captured.length = 0;
        resetCaptureWindows();
        capture();
        expect(captured).toHaveLength(grade === "defect" ? 1 : 0);
      }
    });
  }
});

test("capture preserves finite dimensions when fingerprint metadata is unreadable", () => {
  class MetadataError extends Error {
    override readonly name = "MetadataError";
    readonly reason = "decode";
    static readonly stellaExceptionFingerprintFields = new Proxy(
      ["reason", "stage"],
      {
        get: (target, key, receiver): unknown => {
          if (key === "1") {
            throw new TypeError("unreadable metadata");
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
  }
  const error = new MetadataError("private metadata sentinel");
  captureError(error, handlerErrorContext("analytics.metadata"));
  expect(captured).toHaveLength(1);
  expect(readEvidence(error).truncation).toBe("read_failed");
  expect(captured[0]?.properties["$exception_fingerprint"]).toContain("decode");
  expect(JSON.stringify(captured[0]?.properties)).not.toContain(
    "private metadata sentinel",
  );
});

test("conversion refusal fingerprints depend on kind rather than variable details", () => {
  assertProperty(
    "conversion refusal fingerprints depend on kind rather than variable details",
    fc.property(fc.string(), (detail) => {
      captured.length = 0;
      resetCaptureWindows();
      const privateDetail = `PRIVATE_CONVERSION_SENTINEL:${detail}`;
      const reference = new ConversionInputError({
        message: privateDetail,
        reason: {
          kind: "unsupported_reference",
          format: privateDetail,
          element: privateDetail,
          attribute: privateDetail,
        },
      });
      expect(readEvidence(reference).nodes.at(0)?.discriminators).toEqual({
        "reason.kind": "unsupported_reference",
      });
      for (const error of [
        reference,
        new ConversionInputError({
          message: "Another message",
          reason: {
            kind: "unsupported_reference",
            format: "another format",
            element: "another element",
            attribute: "another attribute",
          },
        }),
        new ConversionInputError({
          message: privateDetail,
          reason: { kind: "unsupported_encoding", encoding: privateDetail },
        }),
      ]) {
        captureError(error, handlerErrorContext("analytics.conversionRefusal"));
      }
      expect(captured).toHaveLength(2);
      expect(
        new Set(
          captured.map(
            ({ properties }) => properties["$exception_fingerprint"],
          ),
        ).size,
      ).toBe(2);
      expect(JSON.stringify(captured)).not.toContain(
        "PRIVATE_CONVERSION_SENTINEL",
      );
    }),
  );
});

test("request values cannot change declared or unmatched exception fingerprints", () => {
  assertProperty(
    "request values cannot change declared or unmatched exception fingerprints",
    fc.property(fc.uuid(), fc.uuid(), (beforeId, afterId) => {
      const scopes = [
        { type: "request", method: "GET", routeTemplate: "/files/:fileId" },
        { type: "request", method: "GET", routeTemplate: "unmatched" },
        { type: "handler", handlerId: "analytics.contextlessRequest" },
      ] as const;
      for (const scope of scopes) {
        const fingerprint = (id: string) => {
          captured.length = 0;
          resetCaptureWindows();
          const request = new Request(
            `https://api.test/files/${id}?token=${id}`,
          );
          initRequestContext(request);
          captureRequestError(new Error("fixture failure"), {
            scope,
            fingerprintKey: "analytics.requestValueInvariant",
            request,
          });
          const identity = captured.at(0)?.properties["$exception_fingerprint"];
          expect(typeof identity).toBe("string");
          expect(String(identity)).not.toContain(id);
          expect(String(identity)).not.toContain("token=");
          return identity;
        };
        expect(fingerprint(beforeId)).toBe(fingerprint(afterId));
      }
    }),
  );
});
