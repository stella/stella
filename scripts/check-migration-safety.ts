#!/usr/bin/env bun

// Lints migration SQL for operations that need an explicit reviewed
// acknowledgement (destructive changes, bulk backfills, access-control changes)
// and for structural invariants that are never allowed. Lock safety
// (concurrent indexes, NOT VALID, transaction nesting) is owned by squawk; see
// .squawk.toml.
//
// Acknowledgements are statement-scoped and rule-scoped. The comment must sit
// in the comment block directly above the statement it clears:
//
//   -- stella-migration-safety: reviewed drop-object - <why this is safe>
//
// An acknowledgement that clears nothing, names an unknown rule, or carries a
// reason shorter than MIN_ACKNOWLEDGEMENT_REASON_LENGTH is itself an error.

import { panic } from "better-result";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import { createSha256 } from "@stll/sha256/node";

import { CODE_OWNED_TABLES } from "../apps/api/src/db/code-owned-tables";
import { HIGH_VOLUME_TABLES } from "../apps/api/src/db/high-volume-tables";
// Statement hashes pin historical index work without exempting a whole file.
// The corpus test requires exact findings and forbids additions to this snapshot.
import indexFindingsSnapshot from "./migration-index-findings.json" with { type: "json" };
import type { MigrationSafetyRuleId } from "./migration-safety-rule-ids";

type Statement = {
  line: number;
  identifiers: { index: number; name: string }[];
  literals: { index: number; end: number; value: string }[];
  executableIndexHint?: boolean;
  // Comment, string, and identifier content masked to spaces so keyword scans
  // cannot be fooled by literals.
  text: string;
  // Unmasked text from the first token of the statement. Object-name readers
  // pair this view with masked keyword offsets to exclude comments/literals.
  raw: string;
  // Surfaced from a stored-routine (CREATE FUNCTION/PROCEDURE) body: the body is
  // stored, not executed during the migration, so rules that judge migration
  // time effects must not fire on it. DO blocks execute immediately and are not
  // deferred.
  deferred?: boolean;
  // Start line of the outermost statement whose dollar-quoted body surfaced
  // this one. An acknowledgement above that statement also covers this one.
  enclosingLine?: number;
};

type GuardedCategory = (typeof GUARDED_CATEGORIES)[number];

type GuardedRule = {
  id: MigrationSafetyRuleId;
  description: string;
  category: GuardedCategory;
  pattern?: RegExp;
  matches?: (statement: string) => boolean;
};

// Never acknowledgeable: the statement has to be rewritten.
type StatementInvariantRule = {
  id: MigrationSafetyRuleId;
  description: string;
  matches: (statement: Statement) => boolean;
  guidance: string;
};

type FileInvariantRule = {
  id: MigrationSafetyRuleId;
  description: string;
  matches: (statements: Statement[]) => boolean;
  guidance: string;
};

type Finding = {
  file: string;
  line: number;
  ruleId: string;
  description: string;
  guidance?: string;
  statementHash?: string;
};

type Acknowledgement = {
  line: number;
  ruleIds: string[];
  reason: string;
  usedRuleIds: Set<string>;
};

type SingleQuoteScanInput = {
  char: string;
  nextChar: string;
  current: string;
  line: number;
  singleQuoteAllowsBackslashEscapes: boolean;
};

type SingleQuoteScanResult = {
  current: string;
  line: number;
  skipNextCharacter: boolean;
  state: "normal" | "single-quote";
  singleQuoteAllowsBackslashEscapes: boolean;
};

const GUARDED_CATEGORIES = [
  "destructive-change",
  "bulk-backfill",
  "access-control",
] as const;

const GUARDED_CATEGORY_GUIDANCE = {
  "destructive-change":
    "Confirm the operation is safe for every running API task and how rollback is handled.",
  "bulk-backfill":
    "Migrations should be fast, additive DDL. Move bulk or idempotent backfills to an out-of-band batched script (see the pattern in apps/api/src/scripts/backfill-case-law-slugs.ts), or add a bounded WHERE clause.",
  "access-control":
    "Privilege, ownership, and policy changes widen or shift data access. Confirm least privilege and workspace isolation are preserved.",
} as const satisfies Record<GuardedCategory, string>;

const ACKNOWLEDGEMENT_MARKER_PATTERN =
  /^\s*--\s*stella-migration-safety:\s*reviewed\b(?<rest>.*)$/iu;
// `<ids> - <reason>`: ids and reason split at the first ` - ` (whitespace,
// hyphen, whitespace), ids validated one by one.
const ACKNOWLEDGEMENT_SEPARATOR_PATTERN = /\s-\s/u;
const RULE_ID_PATTERN = /^[a-z][a-z0-9-]*$/iu;
const LINE_COMMENT_PATTERN = /^\s*--/u;
const MIN_ACKNOWLEDGEMENT_REASON_LENGTH = 12;

const DEFAULT_MIGRATIONS_DIR = "apps/api/drizzle";
// Migrations applied before the current rule set. Shared with squawk via
// scripts/check-migrations.sh. Entries are immutable migrations, so the list
// only shrinks (scripts/check-migration-baseline.ts); a listed file that no
// longer exists is an error.
const BASELINE_FILE = "scripts/migration-baseline.txt";

const ALTER_TABLE_PATTERN = /\bALTER\s+TABLE\b/iu;
const ALTER_COLUMN_TYPE_PATTERN =
  /\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
const DO_BLOCK_DOLLAR_QUOTE_PREFIX_PATTERN = /\bDO(?:\s+LANGUAGE\s+\S+)?\s*$/iu;
const ROUTINE_DOLLAR_QUOTE_PREFIX_PATTERN =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b[\s\S]*\b(?:AS|IS)\s*$/iu;
const LOCK_TIMEOUT_PATTERN =
  /^\s*SET\s+(?:LOCAL\s+|SESSION\s+)?lock_timeout\b/iu;
const STATEMENT_TIMEOUT_PATTERN =
  /^\s*SET\s+(?:LOCAL\s+|SESSION\s+)?statement_timeout\b/iu;
const WHERE_TAUTOLOGY_PATTERN =
  /^\s*(?:TRUE|1\s*=\s*1)\s*(?:$|;|\)|RETURNING\b)/iu;

const GRANT_PRIVILEGE_KEYWORDS =
  "SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|USAGE|EXECUTE|CREATE|CONNECT|TEMP|TEMPORARY|MAINTAIN|SET|ALTER";
const BROAD_GRANT_PATTERNS = [
  /^\s*GRANT\b[\s\S]*\bTO\s+PUBLIC\b/iu,
  /^\s*GRANT\s+ALL\b/iu,
  /^\s*GRANT\b[\s\S]*\bWITH\s+GRANT\s+OPTION\b/iu,
  // Role membership: the word after GRANT is a role, not a privilege. A quoted
  // role is masked to spaces, which the lookahead treats the same way.
  new RegExp(
    `^\\s*GRANT\\s+(?!(?:${GRANT_PRIVILEGE_KEYWORDS})\\b)[^;]*?\\bTO\\b`,
    "iu",
  ),
  /\bALTER\s+DEFAULT\s+PRIVILEGES\b/iu,
];
const CREATE_POLICY_PATTERN = /\bCREATE\s+POLICY\b/iu;
const POLICY_PREDICATE_PATTERN = /\b(?:USING|WITH\s+CHECK)\s*\(/iu;
const POLICY_TRUE_PREDICATE_PATTERN =
  /\b(?:USING|WITH\s+CHECK)\s*\(\s*TRUE\s*\)/iu;
// A policy with no USING and no WITH CHECK permits every row, the same as an
// explicit `USING (true)`.
const isUnconditionalPolicy = (statement: string): boolean =>
  CREATE_POLICY_PATTERN.test(statement) &&
  (POLICY_TRUE_PREDICATE_PATTERN.test(statement) ||
    !POLICY_PREDICATE_PATTERN.test(statement));
// `TO` cannot occur in a policy header except as the role clause, so its
// presence before the predicate is enough even when the role name is a masked
// quoted identifier.
const POLICY_ROLE_CLAUSE_PATTERN =
  /\bCREATE\s+POLICY\b[\s\S]*?\bTO\b[\s\S]*?\b(?:USING|WITH\s+CHECK)\b/iu;
const POLICY_PUBLIC_ROLE_PATTERN =
  /\bCREATE\s+POLICY\b[\s\S]*\bTO\s+(?:[^,\s]+\s*,\s*)*PUBLIC\b/iu;

// Object names are read from the unmasked statement, anchored to its first
// token so a comment or literal later in the statement cannot supply one.
const DROP_INDEX_NAME_PATTERN =
  /^\s*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?<name>"[^"]+"|[\w.]+)/iu;
const CREATE_INDEX_NAME_PATTERN =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?<name>"[^"]+"|[\w.]+)/iu;

const IDENTIFIER_CHARACTER_PATTERN = /[A-Za-z0-9_]/u;
const IDENTIFIER_WORD_PATTERN = /^[A-Za-z0-9_]+/u;
const UPDATE_KEYWORD = "UPDATE";
const SET_KEYWORD = "SET";
const WHERE_KEYWORD = "WHERE";
const RETURNING_KEYWORD = "RETURNING";

