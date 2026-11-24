import { readFileSync, writeFileSync } from "node:fs";

// The parser is copied as written: Function.prototype.toString returns the
// runtime's own rendering, which Bun's transpiler changes.
const declaration = "export const parseMergeGroupEntries = ";
const parserSource = readFileSync(
  new URL("merge-group-entries.mjs", import.meta.url),
  "utf8",
);
const parserStart = parserSource.indexOf(declaration);
if (parserStart === -1)
  throw new TypeError("Missing the parseMergeGroupEntries export");
const parser = parserSource
  .slice(parserStart + declaration.length)
  .trimEnd()
  .replace(/;$/u, "");
const path = new URL("../.github/workflows/cla.yml", import.meta.url);
const source = readFileSync(path, "utf8");
const begin = "            // BEGIN GENERATED merge-group parser\n";
const end = "            // END GENERATED merge-group parser";
const generated = `const parseMergeGroupEntries = ${parser};\n`
  .split("\n")
  .filter((line, index, lines) => index < lines.length - 1)
  .map((line) => `            ${line}\n`)
  .join("");
const start = source.indexOf(begin) + begin.length;
const stop = source.indexOf(end);
if (start < begin.length || stop < start)
  throw new TypeError("Missing merge-group parser markers");
const output = source.slice(0, start) + generated + source.slice(stop);
if (process.argv.includes("--check")) {
  if (source !== output)
    throw new TypeError("Run bun scripts/sync-merge-group-parser.mjs");
} else {
  writeFileSync(path, output);
}
