import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { SEED_RULES } from "../src/handlers/case-law/polarity/seed-rules";
import { citationEvidenceWindowsValidSql } from "../src/lib/case-law/citation-evidence";

/** SQL literals are escaped independently of regex escaping. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const renderSeedRuleKindBackfill =
  () => `UPDATE "case_law_polarity_rules" AS rules
SET "kind" = seeds.kind,
    "polarity" = CASE WHEN seeds.kind = 'form' THEN 'neutral' ELSE rules.polarity END
FROM (VALUES
${SEED_RULES.map((rule) => `  (${literal(rule.language)}, ${literal(rule.pattern)}, ${literal(rule.kind)})`).join(",\n")}
) AS seeds(language, pattern, kind)
WHERE rules.language = seeds.language AND rules.pattern = seeds.pattern;`;

export const renderCitationEvidenceWindowCheck = () =>
  new PgDialect().sqlToQuery(
    citationEvidenceWindowsValidSql(
      sql.identifier("polarity_evidence_windows"),
    ).inlineParams(),
  ).sql;

if (import.meta.main) {
  if (process.argv.includes("--write-window-check")) {
    const file = new URL(
      "../drizzle/20261010005100_case_law_polarity_kind_evidence/migration.sql",
      import.meta.url,
    );
    const source = await Bun.file(file).text();
    const marker =
      '  ADD CONSTRAINT "citations_polarity_window_bounds" CHECK (';
    const start = source.indexOf(marker);
    const end = source.indexOf(
      '  ADD CONSTRAINT "citations_polarity_confidence_bounds"',
      start,
    );
    if (start === -1 || end === -1) {
      panic("Evidence constraint markers are missing from the migration");
    }
    await Bun.write(
      file,
      `${
        source.slice(0, start) + marker
      }\n    ${renderCitationEvidenceWindowCheck()}\n  ) NOT VALID,\n${source.slice(
        end,
      )}`,
    );
  } else {
    console.log(renderSeedRuleKindBackfill());
  }
}
