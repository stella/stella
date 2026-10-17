import { panic } from "better-result";

import {
  migrationStatementTokens,
  parseMigrationStatements,
  readMigrationRelation,
  reviewedMigrationLines,
  splitMigrationAlterActions,
} from "./check-migration-safety";

type LockMode =
  | "ACCESS SHARE"
  | "ROW SHARE"
  | "ROW EXCLUSIVE"
  | "SHARE UPDATE EXCLUSIVE"
  | "SHARE"
  | "SHARE ROW EXCLUSIVE"
  | "EXCLUSIVE"
  | "ACCESS EXCLUSIVE"
  | "NO EXISTING RELATION";

type DdlFormDefinition = {
  lockMode: LockMode;
  pattern: RegExp;
  scope: "statement" | "alter-table";
};

// Strongest relation lock per form, including indexes and referenced tables.
// NO EXISTING RELATION means catalog/object locks, not absence of all locks.
export const DDL_FORMS = {
  // PG18 §13.3.1: https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-TABLES
  "create-index-concurrently": {
    scope: "statement",
    lockMode: "SHARE UPDATE EXCLUSIVE",
    pattern: /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY\b/u,
  },
  // PG18 §13.3.1, CREATE INDEX (without CONCURRENTLY).
  "create-index": {
    scope: "statement",
    lockMode: "SHARE",
    pattern: /^CREATE (?:UNIQUE )?INDEX\b/u,
  },
  // PG18 DROP INDEX, CONCURRENTLY: https://www.postgresql.org/docs/18/sql-dropindex.html
  "drop-index-concurrently": {
    scope: "statement",
    lockMode: "SHARE UPDATE EXCLUSIVE",
    pattern: /^DROP INDEX CONCURRENTLY\b/u,
  },
  // PG18 DROP INDEX, Description: ACCESS EXCLUSIVE on parent table.
  "drop-index": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^DROP INDEX\b/u,
  },
  // PG18 §13.3.1, REINDEX CONCURRENTLY.
  "reindex-concurrently": {
    scope: "statement",
    lockMode: "SHARE UPDATE EXCLUSIVE",
    pattern: /^REINDEX (?:INDEX|TABLE) CONCURRENTLY\b/u,
  },
  // PG18 §13.3.1: ACCESS EXCLUSIVE on the index, SHARE on its table.
  reindex: {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^REINDEX (?:INDEX|TABLE)\b/u,
  },
  // PG18 ALTER INDEX, RENAME: https://www.postgresql.org/docs/18/sql-alterindex.html
  "rename-index": {
    scope: "statement",
    lockMode: "SHARE UPDATE EXCLUSIVE",
    pattern: /^ALTER INDEX .+ RENAME TO\b/u,
  },
  // PG18 §13.3.1, ANALYZE.
  analyze: {
    scope: "statement",
    lockMode: "SHARE UPDATE EXCLUSIVE",
    pattern: /^ANALYZE\b/u,
  },
  // PG18 §13.3.1, COMMENT ON.
  comment: {
    scope: "statement",
    lockMode: "SHARE UPDATE EXCLUSIVE",
    pattern: /^COMMENT ON\b/u,
  },
  // PG18 §13.3.1, CREATE TRIGGER.
  "create-trigger": {
    scope: "statement",
    lockMode: "SHARE ROW EXCLUSIVE",
    pattern: /^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER\b/u,
  },
  // PG18 DROP TRIGGER Description: https://www.postgresql.org/docs/18/sql-droptrigger.html
  "drop-trigger": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^DROP TRIGGER\b/u,
  },
  // PG18 §13.3.1, DROP TABLE.
  "drop-table": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^DROP TABLE\b/u,
  },
  // PG18 §13.3.1, TRUNCATE.
  truncate: {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^TRUNCATE\b/u,
  },
  // PG18 LOCK, default mode: https://www.postgresql.org/docs/18/sql-lock.html
  "lock-access-exclusive": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern:
      /^LOCK (?:TABLE )?.+ IN ACCESS EXCLUSIVE MODE$|^LOCK (?:TABLE )?[A-Z_".]+$/u,
  },
  // PG18 CREATE TABLE, REFERENCES: https://www.postgresql.org/docs/18/sql-createtable.html
  "create-table-references": {
    scope: "statement",
    lockMode: "SHARE ROW EXCLUSIVE",
    pattern:
      /^CREATE (?:UNLOGGED |TEMPORARY |TEMP )?TABLE\b(?!.*\b(?:PARTITION|INHERITS|OF|AS SELECT)\b).*\bREFERENCES\b/u,
  },
  // PG18 CREATE TABLE Description; the new relation is not visible to other sessions.
  "create-table": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern:
      /^CREATE (?:UNLOGGED |TEMPORARY |TEMP )?TABLE\b(?!.*\b(?:PARTITION|INHERITS|OF|AS SELECT)\b)/u,
  },
  // PG18 CREATE VIEW Description: https://www.postgresql.org/docs/18/sql-createview.html
  "replace-view": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^CREATE OR REPLACE VIEW\b/u,
  },
  // PG18 CREATE VIEW Description; SELECT takes ACCESS SHARE on dependencies (§13.3.1).
  "create-view": {
    scope: "statement",
    lockMode: "ACCESS SHARE",
    pattern: /^CREATE VIEW\b/u,
  },
  // PG18 ALTER DEFAULT PRIVILEGES: https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html
  "alter-default-privileges": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^ALTER DEFAULT PRIVILEGES\b/u,
  },
  // PG18 LOCK, explicit mode: https://www.postgresql.org/docs/18/sql-lock.html
  "lock-share-row-exclusive": {
    scope: "statement",
    lockMode: "SHARE ROW EXCLUSIVE",
    pattern: /^LOCK (?:TABLE )?.+ IN SHARE ROW EXCLUSIVE MODE$/u,
  },
  // PG18 policy command sections: https://www.postgresql.org/docs/18/sql-createpolicy.html
  // Lock choice is explicit in PG18 policy.c (CreatePolicy/AlterPolicy/RemovePolicyById):
  // https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/commands/policy.c
  "create-policy": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^CREATE POLICY\b/u,
  },
  // PG18 ALTER POLICY Description; policy.c AlterPolicy, link above.
  "alter-policy": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^ALTER POLICY\b/u,
  },
  // PG18 DROP POLICY Description; policy.c RemovePolicyById, link above.
  "drop-policy": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^DROP POLICY\b/u,
  },
  // PG18 ALTER TABLE, VALIDATE CONSTRAINT: https://www.postgresql.org/docs/18/sql-altertable.html
  "validate-constraint": {
    scope: "alter-table",
    lockMode: "SHARE UPDATE EXCLUSIVE",
    pattern: /^VALIDATE CONSTRAINT\b/u,
  },
  // PG18 ALTER TABLE, ADD table_constraint: foreign keys lock both relations.
  "add-foreign-key": {
    scope: "alter-table",
    lockMode: "SHARE ROW EXCLUSIVE",
    pattern: /^ADD (?:CONSTRAINT (?:"ID"|[A-Z_][A-Z0-9_$]*) )?FOREIGN KEY\b/u,
  },
  // PG18 ALTER TABLE, ADD COLUMN (default ACCESS EXCLUSIVE).
  "add-column": {
    scope: "alter-table",
    lockMode: "ACCESS EXCLUSIVE",
    pattern:
      /^ADD COLUMN (?:IF NOT EXISTS )?(?:"ID"|[A-Z_][A-Z0-9_$]*) (?!FOREIGN\b|CHECK\b|PRIMARY\b|UNIQUE\b)/u,
  },
  // PG18 ALTER TABLE, ADD table_constraint (except foreign keys).
  "add-constraint": {
    scope: "alter-table",
    lockMode: "ACCESS EXCLUSIVE",
    pattern:
      /^ADD (?:CONSTRAINT (?:"ID"|[A-Z_][A-Z0-9_$]*) )?(?:CHECK|PRIMARY KEY|UNIQUE|EXCLUDE)\b/u,
  },
  // PG18 ALTER TABLE, DROP COLUMN.
  "drop-column": {
    scope: "alter-table",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^DROP COLUMN\b/u,
  },
  // PG18 ALTER TABLE, DROP CONSTRAINT.
  "drop-constraint": {
    scope: "alter-table",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^DROP CONSTRAINT\b/u,
  },
  // PG18 ALTER TABLE, ALTER COLUMN subcommands (explicitly enumerated).
  "alter-column": {
    scope: "alter-table",
    lockMode: "ACCESS EXCLUSIVE",
    pattern:
      /^ALTER (?:COLUMN )?(?:"ID"|[A-Z_][A-Z0-9_$]*) (?:SET (?:DEFAULT|NOT NULL|DATA TYPE)|DROP (?:DEFAULT|NOT NULL)|TYPE)\b/u,
  },
  // PG18 ALTER TABLE, RENAME.
  "rename-table-or-column": {
    scope: "alter-table",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^RENAME (?:TO|COLUMN|CONSTRAINT)\b/u,
  },
  // PG18 ALTER TABLE, ENABLE/DISABLE/FORCE/NO FORCE ROW LEVEL SECURITY.
  "row-level-security": {
    scope: "alter-table",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^(?:ENABLE|DISABLE|FORCE|NO FORCE) ROW LEVEL SECURITY$/u,
  },
  // PG18 ALTER TABLE, ENABLE/DISABLE TRIGGER (SHARE ROW EXCLUSIVE).
  "toggle-trigger": {
    scope: "alter-table",
    lockMode: "SHARE ROW EXCLUSIVE",
    pattern: /^(?:ENABLE (?:REPLICA |ALWAYS )?|DISABLE )TRIGGER\b/u,
  },
  // PG18 CREATE FUNCTION Description: https://www.postgresql.org/docs/18/sql-createfunction.html
  "create-function": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^CREATE (?:OR REPLACE )?FUNCTION\b/u,
  },
  // PG18 ALTER FUNCTION: https://www.postgresql.org/docs/18/sql-alterfunction.html
  "alter-function": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^ALTER FUNCTION\b/u,
  },
  // PG18 DROP FUNCTION: https://www.postgresql.org/docs/18/sql-dropfunction.html
  "drop-function": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^DROP FUNCTION\b/u,
  },
  // PG18 CREATE TYPE: https://www.postgresql.org/docs/18/sql-createtype.html
  "create-type": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^CREATE TYPE\b/u,
  },
  // PG18 DROP TYPE: https://www.postgresql.org/docs/18/sql-droptype.html
  "drop-type": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^DROP TYPE\b/u,
  },
  // PG18 CREATE ROLE: https://www.postgresql.org/docs/18/sql-createrole.html
  "create-role": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^CREATE ROLE\b/u,
  },
  // PG18 ALTER ROLE: https://www.postgresql.org/docs/18/sql-alterrole.html
  "alter-role": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^ALTER ROLE\b/u,
  },
  // PG18 CREATE EXTENSION: https://www.postgresql.org/docs/18/sql-createextension.html
  // Only these catalog-only extensions occur in the migration corpus.
  "create-extension": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^CREATE EXTENSION (?:IF NOT EXISTS )?(?:UNACCENT|PG_TRGM)$/u,
  },
  // PG18 CREATE TEXT SEARCH CONFIGURATION: https://www.postgresql.org/docs/18/sql-createtsconfig.html
  "create-text-search-configuration": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^CREATE TEXT SEARCH CONFIGURATION\b/u,
  },
  // PG18 ALTER TEXT SEARCH CONFIGURATION: https://www.postgresql.org/docs/18/sql-altertsconfig.html
  "alter-text-search-configuration": {
    scope: "statement",
    lockMode: "NO EXISTING RELATION",
    pattern: /^ALTER TEXT SEARCH CONFIGURATION\b/u,
  },
} as const satisfies Record<string, DdlFormDefinition>;

