import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { ONLINE_VALIDATED_INDEX_NAMES } from "./online-migrations";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const SAFETY_TOKEN =
  /\bSET\s+(?:LOCAL\s+)?statement_timeout\s*=\s*(?:'[^']*'|[^\s;]+)|\b(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY\b/giu;
const UNBOUNDED_TIMEOUT = /^SET\s+statement_timeout\s*=\s*(?:'0'|0)$/iu;
const CONCURRENT_IF_NOT_EXISTS =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/giu;
const CONCURRENT_UNIQUE_CREATE =
  /\bCREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY(?<idempotent>\s+IF\s+NOT\s+EXISTS)?\s+"(?<name>[^"]+)"/giu;
const CONCURRENT_DROP =
  /\bDROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+"([^"]+)"/giu;

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
      [...sqlWithoutLineComments.matchAll(CONCURRENT_DROP)].flatMap((match) =>
        match.at(1) ? [match[1]] : [],
      ),
    );
    for (const { groups } of sqlWithoutLineComments.matchAll(
      CONCURRENT_UNIQUE_CREATE,
    )) {
      const name = groups?.name;
      if (!name) {
        continue;
      }
      if (!groups.idempotent) {
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

describe("concurrent index migration safety", () => {
  test("enforces bounded-lock, unbounded-build, and validity-aware retries", async () => {
    expect(await collectUnsafeConcurrentIndexes()).toEqual([]);
  });
});
