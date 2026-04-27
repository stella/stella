import { Result } from "better-result";
import { describe, expect, it } from "bun:test";

import { transpileSandboxSource } from "@/api/handlers/chat/tools/execute/sandbox/transpile";

describe("transpileSandboxSource", () => {
  it("strips type annotations and interfaces", () => {
    const source = `
      interface Person { name: string }
      const p: Person = { name: "ada" };
      const greet = (who: string): string => "hi " + who;
      return greet(p.name);
    `;
    const js = transpileSandboxSource(source).unwrap();
    expect(js).not.toContain("interface");
    expect(js).not.toContain(": string");
    expect(js).toContain("greet");
  });

  it("rejects ESM import statements", () => {
    const result = transpileSandboxSource(`import x from "fs"; return x;`);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("forbidden-syntax");
    }
  });

  it("rejects ESM export statements", () => {
    const result = transpileSandboxSource(`export const x = 1;`);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("forbidden-syntax");
    }
  });

  it("rejects require() calls", () => {
    const result = transpileSandboxSource(`const fs = require("fs");`);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("forbidden-syntax");
    }
  });

  it("rejects dynamic import() calls", () => {
    const result = transpileSandboxSource(`const m = await import("fs");`);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("forbidden-syntax");
    }
  });

  it("surfaces a syntax error as a transpile failure", () => {
    const result = transpileSandboxSource(`const x = ;`);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.reason).toBe("transpile");
    }
  });

  it("accepts plain async/await TypeScript", () => {
    const js = transpileSandboxSource(
      `const x: number = await Promise.resolve(1); return x + 2;`,
    ).unwrap();
    expect(js).toContain("await");
    expect(js).toContain("Promise.resolve");
  });
});
