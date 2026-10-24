import { panic } from "better-result";
import { readFile, writeFile } from "node:fs/promises";

import { caseLawDecisionViewGrantStatements } from "../src/lib/public-law-relations";

const migration = new URL(
  "../drizzle/20261010212200_case_law_public_decision_views/migration.sql",
  import.meta.url,
);
const start = "-- generated case-law decision view grants: start";
const end = "-- generated case-law decision view grants: end";
const source = await readFile(migration, "utf-8");
const startOffset = source.indexOf(start);
const endOffset = source.indexOf(end);
if (startOffset === -1 || endOffset < startOffset) {
  panic("Decision view grant migration lacks its generated section");
}
const generated = `${start}\n${caseLawDecisionViewGrantStatements().join(";--> statement-breakpoint\n\n")};\n${end}`;
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
