import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  aiHandlerError,
  classifyAIError,
  providerStatusCode,
} from "@/api/lib/ai-error";
import { MANAGED_PROVIDER_UNAVAILABLE_CODE } from "@/api/lib/chat/provider-data-policy";
import { INCOMPLETE_STREAM_CODE } from "@/api/lib/chat/provider-stream-contract";
import {
  PROVIDER_CALL_ERROR_MESSAGE,
  PROVIDER_ERROR_CODE,
} from "@/api/lib/errors/provider-call-error";
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
          const sink = failureSink({
            event: "provider_call.failure",
            expected: [],
          });
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
          JSON.stringify(Object.fromEntries(Object.entries(error))),
          Error.prototype.toString.call(error),
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

  for (const isRetryable of [true, false]) {
    test(`preserves managed unavailable code and retry disposition when mapped (${isRetryable})`, () => {
      const error = createProviderCallError({
        model: { provider: "openrouter", keySource: "instance" },
        status: 503,
        code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
        evidence: { status: 503, isRetryable },
      });

      const mapped = aiHandlerError(error, {
        status: 502,
        message: "Generation failed",
      });

      expect(mapped).toMatchObject({
        status: 502,
        code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
        cause: { status: 503, isRetryable },
      });
    });
  }
});

describe("provider call error codes", () => {
  test("keep the application's own codes and name every other value provider_error", () => {
    const ownCodes = [
      MANAGED_PROVIDER_UNAVAILABLE_CODE,
      INCOMPLETE_STREAM_CODE,
      "max_tokens",
    ] as const;
    assertProperty(
      "keep the application's own codes and name every other value provider_error",
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom(...ownCodes)),
        fc.constantFrom(400, 429, 500, 502, 503),
        (code, status) => {
          const error = createProviderCallError({
            model: { provider: "openrouter", keySource: "byok" },
            status: 502,
            code,
            evidence: { error: { code: status, message: code } },
          });
          const expected =
            ownCodes.find((own) => own === code) ?? PROVIDER_ERROR_CODE;
          expect(error.code).toBe(expected);
          expect(error.message).toBe(PROVIDER_CALL_ERROR_MESSAGE);
          const fallback = {
            status: 502,
            message: "Generation failed",
          } as const;
          expect(aiHandlerError(error, fallback).code).toBe(expected);
        },
      ),
    );
  });

  test("leaves an absent code absent", () => {
    expect(
      createProviderCallError({
        model: { provider: "openrouter", keySource: "byok" },
        status: 502,
        evidence: {},
      }).code,
    ).toBeUndefined();
  });

  test("reach the HTTP body and telemetry as the closed value", () => {
    const sentinel = "SENTINEL_PROVIDER_CODE";
    const error = createProviderCallError({
      model: { provider: "openrouter", keySource: "byok" },
      status: 502,
      code: sentinel,
      evidence: { error: { code: 503, message: sentinel } },
    });
    const fallback = { status: 502, message: "Generation failed" } as const;
    expect(aiHandlerError(error, fallback).code).toBe(PROVIDER_ERROR_CODE);
    const analytics = installRecordingAnalytics();
    const logs = installRecordingLogger();
    try {
      const sink = failureSink({
        event: "provider_call.failure",
        expected: [],
      });
      observeFailure(aiHandlerError(error, fallback), { sink });
      expect(JSON.stringify(analytics.events)).not.toContain(sentinel);
      expect(JSON.stringify(logs.records)).not.toContain(sentinel);
    } finally {
      analytics.restore();
      logs.restore();
    }
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });
});