export type DdlForm = keyof typeof DDL_FORMS;
type CensusForm = { form: DdlForm; lockMode: LockMode; line: number };
const isDdlForm = (value: string): value is DdlForm =>
  Object.hasOwn(DDL_FORMS, value);
const FORM_ENTRIES = Object.entries(DDL_FORMS).flatMap(([form, definition]) =>
  isDdlForm(form)
    ? [[form, definition] as const]
    : panic(`Unknown DDL form key: ${form}`),
);
const DDL_VERB =
  /\b(?:CREATE|ALTER|DROP|REINDEX|ANALYZE|COMMENT|TRUNCATE|LOCK|VACUUM|CLUSTER|REFRESH|SECURITY|IMPORT|REASSIGN)\b/iu;

export const censusSql = (source: string) => {
  const forms: CensusForm[] = [];
  const errors: string[] = [];
  const classify = (sql: string, line: number, alter: boolean) => {
    const normalized = sql.replace(/\s+/gu, " ").trim().replace(/;$/u, "");
    const match = FORM_ENTRIES.find(
      ([, { pattern, scope }]) =>
        (scope === "alter-table") === alter && pattern.test(normalized),
    );
    if (!match) {
      errors.push(
        `line ${line}: Unknown DDL form: ${normalized.slice(0, 140)}`,
      );
      return;
    }
    const [form, { lockMode }] = match;
    forms.push({ form, lockMode, line });
  };
  for (const statement of parseMigrationStatements(source)) {
    const tokens = migrationStatementTokens(statement);
    // A privilege name is not a statement, nor is ALTER in an ALTER FUNCTION option.
    if (
      /^\s*(?:GRANT|REVOKE|SELECT|WITH|INSERT|UPDATE|DELETE|MERGE)\b/iu.test(
        statement.text,
      )
    ) {
      continue;
    }
    const start = tokens.findIndex(
      (token, index) =>
        token.kind === "word" &&
        DDL_VERB.test(token.value) &&
        (index === 0 ||
          /^(?:begin|then|else|loop)$/u.test(tokens[index - 1]?.value ?? "")),
    );
    if (start !== -1) {
      const sqlTokens = tokens.slice(start);
      const render = (items: typeof tokens) =>
        items
          .map((token) =>
            token.kind === "identifier" ? '"ID"' : token.value.toUpperCase(),
          )
          .join(" ");
      if (
        sqlTokens.at(0)?.value === "alter" &&
        sqlTokens.at(1)?.value === "table"
      ) {
        let cursor = 2;
        if (sqlTokens[cursor]?.value === "if") {
          cursor += 2;
        }
        if (sqlTokens[cursor]?.value === "only") {
          cursor++;
        }
        const relation = readMigrationRelation(sqlTokens, cursor);
        if (!relation) {
          errors.push(`line ${statement.line}: Unknown ALTER TABLE target`);
        } else {
          for (const action of splitMigrationAlterActions(
            sqlTokens.slice(relation.next),
          )) {
            classify(render(action), statement.line, true);
          }
        }
      } else {
        classify(render(sqlTokens), statement.line, false);
      }
    }
    // SQL passed to EXECUTE/format is executable, unlike ordinary string data.
    if (/\bEXECUTE\b/iu.test(statement.text)) {
      for (const literal of statement.literals) {
        if (
          !/^\s*(?:CREATE|ALTER|DROP|REINDEX|ANALYZE|COMMENT|TRUNCATE|LOCK|VACUUM|CLUSTER|REFRESH|SECURITY|IMPORT|REASSIGN)\b/iu.test(
            literal.value,
          )
        ) {
          continue;
        }
        const nested = censusSql(
          literal.value.replace(/%(?:\d+\$)?[ILs]/gu, '"dynamic_identifier"'),
        );
        forms.push(
          ...nested.forms.map((form) => ({ ...form, line: statement.line })),
        );
        errors.push(
          ...nested.errors.map(
            (error) => `line ${statement.line}: dynamic SQL: ${error}`,
          ),
        );
      }
    }
  }
  return { forms, errors };
};

