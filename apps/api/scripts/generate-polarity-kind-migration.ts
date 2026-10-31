import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { citationEvidenceWindowsValidSql } from "../src/lib/case-law/citation-evidence";

export const renderCitationEvidenceWindowCheck = () =>
  new PgDialect().sqlToQuery(
    citationEvidenceWindowsValidSql(
      sql.identifier("polarity_evidence_windows"),
    ).inlineParams(),
  ).sql;

if (import.meta.main && process.argv.includes("--write-window-check")) {
  const file = new URL(
    "../drizzle/20261030213329_case_law_polarity_kind_evidence/migration.sql",
    import.meta.url,
  );
  const source = await Bun.file(file).text();
  const marker = '  ADD CONSTRAINT "citations_polarity_window_bounds" CHECK (';
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
}
