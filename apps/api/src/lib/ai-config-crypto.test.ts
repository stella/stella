import { describe, expect, test } from "bun:test";

import { maskApiKey } from "@/api/lib/ai-config-crypto";

describe("maskApiKey", () => {
  test("shows first 8 chars for keys longer than 16 chars", () => {
    const masked = maskApiKey("sk-1234567890abcdefghij");

    expect(masked).toBe(`sk-12345${"*".repeat(16)}`);
  });

  test("shows half the key when length is between 2 and 16", () => {
    expect(maskApiKey("abcd1234")).toBe(`abcd${"*".repeat(16)}`);
  });

  test("shows 1 visible char for a 2-char key", () => {
    expect(maskApiKey("ab")).toBe(`a${"*".repeat(16)}`);
  });

  test("shows 0 visible chars for a 1-char key", () => {
    expect(maskApiKey("x")).toBe("*".repeat(16));
  });

  test("returns only asterisks for an empty string", () => {
    expect(maskApiKey("")).toBe("*".repeat(16));
  });

  test("caps visible chars at 8 for very long keys", () => {
    const masked = maskApiKey("a".repeat(200));

    expect(masked).toBe(`${"a".repeat(8)}${"*".repeat(16)}`);
  });
});