export type MigrationLockAllowance = {
  migration: string;
  form: DdlForm;
  reason: string;
};
// New ACCESS EXCLUSIVE work without an existing safety acknowledgement needs a
// statement-form decision here (for example, an additive expand/contract step).
export const MIGRATION_LOCK_ALLOWANCES: readonly MigrationLockAllowance[] = [];
export type LockBaselineEntry = {
  migration: string;
  form: DdlForm;
  count: number;
};
export type MigrationSource = { file: string; source: string };
export const migrationFolder = (file: string) =>
  file
    .replace(/^apps\/api\/drizzle\//u, "")
    .split("/")
    .at(0) ?? "";

export const migrationLockPairs = (sources: readonly MigrationSource[]) => {
  const pairs = new Map<string, LockBaselineEntry>();
  for (const { file, source } of sources) {
    const migration = migrationFolder(file);
    for (const { form } of censusSql(source).forms) {
      const key = `${migration}/${form}`;
      const entry = pairs.get(key);
      if (entry) {
        entry.count++;
      } else {
        pairs.set(key, { migration, form, count: 1 });
      }
    }
  }
  return [...pairs.keys()]
    .toSorted()
    .map(
      (key) => pairs.get(key) ?? panic(`Missing migration lock pair: ${key}`),
    );
};

type CheckMigrationLocksOptions = {
  sources: readonly MigrationSource[];
  baseline: readonly LockBaselineEntry[];
  allowances?: readonly MigrationLockAllowance[];
};
export const checkMigrationLocks = ({
  sources,
  baseline,
  allowances = MIGRATION_LOCK_ALLOWANCES,
}: CheckMigrationLocksOptions) => {
  const errors: string[] = [];
  const counts = new Map<LockMode, number>();
  const remaining = new Map(
    baseline.map((entry) => [`${entry.migration}/${entry.form}`, entry.count]),
  );
  for (const { file, source } of sources) {
    const migration = migrationFolder(file);
    const census = censusSql(source);
    errors.push(...census.errors.map((error) => `${file}: ${error}`));
    const reviewed = reviewedMigrationLines(source);
    for (const { form, lockMode, line } of census.forms) {
      counts.set(lockMode, (counts.get(lockMode) ?? 0) + 1);
      const key = `${migration}/${form}`;
      const historical = remaining.get(key) ?? 0;
      if (historical > 0) {
        remaining.set(key, historical - 1);
        continue;
      }
      if (lockMode !== "ACCESS EXCLUSIVE" || reviewed.has(line)) {
        continue;
      }
      if (
        allowances.some(
          (entry) =>
            entry.migration === migration &&
            entry.form === form &&
            entry.reason.trim().length >= 12,
        )
      ) {
        continue;
      }
      errors.push(
        `${file}:${line}: ACCESS EXCLUSIVE ${form} needs a reviewed safety acknowledgement or typed lock allowance with a reason`,
      );
    }
  }
  for (const [key, count] of remaining) {
    if (count > 0) {
      errors.push(`Baseline drift: ${key} has ${count} missing occurrences`);
    }
  }
  return { errors, counts };
};