// Keywords whose immediately following UPDATE is a clause, not an executable
// statement: row locks (`FOR UPDATE`), trigger timing (`BEFORE`/`AFTER`/
// `INSTEAD OF UPDATE`), FK actions (`ON UPDATE`), and upsert actions (`DO
// UPDATE`). None rewrite table data, so the UPDATE token after them is skipped.
const UPDATE_CLAUSE_PREFIXES = new Set([
  "FOR",
  "BEFORE",
  "AFTER",
  "OF",
  "ON",
  "DO",
]);

type DepthWord = { word: string; index: number; depth: number };

// Every identifier-like word in a masked statement with its parenthesis depth.
const wordsWithDepth = (statement: string): DepthWord[] => {
  const words: DepthWord[] = [];
  let depth = 0;

  for (let index = 0; index < statement.length; index++) {
    const char = statement[index] ?? "";

    if (char === "(") {
      depth++;
      continue;
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    const isWordStart =
      IDENTIFIER_CHARACTER_PATTERN.test(char) &&
      !IDENTIFIER_CHARACTER_PATTERN.test(statement[index - 1] ?? "");
    if (!isWordStart) {
      continue;
    }

    const word = (
      IDENTIFIER_WORD_PATTERN.exec(statement.slice(index))?.[0] ?? ""
    ).toUpperCase();
    words.push({ word, index, depth });
  }

  return words;
};

// Scan an executable UPDATE found at `updateIndex` (parenthesis depth
// `baseDepth`) for a WHERE bounding it at that same depth. The update's clause
// runs until its enclosing parenthesis closes, a top-level `;`, `RETURNING`, or
// end of text. A WHERE living only inside a SET subquery sits one level deeper,
// so it does not bound the update and the row set stays the whole table. A
// WHERE whose whole predicate is a tautology (`WHERE true`, `WHERE 1 = 1`) does
// not bound it either. Returns true only when the statement is a real
// `UPDATE ... SET` with no bounding WHERE.
const isUnboundedUpdateAt = (
  statement: string,
  updateIndex: number,
  baseDepth: number,
): boolean => {
  let depth = baseDepth;
  let sawSet = false;

  for (
    let index = updateIndex + UPDATE_KEYWORD.length;
    index < statement.length;
    index++
  ) {
    const char = statement[index] ?? "";

    if (char === "(") {
      depth++;
      continue;
    }

    if (char === ")") {
      depth--;
      // Left the parenthesised context holding this UPDATE (e.g. a CTE body).
      if (depth < baseDepth) {
        break;
      }
      continue;
    }

    if (char === ";" && depth === baseDepth) {
      break;
    }

    const isWordStart =
      depth === baseDepth &&
      IDENTIFIER_CHARACTER_PATTERN.test(char) &&
      !IDENTIFIER_CHARACTER_PATTERN.test(statement[index - 1] ?? "");
    if (!isWordStart) {
      continue;
    }

    const word = (
      IDENTIFIER_WORD_PATTERN.exec(statement.slice(index))?.[0] ?? ""
    ).toUpperCase();

    if (word === SET_KEYWORD) {
      sawSet = true;
      continue;
    }
    if (word === RETURNING_KEYWORD) {
      break;
    }
    if (word === WHERE_KEYWORD && sawSet) {
      return WHERE_TAUTOLOGY_PATTERN.test(
        statement.slice(index + WHERE_KEYWORD.length),
      );
    }
  }

  return sawSet;
};

// True when the statement executes an UPDATE that rewrites every row. Catches
// top-level backfills, data-modifying CTEs (`WITH u AS (UPDATE ... RETURNING
// ...) ...`), and DO/function bodies (parseStatements surfaces their inner
// statements). `FOR`/`BEFORE`/`AFTER`/`OF`/`ON`/`DO UPDATE` clauses and `INSERT
// ... ON CONFLICT DO UPDATE` upserts are not executable updates and are skipped.
const isUnboundedUpdate = (statement: string): boolean => {
  let previousWord = "";

  for (const { word, index, depth } of wordsWithDepth(statement)) {
    if (
      word === UPDATE_KEYWORD &&
      !UPDATE_CLAUSE_PREFIXES.has(previousWord) &&
      isUnboundedUpdateAt(statement, index, depth)
    ) {
      return true;
    }

    previousWord = word;
  }

  return false;
};

// True when an INSERT copies rows out of another relation: a SELECT with a
// FROM at the INSERT's own parenthesis depth. A seed row written as
// `INSERT ... SELECT 'x' WHERE NOT EXISTS (SELECT 1 FROM ...)` keeps its FROM
// one level deeper and is not a backfill.
const isInsertFromQuery = (statement: string): boolean => {
  const words = wordsWithDepth(statement);

  for (let index = 0; index < words.length; index++) {
    const insert = words[index];
    if (
      insert?.word !== "INSERT" ||
      words[index + 1]?.word !== "INTO" ||
      words[index + 1]?.depth !== insert.depth
    ) {
      continue;
    }

    let sawSelect = false;

    for (let next = index + 2; next < words.length; next++) {
      const candidate = words[next];
      if (!candidate || candidate.depth < insert.depth) {
        break;
      }
      if (candidate.depth !== insert.depth) {
        continue;
      }
      if (candidate.word === "ON" || candidate.word === RETURNING_KEYWORD) {
        break;
      }
      if (candidate.word === "SELECT") {
        sawSelect = true;
        continue;
      }
      if (candidate.word === "FROM" && sawSelect) {
        return true;
      }
    }
  }

  return false;
};

const CREATE_TABLE_PATTERN =
  /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\b/iu;
const TABLE_AS_QUERY_PATTERN =
  /\bAS\s*(?:\(\s*)?(?:SELECT|WITH|TABLE|VALUES|EXECUTE)\b/iu;

// `CREATE TABLE name AS <query>`: the AS query comes before any column list
// parenthesis. A plain `CREATE TABLE name (...)` has its first `(` first.
const isCreateTableAsQuery = (statement: string): boolean => {
  const create = CREATE_TABLE_PATTERN.exec(statement);
  if (!create) {
    return false;
  }

  const rest = statement.slice(create.index + create[0].length);
  const asQuery = TABLE_AS_QUERY_PATTERN.exec(rest);
  if (!asQuery) {
    return false;
  }

  const firstParenthesis = rest.indexOf("(");
  return firstParenthesis === -1 || asQuery.index < firstParenthesis;
};

const GUARDED_RULES = [
  {
    id: "drop-object",
    description: "drops a database object",
    category: "destructive-change",
    pattern:
      /\bDROP\s+(?:DATABASE|DOMAIN|EXTENSION|FUNCTION|INDEX|MATERIALIZED\s+VIEW|OWNED|POLICY|PROCEDURE|ROLE|RULE|SCHEMA|SEQUENCE|TABLE|TRIGGER|TYPE|VIEW)\b/iu,
  },
  {
    id: "drop-column",
    description: "drops a table column",
    category: "destructive-change",
    pattern:
      /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(?!(?:CONSTRAINT|DEFAULT|EXPRESSION|IDENTITY|NOT\s+NULL)\b)\S+/iu,
  },
  {
    id: "drop-column-identity",
    description: "drops a column's identity or generated expression",
    category: "destructive-change",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?:EXPRESSION|IDENTITY)\b/iu,
  },
  {
    id: "drop-constraint",
    description: "drops a table constraint",
    category: "destructive-change",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+CONSTRAINT\b/iu,
  },
  {
    id: "rename-table-or-column",
    description: "renames a table or column",
    category: "destructive-change",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/iu,
  },
  {
    id: "rename-enum-value",
    description: "renames an enum value",
    category: "destructive-change",
    pattern: /\bALTER\s+TYPE\b[\s\S]*\bRENAME\s+VALUE\b/iu,
  },
  {
    id: "alter-column-type",
    description: "changes a column type",
    category: "destructive-change",
    matches: (statement) =>
      ALTER_TABLE_PATTERN.test(statement) &&
      ALTER_COLUMN_TYPE_PATTERN.test(statement),
  },
  {
    id: "truncate-table",
    description: "truncates table data",
    category: "destructive-change",
    pattern: /\bTRUNCATE\b/iu,
  },
  {
    id: "delete-data",
    description: "deletes table data",
    category: "destructive-change",
    pattern: /\bDELETE\s+FROM\b/iu,
  },
  {
    id: "set-unlogged",
    description: "makes a table unlogged (data is lost on crash recovery)",
    category: "destructive-change",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bSET\s+UNLOGGED\b/iu,
  },
  {
    id: "disable-trigger",
    description: "disables triggers (skips FK, audit, or sync enforcement)",
    category: "destructive-change",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDISABLE\s+TRIGGER\b/iu,
  },
  {
    id: "unbounded-update",
    description: "runs a full-table UPDATE with no bounding WHERE clause",
    category: "bulk-backfill",
    matches: isUnboundedUpdate,
  },
  {
    id: "insert-select",
    description:
      "copies rows from another relation (INSERT ... SELECT ... FROM)",
    category: "bulk-backfill",
    matches: isInsertFromQuery,
  },
  {
    id: "merge",
    description: "runs a MERGE statement",
    category: "bulk-backfill",
    pattern: /\bMERGE\s+INTO\b/iu,
  },
  {
    id: "create-table-as",
    description: "materialises a query into a new table (CREATE TABLE AS)",
    category: "bulk-backfill",
    matches: isCreateTableAsQuery,
  },
  {
    id: "materialized-view-populate",
    description: "populates a materialized view during the migration",
    category: "bulk-backfill",
    matches: (statement) =>
      /\bREFRESH\s+MATERIALIZED\s+VIEW\b/iu.test(statement) ||
      (/\bCREATE\s+MATERIALIZED\s+VIEW\b/iu.test(statement) &&
        !/\bWITH\s+NO\s+DATA\b/iu.test(statement)),
  },
  {
    id: "recursive-cte",
    description: "uses a recursive CTE (WITH RECURSIVE)",
    category: "bulk-backfill",
    pattern: /\bWITH\s+RECURSIVE\b/iu,
  },
  {
    id: "disable-row-level-security",
    description: "disables or stops forcing row-level security",
    category: "access-control",
    pattern:
      /\bALTER\s+TABLE\b[\s\S]*\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/iu,
  },
  {
    // Routine grants of table privileges to a named service role are the
    // house pattern for every new table and are not flagged. Broad grants are:
    // to PUBLIC, of ALL, WITH GRANT OPTION, role membership, or defaults that
    // apply to objects created later.
    id: "grant-privileges",
    description:
      "grants broad privileges (PUBLIC, ALL, GRANT OPTION, role membership, or default privileges)",
    category: "access-control",
    matches: (statement) =>
      BROAD_GRANT_PATTERNS.some((pattern) => pattern.test(statement)),
  },
  {
    id: "alter-policy",
    description: "alters a row-level security policy",
    category: "access-control",
    pattern: /\bALTER\s+POLICY\b/iu,
  },
  {
    // A `USING (true)` policy scoped `TO <role>` is how global (non-tenant)
    // tables expose themselves to a specific service role. The same predicate
    // with no role clause, or `TO PUBLIC`, disables row-level security for
    // everyone.
    id: "permissive-policy",
    description:
      "creates an unconditionally true policy that is not restricted to a named role",
    category: "access-control",
    matches: (statement) =>
      isUnconditionalPolicy(statement) &&
      (!POLICY_ROLE_CLAUSE_PATTERN.test(statement) ||
        POLICY_PUBLIC_ROLE_PATTERN.test(statement)),
  },
  {
    id: "security-definer",
    description: "defines a SECURITY DEFINER routine",
    category: "access-control",
    pattern: /\bSECURITY\s+DEFINER\b/iu,
  },
  {
    id: "change-owner",
    description: "changes an object's owner",
    category: "access-control",
    pattern: /\bOWNER\s+TO\b/iu,
  },
  {
    id: "set-schema",
    description: "moves an object to another schema",
    category: "access-control",
    pattern: /\bSET\s+SCHEMA\b/iu,
  },
] satisfies GuardedRule[];

const HIGH_VOLUME_TABLE_NAMES = new Set<string>(HIGH_VOLUME_TABLES);
const HIGH_VOLUME_INDEX_BUILD_RULE_ID =
  "high-volume-index-build" satisfies MigrationSafetyRuleId;

const DML_VERBS = ["INSERT", "UPDATE", "DELETE", "MERGE"] as const;
type DmlVerb = (typeof DML_VERBS)[number];

// The keyword between a DML verb and its target relation; UPDATE takes none.
const DML_TARGET_KEYWORDS = {
  INSERT: "into",
  UPDATE: undefined,
  DELETE: "from",
  MERGE: "into",
} as const satisfies Record<DmlVerb, string | undefined>;

const DML_VERB_BY_TOKEN = new Map<string, DmlVerb>(
  DML_VERBS.map((verb) => [verb.toLowerCase(), verb]),
);

type DmlTarget = { verb: DmlVerb; table: string };

// The relations a statement writes rows of when the migration runs, read from
// the token stream: comments and string literals are masked there and quoted
// identifiers are tokens of their own, so no keyword or name inside a comment
// or literal counts, and a comment between tokens (`INSERT /* x */ INTO`) is
// plain whitespace. A relation outside the public schema is none of the
// registered tables. A stored-routine body executes nothing at migration
// time, and an UPDATE after a clause keyword (`FOR UPDATE`, `DO UPDATE`) is
// not a statement of its own.
const executedDmlTargets = (statement: Statement): DmlTarget[] => {
  if (statement.deferred) {
    return [];
  }

  const tokens = indexTokens(statement);
  const targets: DmlTarget[] = [];

  for (const [position, token] of tokens.entries()) {
    const verb =
      token.kind === "word" ? DML_VERB_BY_TOKEN.get(token.value) : undefined;
    if (verb === undefined) {
      continue;
    }

    const previous = tokens[position - 1];
    if (
      verb === UPDATE_KEYWORD &&
      previous?.kind === "word" &&
      UPDATE_CLAUSE_PREFIXES.has(previous.value.toUpperCase())
    ) {
      continue;
    }

    let next = position + 1;
    const keyword = DML_TARGET_KEYWORDS[verb];
    if (keyword !== undefined) {
      if (!isIndexKeyword(tokens[next], keyword)) {
        continue;
      }
      next++;
    }
    if (isIndexKeyword(tokens[next], "only")) {
      next++;
    }

    const relation = readIndexRelation(tokens, next)?.relation;
    if (relation?.schema.toLowerCase() !== "public") {
      continue;
    }

    targets.push({ verb, table: relation.name.toLowerCase() });
  }

  return targets;
};

// True when the statement rewrites rows of a registered high-volume table. An
// INSERT counts only when it copies rows out of another relation.
const isHighVolumeTableDml = (statement: Statement): boolean =>
  executedDmlTargets(statement).some(
    ({ verb, table }) =>
      HIGH_VOLUME_TABLE_NAMES.has(table) &&
      (verb !== "INSERT" || isInsertFromQuery(statement.text)),
  );

const CODE_OWNED_TABLE_NAMES = new Set<string>(CODE_OWNED_TABLES);

// DELETE stays allowed: removing a row the code no longer declares, or one an
// older migration seeded, converges every database on the code's state.
const isCodeOwnedTableWrite = (statement: Statement): boolean =>
  executedDmlTargets(statement).some(
    ({ verb, table }) => verb !== "DELETE" && CODE_OWNED_TABLE_NAMES.has(table),
  );

// Calls whose result depends on when, or by which draw, the statement runs.
// Matched against masked text, so a quoted identifier, string literal or
// comment never matches; the SQL-standard datetime keywords take no
// parentheses.
const VOLATILE_VALUE_PATTERN =
  /\b(?:(?:now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday|random|gen_random_uuid|uuid_generate_v1|uuid_generate_v1mc|uuid_generate_v4|uuidv4|uuidv7)\s*\(|(?:current_timestamp|current_time|current_date|localtimestamp|localtime)\b)/iu;

// A row written from the clock or a random draw differs between a database
// that ran the migration at deploy time and one migrated from scratch later,
// so the clean and upgraded catalogs never converge. Column DEFAULTs in DDL
// are not writes and stay allowed; DELETE writes no value.
const isVolatileDataWrite = (statement: Statement): boolean =>
  VOLATILE_VALUE_PATTERN.test(statement.text) &&
  executedDmlTargets(statement).some(({ verb }) => verb !== "DELETE");

const STATEMENT_INVARIANT_RULES = [
  {
    id: "on-conflict-column-target",
    description: "uses a column-target ON CONFLICT clause",
    matches: ({ text }) => /\bON\s+CONFLICT\s*\([^)]*\)/iu.test(text),
    guidance:
      "Use ON CONFLICT ON CONSTRAINT for a named table constraint, or use WHERE NOT EXISTS when the arbiter is a partial unique index.",
  },
  {
    id: "code-owned-table-write",
    description: "inserts or updates rows of a table the application code owns",
    matches: isCodeOwnedTableWrite,
    guidance: `The application writes these rows from its own declarations at boot, so a migration copy drifts from what the code declares and from a database migrated at another time. Declare the row in code (scheduler jobs: DECLARED_SCHEDULER_JOBS in apps/api/src/lib/scheduler/jobs.ts); a migration may only DELETE rows the code no longer owns. Registered tables: ${CODE_OWNED_TABLES.join(", ")}.`,
  },
  {
    id: "volatile-data-write",
    description:
      "writes rows from the clock or a random draw (now(), current_timestamp, random(), gen_random_uuid(), ...)",
    matches: isVolatileDataWrite,
    guidance:
      'A database migrated at deploy time and one migrated from scratch later then hold different rows. Seed literal values; for a column whose own DEFAULT is volatile (an id, a created_at), omit it or write DEFAULT (INSERT ... DEFAULT, UPDATE ... SET "updated_at" = DEFAULT), which the migration catalog comparison already excludes; or write the row from application code.',
  },
  {
    id: "high-volume-table-dml",
    description:
      "rewrites rows of a high-volume table inside the migration transaction",
    matches: isHighVolumeTableDml,
    guidance: `The table holds millions of rows in production and the statement runs under the migration's statement budget whatever its WHERE clause matches. Keep the migration to DDL and register the data repair as an online repair in apps/api/src/db/online-migrations.ts (bounded batches over an indexed access path, resumable, validated on completion). Registered tables: ${HIGH_VOLUME_TABLES.join(", ")}.`,
  },
] satisfies StatementInvariantRule[];

const STATEMENT_INVARIANT_RULE_IDS = new Set<string>([
  ...STATEMENT_INVARIANT_RULES.map((rule) => rule.id),
  HIGH_VOLUME_INDEX_BUILD_RULE_ID,
]);

// Statements allowed before the timeouts are set: only other SET commands. The
// timeouts must precede the first migration operation, or that operation runs
// without them.
const SET_STATEMENT_PATTERN = /^\s*SET\b/iu;

const isTimeoutSetBeforeFirstOperation = (
  statements: Statement[],
  timeoutPattern: RegExp,
): boolean => {
  for (const statement of statements) {
    if (timeoutPattern.test(statement.text)) {
      return true;
    }
    if (!SET_STATEMENT_PATTERN.test(statement.text)) {
      return false;
    }
  }

  return false;
};

const FILE_INVARIANT_RULES = [
  {
    id: "missing-lock-timeout",
    description:
      "does not set lock_timeout before the first migration operation",
    matches: (statements) =>
      !isTimeoutSetBeforeFirstOperation(statements, LOCK_TIMEOUT_PATTERN),
    guidance:
      "Start the migration with SET LOCAL lock_timeout = '<short>'; so a blocked DDL lock fails fast instead of queueing behind live traffic.",
  },
  {
    id: "missing-statement-timeout",
    description:
      "does not set statement_timeout before the first migration operation",
    matches: (statements) =>
      !isTimeoutSetBeforeFirstOperation(statements, STATEMENT_TIMEOUT_PATTERN),
    guidance:
      "Start the migration with SET LOCAL statement_timeout = '<bound>'; so a slow statement cannot hold locks indefinitely.",
  },
] satisfies FileInvariantRule[];

// Every id in MIGRATION_SAFETY_RULE_IDS names a rule defined above.
type DefinedRuleId =
  | (typeof GUARDED_RULES)[number]["id"]
  | (typeof STATEMENT_INVARIANT_RULES)[number]["id"]
  | (typeof FILE_INVARIANT_RULES)[number]["id"]
  | typeof HIGH_VOLUME_INDEX_BUILD_RULE_ID;
true satisfies [Exclude<MigrationSafetyRuleId, DefinedRuleId>] extends [never]
  ? true
  : never;

const KNOWN_RULE_IDS = new Set<string>(GUARDED_RULES.map((rule) => rule.id));

const usage = () => {
  console.error(
    "Usage: bun scripts/check-migration-safety.ts [apps/api/drizzle/<migration>/migration.sql ...]",
  );
};

const toRepoPath = (file: string): string =>
  repoRelativePath(
    process.cwd(),
    existsSync(file) ? realpathSync(file) : path.resolve(file),
  )
    .split(path.sep)
    .join("/");

const readBaseline = (): Set<string> => {
  if (!existsSync(BASELINE_FILE)) {
    console.error(`ERROR: ${BASELINE_FILE} is missing.`);
    process.exit(1);
  }

  return new Set(
    readFileSync(BASELINE_FILE, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
};

// Emit a GitHub Actions annotation so the finding renders inline on the PR
// diff. Message must stay single-line (newlines would need %0A escaping).
const annotate = ({ file, line, ruleId, description }: Finding) => {
  if (process.env["GITHUB_ACTIONS"] !== "true") {
    return;
  }

  console.log(
    `::error file=${toRepoPath(file)},line=${line},title=${ruleId}::${description}`,
  );
};

const isWhitespaceOnly = (value: string): boolean => value.trim().length === 0;

const appendMasked = (value: string): string => (value === "\n" ? "\n" : " ");

const maskText = (value: string): string => value.replace(/[^\n]/gu, " ");

const countNewlines = (value: string): number =>
  value.match(/\n/gu)?.length ?? 0;

const isIdentifierCharacter = (value: string): boolean =>
  /[A-Za-z0-9_$]/u.test(value);

const hasEscapeStringPrefix = (source: string, quoteIndex: number): boolean => {
  const prefix = source[quoteIndex - 1] ?? "";
  const beforePrefix = source[quoteIndex - 2] ?? "";

  return (
    (prefix === "E" || prefix === "e") && !isIdentifierCharacter(beforePrefix)
  );
};

const readDollarQuoteTag = (source: string, index: number): string | null => {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(source.slice(index));

  return match?.[0] ?? null;
};

const shouldScanDollarQuoteBody = (statementPrefix: string): boolean =>
  DO_BLOCK_DOLLAR_QUOTE_PREFIX_PATTERN.test(statementPrefix) ||
  ROUTINE_DOLLAR_QUOTE_PREFIX_PATTERN.test(statementPrefix);

const consumeSingleQuotedCharacter = ({
  char,
  nextChar,
  current,
  line,
  singleQuoteAllowsBackslashEscapes,
}: SingleQuoteScanInput): SingleQuoteScanResult => {
  let nextCurrent = current;
  let nextLine = line;
  let skipNextCharacter = false;
  let nextState: "normal" | "single-quote" = "single-quote";
  let nextAllowsBackslashEscapes = singleQuoteAllowsBackslashEscapes;

  if (char === "\n") {
    nextLine++;
  }

  nextCurrent += appendMasked(char);

  if (singleQuoteAllowsBackslashEscapes && char === "\\" && nextChar) {
    if (nextChar === "\n") {
      nextLine++;
    }

    nextCurrent += appendMasked(nextChar);
    skipNextCharacter = true;

    return {
      current: nextCurrent,
      line: nextLine,
      skipNextCharacter,
      state: nextState,
      singleQuoteAllowsBackslashEscapes: nextAllowsBackslashEscapes,
    };
  }

  if (char === "'" && nextChar === "'") {
    nextCurrent += " ";
    skipNextCharacter = true;

    return {
      current: nextCurrent,
      line: nextLine,
      skipNextCharacter,
      state: nextState,
      singleQuoteAllowsBackslashEscapes: nextAllowsBackslashEscapes,
    };
  }

  if (char === "'") {
    nextAllowsBackslashEscapes = false;
    nextState = "normal";
  }

  return {
    current: nextCurrent,
    line: nextLine,
    skipNextCharacter,
    state: nextState,
    singleQuoteAllowsBackslashEscapes: nextAllowsBackslashEscapes,
  };
};

// PostgreSQL E strings support escaped characters and numeric byte/codepoint forms.
const decodeEscapeString = (value: string): string =>
  value.replace(
    /\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|[\s\S])/gu,
    (_match, escape: string) => {
      if (/^[Uux]/u.test(escape)) {
        return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
      }
      if (/^[0-7]/u.test(escape)) {
        return String.fromCodePoint(Number.parseInt(escape, 8));
      }
      switch (escape) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "b":
          return "\b";
        case "f":
          return "\f";
        default:
          return escape;
      }
    },
  );

const decodeSingleQuotedLiteral = (value: string, escaped: boolean): string => {
  const unquoted = value.replace(/''/gu, "'");
  return escaped ? decodeEscapeString(unquoted) : unquoted;
};

type QuotedBodyOptions = {
  prefix: string;
  body: string;
  startLine: number;
  enclosingLine: number;
};

const INDEX_BUILD_HINT_PATTERN =
  /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|REINDEX|ALTER\s+TABLE[\s\S]*?\bADD\b[\s\S]*?\b(?:PRIMARY\s+KEY|UNIQUE|EXCLUDE))\b/iu;

