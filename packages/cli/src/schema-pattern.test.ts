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

  test("preserves serialized flags and always enables Unicode mode", () => {
    const compiled = compileSchemaPattern("^[a-f]+$", "i");

    expect(compiled.status).toBe("valid");
    if (compiled.status === "valid") {
      expect(compiled.regex.flags).toContain("i");
      expect(compiled.regex.flags).toContain("u");
      expect(compiled.regex.test("ABCDEF")).toBe(true);
    }
  });

  // re2-wasm never frees a compiled pattern and its heap cannot grow, so a
  // recompile per help assembly or validation eventually aborts with an OOM.
  test("recompiling one pattern many times does not exhaust the wasm heap", () => {
    for (let index = 0; index < 20_000; index += 1) {
      expect(compileSchemaPattern("^[a-z]{2,8}-[0-9]+$").status).toBe("valid");
    }
  });

  test("a stateful (g/y) pattern is never shared between callers", () => {
    const first = compileSchemaPattern("a", "g");
    const second = compileSchemaPattern("a", "g");
    expect(first.status === "valid" && second.status === "valid").toBe(true);
    if (first.status === "valid" && second.status === "valid") {
      expect(first.regex).not.toBe(second.regex);
    }
  });

  test("rejects unsupported serialized flags", () => {
    expect(compileSchemaPattern("value", "x")).toEqual({ status: "invalid" });
  });
});
