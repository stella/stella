import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { ONLINE_VALIDATED_INDEX_NAMES } from "./online-migrations";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const SAFETY_TOKEN =
  /\bSET\s+(?:(?:SESSION|LOCAL)\s+)?statement_timeout\s*=\s*(?:'[^']*'|[^\s;]+)|\b(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY\b/giu;
const ZERO_DURATION = /^'?0\s*(?:us|ms|s|min|h|d)?'?$/iu;
const UNBOUNDED_TIMEOUT =
  /^SET\s+(?:SESSION\s+)?statement_timeout\s*=\s*'?0\s*(?:us|ms|s|min|h|d)?'?$/iu;
const CONCURRENT_IF_NOT_EXISTS =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/giu;
const CONCURRENT_UNIQUE_CREATE =
  /\bCREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY(?<idempotent>\s+IF\s+NOT\s+EXISTS)?\s+"(?<name>[^"]+)"/giu;
const CONCURRENT_DROP =
  /\bDROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+"([^"]+)"/giu;
const TYPE_CHANGE =
  /^ALTER\s+TABLE\b[^;]*?\bALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|[A-Z_][A-Z0-9_$]*)\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
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

const dollarQuoteDelimiterAt = (source: string, index: number) =>
  /^\$(?:[A-Z_][A-Z0-9_]*)?\$/iu.exec(source.slice(index))?.at(0);

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
  let quote: '"' | "'" | undefined;

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
      if (character === "\\" && nextCharacter) {
        result += nextCharacter;
        index += 2;
      } else if (character === quote && nextCharacter === quote) {
        result += nextCharacter;
        index += 2;
      } else {
        if (character === quote) {
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
      quote = character;
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
  let quote: '"' | "'" | undefined;

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
      if (character === "\\" && nextCharacter) {
        current += nextCharacter;
        index += 2;
      } else if (character === quote && nextCharacter === quote) {
        current += nextCharacter;
        index += 2;
      } else {
        if (character === quote) {
          quote = undefined;
        }
        index += 1;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
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
  const setGroups =
    /^SET\s+(?:(?<scope>SESSION|LOCAL)\s+)?(?<name>statement|lock)_timeout\s*(?:(?:=|TO)\s*(?<value>.+)|FROM\s+CURRENT)$/iu.exec(
      statement,
    )?.groups;
  const setName = setGroups?.["name"];
  if (setName === "lock" || setName === "statement") {
    return {
      type: "set",
      name: setName,
      scope:
        setGroups?.["scope"]?.toLowerCase() === "local" ? "local" : "session",
      state: classifyTimeout(setGroups?.["value"] ?? ""),
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
  /^DO\s+\$\$[\s\S]*SELECT\s+setting::integer\s+INTO\s+current_ms\s+FROM\s+pg_settings\s+WHERE\s+name\s*=\s*'statement_timeout';[\s\S]*IF\s+current_ms\s*<>\s*0\s+AND\s+current_ms\s*<\s*1200000\s+THEN[\s\S]*PERFORM\s+set_config\(\s*'statement_timeout'\s*,\s*'20min'\s*,\s*false\s*\);[\s\S]*END[\s\S]*\$\$$/iu.test(
    statement,
  );

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
    let hasUnboundedTimeout = false;
    let sawConcurrentIndex = false;

    for (const match of sqlWithoutLineComments.matchAll(SAFETY_TOKEN)) {
      const token = match[0].replaceAll(/\s+/gu, " ").trim();
      if (/^SET\s/iu.test(token)) {
        hasUnboundedTimeout = UNBOUNDED_TIMEOUT.test(token);
        continue;
      }
      if (!hasUnboundedTimeout) {
        violations.push(
          `${relativePath}: concurrent index operation has a timeout`,
        );
      }
      sawConcurrentIndex = true;
    }

    if (sawConcurrentIndex && hasUnboundedTimeout) {
      violations.push(`${relativePath}: statement timeout is not restored`);
    }
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
  IF current_ms <> 0 AND current_ms < 1200000 THEN
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
    expect(UNBOUNDED_TIMEOUT.test("SET LOCAL statement_timeout = 0")).toBe(
      false,
    );
    expect(UNBOUNDED_TIMEOUT.test("SET SESSION statement_timeout = 0")).toBe(
      true,
    );
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

  test("bounds lock waits without interrupting acquired type changes", async () => {
    expect(await collectUnsafeTypeChanges()).toEqual([]);
  });
});
