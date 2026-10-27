import { panic } from "better-result";

import {
  matchingMigrationGuardedRules,
  migrationStatementTokens,
  parseMigrationStatements,
  readMigrationRelation,
  reviewedMigrationStatements,
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
  // CASCADE can remove columns on unknown dependent tables, regardless of the
  // dropped object's own locks. Match before every object-specific DROP form.
  // PG18 dependency tracking: https://www.postgresql.org/docs/18/ddl-depend.html
  "drop-cascade": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^DROP\b.*\bCASCADE$/u,
  },
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
      /^ADD (?:CONSTRAINT (?:"ID"|[A-Z_][A-Z0-9_$]*) )?(?:CHECK|PRIMARY KEY|UNIQUE|NOT NULL|EXCLUDE)\b/u,
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
  // PG18 ALTER TABLE: OWNER uses the default ACCESS EXCLUSIVE lock.
  "change-owner": {
    scope: "alter-table",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /^OWNER TO\b/u,
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
  // The command text may contain any DDL, so unresolved dynamic SQL assumes
  // the strongest relation lock until the migration records a typed decision.
  "unresolved-execute": {
    scope: "statement",
    lockMode: "ACCESS EXCLUSIVE",
    pattern: /\b\B/u,
  },
} as const satisfies Record<string, DdlFormDefinition>;

export type DdlForm = keyof typeof DDL_FORMS;
type CensusForm = {
  form: DdlForm;
  lockMode: LockMode;
  line: number;
  statementIndex: number;
  sql: string;
  // Undefined represents a relation reached through an unbounded dependency.
  lockTargets: readonly (string | undefined)[];
  locksExistingRelation: boolean;
};
const isDdlForm = (value: string): value is DdlForm =>
  Object.hasOwn(DDL_FORMS, value);
const FORM_ENTRIES = Object.entries(DDL_FORMS).flatMap(([form, definition]) =>
  isDdlForm(form)
    ? [[form, definition] as const]
    : panic(`Unknown DDL form key: ${form}`),
);
const DDL_VERB =
  /\b(?:CREATE|ALTER|DROP|REINDEX|ANALYZE|COMMENT|TRUNCATE|LOCK|VACUUM|CLUSTER|REFRESH|SECURITY|IMPORT|REASSIGN)\b/iu;

type StatementTokens = ReturnType<typeof migrationStatementTokens>;

// `CREATE [UNLOGGED|TEMP|TEMPORARY] TABLE name` without IF NOT EXISTS: the
// relation is new exactly when this statement runs.
const createdRelationKey = (tokens: StatementTokens): string | undefined => {
  if (tokens.at(0)?.value !== "create") {
    return undefined;
  }
  let cursor = 1;
  if (/^(?:unlogged|temp|temporary)$/u.test(tokens[cursor]?.value ?? "")) {
    cursor++;
  }
  if (tokens[cursor]?.value !== "table" || tokens[cursor + 1]?.value === "if") {
    return undefined;
  }
  return readMigrationRelation(tokens, cursor + 1)?.relation.key;
};

// The table `CREATE [UNIQUE] INDEX` or `CREATE POLICY` / `CREATE TRIGGER` acts on.
const onRelationKey = (tokens: StatementTokens): string | undefined => {
  const kind =
    tokens.at(1)?.value === "unique"
      ? tokens.at(2)?.value
      : tokens.at(1)?.value;
  if (
    tokens.at(0)?.value !== "create" ||
    !/^(?:index|policy|trigger)$/u.test(kind ?? "")
  ) {
    return undefined;
  }
  const on = tokens.findIndex(
    (token) => token.kind === "word" && token.value === "on",
  );
  if (on === -1) {
    return undefined;
  }
  const start = tokens[on + 1]?.value === "only" ? on + 2 : on + 1;
  return readMigrationRelation(tokens, start)?.relation.key;
};

