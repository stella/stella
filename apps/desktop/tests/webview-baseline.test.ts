import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// The desktop shell renders in the system WebView of its minimum macOS
// version (tauri.conf.json `minimumSystemVersion`), whose newest Safari is
// 15.6. Built-ins that first shipped in Safari 16 or later throw there, and
// the bundler does not polyfill them, so desktop sources must not call them.
const MINIMUM_MACOS = "10.15";

const UNSUPPORTED_BUILT_INS = [
  { name: "Array#toSorted", pattern: /\.toSorted\(/u },
  { name: "Array#toReversed", pattern: /\.toReversed\(/u },
  { name: "Array#toSpliced", pattern: /\.toSpliced\(/u },
  { name: "Array.fromAsync", pattern: /\bArray\.fromAsync\b/u },
  { name: "Object.groupBy", pattern: /\bObject\.groupBy\b/u },
  { name: "Map.groupBy", pattern: /\bMap\.groupBy\b/u },
  { name: "Promise.withResolvers", pattern: /\bPromise\.withResolvers\b/u },
  { name: "String#isWellFormed", pattern: /\.isWellFormed\(/u },
  { name: "String#toWellFormed", pattern: /\.toWellFormed\(/u },
  // These names exist only on Set, so any receiver is flagged.
  {
    name: "Set relation methods",
    pattern:
      /\.(?:symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/u,
  },
  // Schema and date libraries share these names (`v.union(...)`), so only a
  // call with a Set argument is flagged.
  {
    name: "Set composition methods",
    pattern: /\.(?:union|intersection|difference)\(\s*new Set\b/u,
  },
] as const;

const SOURCE_ROOT = path.join(import.meta.dir, "../src");

const unsupportedCalls = (file: string, source: string) =>
  UNSUPPORTED_BUILT_INS.filter(({ pattern }) => pattern.test(source)).map(
    ({ name }) => `${file}: ${name}`,
  );

describe("desktop WebView baseline", () => {
  test("the guard targets the configured minimum macOS version", async () => {
    const config = await readFile(
      path.join(import.meta.dir, "../src-tauri/tauri.conf.json"),
      "utf-8",
    );
    expect(config).toContain(`"minimumSystemVersion": "${MINIMUM_MACOS}"`);
  });

  test("desktop sources call no built-in newer than the minimum WebView", async () => {
    const files = (await readdir(SOURCE_ROOT, { recursive: true })).filter(
      (file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file),
    );
    expect(files.length).toBeGreaterThan(0);
    const findings: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(SOURCE_ROOT, file), "utf-8");
      findings.push(...unsupportedCalls(file, source));
    }
    expect(findings).toEqual([]);
  });

  test("each unsupported built-in is detected", () => {
    const samples = [
      "items.toSorted((a, b) => a - b)",
      "items.toReversed()",
      "items.toSpliced(0, 1)",
      "await Array.fromAsync(stream)",
      "Object.groupBy(items, key)",
      "Map.groupBy(items, key)",
      "Promise.withResolvers()",
      "text.isWellFormed()",
      "text.toWellFormed()",
      "left.isSubsetOf(right)",
      "left.union(new Set(right))",
    ];
    expect(
      samples.map((sample) => unsupportedCalls("sample.ts", sample)),
    ).toEqual(UNSUPPORTED_BUILT_INS.map(({ name }) => [`sample.ts: ${name}`]));
    expect(
      unsupportedCalls("sample.ts", "[...items].sort((a, b) => a - b)"),
    ).toEqual([]);
    for (const call of [
      "left.symmetricDifference(right)",
      "left.isSupersetOf(right)",
      "left.isDisjointFrom(right)",
    ]) {
      expect(unsupportedCalls("sample.ts", call)).toEqual([
        "sample.ts: Set relation methods",
      ]);
    }
    expect(unsupportedCalls("sample.ts", "v.union([a, b])")).toEqual([]);
  });
});
