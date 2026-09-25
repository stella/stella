import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";

import {
  captureError,
  captureRequestError,
  resetCaptureWindows,
} from "@/api/lib/analytics/capture";
import { setAnalyticsForTesting } from "@/api/lib/analytics/client";
import {
  extractionWorkerErrorCode,
  ExtractionWorkerError,
  type ExtractionWorkerTermination,
  SUBPROCESS_TERMINATION_REASON,
} from "@/api/lib/errors/tagged-errors";
import {
  enrichRequestContext,
  initRequestContext,
} from "@/api/lib/observability/request-context";
import * as legacy from "@/api/tests/helpers/legacy-error-fields";

const captured: {
  groups?: Record<string, string>;
  properties: Record<string, unknown>;
}[] = [];

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
 * Both helpers construct their error on a single source line, so every
 * occurrence from one helper shares a `error.frame` and therefore a
 * suppression key — the shape of a loop that keeps failing at the same site.
 * The two helpers sit on different lines, so they are different defects.
 */
const captureFromSiteA = (context?: Record<string, string>): void => {
  captureError(new Error("boom"), context);
};

const captureFromSiteB = (): void => {
  captureError(new Error("boom"));
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
  captureError(new Error("query failed", { cause: driverError }));
};

const extractionError = ({
  exitCode,
  message,
  termination,
}: {
  exitCode: number | null;
  message: string;
  termination: ExtractionWorkerTermination | null;
}): ExtractionWorkerError =>
  new ExtractionWorkerError({
    code: extractionWorkerErrorCode(termination),
    exitCode,
    message,
    mimeType: "application/pdf",
    sizeBytes: 12_345,
    termination,
  });

beforeEach(() => {
  captured.length = 0;
  resetCaptureWindows();
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
    captureError(new Error("Privileged client matter detail"));

    const fingerprint = captured.at(0)?.properties["$exception_fingerprint"];
    expect(typeof fingerprint).toBe("string");
    expect(fingerprint).not.toContain("Privileged");
  });
});

describe("captureRequestError organization attribution", () => {
  test("attaches the organization group from the request context", () => {
    const organizationId = "3f6e0a7e-9f6f-4a53-9a3e-2b8f6f0c9d41";
    const request = new Request("https://api.test/internal");
    initRequestContext(request);
    enrichRequestContext(request, { organizationId });

    captureRequestError(new Error("boom"), { request });

    // The group is what PostHog's organization breakdown reads; losing it
    // while organization_id survives as a plain property would go unnoticed.
    expect(captured.at(0)?.groups).toEqual({ organization: organizationId });
  });

  test("stays ungrouped without an organization in the request context", () => {
    const request = new Request("https://api.test/internal");
    initRequestContext(request);

    captureRequestError(new Error("boom"), { request });

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
      { runId: "run-1" },
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
});

describe("captureError owned fields", () => {
  test("groups by the identity the legacy fields produced", () => {
    const driverError = Object.assign(new Error("driver"), {
      errno: "23505",
      constraint: "users_email_key",
    });
    const error = new Error("query failed", { cause: driverError });

    captureError(error);

    expect(captured.at(0)?.properties["$exception_fingerprint"]).toBe(
      legacy.legacyErrorIdentity(legacy.errorFingerprint(error)),
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

  test("a request capture is graded with its request's own evidence", () => {
    const request = new Request("https://api.test/v1/items");
    initRequestContext(request);

    captureRequestError(
      Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      { request },
    );

    expect(captured.at(0)?.properties).toMatchObject({
      "failure.grade": "transient",
      "failure.reason": "network_reset",
    });
  });
});
