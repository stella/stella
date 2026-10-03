import { describe, expect, test } from "bun:test";

import {
  aiHandlerError,
  classifyAIError,
  providerStatusCode,
} from "@/api/lib/ai-error";
import { PROVIDER_CALL_ERROR_MESSAGE } from "@/api/lib/errors/provider-call-error";
import { createProviderCallError } from "@/api/lib/errors/provider-call-failure";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const SENTINEL = "SENTINEL_PROVIDER_CALL_BODY";

describe("provider call error structural contract", () => {
  for (const keySource of ["byok", "instance"] as const) {
    for (const status of [400, 401, 402, 403, 404, 429, 500, 503]) {
      test(`${keySource} status ${status} preserves classification and structural serialization`, () => {
        const evidence = {
          error: { code: status, message: SENTINEL },
          headers: new Headers({ "x-request-id": "request-fixture" }),
        };
        const original = new HandlerError({
          status: 502,
          message: SENTINEL,
          cause: evidence,
        });
        const error = createProviderCallError({
          model: { provider: "openrouter", keySource },
          status: 502,
          evidence,
        });
        expect(error.kind).toBe(classifyAIError(original));
        expect(classifyAIError(error)).toBe(classifyAIError(original));
        const fallback = { status: 502, message: "Generation failed" } as const;
        expect(aiHandlerError(error, fallback).status).toBe(
          aiHandlerError(original, fallback).status,
        );
        expect(aiHandlerError(error, fallback).message).toBe(
          PROVIDER_CALL_ERROR_MESSAGE,
        );
        expect(providerStatusCode(error.cause)).toBe(status);
        expect(error).toMatchObject({
          message: PROVIDER_CALL_ERROR_MESSAGE,
          provider: "openrouter",
          keySource,
          providerStatus: status,
          requestId: "request-fixture",
          status: 502,
        });
        const analytics = installRecordingAnalytics();
        const logs = installRecordingLogger();
        try {
          const sink = failureSink({ event: "provider_call.failure" });
          observeFailure(aiHandlerError(error, fallback), { sink });
          expect(logs.records.length).toBeGreaterThan(0);
          expect(
            JSON.stringify({ logs: logs.records, analytics: analytics.events }),
          ).not.toContain(SENTINEL);
        } finally {
          logs.restore();
          analytics.restore();
        }
        for (const serialized of [
          JSON.stringify(error),
          JSON.stringify(error.toJSON()),
          JSON.stringify(structuredClone(error)),
          JSON.stringify({ ...error }),
          String(error),
          error.stack ?? "",
          JSON.stringify(readEvidence(error)),
        ]) {
          expect(serialized).not.toContain(SENTINEL);
        }
      });
    }
  }
  test("projects an event request id and provider retry disposition", () => {
    const error = createProviderCallError({
      model: { provider: "openrouter", keySource: "instance" },
      status: 502,
      evidence: {
        requestId: "event-request",
        status: 503,
        isRetryable: false,
        message: SENTINEL,
      },
    });
    expect(error).toMatchObject({
      requestId: "event-request",
      kind: "provider_unavailable",
      cause: { status: 503, isRetryable: false },
    });
    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });
});
