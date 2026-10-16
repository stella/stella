import { TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";

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
      fieldsOf(new DomainFailure({ ...error, termination: null })),
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
