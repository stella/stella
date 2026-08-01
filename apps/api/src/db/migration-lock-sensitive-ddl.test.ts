import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const SAFETY_TOKEN =
  /\bSET\s+(?:LOCAL\s+)?(?:statement|lock)_timeout\s*=\s*(?:'[^']*'|[^\s;]+)|\bALTER\s+TABLE\b[^;]*?\bALTER\s+COLUMN\b[^;]*?\bSET\s+DATA\s+TYPE\b/giu;
const UNBOUNDED_STATEMENT_TIMEOUT =
  /^SET\s+(?:LOCAL\s+)?statement_timeout\s*=\s*(?:'0'|0)$/iu;
const LOCK_TIMEOUT = /^SET\s+(?:LOCAL\s+)?lock_timeout\s*=\s*(.+)$/iu;

const collectUnsafeTypeChanges = async (): Promise<string[]> => {
  const violations: string[] = [];
  const migrationFiles = new Bun.Glob("20*/migration.sql");

  for await (const relativePath of migrationFiles.scan({
    cwd: MIGRATIONS_DIR,
  })) {
    const source = await Bun.file(
      nodePath.join(MIGRATIONS_DIR, relativePath),
    ).text();
    const sqlWithoutLineComments = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    let hasBoundedLockTimeout = false;
    let hasUnboundedStatementTimeout = false;
    let sawTypeChange = false;

    for (const match of sqlWithoutLineComments.matchAll(SAFETY_TOKEN)) {
      const token = match[0].replaceAll(/\s+/gu, " ").trim();
      if (/^SET\s/iu.test(token)) {
        const lockTimeout = LOCK_TIMEOUT.exec(token)?.at(1);
        if (lockTimeout) {
          hasBoundedLockTimeout = !/^(?:'0'|0)$/u.test(lockTimeout);
        } else {
          hasUnboundedStatementTimeout =
            UNBOUNDED_STATEMENT_TIMEOUT.test(token);
        }
        continue;
      }

      sawTypeChange = true;
      if (!hasBoundedLockTimeout) {
        violations.push(
          `${relativePath}: type change has an unbounded lock wait`,
        );
      }
      if (!hasUnboundedStatementTimeout) {
        violations.push(
          `${relativePath}: type change has a bounded execution timeout`,
        );
      }
    }

    if (sawTypeChange && hasUnboundedStatementTimeout) {
      violations.push(`${relativePath}: statement timeout is not restored`);
    }
  }

  return violations.sort();
};

describe("lock-sensitive migration DDL", () => {
  test("bounds lock waits without interrupting acquired type changes", async () => {
    expect(await collectUnsafeTypeChanges()).toEqual([]);
  });
});
