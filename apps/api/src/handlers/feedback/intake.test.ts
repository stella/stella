import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import Elysia from "elysia";

import { FEEDBACK_LIMITS } from "@stll/api-contract/feedback";
import type { FeedbackSubmitResponse } from "@stll/api-contract/feedback";

import {
  MAX_RAW_FEEDBACK_BODY_CHARS,
  receivePublicFeedback,
} from "@/api/handlers/feedback/intake";
import { createFeedbackIntakeGuards } from "@/api/handlers/feedback/intake-guards";
import { feedbackPublicRoute } from "@/api/handlers/feedback/routes";
import { FeedbackStoreError } from "@/api/handlers/feedback/submit";
import type { submitFeedbackReport } from "@/api/handlers/feedback/submit";

const SUBMIT_RESPONSE: FeedbackSubmitResponse = {
  receipt: "FB-7K2M-9QXZ",
  redactions: 0,
  deduplicated: false,
  deliveries: [{ channel: "email", status: "delivered" }],
  stored: true,
};

const submitMock = mock<typeof submitFeedbackReport>(async () =>
  Result.ok(SUBMIT_RESPONSE),
);

const receiveForTest = async ({
  deps,
  ...input
}: Parameters<typeof receivePublicFeedback>[0]) =>
  await receivePublicFeedback({
    ...input,
    deps: { submit: submitMock, ...deps },
  });

// In-memory-only guards: force the Redis path to throw so every call falls back
// to the deterministic in-process counters.
const memoryGuards = () =>
  createFeedbackIntakeGuards({
    createRedis: () => ({
      send: async () => {
        throw new Error("no redis in test");
      },
    }),
    onRedisError: () => undefined,
  });

const raw = (overrides?: Record<string, unknown>): string =>
  JSON.stringify({
    kind: "bug",
    area: "documents",
    title: "read_document returns empty",
    whatHappened: "Called read_document on a large PDF; the body was empty.",
    ...overrides,
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readErrorCode = async (
  response: Response,
): Promise<string | undefined> => {
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !isRecord(payload["error"])) {
    return undefined;
  }
  const code = payload["error"]["code"];
  return typeof code === "string" ? code : undefined;
};

describe("public feedback intake", () => {
  beforeEach(() => {
    submitMock.mockClear();
  });

  test("answers with the submit response and passes an intake reporter", async () => {
    const response = await receiveForTest({
      rawBody: raw({ instance: "self-hosted" }),
      clientIp: "203.0.113.5",
      deps: { guards: memoryGuards() },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SUBMIT_RESPONSE);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls.at(0)?.[0]).toMatchObject({
      reporter: { via: "intake" },
      instance: "self-hosted",
    });
  });

  test("keeps `instance` out of the report the service stores", async () => {
    await receiveForTest({
      rawBody: raw({ instance: "self-hosted" }),
      clientIp: "203.0.113.16",
      deps: { guards: memoryGuards() },
    });

    const input = submitMock.mock.calls.at(0)?.[0].input;
    expect(input).not.toHaveProperty("instance");
  });

  test("rate-limits after 5 submissions from one IP", async () => {
    const deps = { guards: memoryGuards() };
    const ip = "203.0.113.8";

    for (let index = 0; index < 5; index += 1) {
      const ok = await receiveForTest({
        rawBody: raw({ title: `report ${index}` }),
        clientIp: ip,
        deps,
      });
      expect(ok.status).toBe(200);
    }

    const blocked = await receiveForTest({
      rawBody: raw({ title: "report 6" }),
      clientIp: ip,
      deps,
    });

    expect(blocked.status).toBe(429);
    expect(await readErrorCode(blocked)).toBe("rate_limited");
    // The refusal happens before the service is reached.
    expect(submitMock).toHaveBeenCalledTimes(5);
  });

  test("answers 503 when the report could not be stored", async () => {
    const failing = mock<typeof submitFeedbackReport>(async () =>
      Result.err(new FeedbackStoreError({ message: "nope" })),
    );

    const response = await receiveForTest({
      rawBody: raw(),
      clientIp: "203.0.113.14",
      deps: { guards: memoryGuards(), submit: failing },
    });

    expect(response.status).toBe(503);
    expect(await readErrorCode(response)).toBe("internal_error");
  });

  test("schema rejects an oversized whatHappened (422)", async () => {
    const response = await receiveForTest({
      rawBody: raw({ whatHappened: "x".repeat(4001) }),
      clientIp: "203.0.113.10",
      deps: { guards: memoryGuards() },
    });

    expect(response.status).toBe(422);
    expect(await readErrorCode(response)).toBe("validation_error");
    expect(submitMock).not.toHaveBeenCalled();
  });

  test("schema rejects unknown keys (422)", async () => {
    const response = await receiveForTest({
      rawBody: raw({ severity: "high" }),
      clientIp: "203.0.113.11",
      deps: { guards: memoryGuards() },
    });

    expect(response.status).toBe(422);
    expect(await readErrorCode(response)).toBe("validation_error");
  });

  test("schema rejects an unknown key inside context (422)", async () => {
    const response = await receiveForTest({
      rawBody: raw({ context: { client: "web", tenant: "acme" } }),
      clientIp: "203.0.113.18",
      deps: { guards: memoryGuards() },
    });

    expect(response.status).toBe(422);
    expect(await readErrorCode(response)).toBe("validation_error");
  });

  test("rejects a malformed JSON body (400)", async () => {
    const response = await receiveForTest({
      rawBody: "{not json",
      clientIp: "203.0.113.12",
      deps: { guards: memoryGuards() },
    });

    expect(response.status).toBe(400);
    expect(await readErrorCode(response)).toBe("validation_error");
  });

  // End-to-end through Elysia routing + parse:"text", to prove the route wires
  // to the handler and the strict contract survives the framework layer. The
  // unknown-key rejection (422) is deterministic and proves the strict Valibot
  // contract runs on the raw payload rather than on Elysia's normalized object.
  test("route wiring: POST /public/feedback reaches the handler", async () => {
    const app = new Elysia().use(feedbackPublicRoute);

    const unknownKey = await app.handle(
      new Request("http://api.test/public/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw({ junk: 1 }),
      }),
    );

    expect(unknownKey.status).toBe(422);
  });

  test("the raw cap admits the worst-case report the schema accepts", () => {
    // Every cap filled with the character JSON escapes most expensively, so
    // the route's coarse byte bound can never refuse a payload the field caps
    // admit. Built from FEEDBACK_LIMITS, so raising a cap re-measures this.
    const worst = (max: number) => "\u0000".repeat(max);
    const escapedRaw = JSON.stringify({
      kind: "bug",
      area: "documents",
      title: worst(FEEDBACK_LIMITS.title),
      whatHappened: worst(FEEDBACK_LIMITS.whatHappened),
      expected: worst(FEEDBACK_LIMITS.expected),
      steps: worst(FEEDBACK_LIMITS.steps),
      evidence: worst(FEEDBACK_LIMITS.evidence),
      instance: worst(FEEDBACK_LIMITS.contextField),
      context: {
        client: "web",
        clientVersion: worst(FEEDBACK_LIMITS.contextField),
        requestId: "r".repeat(64),
        route: worst(FEEDBACK_LIMITS.contextField),
        errorReference: worst(FEEDBACK_LIMITS.contextField),
      },
    });

    expect(escapedRaw.length).toBeLessThanOrEqual(MAX_RAW_FEEDBACK_BODY_CHARS);
  });
});
