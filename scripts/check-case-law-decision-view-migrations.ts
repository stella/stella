import { panic } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIRECTORY = "apps/api/drizzle";
const CASE_LAW_SCHEMA = "apps/api/src/db/schema/case-law.ts";

// These migrations predate the guard. Entries must disappear once their SQL is
// repaired: the validation below rejects stale, missing, and newly added entries.
export const CASE_LAW_DECISION_VIEW_MIGRATION_ALLOWLIST = [
  "20260605120000_legal_corpus",
  "20260727100000_case_law_document_fetch_priority",
  "20260729150000_timestamptz_everywhere",
  "20260730180000_citation_key",
  "20260731130000_decision_source_document_id",
  "20260731150000_decision_sheet_number",
  "20260731170000_case_law_corpus_generation_backfill",
  "20260731180000_case_law_source_observation_order",
  "20260731200000_case_law_ingestion_retry_state",
  "20260731220000_case_law_redaction_fence",
  "20260825142000_corpus_index_projection_intents",
  "20261002120400_case_law_decision_court_id",
  "20261003121000_case_law_decision_case_number_type",
  "20261003122700_case_law_textless_detail_recheck",
  "20261003123300_case_law_decision_docket_family_key",
] as const;

const REQUIRED_VIEW_EXPORTS = [
  "publishedCaseLawDecisions",
  "unredactedCaseLawDecisions",
] as const;

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const decisionViewNamesFromSchema = (schemaSql: string): string[] =>
  REQUIRED_VIEW_EXPORTS.map((exportName) => {
    const match = schemaSql.match(
      new RegExp(
        `export\\s+const\\s+${exportName}\\s*=.*?\\.pgView\\(\\s*["']([^"']+)["']\\s*\\)`,
        "su",
      ),
    );
    if (!match?.[1]) {
      panic(
        `Could not derive ${exportName}'s SQL view name from ${CASE_LAW_SCHEMA}`,
      );
    }
    return match[1];
  });

const withoutSqlComments = (sql: string): string =>
  sql.replaceAll(/--[^\n]*/gu, " ").replaceAll(/\/\*[\s\S]*?\*\//gu, " ");

export const changesCaseLawDecisionColumns = (sql: string): boolean => {
  const uncommented = withoutSqlComments(sql);
  const tableAlterations = uncommented.matchAll(
    /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:(?:"?public"?)\s*\.\s*)?"?case_law_decisions"?\s+([\s\S]*?);/giu,
  );

  for (const [, operations = ""] of tableAlterations) {
    if (
      /(?:^|,)\s*(?:ADD|DROP)\s+(?:COLUMN\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?!(?:CONSTRAINT|TRIGGER|POLICY)\b)["\w]/iu.test(
        operations,
      ) ||
      /(?:^|,)\s*RENAME\s+(?:COLUMN\s+)?["\w]+\s+TO\s+["\w]+/iu.test(
        operations,
      ) ||
      /(?:^|,)\s*ALTER\s+(?:COLUMN\s+)?["\w]+\s+(?:SET\s+DATA\s+)?TYPE\b/iu.test(
        operations,
      )
    ) {
      return true;
    }
  }
  return false;
};

export const recreatedDecisionViews = (
  sql: string,
  viewNames: readonly string[],
): string[] => {
  const uncommented = withoutSqlComments(sql);
  return viewNames.filter((viewName) =>
    new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+(?:(?:"?public"?)\\s*\\.\\s*)?"?${escapeRegExp(viewName)}"?\\s+AS\\b`,
      "iu",
    ).test(uncommented),
  );
};

export const decisionViewMigrationViolation = (
  sql: string,
  viewNames: readonly string[],
): string | undefined => {
  if (!changesCaseLawDecisionColumns(sql)) {
    return undefined;
  }
  const recreated = new Set(recreatedDecisionViews(sql, viewNames));
  const missing = viewNames.filter((viewName) => !recreated.has(viewName));
  if (missing.length === 0) {
    return undefined;
  }
  return `changes case_law_decisions columns without recreating: ${missing.join(", ")}`;
};

export const checkCaseLawDecisionViewMigrations = async (
  root = process.cwd(),
): Promise<string[]> => {
  const migrationsRoot = path.join(root, MIGRATIONS_DIRECTORY);
  const schemaPath = path.join(root, CASE_LAW_SCHEMA);
  const viewNames = decisionViewNamesFromSchema(
    await Bun.file(schemaPath).text(),
  );
  const allowlist = new Set<string>(CASE_LAW_DECISION_VIEW_MIGRATION_ALLOWLIST);
  const migrationDirectories = new Set<string>();
  const failures: string[] = [];

  if (allowlist.size !== CASE_LAW_DECISION_VIEW_MIGRATION_ALLOWLIST.length) {
    failures.push(
      "decision-view migration allowlist contains duplicate entries",
    );
  }

  const glob = new Bun.Glob("*/migration.sql");
  for await (const relativePath of glob.scan({ cwd: migrationsRoot })) {
    const directory = relativePath.split("/").at(0);
    if (!directory) {
      continue;
    }
    migrationDirectories.add(directory);
    const violation = decisionViewMigrationViolation(
      await Bun.file(path.join(migrationsRoot, relativePath)).text(),
      viewNames,
    );
    if (violation && !allowlist.has(directory)) {
      failures.push(`${directory}: ${violation}`);
    }
    if (!violation && allowlist.has(directory)) {
      failures.push(
        `${directory}: allowlist entry is stale because the migration now complies`,
      );
    }
  }

  for (const directory of allowlist) {
    if (
      !migrationDirectories.has(directory) ||
      !existsSync(path.join(migrationsRoot, directory))
    ) {
      failures.push(`${directory}: allowlisted migration does not exist`);
    }
  }
  return failures.toSorted();
};

if (import.meta.main) {
  const failures = await checkCaseLawDecisionViewMigrations();
  if (failures.length > 0) {
    console.error(
      [
        "Case-law decision view migration guard failed:",
        ...failures.map((failure) => `- ${failure}`),
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log("Case-law decision view migration guard passed.");
}