const surfaceQuotedBody = ({
  prefix,
  body,
  startLine,
  enclosingLine,
}: QuotedBodyOptions): Statement[] => {
  if (!shouldScanDollarQuoteBody(prefix)) {
    return [];
  }
  // DO executes now; routine definitions are deferred, including nested bodies.
  const deferred = !DO_BLOCK_DOLLAR_QUOTE_PREFIX_PATTERN.test(prefix);
  const bodyStatements = parseStatements(body);
  const literalFragments = bodyStatements.flatMap(({ literals }) =>
    literals.map(({ value }) => value),
  );
  const executableIndexHint = INDEX_BUILD_HINT_PATTERN.test(
    literalFragments.join(" "),
  );
  return bodyStatements.map((statement) => {
    statement.line += startLine - 1;
    statement.enclosingLine = enclosingLine;
    if (executableIndexHint) {
      statement.executableIndexHint = true;
    }
    if (deferred) {
      statement.deferred = true;
    }
    return statement;
  });
};

const parseStatements = (source: string): Statement[] => {
  const statements: Statement[] = [];
  let current = "";
  let identifiers: Statement["identifiers"] = [];
  let literals: Statement["literals"] = [];
  let literalStart = 0;
  let literalSourceStart = 0;
  let literalEscaped = false;
  let literalLine = 1;
  let identifierStart = 0;
  let identifierSourceStart = 0;
  let currentLine = 1;
  let currentStart = 0;
  let line = 1;
  let blockCommentDepth = 0;
  let singleQuoteAllowsBackslashEscapes = false;
  let state:
    | "normal"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote" = "normal";

  const pushCurrent = (endIndex: number) => {
    if (isWhitespaceOnly(current)) {
      current = "";
      currentLine = line;
      return;
    }

    statements.push({
      line: currentLine,
      text: current,
      raw: source.slice(currentStart, endIndex),
      identifiers,
      literals,
    });
    current = "";
    identifiers = [];
    literals = [];
    currentLine = line;
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    const nextChar = source[index + 1] ?? "";

    if (state === "line-comment") {
      if (char === "\n") {
        line++;
        current += "\n";
        state = "normal";
        continue;
      }

      current += " ";
      continue;
    }

    if (state === "block-comment") {
      if (char === "/" && nextChar === "*") {
        blockCommentDepth++;
        current += "  ";
        index++;
        continue;
      }

      if (char === "*" && nextChar === "/") {
        blockCommentDepth--;
        current += "  ";
        index++;

        if (blockCommentDepth === 0) {
          state = "normal";
        }

        continue;
      }

      if (char === "\n") {
        line++;
      }

      current += appendMasked(char);
      continue;
    }

    if (state === "single-quote") {
      const result = consumeSingleQuotedCharacter({
        char,
        nextChar,
        current,
        line,
        singleQuoteAllowsBackslashEscapes,
      });

      current = result.current;
      if (result.skipNextCharacter) {
        index++;
      }

      line = result.line;
      state = result.state;
      if (state === "normal") {
        const value = decodeSingleQuotedLiteral(
          source.slice(literalSourceStart, index),
          literalEscaped,
        );
        literals.push({ index: literalStart, end: current.length, value });
        statements.push(
          ...surfaceQuotedBody({
            prefix: current.slice(0, literalStart).replace(/E$/iu, ""),
            body: value,
            startLine: literalLine,
            enclosingLine: currentLine,
          }),
        );
      }
      singleQuoteAllowsBackslashEscapes =
        result.singleQuoteAllowsBackslashEscapes;
      continue;
    }

    if (state === "double-quote") {
      if (char === "\n") {
        line++;
      }

      current += appendMasked(char);

      if (char === '"' && nextChar === '"') {
        current += " ";
        index++;
        continue;
      }

      if (char === '"') {
        identifiers.push({
          index: identifierStart,
          name: source.slice(identifierSourceStart, index).replace(/""/gu, '"'),
        });
        state = "normal";
      }

      continue;
    }

    if (char === "-" && nextChar === "-") {
      current += "  ";
      index++;
      state = "line-comment";
      continue;
    }

    if (char === "/" && nextChar === "*") {
      current += "  ";
      blockCommentDepth = 1;
      index++;
      state = "block-comment";
      continue;
    }

    if (isWhitespaceOnly(current) && !/\s/u.test(char)) {
      currentLine = line;
      currentStart = index;
    }

    if (char === "'") {
      literalStart = current.length;
      literalSourceStart = index + 1;
      literalLine = line;
      literalEscaped = hasEscapeStringPrefix(source, index);
      current += " ";
      singleQuoteAllowsBackslashEscapes = literalEscaped;
      state = "single-quote";
      continue;
    }

    if (char === '"') {
      identifierStart = current.length;
      identifierSourceStart = index + 1;
      current += " ";
      state = "double-quote";
      continue;
    }

    const dollarTag = readDollarQuoteTag(source, index);
    if (dollarTag) {
      const bodyStartIndex = index + dollarTag.length;
      const closingIndex = source.indexOf(dollarTag, bodyStartIndex);

      if (closingIndex === -1) {
        current += maskText(source.slice(index));
        break;
      }

      const dollarQuote = source.slice(index, closingIndex + dollarTag.length);

      statements.push(
        ...surfaceQuotedBody({
          prefix: current,
          body: source.slice(bodyStartIndex, closingIndex),
          startLine: line + countNewlines(dollarTag),
          enclosingLine: currentLine,
        }),
      );

      literals.push({
        index: current.length,
        end: current.length + dollarQuote.length,
        value: source.slice(bodyStartIndex, closingIndex),
      });
      current += maskText(dollarQuote);
      line += countNewlines(dollarQuote);
      index += dollarQuote.length - 1;
      continue;
    }

    if (char === ";") {
      pushCurrent(index);
      continue;
    }

    if (char === "\n") {
      line++;
    }

    current += char;
  }

  pushCurrent(source.length);

  return statements;
};

