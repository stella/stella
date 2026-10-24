import { TaggedError } from "better-result";
import { describe, expect, expectTypeOf, test } from "bun:test";

import type { FingerprintFields } from "./fingerprint-fields";
import {
  declareFingerprintFields,
  readFingerprintFields,
} from "./fingerprint-fields";

class DomainFailure extends TaggedError("DomainFailure")<{
  message: string;
  reason: "cancelled" | "unavailable";
  stage: "read" | "write";
  termination: { reason: "timeout" | "crashed" } | null;
}> {
  static {
    declareFingerprintFields(this, ["reason", "stage", "termination.reason"]);
  }
}

class StructuredFailure extends TaggedError("StructuredFailure")<{
  message: string;
  kind: "root-kind";
  reason: { kind: "read" | "write"; detail: string };
}> {
  static {
    declareFingerprintFields(this, ["reason.kind"]);
  }
}

const fieldsOf = (value: object) =>
  readFingerprintFields({
    value,
    prototypes: [Object.getPrototypeOf(value)],
    read: (object, key): unknown => Reflect.get(object, key),
  }).fields;

describe("fingerprint fields preserve owner provenance", () => {
  test("only a finite nested kind can identify a structured dimension", () => {
    expectTypeOf<
      FingerprintFields<StructuredFailure>[number]
    >().toEqualTypeOf<"reason.kind">();
    expectTypeOf<
      FingerprintFields<{ reason: { kind: string } }>[number]
    >().toEqualTypeOf<never>();
    expectTypeOf<
      FingerprintFields<{ reason: { kind: { reason: "read" } } }>[number]
    >().toEqualTypeOf<never>();
    for (const kind of ["read", "write"] as const) {
      expect(
        fieldsOf(
          new StructuredFailure({
            message: "private message",
            kind: "root-kind",
            reason: { kind, detail: "private nested detail" },
          }),
        ),
      ).toEqual({ "reason.kind": kind });
    }
  });

  test("registered nested dimensions are inherited through their declaring prototype", () => {
    class InheritedFailure extends StructuredFailure {}
    expect(
      readFingerprintFields({
        value: new InheritedFailure({
          message: "private",
          kind: "root-kind",
          reason: { kind: "read", detail: "private" },
        }),
        prototypes: [InheritedFailure.prototype, StructuredFailure.prototype],
        read: (object, key): unknown => Reflect.get(object, key),
      }).fields,
    ).toEqual({ "reason.kind": "read" });
  });

  test.each(["kind", "reason.detail", "reason.kind.reason", "reason.kind\n"])(
    "static metadata cannot opt the private path %s in",
    (field) => {
      class MetadataError extends Error {
        override readonly name = "MetadataError";
        readonly kind = "private root kind";
        readonly reason = {
          kind: { reason: "private kind payload" },
          detail: "private nested detail",
          "kind\n": "private newline field",
        };
        static readonly stellaExceptionFingerprintFields = [field];
      }
      expect(fieldsOf(new MetadataError("private"))).toBeUndefined();
    },
  );

  test("captures finite dimensions including nested termination", () => {
    const error = new DomainFailure({
      message: "private message",
      reason: "cancelled",
      stage: "write",
      termination: { reason: "timeout" },
    });
    expect(fieldsOf(error)).toEqual({
      reason: "cancelled",
      stage: "write",
      "termination.reason": "timeout",
    });
    expect(
      fieldsOf(
        new DomainFailure({
          message: error.message,
          reason: error.reason,
          stage: error.stage,
          termination: null,
        }),
      ),
    ).toEqual({
      reason: "cancelled",
      stage: "write",
    });
  });

  test("matching tags cannot opt foreign errors into fingerprint dimensions", () => {
    class ForeignError extends TaggedError("DomainFailure")<{
      message: string;
      reason: string;
    }> {}
    expect(
      fieldsOf(new ForeignError({ message: "private", reason: "private" })),
    ).toBeUndefined();
  });
});

// Compile-time boundary: message text and unconstrained reasons cannot opt in.
class FreeTextFailureError extends Error {
  override readonly name = "FreeTextFailureError";
  readonly reason: string = "private";
  static {
    // @ts-expect-error message is an unrestricted string, not a domain discriminator.
    declareFingerprintFields(this, ["message"]);
    // @ts-expect-error unrestricted reasons are unsafe fingerprint dimensions.
    declareFingerprintFields(this, ["reason"]);
  }
}
void FreeTextFailureError;

class StaticDomainFailure extends TaggedError("StaticDomainFailure")<{
  message: string;
  reason: "decode" | "encode";
}> {
  static readonly stellaExceptionFingerprintFields = [
    "reason",
  ] as const satisfies FingerprintFields<StaticDomainFailure>;
}

test("pure source metadata preserves fields without registration side effects", () => {
  const error = new StaticDomainFailure({
    message: "private",
    reason: "decode",
  });
  expect(fieldsOf(error)).toEqual({ reason: "decode" });
  Object.defineProperty(error, "constructor", { value: Error });
  expect(fieldsOf(error)).toEqual({ reason: "decode" });
});

test("an instance constructor override cannot forge static fingerprint metadata", () => {
  const foreign = new Error("private");
  Object.defineProperties(foreign, {
    constructor: { value: StaticDomainFailure },
    reason: { value: "private" },
  });
  expect(fieldsOf(foreign)).toBeUndefined();
});

