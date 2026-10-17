import { TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";

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

const fieldsOf = (value: object) =>
  readFingerprintFields({
    value,
    prototypes: [Object.getPrototypeOf(value)],
    read: (object, key): unknown => Reflect.get(object, key),
  });

describe("fingerprint fields preserve owner provenance", () => {
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

class FreeTextStaticFailureError extends Error {
  override readonly name = "FreeTextStaticFailureError";
  readonly reason: string = "private";
  static readonly stellaExceptionFingerprintFields = [
    // @ts-expect-error static metadata also rejects unrestricted reason text
    "reason",
  ] as const satisfies FingerprintFields<FreeTextStaticFailureError>;
}
void FreeTextStaticFailureError;
