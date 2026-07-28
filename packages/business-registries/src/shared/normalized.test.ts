import { describe, expect, test } from "bun:test";

import { RegistryValidationError } from "./errors.js";
import { toValidatedRegistryIdentifier } from "./normalized.js";

describe("normalized registry identifiers", () => {
  test("constructs a canonical identifier only after scheme validation", () => {
    const identifier = toValidatedRegistryIdentifier({
      scheme: "GB-CRN",
      value: "00445790",
      validate: (value) => /^\d{8}$/u.test(value),
    });
    expect(identifier.scheme).toBe("GB-CRN");
    expect(String(identifier.value)).toBe("00445790");
  });

  test("rejects invalid identifiers without leaking their value", () => {
    expect(() =>
      toValidatedRegistryIdentifier({
        scheme: "GB-CRN",
        value: "secret-invalid-value",
        validate: () => false,
      }),
    ).toThrow(RegistryValidationError);
    try {
      toValidatedRegistryIdentifier({
        scheme: "GB-CRN",
        value: "secret-invalid-value",
        validate: () => false,
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-invalid-value");
    }
  });
});