const statementRelationKey = (tokens: StatementTokens): string | undefined => {
  const onTarget = onRelationKey(tokens);
  if (onTarget !== undefined) {
    return onTarget;
  }
  const words = tokens.map(({ value }) => value);
  let cursor: number | undefined;
  if (
    words.at(0) === "create" &&
    words.at(1) === "or" &&
    words.at(2) === "replace" &&
    words.at(3) === "view"
  ) {
    cursor = 4;
  } else if (
    words.at(0) === "drop" &&
    /^(?:table|index)$/u.test(words.at(1) ?? "")
  ) {
    cursor = words.at(2) === "concurrently" ? 3 : 2;
  } else if (words.at(0) === "truncate") {
    cursor = words.at(1) === "table" ? 2 : 1;
  } else if (words.at(0) === "lock") {
    cursor = words.at(1) === "table" ? 2 : 1;
  } else if (words.at(0) === "alter" && words.at(1) === "index") {
    cursor = 2;
  } else if (
    words.at(0) === "reindex" &&
    /^(?:index|table)$/u.test(words.at(1) ?? "")
  ) {
    cursor = words.at(2) === "concurrently" ? 3 : 2;
  } else if (
    /^(?:alter|drop)$/u.test(words.at(0) ?? "") &&
    /^(?:policy|trigger)$/u.test(words.at(1) ?? "")
  ) {
    const on = words.indexOf("on");
    cursor = on === -1 ? undefined : on + 1;
  }
  return cursor === undefined
    ? undefined
    : readMigrationRelation(tokens, cursor)?.relation.key;
};

const isSelfContainedNewRelationOperation = (form: DdlForm, sql: string) => {
  if (form === "create-index" || form === "create-index-concurrently") {
    return true;
  }
  if (form === "add-column") {
    // Sequence functions reach another relation. PostgreSQL column defaults
    // cannot otherwise contain subqueries; REFERENCES is classified as an FK.
    return !/\b(?:NEXTVAL|CURRVAL|SETVAL|REFERENCES)\b|::\s*REGCLASS\b/u.test(
      sql,
    );
  }
  if (form === "add-constraint") {
    return /^ADD (?:CONSTRAINT (?:"ID"|[A-Z_][A-Z0-9_$]*) )?(?:CHECK|UNIQUE|PRIMARY KEY|NOT NULL)\b/u.test(
      sql,
    );
  }
  if (form === "alter-column") {
    return /^ALTER (?:COLUMN )?(?:"ID"|[A-Z_][A-Z0-9_$]*) (?:SET (?:DEFAULT|NOT NULL)|DROP (?:DEFAULT|NOT NULL))\b/u.test(
      sql,
    );
  }
  return form === "comment" || form === "change-owner";
};

const relationReferences = (tokens: StatementTokens) => {
  const relations: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "word" || token.value !== "references") {
      continue;
    }
    const relation = readMigrationRelation(tokens, index + 1);
    if (relation) {
      relations.push(relation.relation.key);
    }
  }
  return relations;
};

export const isWriterBlockingLock = (lockMode: LockMode) =>
  lockMode === "SHARE" ||
  lockMode === "SHARE ROW EXCLUSIVE" ||
  lockMode === "EXCLUSIVE" ||
  lockMode === "ACCESS EXCLUSIVE";

const changesRelationIdentity = (tokens: StatementTokens) => {
  if (tokens.some(({ kind, value }) => kind === "word" && value === "rename")) {
    return true;
  }
  if (tokens.at(0)?.value === "drop") {
    return /^(?:table|foreign|view|materialized|sequence|index)$/u.test(
      tokens.at(1)?.value ?? "",
    );
  }
  return tokens.some(
    ({ value }, index) =>
      value === "drop" && tokens[index + 1]?.value === "column",
  );
};

type ClassifyOptions = {
  sql: string;
  line: number;
  alter: boolean;
  statementIndex: number;
  target: string | undefined;
  additionalTargets: readonly string[];
  createdNow: string | undefined;
};

