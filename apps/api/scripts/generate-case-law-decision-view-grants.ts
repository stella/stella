import { panic } from "better-result";
import { readdir, readFile, writeFile } from "node:fs/promises";

import { caseLawDecisionViewGrantStatements } from "../src/lib/public-law-relations";

const start = "-- generated case-law decision view grants: start";
const end = "-- generated case-law decision view grants: end";
const directory = new URL("../drizzle/", import.meta.url);
// Each expansion owns a new marked section; earlier migrations stay immutable.
const candidates = await Promise.all(
  (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_/u.test(entry.name))
    .map(({ name }) => name)
    .toSorted()
    .map(async (name) => {
      const migration = new URL(`${name}/migration.sql`, directory);
      return { migration, source: await readFile(migration, "utf-8") };
    }),
);
const latest = candidates.findLast(({ source }) => source.includes(start));
if (latest === undefined) {
  panic("Decision view grant migration lacks its generated section");
}
const { migration, source } = latest;
const startOffset = source.indexOf(start);
const endOffset = source.indexOf(end);
if (startOffset === -1 || endOffset < startOffset) {
  panic("Decision view grant migration lacks its generated section");
}
const generated = `${start}\n${caseLawDecisionViewGrantStatements("later").join(";--> statement-breakpoint\n\n")};\n${end}`;
const output =
  source.slice(0, startOffset) +
  generated +
  source.slice(endOffset + end.length);
if (process.argv.includes("--check")) {
  if (output !== source) {
    panic("Decision view grants differ from the canonical registry");
  }
} else {
  await writeFile(migration, output);
}
