import { readFileSync, writeFileSync } from "node:fs";

import { parseMergeGroupEntries } from "./merge-group-entries.mjs";

const path = new URL("../.github/workflows/cla.yml", import.meta.url);
const source = readFileSync(path, "utf8");
const begin = "            // BEGIN GENERATED merge-group parser\n";
const end = "            // END GENERATED merge-group parser";
const generated =
  `const parseMergeGroupEntries = ${parseMergeGroupEntries.toString()};\n`
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
    throw new TypeError("Run node scripts/sync-merge-group-parser.mjs");
} else {
  writeFileSync(path, output);
}
