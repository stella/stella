import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { attributeChunk, type SourceMapV3 } from "./bundle-startup-sourcemap";

// A real minified chunk and its sourcemap, built from three modules whose
// sizes are known: two string payloads of very different lengths, and one
// module with a payload on each of two original lines.
let dir = "";
let code = "";
let map: SourceMapV3 = { sources: [], mappings: "" };

const sourceIndex = (name: string): number =>
  map.sources.findIndex((source) => source.endsWith(name));

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "bundle-sourcemap-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(
    path.join(dir, "src/large.ts"),
    `export const large = () => "${"a".repeat(2000)}";\n`,
  );
  writeFileSync(
    path.join(dir, "src/small.ts"),
    `export const small = () => "${"b".repeat(500)}";\n`,
  );
  writeFileSync(
    path.join(dir, "src/lines.ts"),
    [
      `export const first = () => "${"x".repeat(300)}";`,
      "",
      `export const second = () => "${"y".repeat(100)}";`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(dir, "src/entry.ts"),
    [
      'export { large } from "./large";',
      'export { small } from "./small";',
      'export { first, second } from "./lines";',
      "",
    ].join("\n"),
  );
  const build = await Bun.build({
    entrypoints: [path.join(dir, "src/entry.ts")],
    outdir: path.join(dir, "out"),
    minify: true,
    sourcemap: "external",
  });
  const output = build.outputs.find(
    (artifact) => artifact.kind === "entry-point",
  );
  if (output === undefined) {
    throw new Error("the fixture build emitted no entry chunk");
  }
  code = await output.text();
  map = JSON.parse(await Bun.file(`${output.path}.map`).text());
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sourcemap attribution", () => {
  test("attributes each module's minified code to its own source", () => {
    const { bytesBySource } = attributeChunk(code, map);
    const large = bytesBySource[sourceIndex("large.ts")] ?? 0;
    const small = bytesBySource[sourceIndex("small.ts")] ?? 0;

    // Each payload is counted once, with only its few bytes of wrapper.
    expect(large).toBeGreaterThanOrEqual(2000);
    expect(large).toBeLessThan(2100);
    expect(small).toBeGreaterThanOrEqual(500);
    expect(small).toBeLessThan(600);
    const attributed = bytesBySource.reduce((sum, bytes) => sum + bytes, 0);
    expect(attributed).toBeLessThanOrEqual(code.length);
  });

  test("attributes a module's code to the original line it came from", () => {
    const index = sourceIndex("lines.ts");
    const { bytesByLine, bytesBySource } = attributeChunk(
      code,
      map,
      new Set([index]),
    );
    const perLine = bytesByLine.get(index);

    expect(perLine?.get(0)).toBeGreaterThanOrEqual(300);
    expect(perLine?.get(0)).toBeLessThan(400);
    expect(perLine?.get(2)).toBeGreaterThanOrEqual(100);
    expect(perLine?.get(2)).toBeLessThan(200);
    expect(perLine?.has(1)).toBe(false);
    // Lines are recorded only for the sources asked for.
    expect(bytesByLine.has(sourceIndex("large.ts"))).toBe(false);
    const lineTotal = [...(perLine?.values() ?? [])].reduce((a, b) => a + b, 0);
    expect(lineTotal).toBe(bytesBySource[index] ?? -1);
  });

  test("maps a generated position back to the module written there", () => {
    const { sourceAt } = attributeChunk(code, map);
    const lines = code.split("\n");
    const line = lines.findIndex((text) => text.includes("bbbb"));
    const column = lines[line]?.indexOf("bbbb") ?? -1;
    const elsewhere = lines[line]?.indexOf("aaaa") ?? -1;

    expect(line).toBeGreaterThanOrEqual(0);
    expect(sourceAt(line, column)).toBe(sourceIndex("small.ts"));
    expect(sourceAt(line, elsewhere)).toBe(sourceIndex("large.ts"));
    expect(sourceAt(lines.length + 5, 0)).toBe(-1);
  });

  test("rejects mappings that are not base64 VLQ", () => {
    expect(() =>
      attributeChunk("a", { sources: ["a.ts"], mappings: "AA!A" }),
    ).toThrow("Invalid sourcemap mappings character at 2");
  });

  test("rejects a mapping that names a source outside the source table", () => {
    // "ACAA": column 0, source +1, so index 1 of a one-source table.
    expect(() =>
      attributeChunk("a", { sources: ["a.ts"], mappings: "ACAA" }),
    ).toThrow("Sourcemap mapping names source 1, but the map lists 1");
    expect(
      attributeChunk("a", { sources: ["a.ts"], mappings: "AAAA" })
        .bytesBySource[0],
    ).toBe(1);
  });

  test("counts the UTF-8 bytes a span downloads, not its UTF-16 units", () => {
    // One segment from column 0 covers the whole line.
    const euros = `x="${"€".repeat(2100)}"`;
    const emoji = "x='😀'";
    const one = { sources: ["src/routes/a.pending.tsx"], mappings: "AAAA" };

    expect(euros.length).toBe(2104);
    expect(attributeChunk(euros, one).bytesBySource[0]).toBe(
      Buffer.byteLength(euros),
    );
    expect(attributeChunk(euros, one).bytesBySource[0]).toBe(6304);
    expect(emoji.length).toBe(6);
    expect(attributeChunk(emoji, one).bytesBySource[0]).toBe(8);
  });
});
