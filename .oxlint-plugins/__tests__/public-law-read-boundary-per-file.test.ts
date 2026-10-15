import { expect, test } from "bun:test";

import { lintRuleAcrossFiles } from "./lint-single-rule.ts";

const PLUGIN = { plugin: "public-law-read-boundary" };

// Both orders, so the compliant file is linted first in one of the runs
// whatever order oxlint walks the files in. Compliant declarations start
// below line 1, so a report anchored on a stale node from the other file
// shows up as the wrong line instead of passing as the Program report.
// Short lines, so an offset taken from the other file's node lands below
// line 1 here.
const MISSING =
  "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\nconst g = 7;\nconst h = 8;";

const orders = (compliant: string, missing: string) => [
  { "a.ts": compliant, "b.ts": missing },
  { "a.ts": missing, "b.ts": compliant },
];

test("a configured publicLawReadDb in one file never satisfies another file", async () => {
  const configured =
    "// one\n// two\nconst configureReadTransaction = async tx => setup(tx); const publicLawReadDb = fn => database.transaction(async tx => { await configureReadTransaction(tx); return fn(tx); });";
  const missing = MISSING;
  for (const files of orders(configured, missing)) {
    const lines = await lintRuleAcrossFiles(
      "require-configured-read-transaction",
      files,
      PLUGIN,
    );
    const missingFile = files["a.ts"] === missing ? "a.ts" : "b.ts";
    const configuredFile = missingFile === "a.ts" ? "b.ts" : "a.ts";
    expect(lines[missingFile]).toEqual([1]);
    expect(lines[configuredFile]).toEqual([]);
  }
});

test("search implementations in one file never satisfy another file", async () => {
  const implemented =
    '// one\nimport { readPublicDecisionLanguageAlternatesByGroup } from "@/api/lib/case-law/language-alternates";\nfunction searchPostgresDecisions() { return readPublicDecisionLanguageAlternatesByGroup(); }\nconst searchCorpusIndexDecisions = () => readPublicDecisionLanguageAlternatesByGroup();';
  const missing = MISSING;
  for (const files of orders(implemented, missing)) {
    const lines = await lintRuleAcrossFiles(
      "require-language-alternate-counts",
      files,
      PLUGIN,
    );
    const missingFile = files["a.ts"] === missing ? "a.ts" : "b.ts";
    const implementedFile = missingFile === "a.ts" ? "b.ts" : "a.ts";
    expect(lines[missingFile]).toEqual([1, 1]);
    expect(lines[implementedFile]).toEqual([]);
  }
});
