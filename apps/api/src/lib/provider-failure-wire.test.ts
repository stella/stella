import { EventType } from "@tanstack/ai";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import { AI_ERROR_KINDS } from "@stll/api-contract";
import { FAILURE_GRADES, FAILURE_REASON_GRADE } from "@stll/errors";

import { classifyRunErrorChunk } from "@/api/handlers/chat/stream-chat";
import {
  classifyAIError,
  providerErrorBody,
  providerFailureFacts,
  providerStatusCode,
} from "@/api/lib/ai-error";
import {
  ModelDeadlineExceededError,
  ModelOutputIncompleteError,
  ModelOutputInvalidError,
  ModelOutputModeratedError,
  ModelRunUnfinishedError,
  PROVIDER_CALL_FAILURE_REASON,
  ProviderCallError,
} from "@/api/lib/errors/provider-call-error";
import { createProviderCallError } from "@/api/lib/errors/provider-call-failure";
import {
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
  WorkflowIntegrationError,
} from "@/api/lib/errors/tagged-errors";
import {
  failureSink,
  gradeFailure,
  NETWORK_ERROR_CODE_REASON,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";

const fixtureSchema = v.strictObject({
  provider: v.picklist(TANSTACK_AI_PROVIDERS),
  source: v.literal("synthetic"),
  basis: v.string(),
  cases: v.array(
    v.strictObject({
      name: v.string(),
      origin: v.picklist([
        "sdk",
        "transport",
        "plain-error",
        "run-error",
        "unfinished",
        "parse",
        "schema",
        "moderation",
        "deadline",
        "loop",
        "empty",
      ]),
      evidence: v.optional(v.record(v.string(), v.unknown())),
      expected: v.strictObject({
        kind: v.picklist(AI_ERROR_KINDS),
        status: v.nullable(v.number()),
        grade: v.picklist(FAILURE_GRADES),
      }),
    }),
  ),
});

const transportEnvelopeSchema = v.strictObject({
  name: v.string(),
  message: v.string(),
  cause: v.strictObject({ code: v.string(), message: v.string() }),
});

type FailureCase = v.InferOutput<typeof fixtureSchema>["cases"][number];

// These are normalized boundary shapes, not fabricated live recordings. The
// model-owned outcomes have no HTTP response; their producer is a named error.
const evidenceFor = (
  fixture: FailureCase,
  model: {
    provider: (typeof TANSTACK_AI_PROVIDERS)[number];
    keySource: "byok";
  },
): unknown => {
  const { origin, evidence } = fixture;
  switch (origin) {
    case "sdk":
      return evidence;
    case "transport": {
      const envelope = v.parse(transportEnvelopeSchema, evidence);
      const cause = Object.assign(new Error(envelope.cause.message), {
        code: envelope.cause.code,
      });
      return Object.assign(new Error(envelope.message, { cause }), {
        name: envelope.name,
      });
    }
    case "plain-error":
    case "run-error": {
      const message = evidence?.["message"];
      if (typeof message !== "string") {
        return panic("A message envelope needs a string message");
      }
      if (origin === "plain-error") {
        return new Error(message);
      }
      expect(
        classifyRunErrorChunk({
          type: EventType.RUN_ERROR,
          message,
          timestamp: 1,
        }),
      ).toBe(fixture.expected.kind);
      return providerErrorBody(message);
    }
    case "unfinished":
      return new ModelRunUnfinishedError({ model });
    case "parse":
      return new ModelOutputIncompleteError({ model });
    case "schema":
      return new ModelOutputInvalidError({ model });
    case "moderation":
      return new ModelOutputModeratedError({ model });
    case "deadline":
      return new ModelDeadlineExceededError({ deadlineMs: 1000 });
    case "loop":
      return new ChatLoopDetectedError({ message: "Run repeated its work" });
    case "empty":
      return new ChatEmptyCompletionError({
        message: "Run returned no answer",
      });
    default:
      origin satisfies never;
      return panic("Unknown failure fixture origin");
  }
};

const sink = failureSink({ event: "chat.stream_failed", expected: [] });

for (const provider of TANSTACK_AI_PROVIDERS) {
  const fixture = v.parse(
    fixtureSchema,
    JSON.parse(
      readFileSync(
        new URL(
          `../tests/fixtures/provider-wire/${provider}/errors/grading.json`,
          import.meta.url,
        ),
        "utf-8",
      ),
    ),
  );
  describe(`${provider} failure wire grading`, () => {
    test("covers every classified outcome for the registered adapter", () => {
      expect(fixture.provider).toBe(provider);
      expect(
        [
          ...new Set(fixture.cases.map(({ expected }) => expected.kind)),
        ].toSorted(),
      ).toEqual([...AI_ERROR_KINDS].toSorted());
    });

    test("covers every declared network code, including endpoint configuration failures", () => {
      const codes = fixture.cases
        .filter(({ origin }) => origin === "transport")
        .map(
          ({ evidence }) =>
            v.parse(transportEnvelopeSchema, evidence).cause.code,
        );
      expect(codes.toSorted()).toEqual(
        Object.keys(NETWORK_ERROR_CODE_REASON).toSorted(),
      );
    });

    for (const entry of fixture.cases) {
      test(entry.name, () => {
        const model = { provider, keySource: "byok" as const };
        const evidence = evidenceFor(entry, model);
        expect(classifyAIError(evidence)).toBe(entry.expected.kind);
        expect(providerStatusCode(evidence)).toBe(entry.expected.status);
        const error = createProviderCallError({ model, evidence, status: 502 });
        expect(classifyAIError(error)).toBe(entry.expected.kind);
        expect(error.providerStatus ?? null).toBe(entry.expected.status);
        expect(gradeFailure(readEvidence(error), sink).grade).toBe(
          entry.expected.grade,
        );
      });
    }
  });
}

test("provider message recovery accepts only complete known envelopes", () => {
  for (const message of [
    'The request contained {"error":{"code":429}}',
    'got status: 429. {"error":{"code":429}} trailing prose',
    'got status: 999. {"error":{"code":429}}',
    'got status: 429. {"error":',
  ]) {
    expect(providerErrorBody(message)).toBeUndefined();
  }
  expect(providerErrorBody(' \n {"error":{"code":429}}')).toEqual({
    error: { code: 429 },
  });
});

describe("wrapped provider message evidence", () => {
  test("wrappers retain every declared provider kind without losing response facts", () => {
    const model = { provider: "google", keySource: "byok" } as const;
    for (const kind of AI_ERROR_KINDS) {
      for (const status of [403, 503]) {
        const classified = new ProviderCallError({
          model,
          status: 502,
          kind,
          facts: { status, isRetryable: true },
        });
        const wrappers = [
          new Error("Adapter failed", { cause: classified }),
          new HandlerError({
            message: "Adapter failed",
            status: 502,
            code: "internal_error",
            cause: classified,
          }),
          new WorkflowIntegrationError({
            message: "Adapter failed",
            cause: classified,
          }),
        ];
        for (const evidence of wrappers) {
          expect(classifyAIError(evidence)).toBe(kind);
          expect(providerFailureFacts(evidence)).toEqual({
            status,
            isRetryable: true,
          });
          const rebuilt = createProviderCallError({
            model,
            evidence,
            status: 502,
          });
          expect(rebuilt.kind).toBe(kind);
          expect(rebuilt.providerStatus).toBe(status);
          expect(gradeFailure(readEvidence(rebuilt), sink).grade).toBe(
            FAILURE_REASON_GRADE[PROVIDER_CALL_FAILURE_REASON[kind]],
          );
        }
      }
    }
  });

  test("an outer provider response precedes a nested declared kind", () => {
    const classified = new ProviderCallError({
      model: { provider: "google", keySource: "byok" },
      status: 502,
      kind: "provider_stream_incomplete",
      facts: { status: 503 },
    });
    const evidence = Object.assign(
      new Error("Forbidden", { cause: classified }),
      { status: 403 },
    );
    expect(classifyAIError(evidence)).toBe("unknown");
    expect(providerFailureFacts(evidence)).toEqual({ status: 403 });
  });

  test("keeps an unmapped selected status authoritative over a mapped cause", () => {
    const quota = Object.assign(new Error("quota"), { status: 429 });
    for (const evidence of [
      new Error('{"error":{"code":403}}', { cause: quota }),
      Object.assign(new Error("forbidden", { cause: quota }), { status: 403 }),
    ]) {
      expect(providerStatusCode(evidence)).toBe(403);
      expect(classifyAIError(evidence)).toBe("unknown");
      const error = createProviderCallError({
        model: { provider: "google", keySource: "byok" },
        evidence,
        status: 502,
      });
      expect(error.kind).toBe("unknown");
      expect(error.providerStatus).toBe(403);
      expect(error.cause).toMatchObject({ status: 403 });
      expect(gradeFailure(readEvidence(error), sink).grade).toBe("defect");
    }
  });
  test("classifies and preserves structured status ahead of conflicting message bodies", () => {
    for (const message of [
      '{"error":{"code":401}}',
      '{"error":{"type":"authentication_error"}}',
      'got status: 401. {"error":{"code":401}}',
    ]) {
      const evidence = Object.assign(new Error(message), {
        status: 429,
        isRetryable: true,
      });
      expect(classifyAIError(evidence)).toBe("quota_exhausted");
      expect(providerStatusCode(evidence)).toBe(429);
      const error = createProviderCallError({
        model: { provider: "google", keySource: "byok" },
        evidence,
        status: 502,
      });
      expect(error.kind).toBe("quota_exhausted");
      expect(error.providerStatus).toBe(429);
      expect(error.cause).toMatchObject({ status: 429, isRetryable: true });
      expect(gradeFailure(readEvidence(error), sink).grade).toBe("transient");
    }
  });
  for (const depth of [1, 2]) {
    test(`preserves status through ${depth} wrappers and a cause cycle`, () => {
      const inner = Object.assign(
        new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'),
        { isRetryable: true },
      );
      let wrapped: Error = inner;
      for (let level = 0; level < depth; level += 1) {
        wrapped = new Error("Wrapped", { cause: wrapped });
      }
      inner.cause = wrapped;
      expect(classifyAIError(wrapped)).toBe("quota_exhausted");
      expect(providerStatusCode(wrapped)).toBe(429);
      const error = createProviderCallError({
        model: { provider: "google", keySource: "byok" },
        evidence: wrapped,
        status: 502,
      });
      expect(error.kind).toBe("quota_exhausted");
      expect(error.providerStatus).toBe(429);
      expect(error.cause).toMatchObject({ status: 429, isRetryable: true });
      expect(gradeFailure(readEvidence(error), sink).grade).toBe("transient");
    });
  }
  test("terminates when a cause cycle carries no provider envelope", () => {
    const error = new Error("Wrapped");
    error.cause = new Error("Wrapped again", { cause: error });
    expect(providerStatusCode(error)).toBeNull();
    expect(classifyAIError(error)).toBe("unknown");
  });
});
