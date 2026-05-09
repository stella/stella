#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Statement = {
  line: number;
  text: string;
};

type GuardedRule = {
  id: string;
  description: string;
  pattern?: RegExp;
  matches?: (statement: string) => boolean;
};

type InvariantRule = GuardedRule & {
  guidance: string;
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

const ACKNOWLEDGEMENT_PREFIX_PATTERN =
  /^\s*--\s*stella-migration-safety:\s*reviewed\s+destructive-change\s*-\s*/i;

const MIN_ACKNOWLEDGEMENT_REASON_LENGTH = 12;
const DEFAULT_MIGRATIONS_DIR = "apps/api/drizzle";
const ALTER_TABLE_PATTERN = /\bALTER\s+TABLE\b/i;
const ALTER_COLUMN_TYPE_PATTERN =
  /\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i;
const DO_BLOCK_DOLLAR_QUOTE_PREFIX_PATTERN = /\bDO(?:\s+LANGUAGE\s+\S+)?\s*$/i;
const ROUTINE_DOLLAR_QUOTE_PREFIX_PATTERN =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b[\s\S]*\b(?:AS|IS)\s*$/i;

const GUARDED_RULES: GuardedRule[] = [
  {
    id: "drop-object",
    description: "drops a database object",
    pattern:
      /\bDROP\s+(?:DATABASE|EXTENSION|FUNCTION|INDEX|MATERIALIZED\s+VIEW|POLICY|SCHEMA|SEQUENCE|TABLE|TRIGGER|TYPE|VIEW)\b/i,
  },
  {
    id: "drop-column",
    description: "drops a table column",
    pattern:
      /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(?!(?:CONSTRAINT|DEFAULT|NOT\s+NULL)\b)\S+/i,
  },
  {
    id: "drop-constraint",
    description: "drops a table constraint",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+CONSTRAINT\b/i,
  },
  {
    id: "rename-table-or-column",
    description: "renames a table or column",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i,
  },
  {
    id: "alter-column-type",
    description: "changes a column type",
    matches: (statement) =>
      ALTER_TABLE_PATTERN.test(statement) &&
      ALTER_COLUMN_TYPE_PATTERN.test(statement),
  },
  {
    id: "truncate-table",
    description: "truncates table data",
    pattern: /\bTRUNCATE\b/i,
  },
  {
    id: "delete-data",
    description: "deletes table data",
    pattern: /\bDELETE\s+FROM\b/i,
  },
  {
    id: "disable-row-level-security",
    description: "disables row-level security",
    pattern: /\bALTER\s+TABLE\b[\s\S]*\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
  },
];

const INVARIANT_RULES: InvariantRule[] = [
  {
    id: "on-conflict-column-target",
    description: "uses a column-target ON CONFLICT clause",
    pattern: /\bON\s+CONFLICT\s*\([^)]*\)/i,
    guidance:
      "Use ON CONFLICT ON CONSTRAINT for a named table constraint, or use WHERE NOT EXISTS when the arbiter is a partial unique index.",
  },
];

const usage = () => {
  console.error(
    "Usage: bun scripts/check-migration-safety.ts [apps/api/drizzle/<migration>/migration.sql ...]",
  );
};

const hasAcknowledgement = (source: string): boolean => {
  for (const line of source.split("\n")) {
    const match = ACKNOWLEDGEMENT_PREFIX_PATTERN.exec(line);

    if (!match) {
      continue;
    }

    const reason = line.slice(match[0].length).trim();

    if (reason.length >= MIN_ACKNOWLEDGEMENT_REASON_LENGTH) {
      return true;
    }
  }

  return false;
};

const isWhitespaceOnly = (value: string): boolean => value.trim().length === 0;

const appendMasked = (value: string): string => (value === "\n" ? "\n" : " ");

const maskText = (value: string): string => value.replace(/[^\n]/g, " ");

const countNewlines = (value: string): number =>
  value.match(/\n/g)?.length ?? 0;

const isIdentifierCharacter = (value: string): boolean =>
  /[A-Za-z0-9_$]/.test(value);

const hasEscapeStringPrefix = (source: string, quoteIndex: number): boolean => {
  const prefix = source[quoteIndex - 1] ?? "";
  const beforePrefix = source[quoteIndex - 2] ?? "";

  return (
    (prefix === "E" || prefix === "e") && !isIdentifierCharacter(beforePrefix)
  );
};

const readDollarQuoteTag = (source: string, index: number): string | null => {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(source.slice(index));

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

  const pushCurrent = () => {
    if (isWhitespaceOnly(current)) {
      current = "";
      currentLine = line;
      return;
    }

    statements.push({ line: currentLine, text: current });
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

        for (const statement of parseStatements(body)) {
          statements.push({
            line: bodyStartLine + statement.line - 1,
            text: statement.text,
          });
        }
      }

      current += maskText(dollarQuote);
      line += countNewlines(dollarQuote);
      index += dollarQuote.length - 1;
      continue;
    }

    if (char === ";") {
      pushCurrent();
      continue;
    }

    if (isWhitespaceOnly(current) && !/\s/.test(char)) {
      currentLine = line;
    }

    if (char === "\n") {
      line++;
    }

    current += char;
  }

  pushCurrent();

  return statements;
};

const collectMigrationFiles = (directory: string): string[] => {
  if (!existsSync(directory)) {
    return [];
  }

  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectMigrationFiles(path));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".sql")) {
      files.push(path);
    }
  }

  return files.sort();
};

const normalizeInputFiles = (args: string[]): string[] => {
  if (args.length === 0) {
    return collectMigrationFiles(DEFAULT_MIGRATIONS_DIR);
  }

  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
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

    return true;
  });
};

const main = () => {
  const files = normalizeInputFiles(Bun.argv.slice(2));
  let violations = 0;

  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const statements = parseStatements(source);
    const invariantFindings = statements.flatMap((statement) =>
      INVARIANT_RULES.filter((rule) =>
        rule.matches
          ? rule.matches(statement.text)
          : (rule.pattern?.test(statement.text) ?? false),
      ).map((rule) => ({
        file,
        line: statement.line,
        rule,
      })),
    );

    if (invariantFindings.length > 0) {
      violations += invariantFindings.length;
      console.error(
        `ERROR: ${file} contains migration operations that are structurally unsafe:`,
      );

      for (const finding of invariantFindings) {
        console.error(
          `  ${finding.file}:${finding.line} [${finding.rule.id}] ${finding.rule.description}`,
        );
        console.error(`    ${finding.rule.guidance}`);
      }
    }

    const guardedFindings = statements.flatMap((statement) =>
      GUARDED_RULES.filter((rule) =>
        rule.matches
          ? rule.matches(statement.text)
          : (rule.pattern?.test(statement.text) ?? false),
      ).map((rule) => ({
        file,
        line: statement.line,
        rule,
      })),
    );

    if (guardedFindings.length === 0) {
      continue;
    }

    if (hasAcknowledgement(source)) {
      continue;
    }

    violations += guardedFindings.length;
    console.error(
      `ERROR: ${file} contains migration operations that need explicit review:`,
    );

    for (const finding of guardedFindings) {
      console.error(
        `  ${finding.file}:${finding.line} [${finding.rule.id}] ${finding.rule.description}`,
      );
    }

    console.error(
      "Add a file-level SQL comment after confirming the operation is safe:",
    );
    console.error(
      "  -- stella-migration-safety: reviewed destructive-change - <why this is safe and how rollback is handled>",
    );
  }

  if (violations > 0 || process.exitCode) {
    process.exit(1);
  }
};

main();
