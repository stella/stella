import { expect, test } from "bun:test";
import path from "node:path";

const OWNER = "apps/api/src/lib/legal-search/parsers/rtf-reader.ts";
const SOURCE_ROOT = path.resolve(import.meta.dir, "../../../../../..");

const readerMarkers = [
  "ansicpg",
  String.raw`\\'`,
  "unicodeFallback",
  'word === "bin"',
] as const;

const looksLikeRtfReader = (source: string): boolean =>
  readerMarkers.filter((marker) => source.includes(marker)).length >= 3;

test("RTF decoding remains confined to its owner", async () => {
  const syntheticSecondReader = [
    'const page = "ansicpg";',
    String.raw`const hex = "\\'";`,
    "let unicodeFallback = 1;",
    'if (word === "bin") return;',
  ].join("\n");
  expect(looksLikeRtfReader(syntheticSecondReader)).toBe(true);

  const readers: string[] = [];
  const glob = new Bun.Glob("apps/api/src/**/*.ts");
  for await (const file of glob.scan({ cwd: SOURCE_ROOT })) {
    if (file.endsWith(".test.ts")) {
      continue;
    }
    if (
      looksLikeRtfReader(await Bun.file(path.join(SOURCE_ROOT, file)).text())
    ) {
      readers.push(file);
    }
  }

  expect(readers).toEqual([OWNER]);
});
