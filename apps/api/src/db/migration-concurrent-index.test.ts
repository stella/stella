import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { ONLINE_VALIDATED_INDEX_NAMES } from "./online-migrations";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const ZERO_DURATION = /^'?0\s*(?:us|ms|s|min|h|d)?'?$/iu;
const CONCURRENT_INDEX_OPERATION =
  /^(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY\b/iu;
const CONCURRENT_IF_NOT_EXISTS =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/giu;
const CONCURRENT_UNIQUE_CREATE =
  /\bCREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY(?<idempotent>\s+IF\s+NOT\s+EXISTS)?\s+"(?<name>[^"]+)"/giu;
const CONCURRENT_DROP =
  /\bDROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+"([^"]+)"/giu;
const TYPE_CHANGE =
  /^ALTER\s+TABLE\b[^;]*?\bALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|[\p{L}_][\p{L}\p{M}\p{N}_$]*)\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
const TYPE_CHANGE_ANYWHERE =
  /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|[\p{L}_][\p{L}\p{M}\p{N}_$]*)\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
const TRANSACTION_REVERSAL =
  /^(?:ABORT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/iu;
const TYPE_CHANGE_POLICY = {
  boundedRewrite: "stella-migration-safety: bounded-type-rewrite",
  metadataOnly: "stella-migration-safety: metadata-only-type-change",
} as const;
const TYPE_CHANGE_POLICY_STATEMENT = "STELLA_MIGRATION_SAFETY";
const CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS = new Set([
  // This conversion derives a 20-minute execution budget from pg_settings in
  // a DO block, which the statement scanner deliberately does not interpret.
  "20260729150000_timestamptz_everywhere/migration.sql",
]);

type TimeoutState = "bounded" | "unbounded" | "unset";
type TypeChangePolicy = "boundedRewrite" | "metadataOnly";
type SqlQuote = {
  backslashEscapes: boolean;
  character: '"' | "'";
};
type TimeoutUpdate =
  | {
      type: "set";
      name: "lock" | "statement";
      scope: "local" | "session";
      state: TimeoutState;
    }
  | {
      type: "reset";
      name: "all" | "lock" | "statement";
    }
  | {
      type: "preserve";
      name: "lock" | "statement";
      scope: "local" | "session";
    };

const classifyTimeout = (value: string): TimeoutState => {
  if (ZERO_DURATION.test(value)) {
    return "unbounded";
  }
  if (/^'?[1-9][0-9]*\s*(?:us|ms|s|min|h|d)?'?$/iu.test(value)) {
    return "bounded";
  }
  return "unset";
};

const dollarQuoteDelimiterAt = (source: string, index: number) => {
  if (/[A-Z0-9_$]/iu.test(source[index - 1] ?? "")) {
    return undefined;
  }
  return /^\$(?:[A-Z_][A-Z0-9_]*)?\$/iu.exec(source.slice(index))?.at(0);
};

const sqlQuoteAt = (
  source: string,
  index: number,
  character: '"' | "'",
): SqlQuote => {
  const prefix = source[index - 1] ?? "";
  const beforePrefix = source[index - 2] ?? "";
  const isEscapeString =
    character === "'" &&
    prefix.toLowerCase() === "e" &&
    !/[A-Z0-9_$]/iu.test(beforePrefix);

  return { backslashEscapes: isEscapeString, character };
};

const policyStatementForComment = (comment: string) => {
  if (comment.includes(TYPE_CHANGE_POLICY.metadataOnly)) {
    return `${TYPE_CHANGE_POLICY_STATEMENT} metadataOnly;`;
  }
  if (comment.includes(TYPE_CHANGE_POLICY.boundedRewrite)) {
    return `${TYPE_CHANGE_POLICY_STATEMENT} boundedRewrite;`;
  }
  return "";
};

const stripSqlComments = (source: string) => {
  let result = "";
  let index = 0;
  let blockCommentDepth = 0;
  let dollarQuoteDelimiter: string | undefined;
  let quote: SqlQuote | undefined;

  while (index < source.length) {
    const character = source[index] ?? "";
    const nextCharacter = source[index + 1] ?? "";

    if (blockCommentDepth > 0) {
      if (character === "/" && nextCharacter === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (character === "*" && nextCharacter === "/") {
        blockCommentDepth -= 1;
        index += 2;
      } else {
        if (character === "\n") {
          result += "\n";
        }
        index += 1;
      }
      continue;
    }

    if (dollarQuoteDelimiter) {
      if (source.startsWith(dollarQuoteDelimiter, index)) {
        result += dollarQuoteDelimiter;
        index += dollarQuoteDelimiter.length;
        dollarQuoteDelimiter = undefined;
      } else {
        result += character;
        index += 1;
      }
      continue;
    }

    if (quote) {
      result += character;
      if (quote.backslashEscapes && character === "\\" && nextCharacter) {
        result += nextCharacter;
        index += 2;
      } else if (
        character === quote.character &&
        nextCharacter === quote.character
      ) {
        result += nextCharacter;
        index += 2;
      } else {
        if (character === quote.character) {
          quote = undefined;
        }
        index += 1;
      }
      continue;
    }

    if (character === "-" && nextCharacter === "-") {
      const newlineIndex = source.indexOf("\n", index + 2);
      const commentEnd = newlineIndex === -1 ? source.length : newlineIndex;
      const policyStatement = policyStatementForComment(
        source.slice(index + 2, commentEnd),
      );
      if (policyStatement) {
        result += `\n${policyStatement}\n`;
      }
      if (newlineIndex === -1) {
        break;
      }
      result += "\n";
      index = commentEnd + 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      result += " ";
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = sqlQuoteAt(source, index, character);
      result += character;
      index += 1;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiterAt(source, index);
      if (delimiter) {
        dollarQuoteDelimiter = delimiter;
        result += delimiter;
        index += delimiter.length;
        continue;
      }
    }

    result += character;
    index += 1;
  }

  return result;
};

const splitSqlStatements = (source: string) => {
  const statements = [];
  const sql = stripSqlComments(source);
  let current = "";
  let index = 0;
  let dollarQuoteDelimiter: string | undefined;
  let quote: SqlQuote | undefined;

  while (index < sql.length) {
    const character = sql[index] ?? "";
    const nextCharacter = sql[index + 1] ?? "";

    if (dollarQuoteDelimiter) {
      if (sql.startsWith(dollarQuoteDelimiter, index)) {
        current += dollarQuoteDelimiter;
        index += dollarQuoteDelimiter.length;
        dollarQuoteDelimiter = undefined;
      } else {
        current += character;
        index += 1;
      }
      continue;
    }

    if (quote) {
      current += character;
      if (quote.backslashEscapes && character === "\\" && nextCharacter) {
        current += nextCharacter;
        index += 2;
      } else if (
        character === quote.character &&
        nextCharacter === quote.character
      ) {
        current += nextCharacter;
        index += 2;
      } else {
        if (character === quote.character) {
          quote = undefined;
        }
        index += 1;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = sqlQuoteAt(sql, index, character);
      current += character;
      index += 1;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiterAt(sql, index);
      if (delimiter) {
        dollarQuoteDelimiter = delimiter;
        current += delimiter;
        index += delimiter.length;
        continue;
      }
    }
    if (character === ";") {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = "";
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
};

const parseTimeoutUpdate = (statement: string): TimeoutUpdate | undefined => {
  if (/^DISCARD\s+ALL$/iu.test(statement)) {
    return { type: "reset", name: "all" };
  }

  const setGroups =
    /^SET\s+(?:(?<scope>SESSION|LOCAL)\s+)?(?<name>statement|lock)_timeout\s*(?:(?:=|TO)\s*(?<value>.+)|FROM\s+CURRENT)$/iu.exec(
      statement,
    )?.groups;
  const setName = setGroups?.["name"];
  if (setName === "lock" || setName === "statement") {
    const scope =
      setGroups?.["scope"]?.toLowerCase() === "local" ? "local" : "session";
    if (!setGroups?.["value"]) {
      return { type: "preserve", name: setName, scope };
    }
    if (/^DEFAULT$/iu.test(setGroups["value"])) {
      return scope === "session"
        ? { type: "reset", name: setName }
        : { type: "preserve", name: setName, scope };
    }
    return {
      type: "set",
      name: setName,
      scope,
      state: classifyTimeout(setGroups["value"]),
    };
  }

  const setConfigGroups =
    /^(?:SELECT|PERFORM)\s+(?:pg_catalog\.)?set_config\(\s*'(?<name>statement|lock)_timeout'\s*,\s*(?<value>'(?:''|[^'])*')\s*,\s*(?<local>true|false)\s*\)$/iu.exec(
      statement,
    )?.groups;
  const setConfigName = setConfigGroups?.["name"];
  if (setConfigName === "lock" || setConfigName === "statement") {
    return {
      type: "set",
      name: setConfigName,
      scope:
        setConfigGroups?.["local"]?.toLowerCase() === "true"
          ? "local"
          : "session",
      state: classifyTimeout(setConfigGroups?.["value"] ?? ""),
    };
  }

  const resetName =
    /^RESET\s+(?<name>ALL|statement_timeout|lock_timeout)$/iu.exec(statement)
      ?.groups?.["name"];
  if (resetName?.toLowerCase() === "all") {
    return { type: "reset", name: "all" };
  }
  if (resetName?.toLowerCase() === "lock_timeout") {
    return { type: "reset", name: "lock" };
  }
  if (resetName?.toLowerCase() === "statement_timeout") {
    return { type: "reset", name: "statement" };
  }

  return undefined;
};

const parseTypeChangePolicy = (
  statement: string,
): TypeChangePolicy | undefined => {
  const policy = new RegExp(
    `^${TYPE_CHANGE_POLICY_STATEMENT}\\s+(boundedRewrite|metadataOnly)$`,
    "u",
  )
    .exec(statement)
    ?.at(1);
  if (policy === "boundedRewrite" || policy === "metadataOnly") {
    return policy;
  }
  return undefined;
};

const isCustomStatementBudget = (statement: string) =>
  /^DO\s+\$\$[\s\S]*SELECT\s+setting::integer\s+INTO\s+current_ms\s+FROM\s+pg_settings\s+WHERE\s+name\s*=\s*'statement_timeout';[\s\S]*IF\s+current_ms\s*=\s*0\s+OR\s+current_ms\s*<\s*1200000\s+THEN[\s\S]*PERFORM\s+set_config\(\s*'statement_timeout'\s*,\s*'20min'\s*,\s*false\s*\);[\s\S]*END[\s\S]*\$\$$/iu.test(
    statement,
  );

const collectUnsafeConcurrentTimeouts = (
  relativePath: string,
  source: string,
) => {
  const violations = [];
  let statementTimeout: TimeoutState = "unset";
  let lockTimeout: TimeoutState = "unset";
  let concurrentBlockOpen = false;
  let statementTimeoutRestored = false;
  let lockTimeoutRequiresRestore = false;

  for (const statement of splitSqlStatements(source)) {
    const timeoutUpdate = parseTimeoutUpdate(statement);
    const isConcurrentOperation = CONCURRENT_INDEX_OPERATION.test(statement);
    const isUnsupportedTransactionReversal =
      TRANSACTION_REVERSAL.test(statement);
    const isStatementRestore =
      timeoutUpdate?.type === "set" &&
      timeoutUpdate.name === "statement" &&
      timeoutUpdate.scope === "session" &&
      timeoutUpdate.state === "bounded";
    const isProtocolBridge =
      (timeoutUpdate?.type === "set" && timeoutUpdate.name === "lock") ||
      (timeoutUpdate?.type === "reset" &&
        (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock")) ||
      /^(?:BEGIN|COMMIT)$/iu.test(statement);

    if (isUnsupportedTransactionReversal) {
      violations.push(
        `${relativePath}: timeout safety does not support transaction reversal`,
      );
    }

    if (timeoutUpdate?.type === "set" && timeoutUpdate.scope === "session") {
      if (timeoutUpdate.name === "statement") {
        statementTimeout = timeoutUpdate.state;
      } else {
        lockTimeout = timeoutUpdate.state;
        lockTimeoutRequiresRestore = timeoutUpdate.state !== "bounded";
      }
    } else if (timeoutUpdate?.type === "reset") {
      if (timeoutUpdate.name === "all" || timeoutUpdate.name === "statement") {
        statementTimeout = "unset";
      }
      if (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock") {
        lockTimeout = "unset";
      }
    }

    if (concurrentBlockOpen) {
      if (isStatementRestore) {
        statementTimeoutRestored = true;
      }
      if (statementTimeoutRestored && !lockTimeoutRequiresRestore) {
        concurrentBlockOpen = false;
      } else if (
        !isConcurrentOperation &&
        !isStatementRestore &&
        !isProtocolBridge
      ) {
        violations.push(
          `${relativePath}: timeouts are not restored immediately after concurrent index operations`,
        );
        concurrentBlockOpen = false;
      }
    }

    if (timeoutUpdate || isUnsupportedTransactionReversal) {
      continue;
    }
    if (!isConcurrentOperation) {
      continue;
    }

    if (statementTimeout !== "unbounded") {
      violations.push(
        `${relativePath}: concurrent index operation has a timeout`,
      );
    }
    concurrentBlockOpen = true;
    statementTimeoutRestored = false;
    lockTimeoutRequiresRestore = lockTimeout === "unbounded";
  }

  if (concurrentBlockOpen && lockTimeoutRequiresRestore) {
    violations.push(`${relativePath}: lock timeout is not restored`);
  }
  if (
    (concurrentBlockOpen && !statementTimeoutRestored) ||
    (!concurrentBlockOpen && statementTimeout === "unbounded")
  ) {
    violations.push(`${relativePath}: statement timeout is not restored`);
  }

  return violations;
};

const collectUnsafeConcurrentIndexes = async (): Promise<string[]> => {
  const violations: string[] = [];
  const migrationFiles = new Bun.Glob("20*/migration.sql");

  for await (const relativePath of migrationFiles.scan({
    cwd: MIGRATIONS_DIR,
  })) {
    const source = await Bun.file(
      nodePath.join(MIGRATIONS_DIR, relativePath),
    ).text();
    const sqlWithoutLineComments = stripSqlComments(source);
    for (const match of sqlWithoutLineComments.matchAll(
      CONCURRENT_IF_NOT_EXISTS,
    )) {
      const name = match.at(1);
      if (!name || !ONLINE_VALIDATED_INDEX_NAMES.has(name)) {
        violations.push(
          `${relativePath}: ${name ?? "unknown index"} uses IF NOT EXISTS without an online validity postcondition`,
        );
      }
    }

    const droppedIndexes = new Set(
      [...sqlWithoutLineComments.matchAll(CONCURRENT_DROP)].flatMap((match) => {
        const name = match.at(1);
        return name ? [name] : [];
      }),
    );
    const concurrentUniqueCreates = [
      ...sqlWithoutLineComments.matchAll(CONCURRENT_UNIQUE_CREATE),
    ];
    const createdUniqueIndexes = new Set(
      concurrentUniqueCreates.flatMap(({ groups }) => {
        const name = groups?.["name"];
        return name ? [name] : [];
      }),
    );
    if (
      concurrentUniqueCreates.some(({ groups }) => groups?.["idempotent"]) &&
      [...droppedIndexes].some((name) => !createdUniqueIndexes.has(name))
    ) {
      violations.push(
        `${relativePath}: unique replacement drop must follow online validity postconditions`,
      );
    }
    for (const { groups } of concurrentUniqueCreates) {
      const name = groups?.["name"];
      if (!name) {
        continue;
      }
      if (!groups["idempotent"]) {
        violations.push(
          `${relativePath}: unique index ${name} is not retry-idempotent`,
        );
      }
      if (droppedIndexes.has(name)) {
        violations.push(
          `${relativePath}: retry can remove valid unique index ${name}`,
        );
      }
    }
    violations.push(...collectUnsafeConcurrentTimeouts(relativePath, source));
  }

  return violations.sort();
};

const collectUnsafeTypeChangesInMigration = (
  relativePath: string,
  source: string,
) => {
  const violations = [];
  const isCustomBoundedMigration =
    CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS.has(relativePath);

  let lockTimeout: TimeoutState = "unset";
  let statementTimeout: TimeoutState = "unset";
  let metadataOnlyBlockOpen = false;
  let activePolicy: TypeChangePolicy | undefined;
  let activePolicyUsed = false;
  let sawCustomStatementBudget = false;

  for (const statement of splitSqlStatements(source)) {
    if (TRANSACTION_REVERSAL.test(statement)) {
      violations.push(
        `${relativePath}: timeout safety does not support transaction reversal`,
      );
      continue;
    }
    if (/^DO\b/iu.test(statement) && TYPE_CHANGE_ANYWHERE.test(statement)) {
      violations.push(
        `${relativePath}: procedural type changes are not supported by the timeout safety policy`,
      );
      continue;
    }

    const declaredPolicy = parseTypeChangePolicy(statement);
    if (declaredPolicy) {
      if (metadataOnlyBlockOpen) {
        violations.push(
          `${relativePath}: statement timeout is not restored immediately after metadata-only type changes`,
        );
        metadataOnlyBlockOpen = false;
      }
      if (activePolicy && !activePolicyUsed) {
        violations.push(`${relativePath}: type change policy is unused`);
      }
      activePolicy = declaredPolicy;
      activePolicyUsed = false;
      continue;
    }

    const timeoutUpdate = parseTimeoutUpdate(statement);
    const isTypeChange = TYPE_CHANGE.test(statement);
    const isImmediateRestore =
      timeoutUpdate?.type === "set" &&
      timeoutUpdate.name === "statement" &&
      timeoutUpdate.scope === "session" &&
      timeoutUpdate.state === "bounded";

    if (
      activePolicy === "boundedRewrite" &&
      activePolicyUsed &&
      !isTypeChange
    ) {
      activePolicy = undefined;
      activePolicyUsed = false;
    }

    if (metadataOnlyBlockOpen) {
      if (!isTypeChange && !isImmediateRestore) {
        violations.push(
          `${relativePath}: statement timeout is not restored immediately after metadata-only type changes`,
        );
        metadataOnlyBlockOpen = false;
        activePolicy = undefined;
        activePolicyUsed = false;
      } else if (isImmediateRestore) {
        metadataOnlyBlockOpen = false;
        activePolicy = undefined;
        activePolicyUsed = false;
      }
    }

    if (timeoutUpdate?.type === "set") {
      const nextState =
        timeoutUpdate.scope === "session" ? timeoutUpdate.state : "unset";
      if (timeoutUpdate.name === "lock") {
        lockTimeout = nextState;
      } else {
        statementTimeout = nextState;
      }
      continue;
    }
    if (timeoutUpdate?.type === "reset") {
      if (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock") {
        lockTimeout = "unset";
      }
      if (timeoutUpdate.name === "all" || timeoutUpdate.name === "statement") {
        statementTimeout = "unset";
      }
      continue;
    }
    if (isCustomStatementBudget(statement)) {
      sawCustomStatementBudget = true;
      statementTimeout = "bounded";
      continue;
    }
    if (!isTypeChange) {
      continue;
    }

    if (!isCustomBoundedMigration && !activePolicy) {
      violations.push(
        `${relativePath}: type change lacks an explicit execution policy`,
      );
      continue;
    }
    if (lockTimeout !== "bounded") {
      violations.push(
        `${relativePath}: type change has an unbounded lock wait`,
      );
    }
    if (isCustomBoundedMigration) {
      if (!sawCustomStatementBudget || statementTimeout !== "bounded") {
        violations.push(
          `${relativePath}: custom type rewrite lacks its bounded execution budget`,
        );
      }
      continue;
    }
    activePolicyUsed = true;
    if (activePolicy === "metadataOnly" && statementTimeout !== "unbounded") {
      violations.push(
        `${relativePath}: type change has a bounded execution timeout`,
      );
    }
    if (activePolicy === "metadataOnly") {
      metadataOnlyBlockOpen = true;
    }
    if (activePolicy === "boundedRewrite" && statementTimeout !== "bounded") {
      violations.push(
        `${relativePath}: type rewrite lacks a bounded execution timeout`,
      );
    }
  }

  if (activePolicy && !activePolicyUsed) {
    violations.push(`${relativePath}: type change policy is unused`);
  }
  if (metadataOnlyBlockOpen || statementTimeout === "unbounded") {
    violations.push(`${relativePath}: statement timeout is not restored`);
  }

  return violations;
};

const collectUnsafeTypeChanges = async () => {
  const violations = [];
  const migrationFiles = new Bun.Glob("20*/migration.sql");

  for await (const relativePath of migrationFiles.scan({
    cwd: MIGRATIONS_DIR,
  })) {
    const source = await Bun.file(
      nodePath.join(MIGRATIONS_DIR, relativePath),
    ).text();
    violations.push(
      ...collectUnsafeTypeChangesInMigration(relativePath, source),
    );
  }

  return violations.sort();
};

describe("concurrent index migration safety", () => {
  test("enforces bounded-lock, unbounded-build, and validity-aware retries", async () => {
    expect(await collectUnsafeConcurrentIndexes()).toEqual([]);
  });
});

describe("lock-sensitive migration DDL", () => {
  const customStatementBudget = `DO $$
DECLARE current_ms integer;
BEGIN
  SELECT setting::integer INTO current_ms
  FROM pg_settings WHERE name = 'statement_timeout';
  IF current_ms = 0 OR current_ms < 1200000 THEN
    PERFORM set_config('statement_timeout', '20min', false);
  END IF;
END
$$;`;

  test("classifies zero-duration timeout unit forms as unbounded", () => {
    for (const value of ["0", "'0'", "0us", "'0ms'", "0s", "'0min'"]) {
      expect(classifyTimeout(value)).toBe("unbounded");
    }
    for (const value of ["1ms", "'5s'", "20min"]) {
      expect(classifyTimeout(value)).toBe("bounded");
    }
  });

  test("recognizes both PostgreSQL type-change spellings", () => {
    expect(
      TYPE_CHANGE.test(
        'ALTER TABLE "example" ALTER COLUMN "value" TYPE timestamptz',
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        'ALTER TABLE "example" ALTER COLUMN "value" SET DATA TYPE varchar(64)',
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test('ALTER TABLE "example" ALTER "value" TYPE timestamptz'),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        "ALTER TABLE example ALTER COLUMN café TYPE timestamptz",
      ),
    ).toBe(true);
  });

  test("requires immediate timeout restoration after metadata-only blocks", () => {
    const safePrefix = `
-- ${TYPE_CHANGE_POLICY.metadataOnly}
SET lock_timeout = '1s';
SET statement_timeout = 0;
ALTER TABLE "example" ALTER COLUMN "value" TYPE varchar(64);`;

    expect(
      collectUnsafeTypeChangesInMigration(
        "safe/migration.sql",
        `${safePrefix}\nSET statement_timeout = '5s';\nSELECT 1;`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        "unsafe/migration.sql",
        `${safePrefix}\nSELECT 1;\nSET statement_timeout = '5s';`,
      ),
    ).toContain(
      "unsafe/migration.sql: statement timeout is not restored immediately after metadata-only type changes",
    );
  });

  test("scopes execution policies to contiguous type-change blocks", () => {
    const safeSource = `
SET lock_timeout = '1s';
-- ${TYPE_CHANGE_POLICY.metadataOnly}
SET statement_timeout = 0;
ALTER TABLE example ALTER COLUMN value TYPE varchar(64);
SET statement_timeout = '5s';
-- ${TYPE_CHANGE_POLICY.boundedRewrite}
ALTER TABLE example ALTER COLUMN created_at TYPE timestamptz;
SELECT 1;`;
    expect(
      collectUnsafeTypeChangesInMigration("safe/migration.sql", safeSource),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        "unsafe/migration.sql",
        safeSource.replace(`-- ${TYPE_CHANGE_POLICY.boundedRewrite}\n`, ""),
      ),
    ).toContain(
      "unsafe/migration.sql: type change lacks an explicit execution policy",
    );
  });

  test("rejects transaction-local timeout protocols", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    expect(parseTimeoutUpdate("SET LOCAL statement_timeout = 0")).toEqual({
      type: "set",
      name: "statement",
      scope: "local",
      state: "unbounded",
    });
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `BEGIN;
        SET LOCAL lock_timeout = '1s';
        COMMIT;
        ${customStatementBudget}
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    expect(parseTimeoutUpdate("SET statement_timeout FROM CURRENT")).toEqual({
      type: "preserve",
      name: "statement",
      scope: "session",
    });
  });

  test("tracks every timeout form around concurrent index operations", () => {
    const unsafePrefix = "SET statement_timeout = 0; RESET statement_timeout;";
    expect(
      collectUnsafeConcurrentTimeouts(
        "reset/migration.sql",
        `${unsafePrefix} CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "reset/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "to/migration.sql",
        `SET statement_timeout = 0;
        SET statement_timeout TO '5s';
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain("to/migration.sql: concurrent index operation has a timeout");
    expect(
      collectUnsafeConcurrentTimeouts(
        "set-config/migration.sql",
        `SET statement_timeout = 0;
        SELECT set_config('statement_timeout', '5s', false);
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "set-config/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "safe/migration.sql",
        `SET SESSION statement_timeout TO 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeConcurrentTimeouts(
        "safe-set-config/migration.sql",
        `SELECT pg_catalog.set_config('statement_timeout', '0', false);
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SELECT set_config('statement_timeout', '5s', false);`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeConcurrentTimeouts(
        "from-current/migration.sql",
        `SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout FROM CURRENT;`,
      ),
    ).toContain(
      "from-current/migration.sql: timeouts are not restored immediately after concurrent index operations",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "reset-restore/migration.sql",
        `SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        RESET statement_timeout;`,
      ),
    ).toContain(
      "reset-restore/migration.sql: timeouts are not restored immediately after concurrent index operations",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "discard-all/migration.sql",
        `SET statement_timeout = 0;
        DISCARD ALL;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "discard-all/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "unbounded-lock/migration.sql",
        `SET statement_timeout = 0;
        SET lock_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';`,
      ),
    ).toContain("unbounded-lock/migration.sql: lock timeout is not restored");
    expect(
      collectUnsafeConcurrentTimeouts(
        "restored-lock/migration.sql",
        `SET statement_timeout = 0;
        SET lock_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';
        SET lock_timeout = '1s';`,
      ),
    ).toEqual([]);
  });

  test("rejects transaction reversal in timeout protocols", () => {
    expect(
      collectUnsafeConcurrentTimeouts(
        "rollback/migration.sql",
        `BEGIN;
        SET statement_timeout = 0;
        ROLLBACK;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "rollback/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "savepoint/migration.sql",
        `SAVEPOINT before_timeout;
        SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "savepoint/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        "type-rollback/migration.sql",
        `BEGIN;
        SET lock_timeout = '1s';
        ROLLBACK;
        -- ${TYPE_CHANGE_POLICY.boundedRewrite}
        SET statement_timeout = '5s';
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(
      "type-rollback/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        "type-abort/migration.sql",
        `BEGIN;
        SET lock_timeout = '1s';
        ABORT;
        -- ${TYPE_CHANGE_POLICY.boundedRewrite}
        SET statement_timeout = '5s';
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(
      "type-abort/migration.sql: timeout safety does not support transaction reversal",
    );
  });

  test("keeps lock waits bounded for custom execution budgets", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    for (const timeoutSetup of [
      "SET lock_timeout = 0",
      "SET lock_timeout = '1s'; RESET lock_timeout",
      "SET lock_timeout = '1s'; SET lock_timeout TO 0ms",
      "SET lock_timeout = '1s'; RESET ALL",
    ]) {
      expect(
        collectUnsafeTypeChangesInMigration(
          relativePath,
          `${timeoutSetup}; ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
        ),
      ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    }
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET SESSION lock_timeout TO '1s';
        ${customStatementBudget}
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SELECT set_config('lock_timeout', '1s', false);
        ${customStatementBudget}
        SELECT set_config('lock_timeout', '0', false);
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
  });

  test("requires and preserves the custom statement budget", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    const typeChange =
      "ALTER TABLE example ALTER COLUMN value TYPE timestamptz;";
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s'; ${typeChange}`,
      ),
    ).toContain(
      `${relativePath}: custom type rewrite lacks its bounded execution budget`,
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s';
        ${customStatementBudget}
        RESET statement_timeout;
        ${typeChange}`,
      ),
    ).toContain(
      `${relativePath}: custom type rewrite lacks its bounded execution budget`,
    );
  });

  test("ignores timeout text in SQL comments and quoted bodies", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SELECT 1; -- SET lock_timeout = '1s';
        /* SET lock_timeout = '1s'; */
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s';
        ${customStatementBudget}
        SELECT '-- RESET lock_timeout';
        DO $body$ BEGIN PERFORM '/* RESET ALL */'; END $body$;
        /* RESET lock_timeout; */
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toEqual([]);
  });

  test("applies backslash escaping only to PostgreSQL escape strings", () => {
    const ordinaryStringSource = String.raw`SELECT '\';
      ALTER TABLE example ALTER COLUMN value TYPE varchar(64);`;
    expect(splitSqlStatements(ordinaryStringSource)).toHaveLength(2);
    expect(
      collectUnsafeTypeChangesInMigration(
        "ordinary-string/migration.sql",
        ordinaryStringSource,
      ),
    ).toContain(
      "ordinary-string/migration.sql: type change lacks an explicit execution policy",
    );

    expect(
      splitSqlStatements(String.raw`SELECT E'it\'s; still quoted'; SELECT 1;`),
    ).toHaveLength(2);
  });

  test("requires token boundaries for dollar-quoted bodies", () => {
    const identifierSource = `SELECT foo$bar$;
      ALTER TABLE example ALTER COLUMN value TYPE varchar(64);`;
    expect(splitSqlStatements(identifierSource)).toHaveLength(2);
    expect(
      collectUnsafeTypeChangesInMigration(
        "dollar-identifier/migration.sql",
        identifierSource,
      ),
    ).toContain(
      "dollar-identifier/migration.sql: type change lacks an explicit execution policy",
    );
  });

  test("rejects type changes hidden inside procedural bodies", () => {
    expect(
      collectUnsafeTypeChangesInMigration(
        "procedural/migration.sql",
        `DO $$
        BEGIN
          ALTER TABLE example ALTER COLUMN value TYPE varchar(64);
        END
        $$;`,
      ),
    ).toContain(
      "procedural/migration.sql: procedural type changes are not supported by the timeout safety policy",
    );
  });

  test("bounds lock waits without interrupting acquired type changes", async () => {
    expect(await collectUnsafeTypeChanges()).toEqual([]);
  });
});