const censusSqlSource = (source: string, topLevel: boolean) => {
  const forms: CensusForm[] = [];
  const errors: string[] = [];
  const createdRelations = new Set<string>();
  const statements = parseMigrationStatements(source);
  const migrationChangesIdentity = statements.some((statement) =>
    changesRelationIdentity(migrationStatementTokens(statement)),
  );
  const classify = ({
    sql,
    line,
    alter,
    statementIndex,
    target,
    additionalTargets,
    createdNow,
  }: ClassifyOptions) => {
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
    const lockTargets: (string | undefined)[] = [
      ...(target === undefined ? [] : [target]),
      ...additionalTargets,
    ];
    if (isWriterBlockingLock(lockMode) && lockTargets.length === 0) {
      lockTargets.push(undefined);
    }
    if (/\bCASCADE$/u.test(normalized)) {
      lockTargets.push(undefined);
    }
    if (
      target !== undefined &&
      createdRelations.has(target) &&
      !isSelfContainedNewRelationOperation(form, normalized) &&
      form !== "add-foreign-key"
    ) {
      lockTargets.push(undefined);
    }
    forms.push({
      form,
      lockMode,
      line,
      statementIndex,
      sql: alter ? `ALTER TABLE census_target ${normalized}` : normalized,
      lockTargets,
      locksExistingRelation:
        migrationChangesIdentity ||
        lockTargets.some(
          (relation) =>
            relation === undefined ||
            (relation !== createdNow && !createdRelations.has(relation)),
        ),
    });
  };
  for (const [statementIndex, statement] of statements.entries()) {
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
            classify({
              sql: render(action),
              line: statement.line,
              alter: true,
              statementIndex,
              target: relation.relation.key,
              additionalTargets: relationReferences(action),
              createdNow: undefined,
            });
          }
        }
      } else {
        const created = createdRelationKey(sqlTokens);
        classify({
          sql: render(sqlTokens),
          line: statement.line,
          alter: false,
          statementIndex,
          target: created ?? statementRelationKey(sqlTokens),
          additionalTargets: relationReferences(sqlTokens),
          createdNow: created,
        });
        if (
          topLevel &&
          statement.enclosingLine === undefined &&
          start === 0 &&
          created !== undefined
        ) {
          createdRelations.add(created);
        }
      }
    }
    // Only one literal can prove the complete command text. Expressions such
    // as format(), concatenation, and variables can construct arbitrary DDL.
    const executeTokens =
      statement.enclosingLine === undefined
        ? []
        : tokens.filter(
            (token) => token.kind === "word" && token.value === "execute",
          );
    for (const [position, execute] of executeTokens.entries()) {
      // Executed expressions can rename, drop, or replace any relation. Even a
      // literal command crosses a parsing boundary, so exemptions fail closed.
      createdRelations.clear();
      const end = executeTokens[position + 1]?.index ?? statement.text.length;
      const literals = statement.literals.filter(
        (literal) => literal.index > execute.index && literal.index < end,
      );
      const literal = literals.at(0);
      const before = literal
        ? statement.text
            .slice(execute.index + execute.value.length, literal.index)
            .trim()
        : "";
      const after = literal
        ? statement.text.slice(literal.end, end).trim()
        : "";
      if (
        literal &&
        literals.length === 1 &&
        (before === "" || before.toLowerCase() === "e") &&
        /^(?:INTO|USING|$)/iu.test(after)
      ) {
        const nested = censusSqlSource(literal.value, false);
        forms.push(
          ...nested.forms.map((form) => ({
            ...form,
            line: statement.line,
            statementIndex,
          })),
        );
        errors.push(
          ...nested.errors.map(
            (error) => `line ${statement.line}: dynamic SQL: ${error}`,
          ),
        );
        continue;
      }
      forms.push({
        form: "unresolved-execute",
        lockMode: "ACCESS EXCLUSIVE",
        line: statement.line,
        statementIndex,
        sql: "EXECUTE unresolved_dynamic_sql",
        lockTargets: [undefined],
        locksExistingRelation: true,
      });
    }
  }
  return { forms, errors };
};