// Keep quoted identifiers alongside the masked keyword view. Token offsets come
// from the same scanner, so comments and string contents cannot supply names.
type IndexToken = {
  kind: "word" | "identifier" | "punctuation";
  value: string;
  index: number;
};

const indexTokens = (statement: Statement): IndexToken[] => {
  const tokens: IndexToken[] = statement.identifiers.map(({ index, name }) => ({
    kind: "identifier",
    value: name,
    index,
  }));
  for (const match of statement.text.matchAll(
    /[A-Za-z_][A-Za-z0-9_$]*|[(),.]/gu,
  )) {
    tokens.push({
      kind: /^[(),.]$/u.test(match[0]) ? "punctuation" : "word",
      value: match[0].toLowerCase(),
      index: match.index,
    });
  }
  return tokens.toSorted((left, right) => left.index - right.index);
};

const isIndexKeyword = (
  token: IndexToken | undefined,
  value: string,
): boolean => token?.kind === "word" && token.value === value;

type IndexRelation = {
  schema: string;
  name: string;
  key: string;
  qualified: boolean;
};

const readIndexRelation = (tokens: IndexToken[], start: number) => {
  const first = tokens[start];
  if (!first || first.kind === "punctuation") {
    return undefined;
  }
  const second = tokens[start + 2];
  const qualified = tokens[start + 1]?.value === ".";
  if (qualified && (!second || second.kind === "punctuation")) {
    return undefined;
  }
  const schema = qualified ? first.value : "public";
  const name = qualified ? second?.value : first.value;
  if (name === undefined) {
    return undefined;
  }
  return {
    relation: { schema, name, key: JSON.stringify([schema, name]), qualified },
    next: start + (qualified ? 3 : 1),
  };
};

