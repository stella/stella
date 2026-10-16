import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { declareFingerprintFields } from "@stll/errors";
import { assertProperty } from "@stll/property-testing";

import {
  capturedExceptionIdentity,
  fingerprintExceptionEvent,
  isExceptionFingerprintKey,
  routeExceptionFingerprintKey,
} from "@/lib/analytics/exception-fingerprint";

const fixture = {
  entries: [{ type: "TypeError" }],
  key: "chatRuntime:send" as const,
};

describe("stable exception identity", () => {
  test("fingerprints survive line insertion and arbitrary chunk renames", () => {
    assertProperty(
      "fingerprints survive line insertion and arbitrary chunk renames",
      fc.property(
        fc.nat(),
        fc.nat().map((value) => value + 1),
        fc.string(),
        (line, insertedLines, chunk) => {
          const before = {
            ...fixture,
            entries: [
              {
                type: "TypeError",
                stacktrace: {
                  frames: [
                    {
                      filename: "https://my.stll.app/assets/chat-a.js",
                      lineno: line,
                      colno: 51,
                    },
                  ],
                },
              },
            ],
          };
          const after = {
            ...fixture,
            entries: [
              {
                type: "TypeError",
                stacktrace: {
                  frames: [
                    {
                      filename: `https://my.stll.app/assets/chat-runtime-registry-${chunk}.js`,
                      lineno: line + insertedLines,
                      colno: 7,
                    },
                  ],
                },
              },
            ],
          };
          expect(before.entries).not.toEqual(after.entries);
          expect(fingerprintExceptionEvent(before)).toBe(
            fingerprintExceptionEvent(after),
          );
        },
      ),
    );
  });

  test("reporter wrappers preserve the causal class", () => {
    expect(
      fingerprintExceptionEvent({
        ...fixture,
        entries: [{ type: "ClientTelemetryError" }, ...fixture.entries],
      }),
    ).toBe(fingerprintExceptionEvent(fixture));
  });

  test("distinct owners, paths and typed response outcomes remain distinct", () => {
    const identities = [
      fingerprintExceptionEvent(fixture),
      fingerprintExceptionEvent({ ...fixture, key: "chatRuntime:reconnect" }),
      fingerprintExceptionEvent({ ...fixture, key: "documentRuntime:send" }),
      fingerprintExceptionEvent({
        ...fixture,
        http: { status: 402, code: "usage_limit_exceeded" },
      }),
      fingerprintExceptionEvent({
        ...fixture,
        http: { status: 402, code: "billing_unavailable" },
      }),
    ];
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("frameless failures retain their declared path", () => {
    expect(
      fingerprintExceptionEvent({ entries: [], key: "worker:decode" }),
    ).not.toBe(
      fingerprintExceptionEvent({ entries: [], key: "worker:encode" }),
    );
  });

  test("only bounded source owner/path slugs enter sanitized events", () => {
    expect(isExceptionFingerprintKey("chatRuntime:send")).toBe(true);
    for (const key of [
      undefined,
      "",
      "chatRuntime",
      "owner:jana@example.com",
      "owner:private text",
      `owner:${"a".repeat(512)}`,
    ]) {
      expect(isExceptionFingerprintKey(key)).toBe(false);
    }
  });
});

class ClassifiedError extends Error {
  readonly reason: "decode" | "encode";
  constructor(reason: "decode" | "encode") {
    super("Private text");
    this.name = "ClassifiedError";
    this.reason = reason;
  }
}
declareFingerprintFields(ClassifiedError, ["reason"]);

test("registered finite reasons split identities through reporter wrappers", () => {
  const decode = new ClassifiedError("decode");
  const encode = new ClassifiedError("encode");
  const wrapped = new Error("Private wrapper", { cause: decode });
  expect(capturedExceptionIdentity(wrapped)).toEqual(
    capturedExceptionIdentity(decode),
  );
  const identify = (error: unknown) => {
    const { type, fields } = capturedExceptionIdentity(error);
    return fingerprintExceptionEvent({
      ...fixture,
      entries: [{ type }],
      fields,
    });
  };
  expect(identify(decode)).not.toBe(identify(encode));
  expect(identify(wrapped)).toBe(identify(decode));
});

test("throwing error accessors cannot interrupt capture identity", () => {
  const error = new Error("Private text");
  Object.defineProperty(error, "cause", {
    get: () => {
      throw new TypeError("unreadable cause");
    },
  });
  expect(capturedExceptionIdentity(error)).toEqual({
    type: "UnknownError",
    fields: {},
  });
});

test("route owner keys preserve distinct templates without resolved identifiers", () => {
  const keys = [
    "/law/$country/cases/$slug",
    "/law-country/cases/$slug",
    "/law/$country/cases/slug",
  ].map(routeExceptionFingerprintKey);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys.every(isExceptionFingerprintKey)).toBe(true);
});
