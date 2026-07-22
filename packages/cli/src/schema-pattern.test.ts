import { describe, expect, test } from "bun:test";
import { RE2 } from "re2-wasm";

import { compileSchemaPattern } from "./schema-pattern.js";

describe("compileSchemaPattern", () => {
  test("uses the linear-time RE2 engine for nested repetition", () => {
    const compiled = compileSchemaPattern("^(a+)+$");

    expect(compiled.status).toBe("valid");
    if (compiled.status === "valid") {
      expect(compiled.regex).toBeInstanceOf(RE2);
      expect(compiled.regex.test(`${"a".repeat(10_000)}!`)).toBe(false);
    }
  });

  test("returns an invalid result for unsupported syntax", () => {
    expect(compileSchemaPattern("[")).toEqual({ status: "invalid" });
  });
});