type MigrationIndexOperation =
  | { type: "create-table"; table: IndexRelation; conditional: boolean }
  | { type: "create-index"; table: IndexRelation; index?: IndexRelation }
  | { type: "reindex"; target: "index" | "table"; relation?: IndexRelation }
  | { type: "reindex-scope" }
  | {
      type: "rename-table" | "rename-index";
      from: IndexRelation;
      to: IndexRelation;
    }
  | { type: "drop-index"; index: IndexRelation };

// The tail starts inside format(...); its outer close must end the expression.
const isWholeFormatCallTail = (tail: string): boolean => {
  let depth = 1;
  for (let index = 0; index < tail.length; index++) {
    const char = tail[index];
    if (char === "(") {
      depth++;
    }
    if (char !== ")") {
      continue;
    }
    depth--;
    if (depth === 0) {
      return tail.slice(index + 1).trim() === "";
    }
  }
  return false;
};

const migrationRelationLifecycle = (
  tokens: IndexToken[],
  position: number,
): MigrationIndexOperation | undefined => {
  let cursor = position + 1;
  if (isIndexKeyword(tokens[position], "alter")) {
    const table = isIndexKeyword(tokens[cursor], "table");
    if (!table && !isIndexKeyword(tokens[cursor], "index")) {
      return undefined;
    }
    cursor++;
    if (isIndexKeyword(tokens[cursor], "if")) {
      cursor += 2;
    }
    if (isIndexKeyword(tokens[cursor], "only")) {
      cursor++;
    }
    const from = readIndexRelation(tokens, cursor);
    if (
      !from ||
      !isIndexKeyword(tokens[from.next], "rename") ||
      !isIndexKeyword(tokens[from.next + 1], "to")
    ) {
      return undefined;
    }
    const name = readIndexRelation(tokens, from.next + 2)?.relation.name;
    if (name === undefined) {
      return undefined;
    }
    return {
      type: table ? "rename-table" : "rename-index",
      from: from.relation,
      to: {
        ...from.relation,
        name,
        key: JSON.stringify([from.relation.schema, name]),
      },
    };
  }
  if (
    isIndexKeyword(tokens[position], "drop") &&
    isIndexKeyword(tokens[cursor], "index")
  ) {
    cursor++;
    if (isIndexKeyword(tokens[cursor], "concurrently")) {
      cursor++;
    }
    if (isIndexKeyword(tokens[cursor], "if")) {
      cursor += 2;
    }
    const index = readIndexRelation(tokens, cursor)?.relation;
    if (index) {
      return { type: "drop-index", index };
    }
  }
  return undefined;
};

const migrationReindexOperation = (
  tokens: IndexToken[],
  position: number,
): MigrationIndexOperation | undefined => {
  let cursor = position + 1;
  if (!isIndexKeyword(tokens[position], "reindex")) {
    return undefined;
  }
  // PostgreSQL also permits parenthesized options before the target kind.
  if (tokens[cursor]?.value === "(") {
    while (cursor < tokens.length && tokens[cursor]?.value !== ")") {
      cursor++;
    }
    cursor++;
  }
  const kind = tokens[cursor];
  if (
    ["schema", "database", "system"].some((value) =>
      isIndexKeyword(kind, value),
    )
  ) {
    return { type: "reindex-scope" };
  }
  if (!isIndexKeyword(kind, "index") && !isIndexKeyword(kind, "table")) {
    return undefined;
  }
  cursor++;
  if (isIndexKeyword(tokens[cursor], "concurrently")) {
    cursor++;
  }
  const relation = readIndexRelation(tokens, cursor)?.relation;
  return {
    type: "reindex",
    target: isIndexKeyword(kind, "index") ? "index" : "table",
    ...(relation ? { relation } : {}),
  };
};

// Commas inside expressions or index options do not delimit ALTER actions.
const splitAlterActions = (tokens: IndexToken[]): IndexToken[][] => {
  const actions: IndexToken[][] = [];
  let action: IndexToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.value === "(") {
      depth++;
    }
    if (token.value === ")") {
      depth--;
    }
    if (token.value === "," && depth === 0) {
      actions.push(action);
      action = [];
      continue;
    }
    action.push(token);
  }
  actions.push(action);
  return actions;
};

