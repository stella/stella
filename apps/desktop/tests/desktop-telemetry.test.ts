import { describe, expect, test } from "bun:test";

import {
  describeError,
  messageDigest,
  redactErrorMessage,
} from "../src/telemetry/desktop-telemetry";

describe("redactErrorMessage", () => {
  test("drops quoted content but keeps single-quoted code identifiers", () => {
    expect(
      redactErrorMessage(
        `Unexpected token 'a', "Article 12 of the lease agreement" is not valid JSON`,
      ),
    ).toBe(`Unexpected token 'a', "…" is not valid JSON`);
    expect(
      redactErrorMessage(
        "undefined is not an object (evaluating 'item.sourceApp.name')",
      ),
    ).toBe("undefined is not an object (evaluating 'item.sourceApp.name')");
    expect(redactErrorMessage("Cannot read 'Jan Novák' from `notes`")).toBe(
      `Cannot read "…" from "…"`,
    );
    expect(redactErrorMessage('unterminated "quote text')).toBe(
      'unterminated "…"',
    );
  });

  test("drops urls and long tokens and bounds the length", () => {
    expect(
      redactErrorMessage(
        "Load failed https://example.org/contracts/42?token=abc now",
      ),
    ).toBe("Load failed <url> now");
    expect(redactErrorMessage(`blob ${"A".repeat(80)} rejected`)).toBe(
      "blob … rejected",
    );
    const long = redactErrorMessage("word ".repeat(100));
    expect(long.length).toBe(201);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("describeError", () => {
  test("names the error class and the top bundle frame from a WebKit stack", () => {
    const error = new TypeError(
      "undefined is not an object (evaluating 'item.sourceApp.name')",
    );
    error.stack = [
      "renderCard@tauri://localhost/assets/index-3f2a9c.js:12:34",
      "@tauri://localhost/assets/index-3f2a9c.js:40:2",
    ].join("\n");

    expect(describeError(error)).toEqual({
      errorName: "TypeError",
      frame: "renderCard@index-3f2a9c.js:12:34",
      message: "undefined is not an object (evaluating 'item.sourceApp.name')",
    });
  });

  test("reads Chromium stack frames too", () => {
    const error = new RangeError("Maximum call stack size exceeded");
    error.stack = [
      "RangeError: Maximum call stack size exceeded",
      "    at grow (http://localhost:1420/assets/rail-9b1.js:7:19)",
    ].join("\n");

    expect(describeError(error).frame).toBe("grow@rail-9b1.js:7:19");
  });

  test("digests every message the engine did not write", () => {
    // Same vector as the native test, so both sides agree on the digest.
    expect(messageDigest("a")).toBe("poly64:af63bd4c8601b840");
    expect(describeError("clipboard item no longer exists")).toEqual({
      errorName: "string",
      frame: null,
      message: messageDigest("clipboard item no longer exists"),
    });
    expect(describeError("Attorney client notes").message).not.toContain(
      "Attorney",
    );
    expect(describeError(new Error("privileged draft text")).message).toBe(
      messageDigest("privileged draft text"),
    );
    expect(
      describeError({
        kind: "copy",
        message: 'clipboard write failed for "Share purchase agreement"',
      }),
    ).toEqual({
      errorName: "object.copy",
      frame: null,
      message: messageDigest(
        'clipboard write failed for "Share purchase agreement"',
      ),
    });
    expect(describeError(undefined)).toEqual({
      errorName: "undefined",
      frame: null,
      message: "",
    });
    expect(describeError(null).errorName).toBe("null");
  });

  test("falls back to Error for names that are not identifiers", () => {
    const error = new Error("boom");
    error.name = "Not An Identifier";

    expect(describeError(error).errorName).toBe("Error");
  });
});
