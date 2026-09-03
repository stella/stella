// Passive regression fixture for
// `no-hand-rolled-sql-case/no-hand-rolled-sql-case`.
//
// Each `oxlint-disable-next-line` below suppresses a case the rule MUST flag:
// a CASE whose branches are generated in the interpolation, which renders
// `CASE ELSE …` (a syntax error) as soon as the list is empty. If the rule
// regresses, the directive goes unused and
// `--report-unused-disable-directives-severity=error` fails CI. The accepted
// forms carry no directive, so a rule that over-reports fails here too.

import { sql } from "drizzle-orm";

const branches = ["WHEN court ~* 'apex' THEN 10"];
const rows = [{ id: "a", weight: 4 }];
const columnId = sql`id`;
const fallbackColumn = sql`weight`;
const condition = sql`court IS NOT NULL`;
const toBranch = (row: { id: string; weight: number }): string =>
  `WHEN id = '${row.id}' THEN ${row.weight}`;
const columns = ["court", "weight"];
const renderColumn = (column: string): string => `d.${column}`;

// A joined branch list spliced into the text a query is built from.
// oxlint-disable-next-line no-hand-rolled-sql-case/no-hand-rolled-sql-case
const _joinedText = `CASE ${branches.join("\n")} ELSE 1 END`;

// Mapped and joined in one interpolation; the list is still generated here.
// oxlint-disable-next-line no-hand-rolled-sql-case/no-hand-rolled-sql-case
const _mappedText = `CASE ${rows.map(toBranch).join("\n")} ELSE 1 END`;

// The same shape inside a tagged SQL template.
// oxlint-disable-next-line no-hand-rolled-sql-case/no-hand-rolled-sql-case
const _taggedJoin = sql`CASE ${sql.join(
  rows.map(({ id, weight }) => sql`WHEN ${id} THEN ${weight}`),
  sql.raw(" "),
)} ELSE ${fallbackColumn} END`;

// The simple-CASE form: an empty branch list leaves `CASE id ELSE col END`,
// which Postgres rejects for the same reason.
// oxlint-disable-next-line no-hand-rolled-sql-case/no-hand-rolled-sql-case
const _simpleCase = sql`CASE ${columnId} ${sql.join(
  rows.map(({ id, weight }) => sql`WHEN ${id} THEN ${weight}`),
  sql.raw(" "),
)} ELSE ${fallbackColumn} END`;

// A spread array literal builds the list in place too.
// oxlint-disable-next-line no-hand-rolled-sql-case/no-hand-rolled-sql-case
const _spreadBranches = `CASE ${[...branches].join(" ")} ELSE 1 END`;

// A SQL comment between the keyword and the list hides nothing.
// oxlint-disable-next-line no-hand-rolled-sql-case/no-hand-rolled-sql-case
const _commented = `CASE /* ranked */ ${branches.join(" ")} ELSE 1 END`;

// A real CASE preceded by a quoted keyword: masking the literal must not
// swallow the CASE that follows it.
// oxlint-disable-next-line no-hand-rolled-sql-case/no-hand-rolled-sql-case
const _keywordInData = `SELECT 'END of list', CASE ${branches.join(" ")} ELSE 1 END`;

// Accepted: every keyword sits inside string data, so there is no CASE here.
// Unmasked, the literals would read as an opened and closed CASE around a
// generated column list.
const _quotedKeywords = `SELECT 'CASE', ${columns.map(renderColumn).join(", ")} WHERE marker = 'END'`;

// Accepted: the same pair of keywords as quoted identifiers, which an unmasked
// scan reads as a CASE opened and closed around the generated column list.
const _quotedIdentifier = `SELECT "CASE", ${columns.map(renderColumn).join(", ")} AS "END" FROM decisions`;
// Accepted: a dollar-quoted body, the third spelling Postgres reads as data.
const _dollarQuoted = `SELECT $label$CASE$label$, ${columns.map(renderColumn).join(", ")} AS $label$END$label$ FROM decisions`;

// Accepted: an escaped quote does not end the literal, so the keywords after
// it are still data.
const _escapedQuote = `SELECT 'it''s a CASE', ${columns.map(renderColumn).join(", ")} WHERE marker = 'END'`;

// Accepted: the branches are written out, so there is no list to be empty.
const _writtenOut = sql`CASE WHEN ${condition} THEN 1 ELSE 0 END`;

// Accepted: a simple CASE whose operand is interpolated and whose branches
// are literal text — the interpolation is a column, not a branch list.
const _literalBranches = sql`CASE ${columnId} WHEN 'a' THEN 1 ELSE 0 END`;

// Accepted: a generated list that is not a CASE's branches.
const _notACase = sql`WHERE id IN (${sql.join(
  rows.map(({ id }) => sql`${id}`),
  sql.raw(", "),
)})`;

// Accepted: a generated list interpolated after the branches begin, where an
// empty list cannot leave the CASE branchless.
const _afterFirstBranch = `CASE WHEN a THEN 1 ${branches.join(" ")} ELSE 1 END`;

export {
  _afterFirstBranch,
  _commented,
  _dollarQuoted,
  _escapedQuote,
  _joinedText,
  _keywordInData,
  _literalBranches,
  _mappedText,
  _notACase,
  _quotedIdentifier,
  _quotedKeywords,
  _simpleCase,
  _spreadBranches,
  _taggedJoin,
  _writtenOut,
};