const topLevelAlterTokens = (tokens: IndexToken[]): IndexToken[] => {
  let depth = 0;
  return tokens.filter((token) => {
    if (token.value === "(") {
      depth++;
      return false;
    }
    if (token.value === ")") {
      depth--;
      return false;
    }
    return depth === 0;
  });
};

const namedConstraintIndex = (
  name: string,
  table: IndexRelation,
): IndexRelation => ({
  schema: table.schema,
  name,
  key: JSON.stringify([table.schema, name]),
  qualified: true,
});

const isIndexConstraint = (tokens: IndexToken[], position: number): boolean =>
  isIndexKeyword(tokens[position], "unique") ||
  isIndexKeyword(tokens[position], "exclude") ||
  (isIndexKeyword(tokens[position], "primary") &&
    isIndexKeyword(tokens[position + 1], "key"));

const addedConstraintIndexes = (
  action: IndexToken[],
  table: IndexRelation,
): MigrationIndexOperation[] => {
  if (!isIndexKeyword(action[0], "add")) {
    return [];
  }
  const tokens = topLevelAlterTokens(action);
  const operations: MigrationIndexOperation[] = [];
  let constraint: IndexRelation | undefined;
  for (let position = 1; position < tokens.length; position++) {
    if (isIndexKeyword(tokens[position], "constraint")) {
      const name = readIndexRelation(tokens, position + 1);
      constraint = name
        ? namedConstraintIndex(name.relation.name, table)
        : undefined;
      position = (name?.next ?? position + 2) - 1;
      continue;
    }
    if (!isIndexConstraint(tokens, position)) {
      continue;
    }
    // Attaching an existing online-built index does not build another one.
    const attached = tokens
      .slice(position + 1)
      .some(
        (candidate, offset, tail) =>
          isIndexKeyword(candidate, "using") &&
          isIndexKeyword(tail[offset + 1], "index"),
      );
    if (!attached) {
      operations.push({
        type: "create-index",
        table,
        ...(constraint ? { index: constraint } : {}),
      });
    }
    constraint = undefined;
  }
  return operations;
};

const migrationAlterIndexOperations = (
  tokens: IndexToken[],
  position: number,
): MigrationIndexOperation[] => {
  if (
    !isIndexKeyword(tokens[position], "alter") ||
    !isIndexKeyword(tokens[position + 1], "table")
  ) {
    return [];
  }
  let cursor = position + 2;
  if (isIndexKeyword(tokens[cursor], "if")) {
    cursor += 2;
  }
  if (isIndexKeyword(tokens[cursor], "only")) {
    cursor++;
  }
  const table = readIndexRelation(tokens, cursor);
  if (!table) {
    return [];
  }
  return splitAlterActions(tokens.slice(table.next)).flatMap((action) =>
    addedConstraintIndexes(action, table.relation),
  );
};

const migrationIndexOperations = (
  statement: Statement,
): MigrationIndexOperation[] => {
  if (statement.deferred) {
    return [];
  }
  const tokens = indexTokens(statement);
  const operations: MigrationIndexOperation[] = [];
  for (let position = 0; position < tokens.length; position++) {
    let cursor = position + 1;
    const lifecycle = migrationRelationLifecycle(tokens, position);
    if (lifecycle) {
      operations.push(lifecycle);
      continue;
    }
    operations.push(...migrationAlterIndexOperations(tokens, position));
    const reindex = migrationReindexOperation(tokens, position);
    if (reindex) {
      operations.push(reindex);
      continue;
    }
    if (!isIndexKeyword(tokens[position], "create")) {
      continue;
    }
    if (
      ["unlogged", "temp", "temporary", "unique"].some((value) =>
        isIndexKeyword(tokens[cursor], value),
      )
    ) {
      cursor++;
    }
    const tableCreation = isIndexKeyword(tokens[cursor], "table");
    if (!tableCreation && !isIndexKeyword(tokens[cursor], "index")) {
      continue;
    }
    cursor++;
    if (isIndexKeyword(tokens[cursor], "concurrently")) {
      cursor++;
    }
    const conditional = isIndexKeyword(tokens[cursor], "if");
    if (conditional) {
      cursor += 3; // IF NOT EXISTS
    }
    if (tableCreation) {
      const table = readIndexRelation(tokens, cursor)?.relation;
      if (table) {
        operations.push({ type: "create-table", table, conditional });
      }
      continue;
    }
    let index: IndexRelation | undefined;
    if (!isIndexKeyword(tokens[cursor], "on")) {
      const name = readIndexRelation(tokens, cursor);
      index = name?.relation;
      cursor = name?.next ?? cursor;
    }
    if (!isIndexKeyword(tokens[cursor], "on")) {
      continue;
    }
    cursor++;
    if (isIndexKeyword(tokens[cursor], "only")) {
      cursor++;
    }
    const table = readIndexRelation(tokens, cursor)?.relation;
    if (!table) {
      continue;
    }
    // An unqualified index is created in its table's schema, not search_path.
    if (index) {
      index = {
        schema: table.schema,
        name: index.name,
        key: JSON.stringify([table.schema, index.name]),
        qualified: true,
      };
    }
    operations.push({
      type: "create-index",
      table,
      ...(index ? { index } : {}),
    });
  }
  operations.push(...dynamicIndexOperations(statement, tokens));
  return operations;
};

type ExecutedSqlOptions = {
  statement: Statement;
  token: IndexToken;
  end: number;
  literals: Statement["literals"];
  first: Statement["literals"][number];
};

