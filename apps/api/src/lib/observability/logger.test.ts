import { afterEach, describe, expect, test } from "bun:test";

import { logger, sanitizeLogAttributes } from "@/api/lib/observability/logger";

const originalStderrWrite = process.stderr.write;
const originalStdoutWrite = process.stdout.write;

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  process.stdout.write = originalStdoutWrite;
});

describe("logger attributes", () => {
  test("drops sensitive attribute keys before emission", () => {
    expect(
      sanitizeLogAttributes({
        body: "request payload",
        email: "person@example.com",
        "error.type": "TaggedError",
        fileName: "strategy.pdf",
        "http.status_code": 500,
        title: "Matter title",
      }),
    ).toEqual({
      "error.type": "TaggedError",
      "http.status_code": 500,
      "log.attributes_dropped": 4,
    });
  });

  test("redacts prompt content keys but keeps prompt token metrics", () => {
    expect(
      sanitizeLogAttributes({
        prompt: "draft this contract clause",
        promptText: "system instructions",
        systemPrompt: "you are a legal assistant",
        promptTokens: 128,
        prompt_tokens: 256,
        promptTokenCount: 512,
      }),
    ).toEqual({
      promptTokens: 128,
      prompt_tokens: 256,
      promptTokenCount: 512,
      "log.attributes_dropped": 3,
    });
  });

  test("stderr backstop emits only sanitized attributes", () => {
    const chunks: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    logger.error("test.failed", {
      body: "raw body",
      "error.type": "TaggedError",
      fileName: "secret.pdf",
      "http.route": "/test",
    });

    const output = chunks.join("");
    expect(output).toContain('"message":"test.failed"');
    expect(output).toContain('"error.type":"TaggedError"');
    expect(output).toContain('"http.route":"/test"');
    expect(output).toContain('"log.attributes_dropped":2');
    expect(output).not.toContain("raw body");
    expect(output).not.toContain("secret.pdf");
    expect(output).not.toContain("fileName");
    expect(output).not.toContain('"body"');
  });

  test("request sink emits only structured operational fields", () => {
    const chunks: string[] = [];
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    logger.request({
      durationMs: 42,
      errorFingerprint: {
        errorClass: "TaggedError",
        errorCode: "DATABASE_UNAVAILABLE",
        errorFrame: "src/server.ts:10:2",
        pgCode: "08006",
      },
      errorType: "TaggedError",
      message: "request.completed",
      method: "GET",
      requestId: "safe-request-id",
      route: "/test/:id",
      severity: "INFO",
      statusCode: 200,
    });

    const output = chunks.join("");
    expect(JSON.parse(output)).toEqual({
      severity: "INFO",
      message: "request.completed",
      "error.type": "TaggedError",
      "error.class": "TaggedError",
      "error.code": "DATABASE_UNAVAILABLE",
      "error.frame": "src/server.ts:10:2",
      "error.cause.pg_code": "08006",
      "http.method": "GET",
      "http.route": "/test/:id",
      "http.status_code": 200,
      "request.duration_ms": 42,
      "request.id": "safe-request-id",
    });
  });

  test("request sink never falls back to a raw unmatched URL", () => {
    const chunks: string[] = [];
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    logger.request({
      durationMs: 1,
      message: "request.failed",
      method: "GET",
      severity: "WARN",
      statusCode: 404,
    });

    expect(JSON.parse(chunks.join(""))).toMatchObject({
      "http.route": "unmatched",
    });
  });
});
