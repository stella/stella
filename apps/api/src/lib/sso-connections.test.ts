import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { normalizeSsoDomain } from "@/api/lib/sso-connections";

describe("normalizeSsoDomain", () => {
  test("normalizes case, a trailing root label, and international domains", () => {
    const ascii = normalizeSsoDomain(" Example.COM. ");
    const international = normalizeSsoDomain("bücher.example");

    expect(Result.isOk(ascii) ? ascii.value : null).toBe("example.com");
    expect(Result.isOk(international) ? international.value : null).toBe(
      "xn--bcher-kva.example",
    );
  });

  test("rejects non-domain and ambiguous host inputs", () => {
    for (const value of [
      "localhost",
      "127.0.0.1",
      "example.com/path",
      "-example.com",
      "example.123",
    ]) {
      expect(Result.isError(normalizeSsoDomain(value))).toBe(true);
    }
  });
});
