import { afterEach, describe, expect, test } from "bun:test";

import { logger, sanitizeLogAttributes } from "@/api/lib/observability/logger";

const originalStderrWrite = process.stderr.write;

afterEach(() => {
  process.stderr.write = originalStderrWrite;
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

  test("stderr backstop emits only sanitized attributes", () => {
    const chunks: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;

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
});
