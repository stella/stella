import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSharepointOAuthCallback } from "@/api/handlers/sharepoint/oauth-callback";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  getRequestId,
  initRequestContext,
} from "@/api/lib/observability/request-context";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// The deployment flag is read at env import time; the gate itself is not
// under test here, so replace it wholesale (a full module mock, no partial).
const sharepointOAuthCallback = createSharepointOAuthCallback({
  assertSharepointConnectionEnabled: async () =>
    await Promise.resolve(Result.ok(undefined)),
});

type CallbackCtx = Parameters<typeof sharepointOAuthCallback.handler>[0];

const orgA = toSafeId<"organization">("org_a");
const userA = toSafeId<"user">("user_a");

const reasonOf = (result: unknown): string | null => {
  if (!(result instanceof Response)) {
    throw new Error(`expected a 302 Response, got ${JSON.stringify(result)}`);
  }
  expect(result.status).toBe(302);
  const location = result.headers.get("Location");
  expect(location).not.toBeNull();
  return new URL(location ?? "").searchParams.get("reason");
};

// The state-row lookup goes through safeDb; queue results in call order.
const queuedSafeDb = (results: unknown[]): CallbackCtx["safeDb"] =>
  asTestRaw<CallbackCtx["safeDb"]>(async () => {
    const next = results.shift();
    if (next instanceof Error) {
      return Result.err(next);
    }
    return Result.ok(next);
  });

const scopedRequest = (): Request => {
  const request = new Request("https://api.test/sharepoint/oauth/callback");
  initRequestContext(request);
  return request;
};

const failingLookupContext = (
  error: Error,
  request: Request = scopedRequest(),
): CallbackCtx =>
  asTestRaw<CallbackCtx>({
    query: { code: "auth-code", state: "state-token" },
    request,
    safeDb: queuedSafeDb([error]),
    scopedDb: asTestRaw<CallbackCtx["scopedDb"]>(async () => undefined),
    session: { activeOrganizationId: orgA },
    user: { id: userA },
    memberRole: { role: "owner" },
    recordAuditEvent: async () => {},
  });

describe("sharepointOAuthCallback", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
  });

  const failureRecords = () =>
    logs.records.filter((record) => record.message === "oauth_callback.failed");

  // A safeDb failure surfaces as Result.err, not a thrown exception. The
  // callback must still redirect (never a raw JSON error body) so the popup
  // can close itself instead of showing an API error page.
  test("redirects a failed DB lookup to invalid-secret and reports it", async () => {
    const result = await sharepointOAuthCallback.handler(
      failingLookupContext(
        new HandlerError({ status: 500, message: "db down" }),
      ),
    );

    expect(reasonOf(result)).toBe("invalid-secret");
    expect(
      analytics.exceptions().map((event) => event.properties),
    ).toMatchObject([
      { "error.class": "HandlerError", operation: "sharepoint_oauth_callback" },
    ]);
  });

  test("does not report a client-side handler error", async () => {
    const result = await sharepointOAuthCallback.handler(
      failingLookupContext(
        new HandlerError({ status: 409, message: "Reconnect required" }),
      ),
    );

    expect(reasonOf(result)).toBe("invalid-secret");
    expect(analytics.exceptions()).toEqual([]);
  });

  test("logs the failure with the request id", async () => {
    const request = scopedRequest();
    await sharepointOAuthCallback.handler(
      failingLookupContext(
        new HandlerError({ status: 500, message: "db down" }),
        request,
      ),
    );

    expect(failureRecords().map((record) => record.attributes)).toMatchObject([
      {
        "request.id": getRequestId(request),
        operation: "sharepoint_oauth_callback",
      },
    ]);
  });

  test("logs a transient network failure as a warning without reporting it", async () => {
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const result = await sharepointOAuthCallback.handler(
      failingLookupContext(
        new DatabaseError({ message: "connection reset", cause: reset }),
      ),
    );

    expect(reasonOf(result)).toBe("unexpected");
    expect(failureRecords().map((record) => record.severityText)).toEqual([
      "WARN",
    ]);
    expect(analytics.exceptions()).toEqual([]);
  });
});