export const censusSql = (source: string) => censusSqlSource(source, true);

export type MigrationLockAllowance = {
  migration: string;
  form: DdlForm;
  reason: string;
};
// New writer-blocking work without an existing safety acknowledgement needs a
// statement-form decision here (for example, an additive expand/contract step).
export const MIGRATION_LOCK_ALLOWANCES: readonly MigrationLockAllowance[] = [
  {
    migration: "20261026120100_data_box_correspondence",
    form: "add-column",
    reason:
      "The envelope is nullable and default-free; the data-box inventory uses a constant JSON default on PostgreSQL's fast-default path. Neither addition rewrites existing rows; lock_timeout is 1s and statement_timeout is 5s.",
  },
  {
    migration: "20261026120100_data_box_correspondence",
    form: "alter-column",
    reason:
      "Dropping direction's NOT NULL flag changes catalog metadata without reading correspondence rows. The replacement channel-specific CHECK is added NOT VALID; lock_timeout is 1s and statement_timeout is 5s.",
  },
  {
    migration: "20261026120100_data_box_correspondence",
    form: "add-constraint",
    reason:
      "All four channel, direction, envelope and bounded-inventory CHECKs are added NOT VALID, with no existing-row scan. Canonical gated online repairs validate them after commit; lock_timeout is 1s and statement_timeout is 5s.",
  },
  {
    migration: "20261026120300_data_box_sources",
    form: "create-table-references",
    reason:
      "The new empty source table references existing matter, record and entity keys. Creating its foreign keys locks the parents but scans no existing source rows; lock_timeout is 1s and statement_timeout is 5s.",
  },
  {
    migration: "20261026120300_data_box_sources",
    form: "row-level-security",
    reason:
      "ENABLE and FORCE ROW LEVEL SECURITY apply to the newly created empty source table. Both are catalog changes without a data rewrite, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261026120300_data_box_sources",
    form: "create-trigger",
    reason:
      "The four source lifecycle triggers are attached through catalog changes; this migration executes no application DML or history backfill. Lock acquisition is bounded by 1s lock_timeout and each statement by 5s statement_timeout.",
  },
  {
    migration: "20261026120300_data_box_sources",
    form: "add-foreign-key",
    reason:
      "After the source lifecycle triggers are installed, the current-source foreign key changes from cascade to restrict as NOT VALID, without scanning live rows. Gated online validation follows; lock_timeout is 1s and statement_timeout is 5s.",
  },
  {
    migration: "20261026120400_data_box_source_gates",
    form: "create-policy",
    reason:
      "The eight source-table policies install the canonical feature, matter, organization and reset-owner fences. Policy creation is catalog-only and scans no rows; this generated migration declares 1s lock_timeout and 10s statement_timeout.",
  },
  {
    migration: "20261026120400_data_box_source_gates",
    form: "create-trigger",
    reason:
      "The canonical feature write trigger is attached to the new source table without executing row work. This generated migration declares 1s lock_timeout and 10s statement_timeout; it contains only catalog operations.",
  },
  {
    migration: "20261026120600_correspondence_source_maintenance",
    form: "create-policy",
    reason:
      "The four lifecycle policies give only the private non-bypass role row-scoped access derived from the deleted source. Catalog-only policy creation scans no history, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261025130000_reader_answer_continuation_spans",
    form: "add-column",
    reason:
      "The NOT NULL jsonb column uses a constant '[]'::jsonb default on PostgreSQL's fast-default catalog path without scanning or rewriting answer rows, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261022120000_case_law_batch_slots",
    form: "add-column",
    reason:
      "The three parsed-input fields and two captured raw-object keys are nullable and default-free catalog additions, without a corpus row scan or table rewrite; lock acquisition is bounded by 1s and the statement by 30s.",
  },
  {
    migration: "20261022120000_case_law_batch_slots",
    form: "add-constraint",
    reason:
      "The complete parsed-input CHECK is added NOT VALID without scanning existing corpus rows, under transaction-local 1s lock_timeout and 30s statement_timeout; the canonical online phase validates it after releasing the schema lock.",
  },
  {
    migration: "20261022120000_case_law_batch_slots",
    form: "create-trigger",
    reason:
      "Installing the row-level provenance invalidation trigger is a catalog-only change without a corpus scan, with acquisition bounded by transaction-local 1s lock_timeout and execution by 30s statement_timeout.",
  },
  {
    migration: "20261023160000_organization_access_state_origin",
    form: "add-column",
    reason:
      "The constant text default uses PostgreSQL's fast-default catalog path without rewriting the one-row-per-organization access states; lock acquisition is bounded by 1s and the statement by 5s.",
  },
  {
    migration: "20261023160000_organization_access_state_origin",
    form: "alter-column",
    reason:
      "Changing the column default is catalog-only and leaves the stored fast default of existing rows in place, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261023160000_organization_access_state_origin",
    form: "add-constraint",
    reason:
      "The origin CHECK is added NOT VALID without scanning rows, under 1s lock_timeout and 5s statement_timeout; the online phase validates it after the schema lock is released.",
  },
  {
    migration: "20261016100500_agent_skill_binding",
    form: "add-column",
    reason:
      "The two nullable, default-free UUID binding columns are catalog-only additions without a table rewrite; lock acquisition is bounded by 1s lock_timeout and each statement by 5s statement_timeout.",
  },
  {
    migration: "20261016100500_agent_skill_binding",
    form: "add-constraint",
    reason:
      "The single-binding CHECK is added NOT VALID, enforcing new writes without scanning existing rows; the gated online phase validates it after deploy, with this catalog addition bounded by 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261016100500_agent_skill_binding",
    form: "add-foreign-key",
    reason:
      "The two composite binding foreign keys retain organization identity and are added NOT VALID without scanning existing rows; validation runs through the online table gate, while pre-deploy lock acquisition is bounded by 1s and each catalog statement by 5s.",
  },
  {
    migration: "20261016100500_agent_skill_binding",
    form: "create-policy",
    reason:
      "The seven replacement policies retain organization and visibility checks, add binding reach, and allow a matter-bound skill's author to write it; each catalog-only replacement stays in the migration transaction under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261024193000_owner_erasure_paths",
    form: "create-policy",
    reason:
      "The eighteen policies add only table-owner SELECT/DELETE access fenced to the reset organization; catalog-only policy creation performs no row scan, with transaction-local 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261024190300_invoice_line_exemption_reason",
    form: "add-column",
    reason:
      "The nullable, default-free exemption basis is a catalog-only addition to invoice lines without a table rewrite, under 5s lock_timeout and 30s statement_timeout.",
  },
  {
    migration: "20261019010000_invoice_party_tax_vat_ids",
    form: "add-column",
    reason:
      "The seller, contact and invoice party identifier columns are nullable and default-free, a catalog-only addition without a table rewrite, under 5s lock_timeout and 30s statement_timeout.",
  },
  {
    migration: "20261019020000_invoice_language",
    form: "add-column",
    reason:
      "The nullable language preferences are catalog-only; invoices.language takes a constant literal default on PostgreSQL's fast-default path without rewriting invoice rows; lock acquisition is bounded by 5s and the statement by 30s.",
  },
  {
    migration: "20261019020000_invoice_language",
    form: "add-constraint",
    reason:
      "The three language CHECKs are added NOT VALID without scanning existing rows, under 5s lock_timeout and 30s statement_timeout; they are validated in the online phase after the schema lock is released.",
  },
  {
    migration: "20261024214500_invoice_vat_exchange_rate",
    form: "add-column",
    reason:
      "The five VAT exchange-rate columns are nullable and default-free, a catalog-only addition without a table rewrite, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261024190200_case_law_decision_date_floor_gbr",
    form: "add-constraint",
    reason:
      "The widened decision-date CHECK is added NOT VALID without scanning corpus rows; metadata-only lock acquisition retries at 2s, 10s and 30s within a 10-minute statement budget, then validation runs in the online phase.",
  },
  {
    migration: "20261020013635_case_law_source_hash_version",
    form: "add-column",
    reason:
      "The non-volatile constant smallint default uses PostgreSQL's fast-default catalog path without rewriting decision rows; lock acquisition is bounded by 5s and the statement by 30s.",
  },
  {
    migration: "20261024090100_reader_answer_feature_refusal",
    form: "add-constraint",
    reason:
      "The widened diagnostic CHECK is added NOT VALID without scanning existing messages, under 1s lock_timeout and 5s statement_timeout; its later validation runs only after releasing the schema lock.",
  },
  {
    migration: "20261020013635_case_law_source_hash_version",
    form: "replace-view",
    reason:
      "The two decision views re-expand their existing SELECT * definitions to include source_hash_version while preserving the redaction and listing filters; replacement updates view metadata without scanning corpus rows, under 5s lock_timeout and 30s statement_timeout.",
  },
  {
    migration: "20261023233000_oauth_client_metadata_validated_at",
    form: "add-column",
    reason:
      "The nullable, default-free validation timestamp is a catalog-only addition without a table rewrite, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261019091000_legislation_publisher_identity",
    form: "add-column",
    reason:
      "Constant literal defaults use the PostgreSQL fast-default catalog path without rewriting either legislation table; lock acquisition is bounded by 1s and the statement by 10s.",
  },
  {
    migration: "20261019091000_legislation_publisher_identity",
    form: "create-trigger",
    reason:
      "The three identity and writer fences install trigger metadata without scanning existing rows, under the migration's 1s lock_timeout and 10s statement_timeout.",
  },
  {
    migration: "20261019091000_legislation_publisher_identity",
    form: "add-constraint",
    reason:
      "Identity, namespace, lifecycle and nonempty CHECK constraints are added NOT VALID under a 1s lock_timeout; validation runs separately under its weaker lock.",
  },
  {
    migration: "20261019091000_legislation_publisher_identity",
    form: "row-level-security",
    reason:
      "ENABLE and FORCE RLS affect only the identifier lookup table created by this migration; retries retain the 1s lock_timeout and 10s statement_timeout.",
  },
  {
    migration: "20261019091000_legislation_publisher_identity",
    form: "create-policy",
    reason:
      "Policies install the identifier lookup table's existing ingestion/public-reader role boundary without application-relation reads, with DDL lock acquisition bounded to 1s.",
  },
  {
    migration: "20261019091000_legislation_publisher_identity",
    form: "create-index",
    reason:
      "The ordinary index targets the lookup table initially created empty by this migration, not the populated legislation corpus; replay is bounded by 1s lock_timeout and 10s statement_timeout.",
  },
  {
    migration: "20261019091000_legislation_publisher_identity",
    form: "add-foreign-key",
    reason:
      "The identifier lookup foreign key is installed NOT VALID without an existing-row scan; locks on the lookup and legislation_sources are bounded by 1s lock_timeout.",
  },
  {
    migration: "20261020143000_case_law_coverage_slice_public_reader",
    form: "create-policy",
    reason:
      "The SELECT-only public-reader policy adds metadata with a constant predicate and no application-relation reads, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261022120000_scheduler_pause_bound",
    form: "create-index",
    reason:
      "The partial pause index covers one scheduler row per declared job or scheduled flow; lock acquisition is bounded to 1s and the entire index build to 5s.",
  },
  {
    migration: "20261023100000_case_law_sitemap_shard_counts",
    form: "row-level-security",
    reason:
      "ENABLE and FORCE RLS apply to the new empty sitemap count table before publication, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261024090000_professional_use_acceptance_operator_source",
    form: "add-constraint",
    reason:
      "The source CHECK is replaced transactionally and added NOT VALID, avoiding a scan under ACCESS EXCLUSIVE; 1s lock_timeout bounds acquisition and separate validation uses the weaker lock.",
  },
  {
    migration: "20261022233000_mcp_web_handoff",
    form: "create-table-references",
    reason:
      "Foreign keys are installed with a new empty table, so no existing rows are scanned; the 1s lock_timeout bounds referenced-table lock acquisition.",
  },
  {
    migration: "20261022233000_mcp_web_handoff",
    form: "row-level-security",
    reason:
      "ENABLE and FORCE RLS apply only to the new empty handoff table before it becomes visible to application traffic, under a 1s lock_timeout.",
  },
  {
    migration: "20261022233000_mcp_web_handoff",
    form: "create-policy",
    reason:
      "Both policies are installed on the new empty handoff table under a 1s lock_timeout; their expressions inspect table ownership or return false, without reading application relations.",
  },
  {
    migration: "20261022233000_mcp_web_handoff",
    form: "add-column",
    reason:
      "The two session columns are nullable and default-free catalog additions under a 1s lock_timeout, without a heap rewrite.",
  },
  {
    migration: "20261022233000_mcp_web_handoff",
    form: "add-foreign-key",
    reason:
      "The session foreign key is added NOT VALID, avoiding an existing-row scan while the 1s lock_timeout bounds locks on session and oauth_consent.",
  },
  {
    migration: "20261015060000_folio_collab_saved_snapshot_cut",
    form: "add-column",
    reason:
      "Nullable, default-free columns are a catalog-only change under a 1s lock_timeout.",
  },
  {
    migration: "20261015060000_folio_collab_saved_snapshot_cut",
    form: "add-constraint",
    reason:
      "CHECK constraints are added NOT VALID under a 1s lock_timeout; 20261015060010 validates them without ACCESS EXCLUSIVE.",
  },
  {
    migration: "20261020090000_corpus_projection_desired_at",
    form: "add-column",
    reason:
      "Nullable, default-free columns are a catalog-only change under a 1s lock_timeout.",
  },
  {
    migration: "20261020090000_corpus_projection_desired_at",
    form: "alter-column",
    reason:
      "SET DEFAULT changes only the catalog default for future rows (no rewrite or scan) under a 1s lock_timeout.",
  },
  {
    migration: "20261022120000_professional_use_acceptance_source",
    form: "add-column",
    reason:
      "Merged history adds a constant-default column as a catalog-only change under a 1s lock_timeout.",
  },
  {
    migration: "20261022120000_professional_use_acceptance_source",
    form: "add-constraint",
    reason:
      "Merged history adds the CHECK constraint NOT VALID under a 1s lock_timeout, then validates it separately.",
  },
  {
    migration: "20261020000100_stored_keys_organization_scope",
    form: "add-constraint",
    reason:
      "CHECK constraints are added NOT VALID, avoiding a table scan while the 5s lock_timeout bounds lock acquisition.",
  },
  {
    migration: "20261020000100_stored_keys_organization_scope",
    form: "create-trigger",
    reason:
      "Creating the trigger is a metadata-only change with lock acquisition bounded by the 5s lock_timeout.",
  },
  {
    migration: "20261020120000_field_cell_ownership",
    form: "add-column",
    reason:
      "Nullable, default-free columns are catalog-only changes under a 1s lock_timeout.",
  },
  {
    migration: "20261020120000_republished_ruling_identity_raw",
    form: "add-column",
    reason:
      "Nullable, default-free columns are catalog-only changes under a 5s lock_timeout.",
  },
  {
    migration: "20261020140000_republished_alias_moved_identities",
    form: "create-table-references",
    reason:
      "The foreign key is created with its new empty table, avoiding an existing-row scan under the 1s lock_timeout.",
  },
  {
    migration: "20261020140000_republished_alias_moved_identities",
    form: "row-level-security",
    reason:
      "Row-level security is enabled on the new empty table before it is available to concurrent application traffic.",
  },
  {
    migration: "20261020140000_republished_alias_moved_identities",
    form: "create-policy",
    reason:
      "The policy is created on the new empty table before it is available to concurrent application traffic.",
  },
  {
    migration: "20261022120000_scheduler_pause_bound",
    form: "add-column",
    reason:
      "The nullable, default-free column is a catalog-only change under a 1s lock_timeout.",
  },
  {
    migration: "20261022120000_scheduler_pause_bound",
    form: "add-constraint",
    reason:
      "CHECK constraints are added NOT VALID, avoiding a table scan while the 1s lock_timeout bounds lock acquisition.",
  },
  {
    migration: "20261022120000_scheduler_pause_bound",
    form: "create-trigger",
    reason:
      "Creating the trigger is a metadata-only change with lock acquisition bounded by the 1s lock_timeout.",
  },
  {
    migration: "20261021080000_reader_annotation_verification_claims",
    form: "add-column",
    reason:
      "The three claim columns are nullable and default-free, a catalog-only addition to reader notes without a rewrite, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261021080000_reader_annotation_verification_claims",
    form: "add-constraint",
    reason:
      "The widened target-type and claim-shape CHECKs are added NOT VALID without scanning existing notes, under 1s lock_timeout and 5s statement_timeout; the online phase validates them after the schema lock is released.",
  },
  {
    migration: "20261021080000_reader_annotation_verification_claims",
    form: "add-foreign-key",
    reason:
      "The matter key is added NOT VALID, so existing notes (all with a null matter) are not scanned, under 1s lock_timeout and 5s statement_timeout; the online phase validates it.",
  },
  {
    migration: "20261021080000_reader_annotation_verification_claims",
    form: "create-policy",
    reason:
      "Replacing the reader-note policies installs catalog metadata without reading rows, with DDL lock acquisition bounded by 1s and the statement by 5s.",
  },
  {
    migration: "20261025180000_search_history_entry_country",
    form: "add-column",
    reason:
      "The nullable, default-free country and country_used_at columns are catalog-only changes under a 1s lock_timeout; the index is built online.",
  },
  {
    migration: "20261021080000_reader_annotation_verification_claims",
    form: "row-level-security",
    reason:
      "FORCE ROW LEVEL SECURITY on reader notes changes only catalog flags; the owner paths it affects get their own policies in the same migration, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261021080000_reader_annotation_verification_claims",
    form: "create-trigger",
    reason:
      "The statement-level claim cleanup trigger installs metadata on the claims table without scanning rows, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261022130000_account_export_annotation_authorship",
    form: "create-policy",
    reason:
      "The account export owner policy adds catalog metadata to reader notes without reading rows, with DDL lock acquisition bounded by 1s and the statement by 5s.",
  },
  {
    migration: "20261026100000_account_email_undeliverable",
    form: "add-column",
    reason:
      "The three refusal columns are nullable and default-free, a catalog-only addition to user without a rewrite, under 1s lock_timeout and 5s statement_timeout.",
  },
  {
    migration: "20261026100000_account_email_undeliverable",
    form: "add-constraint",
    reason:
      "The refusal-shape CHECK is added NOT VALID without scanning existing users, under 1s lock_timeout and 5s statement_timeout; the online phase validates it after the schema lock is released.",
  },
];
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
    const reviewed = reviewedMigrationStatements(source);
    for (const {
      form,
      lockMode,
      line,
      statementIndex,
      sql,
      locksExistingRelation,
    } of census.forms) {
      counts.set(lockMode, (counts.get(lockMode) ?? 0) + 1);
      const key = `${migration}/${form}`;
      const historical = remaining.get(key) ?? 0;
      if (historical > 0) {
        remaining.set(key, historical - 1);
        continue;
      }
      if (!isWriterBlockingLock(lockMode) || !locksExistingRelation) {
        continue;
      }
      if (
        matchingMigrationGuardedRules(sql).some((rule) =>
          reviewed.get(statementIndex)?.has(rule),
        )
      ) {
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
        `${file}:${line}: ${lockMode} ${form} needs a reviewed safety acknowledgement or typed lock allowance with a reason; add { migration, form, reason } to MIGRATION_LOCK_ALLOWANCES in scripts/migration-lock-census.ts`,
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
