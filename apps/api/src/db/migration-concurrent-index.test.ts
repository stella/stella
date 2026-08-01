import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const SAFETY_TOKEN =
  /\bSET\s+(?:LOCAL\s+)?statement_timeout\s*=\s*(?:'[^']*'|[^\s;]+)|\b(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY\b/giu;
const UNBOUNDED_TIMEOUT = /^SET\s+statement_timeout\s*=\s*(?:'0'|0)$/iu;
const UNSAFE_IDEMPOTENCE =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\b/iu;

const collectUnsafeConcurrentIndexes = async (): Promise<string[]> => {
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
    if (UNSAFE_IDEMPOTENCE.test(sqlWithoutLineComments)) {
      violations.push(`${relativePath}: concurrent index uses IF NOT EXISTS`);
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

describe("concurrent index migration safety", () => {
  test("disables statement timeout around every concurrent index operation", async () => {
    expect(await collectUnsafeConcurrentIndexes()).toEqual([]);
  });
});