const resolveExecutedSql = ({
  statement,
  token,
  end,
  literals,
  first,
}: ExecutedSqlOptions): string | undefined => {
  const before = statement.text
    .slice(token.index + token.value.length, first.index)
    .trim();
  const after = statement.text.slice(first.end, end).trim();
  let tail = statement.text.slice(first.end, end);
  for (const literal of literals.slice(1).toReversed()) {
    const start = literal.index - first.end;
    tail = `${tail.slice(0, start)}'literal'${tail.slice(literal.end - first.end)}`;
  }
  let sql: string | undefined;
  if (
    (before === "" || before.toLowerCase() === "e") &&
    /^(?:INTO|USING|$)/iu.test(after)
  ) {
    sql = first.value;
  } else if (/^format\s*\($/iu.test(before)) {
    // Only literal format arguments can prove the target. Variables and
    // expressions must not masquerade as constant identifiers.
    const argumentShape = tail;
    if (/^\s*(?:,\s*(?:E?'(?:[^']|'')*')\s*)*\)\s*$/iu.test(argumentShape)) {
      // Each %I/%s consumes the next literal argument; more placeholders than
      // arguments leaves the target unknown.
      const placeholders = [...first.value.matchAll(/%%|%[Is]/gu)].filter(
        ([match]) => match !== "%%",
      ).length;
      const unresolvedArgument = placeholders > literals.length - 1;
      let argument = 1;
      sql = first.value.replace(
        /%%|%([Is])/gu,
        (match, kind: string | undefined) => {
          if (match === "%%") {
            return "%";
          }
          const value = literals[argument++]?.value;
          if (value === undefined) {
            return "%";
          }
          return kind === "I" ? `"${value.replaceAll('"', '""')}"` : value;
        },
      );
      if (
        unresolvedArgument ||
        /%(?!%)/u.test(first.value.replace(/%%|%[Is]/gu, ""))
      ) {
        sql = undefined;
      }
    } else if (isWholeFormatCallTail(tail) && !/%(?!%|I)/u.test(first.value)) {
      // Unknown %I arguments are quoted identifiers, so they cannot inject
      // another SQL statement. A placeholder target still fails closed.
      sql = first.value.replace(/%%|%I/gu, (match) =>
        match === "%%" ? "%" : '"__migration_dynamic_identifier__"',
      );
    }
  } else if (
    /^(?:E)?$/iu.test(before) &&
    /^\s*(?:\|\|\s*(?:E?'(?:[^']|'')*')\s*)+$/iu.test(tail)
  ) {
    sql = literals.map(({ value }) => value).join("");
  }
  return sql;
};

const dynamicIndexOperations = (
  statement: Statement,
  tokens: IndexToken[],
): MigrationIndexOperation[] => {
  const operations: MigrationIndexOperation[] = [];
  if (statement.enclosingLine !== undefined) {
    for (const [position, token] of tokens.entries()) {
      if (!isIndexKeyword(token, "execute")) {
        continue;
      }
      const nextExecute = tokens
        .slice(position + 1)
        .find((candidate) => isIndexKeyword(candidate, "execute"));
      const end = nextExecute?.index ?? statement.text.length;
      const literals = statement.literals.filter(
        (literal) => literal.index > token.index && literal.index < end,
      );
      const first = literals.at(0);
      if (!first) {
        if (statement.executableIndexHint) {
          operations.push({ type: "reindex-scope" });
        }
        continue;
      }
      const sql = resolveExecutedSql({
        statement,
        token,
        end,
        literals,
        first,
      });
      if (sql !== undefined) {
        for (const nested of parseStatements(sql)) {
          for (const operation of migrationIndexOperations(nested)) {
            let table: IndexRelation | undefined;
            if (operation.type === "create-index") {
              table = operation.table;
            } else if (operation.type === "reindex") {
              table = operation.relation;
            }
            if (
              table &&
              (table.name.includes("__migration_dynamic_identifier__") ||
                table.schema.includes("__migration_dynamic_identifier__"))
            ) {
              operations.push({ type: "reindex-scope" });
              continue;
            }
            if (
              operation.type === "create-index" &&
              operation.index?.name.includes("__migration_dynamic_identifier__")
            ) {
              operations.push({ type: "create-index", table: operation.table });
              continue;
            }
            operations.push(operation);
          }
        }
      } else if (
        statement.executableIndexHint ||
        INDEX_BUILD_HINT_PATTERN.test(
          literals.map(({ value }) => value).join(" "),
        )
      ) {
        operations.push({ type: "reindex-scope" });
      }
    }
  }
  return operations;
};

type MigrationIndexSource = { file: string; source: string };

// Sources are supplied in migration order. Only prior executable definitions
// resolve a REINDEX INDEX; missing or conflicting owners fail closed.
export const checkMigrationIndexBuilds = (
  sources: MigrationIndexSource[],
): Finding[] => {
  const findings: Finding[] = [];
  const indexTables = new Map<string, Map<string, IndexRelation>>();
  const renamedHighVolume = new Set<string>();
  const isHeavy = (table: IndexRelation) =>
    HIGH_VOLUME_TABLE_NAMES.has(table.name) || renamedHighVolume.has(table.key);
  const resolveOwners = (relation: IndexRelation) => {
    if (relation.qualified) {
      return indexTables.get(relation.key);
    }
    const matches = [...indexTables.entries()].filter(([key]) =>
      key.endsWith(`,${JSON.stringify(relation.name)}]`),
    );
    return matches.length === 1 ? matches[0]?.[1] : undefined;
  };
  const normalizedSources = sources.map(({ file, source }) => ({
    file: toRepoPath(file),
    source,
  }));
  for (const { file, source } of normalizedSources) {
    const newTables = new Set<string>();
    for (const statement of parseStatements(source)) {
      for (const operation of migrationIndexOperations(statement)) {
        let unsafe: boolean;
        switch (operation.type) {
          case "create-table":
            // A procedural CREATE may sit behind a condition that never runs.
            if (
              !operation.conditional &&
              statement.enclosingLine === undefined
            ) {
              newTables.add(operation.table.key);
            }
            continue;
          case "rename-table": {
            const fresh = newTables.delete(operation.from.key);
            newTables.delete(operation.to.key);
            if (fresh) {
              newTables.add(operation.to.key);
            }
            if (!fresh && isHeavy(operation.from)) {
              renamedHighVolume.add(operation.to.key);
            }
            for (const owners of indexTables.values()) {
              if (owners.delete(operation.from.key)) {
                owners.set(operation.to.key, operation.to);
              }
            }
            continue;
          }
          case "rename-index": {
            const owners = resolveOwners(operation.from);
            if (owners) {
              const ownerSchema =
                owners.values().next().value?.schema ?? operation.from.schema;
              indexTables.delete(
                JSON.stringify([ownerSchema, operation.from.name]),
              );
              indexTables.set(
                JSON.stringify([ownerSchema, operation.to.name]),
                owners,
              );
            }
            continue;
          }
          case "drop-index": {
            const owners = resolveOwners(operation.index);
            if (owners) {
              const ownerSchema =
                owners.values().next().value?.schema ?? operation.index.schema;
              indexTables.delete(
                JSON.stringify([ownerSchema, operation.index.name]),
              );
            }
            continue;
          }
          case "create-index": {
            const { table, index } = operation;
            if (index) {
              const owners =
                indexTables.get(index.key) ?? new Map<string, IndexRelation>();
              owners.set(table.key, table);
              indexTables.set(index.key, owners);
            }
            unsafe = isHeavy(table) && !newTables.has(table.key);
            break;
          }
          case "reindex": {
            const { target, relation } = operation;
            const owners = relation ? resolveOwners(relation) : undefined;
            const knownOwner =
              owners?.size === 1 ? owners.values().next().value : undefined;
            const table = target === "table" ? relation : knownOwner;
            unsafe = !table || (isHeavy(table) && !newTables.has(table.key));
            break;
          }
          case "reindex-scope":
            unsafe = true;
            break;
          default: {
            operation satisfies never;
            panic("Unhandled migration index operation");
          }
        }
        if (unsafe) {
          findings.push({
            file,
            line: statement.line,
            ruleId: HIGH_VOLUME_INDEX_BUILD_RULE_ID,
            statementHash: createSha256().update(statement.raw).digest("hex"),
            description:
              "builds indexes on a high-volume table or an unresolved REINDEX target during a schema migration",
            guidance:
              "Register the index in ONLINE_MIGRATION_INDEXES in apps/api/src/db/online-migrations.ts (online phase) instead. Schema-wide, database-wide and system-wide REINDEX must also run outside schema migrations.",
          });
        }
      }
    }
  }
  return findings;
};

// Keeps the schema qualifier: `audit.old_idx` and `old_idx` are different
// objects, so a drop of one is not rebuilt by a create of the other.
const normalizeIndexName = (quotedOrBare: string): string =>
  quotedOrBare.replace(/"/gu, "").toLowerCase();

// Index names created by statements later in the file than the given position.
// A `DROP INDEX [IF EXISTS] x` followed by `CREATE INDEX x` is a rebuild (the
// retry-cleanup shape used with concurrent builds), not a destructive change.
const isIndexRebuiltLater = (
  statements: Statement[],
  dropPosition: number,
): boolean => {
  const droppedName = DROP_INDEX_NAME_PATTERN.exec(
    statements[dropPosition]?.raw ?? "",
  )?.groups?.["name"];

  if (!droppedName) {
    return false;
  }

  const normalized = normalizeIndexName(droppedName);

  return statements.slice(dropPosition + 1).some((statement) => {
    const created = CREATE_INDEX_NAME_PATTERN.exec(statement.raw)?.groups?.[
      "name"
    ];

    return created !== undefined && normalizeIndexName(created) === normalized;
  });
};

const guardedRuleMatches = (rule: GuardedRule, statement: string): boolean =>
  rule.matches
    ? rule.matches(statement)
    : (rule.pattern?.test(statement) ?? false);

type AcknowledgementBody = { ruleIds: string[]; reason: string };

const parseAcknowledgementBody = (rest: string): AcknowledgementBody | null => {
  if (!/^\s/u.test(rest)) {
    return null;
  }

  const separator = ACKNOWLEDGEMENT_SEPARATOR_PATTERN.exec(rest);
  if (!separator) {
    return null;
  }

  const ruleIds = rest
    .slice(0, separator.index)
    .split(",")
    .map((id) => id.trim().toLowerCase());
  if (ruleIds.some((id) => !RULE_ID_PATTERN.test(id))) {
    return null;
  }

  return {
    ruleIds,
    reason: rest.slice(separator.index + separator[0].length),
  };
};

type AcknowledgementParseResult = {
  acknowledgements: Acknowledgement[];
  errors: Finding[];
};

// Reads every acknowledgement marker with its reason. The reason continues over
// the immediately following `--` comment lines until the block ends or another
// marker starts.
const parseAcknowledgements = (
  file: string,
  lines: string[],
): AcknowledgementParseResult => {
  const acknowledgements: Acknowledgement[] = [];
  const errors: Finding[] = [];

  for (let index = 0; index < lines.length; index++) {
    const marker = ACKNOWLEDGEMENT_MARKER_PATTERN.exec(lines[index] ?? "");
    if (!marker) {
      continue;
    }

    const lineNumber = index + 1;
    const body = parseAcknowledgementBody(marker.groups?.["rest"] ?? "");

    if (!body) {
      errors.push({
        file,
        line: lineNumber,
        ruleId: "malformed-acknowledgement",
        description:
          "acknowledgement must read `-- stella-migration-safety: reviewed <rule-id>[, <rule-id>] - <reason>`",
      });
      continue;
    }

    const reasonLines = [body.reason];
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next] ?? "";
      if (
        !LINE_COMMENT_PATTERN.test(candidate) ||
        ACKNOWLEDGEMENT_MARKER_PATTERN.test(candidate)
      ) {
        break;
      }
      reasonLines.push(candidate.replace(/^\s*--\s?/u, ""));
    }

    const { ruleIds } = body;
    const structuralIds = ruleIds.filter((id) =>
      STATEMENT_INVARIANT_RULE_IDS.has(id),
    );

    if (structuralIds.length > 0) {
      errors.push({
        file,
        line: lineNumber,
        ruleId: "unacknowledgeable-rule",
        description: `${structuralIds.join(", ")} cannot be acknowledged: the statement is structurally unsafe and has to be rewritten`,
      });
      continue;
    }

    const unknownIds = ruleIds.filter((id) => !KNOWN_RULE_IDS.has(id));

    if (unknownIds.length > 0) {
      errors.push({
        file,
        line: lineNumber,
        ruleId: "unknown-acknowledgement-rule",
        description: `acknowledges unknown rule(s) ${unknownIds.join(", ")}; known rules: ${[...KNOWN_RULE_IDS].join(", ")}`,
      });
      continue;
    }

    const reason = reasonLines.join(" ").trim();

    if (reason.length < MIN_ACKNOWLEDGEMENT_REASON_LENGTH) {
      errors.push({
        file,
        line: lineNumber,
        ruleId: "acknowledgement-reason-too-short",
        description: `acknowledgement reason must be at least ${MIN_ACKNOWLEDGEMENT_REASON_LENGTH} characters`,
      });
      continue;
    }

    acknowledgements.push({
      line: lineNumber,
      ruleIds,
      reason,
      usedRuleIds: new Set(),
    });
  }

  return { acknowledgements, errors };
};

