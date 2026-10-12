import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

import { isConnectionFailure } from "./connection-failure";

describe("connection failure classification", () => {
  test("recognizes the runtime error from a closed local port", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 204 }),
    });
    const url = server.url;
    await server.stop(true);
    const cause = await fetch(url).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(cause).toBeInstanceOf(TypeError);
    if (!(cause instanceof TypeError) || !("code" in cause)) {
      throw new TypeError("Expected a coded transport error");
    }
    expect(typeof cause.code).toBe("string");
    expect(
      isConnectionFailure(cause),
      JSON.stringify(cause, Object.getOwnPropertyNames(cause)),
    ).toBe(true);
  });

  for (const code of [
    "ConnectionRefused",
    "FailedToOpenSocket",
    "ConnectionClosed",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ERR_SSL_WRONG_VERSION_NUMBER",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    test(`classifies the recorded ${code} shape without reading its message`, () => {
      const cause = Object.assign(new TypeError("message omitted"), { code });
      expect(isConnectionFailure(cause)).toBe(true);
      expect(isConnectionFailure(new Error("Request failed", { cause }))).toBe(
        true,
      );
    });
  }

  test.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"])(
    "recognizes %s errors from another realm",
    (code) => {
      const cause: unknown = runInNewContext(
        "Object.assign(new TypeError('message omitted'), { code })",
        { code },
      );
      expect(cause).not.toBeInstanceOf(Error);
      expect(Error.isError(cause)).toBe(true);
      expect(isConnectionFailure(cause)).toBe(true);
      expect(isConnectionFailure(new Error("Request failed", { cause }))).toBe(
        true,
      );
    },
  );

  test.each(["deleted", "undefined"])(
    "preserves ordinary classifications when Error.isError is %s",
    (availability) => {
      const descriptor = Object.getOwnPropertyDescriptor(Error, "isError");
      try {
        if (availability === "deleted") {
          expect(Reflect.deleteProperty(Error, "isError")).toBe(true);
        } else {
          Object.defineProperty(Error, "isError", {
            configurable: true,
            value: undefined,
          });
        }
        expect(typeof Error.isError).toBe("undefined");
        const transport = Object.assign(new TypeError("message omitted"), {
          code: "ECONNREFUSED",
        });
        expect(isConnectionFailure(transport)).toBe(true);
        expect(
          isConnectionFailure(
            new Error("Request failed", { cause: transport }),
          ),
        ).toBe(true);
        expect(isConnectionFailure(new TypeError("Failed to fetch"))).toBe(
          true,
        );
        expect(isConnectionFailure(new Error("Programming failure"))).toBe(
          false,
        );
        for (const cause of [
          undefined,
          null,
          false,
          42,
          "Failed to fetch",
          {},
          { code: "ECONNREFUSED", message: "Failed to fetch" },
        ]) {
          expect(isConnectionFailure(cause)).toBe(false);
        }
      } finally {
        if (descriptor) {
          Object.defineProperty(Error, "isError", descriptor);
        } else {
          Reflect.deleteProperty(Error, "isError");
        }
      }
    },
  );

  test("uses messages only when there is no runtime code", () => {
    expect(isConnectionFailure(new TypeError("Unable to connect"))).toBe(true);
    expect(
      isConnectionFailure(
        Object.assign(new TypeError("Unable to connect"), {
          code: "ERR_INVALID_URL",
        }),
      ),
    ).toBe(false);
  });

  test("an abort with connection-looking text remains an abort", () => {
    expect(
      isConnectionFailure(new DOMException("Unable to connect", "AbortError")),
    ).toBe(false);
    expect(
      isConnectionFailure(
        new DOMException("Unable to connect", "TimeoutError"),
      ),
    ).toBe(false);
    expect(
      isConnectionFailure(
        new TypeError("Unable to connect", {
          cause: new DOMException("Stopped", "AbortError"),
        }),
      ),
    ).toBe(false);
  });

  test("terminates on a cyclic cause without classifying a programming failure", () => {
    const cause = new TypeError("Invalid request");
    cause.cause = cause;
    expect(isConnectionFailure(cause)).toBe(false);
  });
});
