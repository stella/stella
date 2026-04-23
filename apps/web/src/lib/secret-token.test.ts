import { describe, expect, test } from "bun:test";

import { createSecretTokenBoundary } from "@/lib/secret-token";
import type { SecretToken } from "@/lib/secret-token";

const testTokenBoundary = createSecretTokenBoundary("test-token");

describe("SecretToken", () => {
  test("reveals only through the explicit boundary helper", () => {
    const token = testTokenBoundary.create("raw-secret");

    expect(testTokenBoundary.reveal(token)).toBe("raw-secret");
  });

  test("is not assignable to string-shaped URL APIs", () => {
    const token = testTokenBoundary.create("raw-secret");
    const acceptsString = (value: string) => value;

    // @ts-expect-error - secret tokens must be revealed explicitly.
    expect(acceptsString(token)).toBe(token);
    expect(() => {
      // @ts-expect-error - secret tokens must not be query params.
      const params = new URLSearchParams({ token });
      expect(params).toBeDefined();
    }).toThrow("Secret token cannot be converted to string: test-token");
  });

  test("throws instead of leaking during accidental string coercion", () => {
    const token = testTokenBoundary.create("raw-secret");

    expect(() => String(token)).toThrow(
      "Secret token cannot be converted to string: test-token",
    );
  });

  test("SecretToken is structurally outside string", () => {
    const secretTokenIsString: SecretToken<"test-token"> extends string
      ? true
      : false = false;

    expect(secretTokenIsString).toBe(false);
  });

  test("cannot be revealed by a different boundary", () => {
    const otherTokenBoundary = createSecretTokenBoundary("test-token");
    const token = testTokenBoundary.create("raw-secret");

    expect(() => otherTokenBoundary.reveal(token)).toThrow(
      "Secret token was not created by this boundary: test-token",
    );
  });
});
