import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { declareFingerprintFields } from "@stll/errors";
import { MAX_EXCEPTION_CAUSE_DEPTH } from "@stll/errors/exception-cause-chain";
import { assertProperty } from "@stll/property-testing";

import {
  capturedExceptionIdentity,
  automaticExceptionKey,
  fingerprintExceptionEvent,
  fingerprintExceptionScope,
  isExceptionFingerprintKey,
  routeExceptionFingerprintKey,
} from "@/lib/analytics/exception-fingerprint";

const fixture = {
  entries: [{ type: "TypeError" }],
  key: "chatRuntime:send" as const,
  scopeIdentity: fingerprintExceptionScope({
    type: "handler",
    handlerId: "chatRuntime:send",
  }),
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

  test("reporter wrappers preserve the full causal class sequence", () => {
    expect(
      fingerprintExceptionEvent({
        ...fixture,
        entries: [{ type: "ClientTelemetryError" }, ...fixture.entries],
      }),
    ).not.toBe(fingerprintExceptionEvent(fixture));
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
      fingerprintExceptionEvent({
        entries: [],
        key: "worker:decode",
        scopeIdentity: fingerprintExceptionScope({
          type: "handler",
          handlerId: "worker.decode",
        }),
      }),
    ).not.toBe(
      fingerprintExceptionEvent({
        entries: [],
        key: "worker:encode",
        scopeIdentity: fingerprintExceptionScope({
          type: "handler",
          handlerId: "worker.encode",
        }),
      }),
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
  expect(capturedExceptionIdentity(wrapped).types).toEqual([
    "Error",
    "ClassifiedError",
  ]);
  const identify = (error: unknown) => {
    const { types, fields } = capturedExceptionIdentity(error);
    return fingerprintExceptionEvent({
      ...fixture,
      entries: types.map((type) => ({ type })),
      fields,
    });
  };
  expect(identify(decode)).not.toBe(identify(encode));
  expect(identify(wrapped)).not.toBe(identify(decode));
});

test("throwing error accessors cannot interrupt capture identity", () => {
  const error = new Error("Private text");
  Object.defineProperty(error, "cause", {
    get: () => {
      throw new TypeError("unreadable cause");
    },
  });
  expect(capturedExceptionIdentity(error)).toEqual({
    types: ["UnknownError"],
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

const automaticKey = ({
  owner,
  hash,
  line,
  message,
}: {
  owner: string;
  hash: string;
  line: number;
  message: string;
}) => {
  const input = {
    firstPartyOrigin: "https://app.example",
    message,
    entries: [
      {
        stacktrace: {
          frames: [
            {
              in_app: true,
              filename: `https://app.example/assets/${owner}-${hash}.js?token=private`,
              lineno: line,
              colno: line,
            },
          ],
        },
      },
    ],
  };
  return automaticExceptionKey(input);
};

test("automatic exception paths survive rebuilds and data substitutions", () => {
  assertProperty(
    "automatic exception paths survive rebuilds and data substitutions",
    fc.property(fc.uuid(), fc.uuid(), fc.nat(), (beforeId, afterId, shift) => {
      const before = {
        owner: "chat-runtime",
        hash: "D3kfQx9a",
        line: 10,
        message: `Failed to decode "private before" for ${beforeId} at 42`,
      };
      const after = {
        ...before,
        hash: "Ck2pW7dm",
        line: 11 + shift,
        message: `Failed to decode "private after" for ${afterId} at 765`,
      };
      expect(before).not.toEqual(after);
      expect(automaticKey(before)).toBe(automaticKey(after));
      expect(automaticKey(before)).not.toContain("private");
      expect(automaticKey(before)).not.toContain(beforeId);
    }),
  );
});

test("automatic exceptions distinguish crash owners and stable message shapes", () => {
  const input = {
    owner: "chat-runtime",
    hash: "D3kfQx9a",
    line: 10,
    message: "Cannot read property of undefined",
  };
  expect(automaticKey(input)).not.toBe(
    automaticKey({ ...input, owner: "document-panel" }),
  );
  expect(automaticKey(input)).not.toBe(
    automaticKey({ ...input, message: "Cannot convert object to primitive" }),
  );
});

test("distinct declared scopes split the same cause and owner", () => {
  const scopes = [
    { type: "request", method: "GET", routeTemplate: "/v1/views/:viewId" },
    { type: "request", method: "PATCH", routeTemplate: "/v1/views/:viewId" },
    { type: "request", method: "GET", routeTemplate: "/v1/entities/:entityId" },
    { type: "handler", handlerId: "settings.members.invite" },
    { type: "handler", handlerId: "settings.members.remove" },
  ] as const;
  assertProperty(
    "distinct declared scopes split the same cause and owner",
    fc.property(
      fc
        .tuple(fc.constantFrom(...scopes), fc.constantFrom(...scopes))
        .filter(
          ([left, right]) => JSON.stringify(left) !== JSON.stringify(right),
        ),
      ([left, right]) => {
        const leftIdentity = fingerprintExceptionEvent({
          ...fixture,
          scopeIdentity: fingerprintExceptionScope(left),
        });
        const rightIdentity = fingerprintExceptionEvent({
          ...fixture,
          scopeIdentity: fingerprintExceptionScope(right),
        });
        expect(leftIdentity).not.toBe(rightIdentity);
      },
    ),
  );
});

test("every bounded causal class position participates in identity", () => {
  const chain = Array.from(
    { length: MAX_EXCEPTION_CAUSE_DEPTH },
    () => "Error",
  );
  assertProperty(
    "every bounded causal class position participates in identity",
    fc.property(
      fc.constantFrom(...chain.keys()),
      fc.boolean(),
      (position, changeScope) => {
        const changed = chain.map((type, index) => ({
          type: index === position && !changeScope ? "TypeError" : type,
        }));
        expect(
          fingerprintExceptionEvent({
            ...fixture,
            entries: chain.map((type) => ({ type })),
          }),
        ).not.toBe(
          fingerprintExceptionEvent({
            ...fixture,
            entries: changed,
            scopeIdentity: changeScope
              ? fingerprintExceptionScope({
                  type: "handler",
                  handlerId: "different.owner",
                })
              : fixture.scopeIdentity,
          }),
        );
      },
    ),
  );
});

test("wrapped native cause classes remain distinct without messages or positions", () => {
  const identify = (error: Error) => {
    const { types, fields } = capturedExceptionIdentity(error);
    return fingerprintExceptionEvent({
      ...fixture,
      entries: types.map((type) => ({ type })),
      fields,
    });
  };
  expect(
    identify(
      new Error("private wrapper", { cause: new TypeError("private detail") }),
    ),
  ).not.toBe(
    identify(
      new Error("private wrapper", {
        cause: new ReferenceError("private detail"),
      }),
    ),
  );
});

test("captured causal class sequences terminate at repeated error objects", () => {
  const outer = new TypeError("private outer");
  const inner = new ReferenceError("private inner", { cause: outer });
  outer.cause = inner;
  expect(capturedExceptionIdentity(outer).types).toEqual([
    "TypeError",
    "ReferenceError",
  ]);
});
