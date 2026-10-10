import { SQL } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import { errorFingerprint } from "@/api/lib/errors/utils";
import { logger, sanitizeLogAttributes } from "@/api/lib/observability/logger";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

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

  test("direct and nested bigint attributes emit as strings", () => {
    const attributes = {
      count: 123n,
      diagnostic: { count: 456n, values: [789n] },
      attempts: 1,
    };
    const expected = {
      count: "123",
      diagnostic: '{"count":"456","values":["789"]}',
      attempts: 1,
    };
    expect(sanitizeLogAttributes(attributes)).toEqual(expected);
    const recording = installRecordingLogger();
    try {
      logger.error("test.failed", attributes);
      expect(recording.records).toEqual([
        { severityText: "ERROR", message: "test.failed", attributes: expected },
      ]);
    } finally {
      recording.restore();
    }
    const chunks: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    logger.error("test.failed", attributes);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks.join(""))).toEqual({
      severity: "ERROR",
      message: "test.failed",
      ...expected,
    });
  });

  test("error attributes use projected fields during JSON serialization", () => {
    const value = "fixture-query-value";
    const diagnostic = Object.assign(new Error("Diagnostic unavailable"), {
      operation: "fetch",
      toJSON: () => ({ params: [value] }),
    });
    const recording = installRecordingLogger();
    try {
      logger.error("test.failed", { diagnostic });
      const serialized = recording.records.at(0)?.attributes?.["diagnostic"];
      expect(serialized).toContain('"operation":"fetch"');
      expect(serialized).not.toContain(value);
      expect(serialized).not.toContain('"params"');
    } finally {
      recording.restore();
    }
  });

  test("streams operational info while keeping debug off the backstop", () => {
    const chunks: string[] = [];
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    logger.debug("test.debug");
    expect(chunks).toEqual([]);

    logger.info("test.info", { "http.route": "/test" });
    const output = chunks.join("");
    expect(output).toContain('"message":"test.info"');
    expect(output).toContain('"http.route":"/test"');
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
        "error.class": "TaggedError",
        "error.code": "DATABASE_UNAVAILABLE",
        "error.frame": "src/server.ts:10:2",
        "error.cause.pg_code": "08006",
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

  test("request sink emits every field the fingerprint reports", () => {
    const chunks: string[] = [];
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    // A wrapped failure is the case that distinguishes the sink from the
    // fingerprint: the wrapper answers `error.class`, and only the cause
    // fields say what actually failed. Asserting over the fingerprint's own
    // output rather than a written-out key list means a field added there is
    // covered here without this test being edited.
    const fingerprint = errorFingerprint(
      new Error("outer", { cause: new Error("inner") }),
    );

    logger.request({
      durationMs: 7,
      errorFingerprint: fingerprint,
      message: "request.failed",
      method: "POST",
      route: "/test/:id",
      severity: "ERROR",
      statusCode: 500,
    });

    const emitted: unknown = JSON.parse(chunks.join(""));
    expect(fingerprint["error.cause.class"]).toBe("Error");
    expect(emitted).toMatchObject(fingerprint);
  });

  test("request log retains a wrapped Bun Postgres idle code", () => {
    const driver = new SQL.PostgresError("idle", {
      code: "ERR_POSTGRES_IDLE_TIMEOUT",
    });
    const chunks: string[] = [];
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    logger.request({
      durationMs: 1,
      errorFingerprint: errorFingerprint(
        new DrizzleQueryError("query failed", [], driver),
      ),
      message: "request.failed",
      method: "POST",
      route: "/test",
      severity: "ERROR",
      statusCode: 500,
    });

    const emitted: unknown = JSON.parse(chunks.join(""));
    expect(emitted).toMatchObject({
      "error.cause.pg_driver_code": "ERR_POSTGRES_IDLE_TIMEOUT",
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

describe("failure ownership in log records", () => {
  test("a failure key outside its closed vocabulary is dropped", () => {
    expect(
      sanitizeLogAttributes({
        "failure.grade": "PRIVILEGED-SENTINEL",
        "failure.reason": "not a reason",
        "failure.shadow_grade": "transient",
        "failure.shadow_reason": "network_reset",
      }),
    ).toEqual({
      "failure.shadow_grade": "transient",
      "failure.shadow_reason": "network_reset",
      "log.attributes_dropped": 2,
    });
  });

  test("marks a WARN or ERROR error record without a grade as unowned", () => {
    const logs = installRecordingLogger();
    try {
      logger.warn("site.failed", { "error.type": "TaggedError" });
      logger.error("site.failed", {
        "error.type": "TaggedError",
        "failure.grade": "defect",
      });
      logger.info("site.done", { "error.type": "TaggedError" });
      logger.warn("site.slow", { "http.route": "/x" });

      expect(
        logs.records.map(
          ({ attributes }) => attributes?.["observability.unowned"],
        ),
      ).toEqual([true, undefined, undefined, undefined]);
    } finally {
      logs.restore();
    }
  });

  test("a request record carries the request's grade, and a fingerprint cannot override its own keys", () => {
    const logs = installRecordingLogger();
    try {
      logger.request({
        durationMs: 3,
        errorFingerprint: {
          "error.class": "Error",
          "http.status_code": "spoofed",
        },
        failure: { grade: "transient", reason: "network_reset" },
        message: "request.failed",
        method: "GET",
        route: "/x",
        severity: "ERROR",
        statusCode: 502,
      });
      logger.request({
        durationMs: 3,
        errorType: "HandlerError",
        message: "request.failed",
        method: "GET",
        route: "/x",
        severity: "WARN",
        statusCode: 404,
      });

      expect(logs.records.map(({ attributes }) => attributes)).toEqual([
        {
          "error.class": "Error",
          "http.method": "GET",
          "http.route": "/x",
          "http.status_code": 502,
          "request.duration_ms": 3,
          "failure.grade": "transient",
          "failure.reason": "network_reset",
          "failure.shadow": "true",
        },
        {
          "http.method": "GET",
          "http.route": "/x",
          "http.status_code": 404,
          "request.duration_ms": 3,
          "error.type": "HandlerError",
          "observability.unowned": true,
        },
      ]);
    } finally {
      logs.restore();
    }
  });
});
