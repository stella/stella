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
// statement-form decision (for example, an additive expand/contract step). Each
// migration keeps its decisions in its own file, so concurrent migrations never
// edit a shared list: scripts/migration-lock-allowances/<migration>.json maps
// each DDL form to the reason it is safe.
export const MIGRATION_LOCK_ALLOWANCES_PATH =
  "scripts/migration-lock-allowances";
const MIGRATION_FOLDER_NAME = /^\d{14}_[a-z0-9_]+$/u;
const MINIMUM_ALLOWANCE_REASON_LENGTH = 12;

export const migrationLockAllowancePath = (migration: string) =>
  `${MIGRATION_LOCK_ALLOWANCES_PATH}/${migration}.json`;

export const parseMigrationLockAllowances = (
  file: string,
  content: unknown,
): { allowances: MigrationLockAllowance[]; errors: string[] } => {
  const migration =
    file
      .split("/")
      .at(-1)
      ?.replace(/\.json$/u, "") ?? "";
  if (!file.endsWith(".json") || !MIGRATION_FOLDER_NAME.test(migration)) {
    return {
      allowances: [],
      errors: [
        `${file}: name the file after its migration folder, <YYYYMMDDHHMMSS>_<name>.json`,
      ],
    };
  }
  if (
    typeof content !== "object" ||
    content === null ||
    Array.isArray(content) ||
    Object.keys(content).length === 0
  ) {
    return {
      allowances: [],
      errors: [
        `${file}: expected a non-empty object mapping each DDL form to its reason`,
      ],
    };
  }
  const allowances: MigrationLockAllowance[] = [];
  const errors: string[] = [];
  for (const [form, reason] of Object.entries(content)) {
    if (!isDdlForm(form)) {
      errors.push(`${file}: ${form} is not a census DDL form`);
    } else if (
      typeof reason !== "string" ||
      reason.trim().length < MINIMUM_ALLOWANCE_REASON_LENGTH
    ) {
      errors.push(
        `${file}: ${form} needs a reason of at least ${String(MINIMUM_ALLOWANCE_REASON_LENGTH)} characters`,
      );
    } else {
      allowances.push({ migration, form, reason });
    }
  }
  return { allowances, errors };
};
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
  // No allowances is the strict default: every new strong lock is reported.
  allowances = [],
}: CheckMigrationLocksOptions) => {
  const errors: string[] = [];
  const migrationFolders = new Set(
    sources.map(({ file }) => migrationFolder(file)),
  );
  for (const migration of new Set(allowances.map((entry) => entry.migration))) {
    if (!migrationFolders.has(migration)) {
      errors.push(
        `${migrationLockAllowancePath(migration)}: orphan allowance; expected migration folder apps/api/drizzle/${migration}`,
      );
    }
  }
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
            entry.reason.trim().length >= MINIMUM_ALLOWANCE_REASON_LENGTH,
        )
      ) {
        continue;
      }
      errors.push(
        `${file}:${line}: ${lockMode} ${form} needs a reviewed safety acknowledgement or typed lock allowance with a reason; add "${form}": "<reason>" to ${migrationLockAllowancePath(migration)}`,
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
