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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

type Statement = {
  line: number;
  // Comment, string, and identifier content masked to spaces so keyword scans
  // cannot be fooled by literals.
  text: string;
  // Unmasked text from the first token of the statement. Used only to read
  // object names out of DROP/CREATE statements; every rule runs on `text`.
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
  id: string;
  description: string;
  category: GuardedCategory;
  pattern?: RegExp;
  matches?: (statement: string) => boolean;
};

type StatementInvariantRule = {
  id: string;
  description: string;
  pattern: RegExp;
  guidance: string;
};

type FileInvariantRule = {
  id: string;
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
};

type Acknowledgement = {
  line: number;
  ruleIds: string[];
  reason: string;
  used: boolean;
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
const ACKNOWLEDGEMENT_BODY_PATTERN =
  /^\s+(?<ids>[a-z][a-z0-9-]*(?:\s*,\s*[a-z][a-z0-9-]*)*)\s+-\s*(?<reason>.*)$/iu;
const LINE_COMMENT_PATTERN = /^\s*--/u;
const MIN_ACKNOWLEDGEMENT_REASON_LENGTH = 12;

const DEFAULT_MIGRATIONS_DIR = "apps/api/drizzle";
// Migrations applied before the current rule set. Shared with squawk via
// scripts/check-migrations.sh. Entries are immutable migrations, so the list
// may only shrink; a listed file that no longer exists is an error.
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
const PERMISSIVE_POLICY_PATTERN =
  /\bCREATE\s+POLICY\b[\s\S]*\b(?:USING|WITH\s+CHECK)\s*\(\s*TRUE\s*\)/iu;
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

const GUARDED_RULES: GuardedRule[] = [
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
    pattern:
      /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\b[^(]*\bAS\s*\(?\s*(?:SELECT|WITH|TABLE|VALUES|EXECUTE)\b/iu,
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
      PERMISSIVE_POLICY_PATTERN.test(statement) &&
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
];

const STATEMENT_INVARIANT_RULES: StatementInvariantRule[] = [
  {
    id: "on-conflict-column-target",
    description: "uses a column-target ON CONFLICT clause",
    pattern: /\bON\s+CONFLICT\s*\([^)]*\)/iu,
    guidance:
      "Use ON CONFLICT ON CONSTRAINT for a named table constraint, or use WHERE NOT EXISTS when the arbiter is a partial unique index.",
  },
];

const FILE_INVARIANT_RULES: FileInvariantRule[] = [
  {
    id: "missing-lock-timeout",
    description: "does not set lock_timeout",
    matches: (statements) =>
      !statements.some((statement) =>
        LOCK_TIMEOUT_PATTERN.test(statement.text),
      ),
    guidance:
      "Start the migration with SET LOCAL lock_timeout = '<short>'; so a blocked DDL lock fails fast instead of queueing behind live traffic.",
  },
  {
    id: "missing-statement-timeout",
    description: "does not set statement_timeout",
    matches: (statements) =>
      !statements.some((statement) =>
        STATEMENT_TIMEOUT_PATTERN.test(statement.text),
      ),
    guidance:
      "Start the migration with SET LOCAL statement_timeout = '<bound>'; so a slow statement cannot hold locks indefinitely.",
  },
];

const KNOWN_RULE_IDS = new Set(GUARDED_RULES.map((rule) => rule.id));

const usage = () => {
  console.error(
    "Usage: bun scripts/check-migration-safety.ts [apps/api/drizzle/<migration>/migration.sql ...]",
  );
};

const toRepoPath = (file: string): string =>
  path.relative(process.cwd(), path.resolve(file)).split(path.sep).join("/");

const readBaseline = (): Set<string> => {
  if (!existsSync(BASELINE_FILE)) {
    return new Set();
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

const parseStatements = (source: string): Statement[] => {
  const statements: Statement[] = [];
  let current = "";
  let currentLine = 1;
  let currentStart = 0;
  let line = 1;
  let blockCommentDepth = 0;
  let dollarQuoteTag: string | null = null;
  let singleQuoteAllowsBackslashEscapes = false;
  let state:
    | "normal"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "dollar-quote" = "normal";

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
    });
    current = "";
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
        state = "normal";
      }

      continue;
    }

    if (state === "dollar-quote") {
      const tag = dollarQuoteTag ?? "";

      if (source.startsWith(tag, index)) {
        current += " ".repeat(tag.length);
        index += tag.length - 1;
        dollarQuoteTag = null;
        state = "normal";
        continue;
      }

      if (char === "\n") {
        line++;
      }

      current += appendMasked(char);
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
      current += " ";
      singleQuoteAllowsBackslashEscapes = hasEscapeStringPrefix(source, index);
      state = "single-quote";
      continue;
    }

    if (char === '"') {
      current += " ";
      state = "double-quote";
      continue;
    }

    const dollarTag = readDollarQuoteTag(source, index);
    if (dollarTag) {
      const bodyStartIndex = index + dollarTag.length;
      const closingIndex = source.indexOf(dollarTag, bodyStartIndex);

      if (closingIndex === -1) {
        current += " ".repeat(dollarTag.length);
        index += dollarTag.length - 1;
        dollarQuoteTag = dollarTag;
        state = "dollar-quote";
        continue;
      }

      const dollarQuote = source.slice(index, closingIndex + dollarTag.length);

      if (shouldScanDollarQuoteBody(current)) {
        const body = source.slice(bodyStartIndex, closingIndex);
        const bodyStartLine = line + countNewlines(dollarTag);
        // A DO block runs at migration time; a routine body is only stored, so
        // its statements (and anything nested in them) are deferred.
        const bodyIsDeferred =
          !DO_BLOCK_DOLLAR_QUOTE_PREFIX_PATTERN.test(current);

        for (const statement of parseStatements(body)) {
          statements.push({
            line: bodyStartLine + statement.line - 1,
            text: statement.text,
            raw: statement.raw,
            // The outermost parse runs last, so the outermost statement wins.
            enclosingLine: currentLine,
            ...(bodyIsDeferred || statement.deferred ? { deferred: true } : {}),
          });
        }
      }

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

const normalizeIndexName = (quotedOrBare: string): string => {
  const lastSegment = quotedOrBare.split(".").at(-1) ?? quotedOrBare;

  return lastSegment.replace(/"/gu, "").toLowerCase();
};

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
    const body = ACKNOWLEDGEMENT_BODY_PATTERN.exec(
      marker.groups?.["rest"] ?? "",
    );

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

    const reasonLines = [body.groups?.["reason"] ?? ""];
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

    const ruleIds = (body.groups?.["ids"] ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase());
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

    acknowledgements.push({ line: lineNumber, ruleIds, reason, used: false });
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
    const candidateLines = blockFor(statement.line);
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

const checkFile = (file: string): FileCheckResult => {
  const source = readFileSync(file, "utf-8");
  const lines = source.split("\n");
  const statements = parseStatements(source);

  const invariantFindings: Finding[] = [];

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
      if (rule.pattern.test(statement.text)) {
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
        acknowledgement.used = true;
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
    if (acknowledgement.used) {
      continue;
    }

    acknowledgementErrors.push({
      file,
      line: acknowledgement.line,
      ruleId: "unused-acknowledgement",
      description: `acknowledgement for ${acknowledgement.ruleIds.join(", ")} clears no statement; place it directly above the statement it reviews, or remove it`,
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

  return files.sort();
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

const main = () => {
  const files = normalizeInputFiles(Bun.argv.slice(2));
  let violations = 0;

  for (const file of files) {
    const { invariantFindings, guardedFindings, acknowledgementErrors } =
      checkFile(file);

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

main();