test("a foreign prototype cannot borrow another constructor's nested metadata", () => {
  class StaticStructuredFailure extends Error {
    override readonly name = "StaticStructuredFailure";
    readonly reason = { kind: "read" as const };
    static readonly stellaExceptionFingerprintFields = [
      "reason.kind",
    ] as const satisfies FingerprintFields<StaticStructuredFailure>;
  }
  class ForeignError extends Error {
    override readonly name = "ForeignError";
    readonly reason = { kind: "private foreign value" };
  }
  expect(fieldsOf(new StaticStructuredFailure("private"))).toEqual({
    "reason.kind": "read",
  });
  class InheritedStaticFailure extends StaticStructuredFailure {}
  expect(
    readFingerprintFields({
      value: new InheritedStaticFailure("private"),
      prototypes: [
        InheritedStaticFailure.prototype,
        StaticStructuredFailure.prototype,
      ],
      read: (object, key): unknown => Reflect.get(object, key),
    }).fields,
  ).toEqual({ "reason.kind": "read" });
  Object.defineProperty(ForeignError.prototype, "constructor", {
    value: StaticStructuredFailure,
  });
  expect(fieldsOf(new ForeignError("private"))).toBeUndefined();
});

class FreeTextStaticFailureError extends Error {
  override readonly name = "FreeTextStaticFailureError";
  readonly reason: string = "private";
  static readonly stellaExceptionFingerprintFields = [
    // @ts-expect-error static metadata also rejects unrestricted reason text
    "reason",
  ] as const satisfies FingerprintFields<FreeTextStaticFailureError>;
}
void FreeTextStaticFailureError;

describe("fingerprint metadata is a bounded hostile-input boundary", () => {
  const readMetadata = (metadata: unknown) => {
    class MetadataError extends Error {
      override readonly name = "MetadataError";
      readonly reason = "decode";
      readonly stage = "read";
      static readonly stellaExceptionFingerprintFields = metadata;
    }
    const value = new MetadataError("private");
    return readFingerprintFields({
      value,
      prototypes: [MetadataError.prototype],
      read: (object, key): unknown => Reflect.get(object, key),
    });
  };

  test.each(["descriptor", "prototype", "revoked"])(
    "a failing constructor %s read preserves registered fields",
    (failure) => {
      class RegisteredError extends Error {
        override readonly name = "RegisteredError";
        readonly reason = "decode" as const;
        static readonly stellaExceptionFingerprintFields = [
          "reason",
        ] as const satisfies FingerprintFields<RegisteredError>;
      }
      declareFingerprintFields(RegisteredError, ["reason"]);
      const { proxy: constructor, revoke } = Proxy.revocable(RegisteredError, {
        getOwnPropertyDescriptor: (target, key) => {
          if (failure === "descriptor") {
            throw new TypeError("unreadable descriptor");
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get: (target, key, receiver): unknown => {
          if (failure === "prototype" && key === "prototype") {
            throw new TypeError("unreadable prototype");
          }
          return Reflect.get(target, key, receiver);
        },
      });
      Object.defineProperty(RegisteredError.prototype, "constructor", {
        value: constructor,
      });
      if (failure === "revoked") {
        revoke();
      }
      expect(
        readFingerprintFields({
          value: new RegisteredError("private"),
          prototypes: [RegisteredError.prototype],
          read: (object, key): unknown => Reflect.get(object, key),
        }),
      ).toEqual({ fields: { reason: "decode" }, status: "read_failed" });
    },
  );

  test("metadata methods and iterators are never called", () => {
    const metadata = ["reason"];
    Object.defineProperties(metadata, {
      filter: {
        get: () => {
          throw new TypeError("filter must not be read");
        },
      },
      [Symbol.iterator]: {
        get: () => {
          throw new TypeError("iterator must not be read");
        },
      },
    });
    expect(readMetadata(metadata)).toEqual({
      fields: { reason: "decode" },
      status: "complete",
    });
  });

  test("line terminators cannot opt private properties into dimension paths", () => {
    for (const key of ["reason", "phase", "stage", "termination"]) {
      for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
        const field = `${key}${suffix}`;
        class MetadataError extends Error {
          override readonly name = "MetadataError";
          static readonly stellaExceptionFingerprintFields = [field];
        }
        const value = Object.defineProperty(
          new MetadataError("private"),
          field,
          {
            value: "private dimension sentinel",
          },
        );
        expect(
          readFingerprintFields({
            value,
            prototypes: [MetadataError.prototype],
            read: (object, property): unknown => Reflect.get(object, property),
          }),
        ).toEqual({ fields: undefined, status: "complete" });
      }
    }
  });

  test("revoked metadata reports a failed read", () => {
    const { proxy, revoke } = Proxy.revocable(["reason"], {});
    revoke();
    expect(readMetadata(proxy)).toEqual({
      fields: undefined,
      status: "read_failed",
    });
  });

  test("a failing index preserves other readable fields", () => {
    const metadata = new Proxy(["reason", "stage"], {
      get: (target, key, receiver): unknown => {
        if (key === "1") {
          throw new TypeError("unreadable index");
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(readMetadata(metadata)).toEqual({
      fields: { reason: "decode" },
      status: "read_failed",
    });
  });

  test("huge metadata lengths have bounded reads and retain the readable prefix", () => {
    let reads = 0;
    const metadata = new Proxy(["reason"], {
      get: (target, key, receiver): unknown => {
        reads += 1;
        return key === "length"
          ? Number.MAX_SAFE_INTEGER
          : Reflect.get(target, key, receiver);
      },
    });
    expect(readMetadata(metadata)).toEqual({
      fields: { reason: "decode" },
      status: "read_failed",
    });
    expect(reads).toBeLessThanOrEqual(17);
  });

  test("overdeep and private paths cannot hide valid sibling fields", () => {
    for (const path of [
      `${"termination.".repeat(6)}reason`,
      `${"phase.".repeat(6)}reason`,
    ]) {
      expect(readMetadata(["reason", path, "message"])).toEqual({
        fields: { reason: "decode" },
        status: "read_failed",
      });
    }
  });
});