// The comment block directly above a statement: contiguous comment or blank
// lines walking upward from the line before the statement. Returns the 1-based
// line numbers in that block.
const precedingCommentBlock = (
  lines: string[],
  statementLine: number,
): Set<number> => {
  const block = new Set<number>();

  for (let lineNumber = statementLine - 1; lineNumber >= 1; lineNumber--) {
    const content = lines[lineNumber - 1] ?? "";
    if (!(isWhitespaceOnly(content) || LINE_COMMENT_PATTERN.test(content))) {
      break;
    }
    block.add(lineNumber);
  }

  return block;
};

type StatementAcknowledgementLookup = (
  statement: Statement,
  ruleId: string,
) => Acknowledgement | undefined;

const createAcknowledgementLookup = (
  lines: string[],
  acknowledgements: Acknowledgement[],
): StatementAcknowledgementLookup => {
  const blockCache = new Map<number, Set<number>>();
  const blockFor = (statementLine: number): Set<number> => {
    const cached = blockCache.get(statementLine);
    if (cached) {
      return cached;
    }
    const block = precedingCommentBlock(lines, statementLine);
    blockCache.set(statementLine, block);
    return block;
  };

  return (statement, ruleId) => {
    const candidateLines = new Set(blockFor(statement.line));
    if (statement.enclosingLine !== undefined) {
      for (const lineNumber of blockFor(statement.enclosingLine)) {
        candidateLines.add(lineNumber);
      }
    }

    return acknowledgements.find(
      (acknowledgement) =>
        candidateLines.has(acknowledgement.line) &&
        acknowledgement.ruleIds.includes(ruleId),
    );
  };
};

type FileCheckResult = {
  invariantFindings: Finding[];
  guardedFindings: (Finding & { category: GuardedCategory })[];
  acknowledgementErrors: Finding[];
};

const checkSource = (
  { file, source }: MigrationIndexSource,
  indexFindings: Finding[],
): FileCheckResult => {
  const lines = source.split("\n");
  const statements = parseStatements(source);

  const invariantFindings = indexFindings.filter(
    (finding) => finding.file === file,
  );

  for (const rule of FILE_INVARIANT_RULES) {
    if (rule.matches(statements)) {
      invariantFindings.push({
        file,
        line: 1,
        ruleId: rule.id,
        description: rule.description,
        guidance: rule.guidance,
      });
    }
  }

  for (const statement of statements) {
    for (const rule of STATEMENT_INVARIANT_RULES) {
      if (rule.matches(statement)) {
        invariantFindings.push({
          file,
          line: statement.line,
          ruleId: rule.id,
          description: rule.description,
          guidance: rule.guidance,
        });
      }
    }
  }

  const { acknowledgements, errors: acknowledgementErrors } =
    parseAcknowledgements(file, lines);
  const findAcknowledgement = createAcknowledgementLookup(
    lines,
    acknowledgements,
  );
  const guardedFindings: FileCheckResult["guardedFindings"] = [];

  for (const [position, statement] of statements.entries()) {
    // A deferred (stored-routine) statement executes nothing at migration
    // time, so no guarded rule applies to it.
    if (statement.deferred) {
      continue;
    }

    for (const rule of GUARDED_RULES) {
      if (!guardedRuleMatches(rule, statement.text)) {
        continue;
      }

      if (
        rule.id === "drop-object" &&
        isIndexRebuiltLater(statements, position)
      ) {
        continue;
      }

      const acknowledgement = findAcknowledgement(statement, rule.id);
      if (acknowledgement) {
        acknowledgement.usedRuleIds.add(rule.id);
        continue;
      }

      guardedFindings.push({
        file,
        line: statement.line,
        ruleId: rule.id,
        description: rule.description,
        category: rule.category,
      });
    }
  }

  for (const acknowledgement of acknowledgements) {
    const unusedRuleIds = acknowledgement.ruleIds.filter(
      (ruleId) => !acknowledgement.usedRuleIds.has(ruleId),
    );
    if (unusedRuleIds.length === 0) {
      continue;
    }

    acknowledgementErrors.push({
      file,
      line: acknowledgement.line,
      ruleId: "unused-acknowledgement",
      description: `acknowledgement for ${unusedRuleIds.join(", ")} clears no statement; place it directly above the statement it reviews, or remove the rule id`,
    });
  }

  return { invariantFindings, guardedFindings, acknowledgementErrors };
};

const reportFindings = (findings: Finding[]) => {
  for (const finding of findings) {
    console.error(
      `  ${finding.file}:${finding.line} [${finding.ruleId}] ${finding.description}`,
    );
    if (finding.guidance) {
      console.error(`    ${finding.guidance}`);
    }
    annotate(finding);
  }
};

const collectMigrationFiles = (directory: string): string[] => {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectMigrationFiles(filePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".sql")) {
      files.push(filePath);
    }
  }

  return files.toSorted();
};

const normalizeInputFiles = (args: string[]): string[] => {
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  const baseline = readBaseline();

  if (args.length === 0) {
    for (const entry of baseline) {
      if (existsSync(entry)) {
        continue;
      }
      console.error(
        `ERROR: ${BASELINE_FILE} lists ${entry}, which no longer exists; remove the entry.`,
      );
      process.exitCode = 1;
    }

    return collectMigrationFiles(DEFAULT_MIGRATIONS_DIR).filter(
      (file) => !baseline.has(toRepoPath(file)),
    );
  }

  return args.filter((file) => {
    if (!existsSync(file)) {
      console.error(`ERROR: Migration file does not exist: ${file}`);
      process.exitCode = 1;
      return false;
    }

    if (!statSync(file).isFile()) {
      console.error(`ERROR: Migration path is not a file: ${file}`);
      process.exitCode = 1;
      return false;
    }

    if (baseline.has(toRepoPath(file))) {
      console.log(`Skipping ${file}: listed in ${BASELINE_FILE}.`);
      return false;
    }

    return true;
  });
};

/**
 * Every finding for the selected migrations, keyed by repo-relative path. The
 * committed corpus is read only to resolve REINDEX owners.
 */
export const checkMigrationSources = (
  selectedSources: readonly MigrationIndexSource[],
): (FileCheckResult & { file: string })[] => {
  // The corpus is needed only for ownership resolution. A raw keyword check
  // may over-select literals, but never skips an executable REINDEX.
  const needsIndexOwners = selectedSources.some(({ source }) =>
    /\bREINDEX\b/iu.test(source),
  );
  const selected = new Map(
    selectedSources.map(({ file, source }) => [file, source]),
  );
  const indexFindings = checkMigrationIndexBuilds(
    needsIndexOwners
      ? [
          ...new Set([
            ...collectMigrationFiles(DEFAULT_MIGRATIONS_DIR),
            ...selected.keys(),
          ]),
        ]
          .toSorted()
          .map((file) => ({
            file,
            source: selected.get(file) ?? readFileSync(file, "utf-8"),
          }))
      : [...selectedSources],
  ).filter(
    (finding) =>
      !indexFindingsSnapshot.some(
        (entry) =>
          entry.file === toRepoPath(finding.file) &&
          entry.line === finding.line &&
          entry.ruleId === finding.ruleId &&
          entry.statementHash === finding.statementHash,
      ),
  );
  return selectedSources.map((migration) => ({
    file: migration.file,
    ...checkSource(migration, indexFindings),
  }));
};

const main = () => {
  const files = normalizeInputFiles(Bun.argv.slice(2)).map(toRepoPath);
  let violations = 0;
  const checks = checkMigrationSources(
    files.map((file) => ({ file, source: readFileSync(file, "utf-8") })),
  );

  for (const {
    file,
    invariantFindings,
    guardedFindings,
    acknowledgementErrors,
  } of checks) {
    if (invariantFindings.length > 0) {
      violations += invariantFindings.length;
      console.error(
        `ERROR: ${file} contains migration operations that are structurally unsafe:`,
      );
      reportFindings(invariantFindings);
    }

    if (acknowledgementErrors.length > 0) {
      violations += acknowledgementErrors.length;
      console.error(`ERROR: ${file} has invalid safety acknowledgements:`);
      reportFindings(acknowledgementErrors);
    }

    if (guardedFindings.length === 0) {
      continue;
    }

    violations += guardedFindings.length;
    console.error(
      `ERROR: ${file} contains migration operations that need explicit review:`,
    );
    reportFindings(guardedFindings);

    const categories = new Set(
      guardedFindings.map((finding) => finding.category),
    );
    for (const category of GUARDED_CATEGORIES) {
      if (categories.has(category)) {
        console.error(`  ${category}: ${GUARDED_CATEGORY_GUIDANCE[category]}`);
      }
    }

    console.error(
      "After review, acknowledge each statement in the comment block directly above it:",
    );
    console.error(
      "  -- stella-migration-safety: reviewed <rule-id> - <why this is safe and how rollback is handled>",
    );
  }

  if (violations > 0 || process.exitCode) {
    process.exit(1);
  }
};

if (import.meta.main) {
  main();
}
