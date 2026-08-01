import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { ONLINE_VALIDATED_INDEX_NAMES } from "./online-migrations";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const SAFETY_TOKEN =
  /\bSET\s+(?:LOCAL\s+)?statement_timeout\s*=\s*(?:'[^']*'|[^\s;]+)|\b(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY\b/giu;
const ZERO_DURATION = /^'?0\s*(?:us|ms|s|min|h|d)?'?$/iu;
const TIMEOUT_SETTING =
  /^SET\s+(?:LOCAL\s+)?(?<name>statement|lock)_timeout\s*=\s*(?<value>.+)$/iu;
const UNBOUNDED_TIMEOUT =
  /^SET\s+(?:LOCAL\s+)?statement_timeout\s*=\s*'?0\s*(?:us|ms|s|min|h|d)?'?$/iu;
const CONCURRENT_IF_NOT_EXISTS =
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/giu;
const CONCURRENT_UNIQUE_CREATE =
  /\bCREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY(?<idempotent>\s+IF\s+NOT\s+EXISTS)?\s+"(?<name>[^"]+)"/giu;
const CONCURRENT_DROP =
  /\bDROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+"([^"]+)"/giu;
const TYPE_CHANGE =
  /\bALTER\s+TABLE\b[^;]*?\bALTER\s+COLUMN\b[^;]*?\b(?:SET\s+DATA\s+)?TYPE\b/iu;
const TYPE_CHANGE_SAFETY_TOKEN = new RegExp(
  String.raw`\bSET\s+(?:LOCAL\s+)?(?:statement|lock)_timeout\s*=\s*(?:'[^']*'|[^\s;]+)|${TYPE_CHANGE.source}`,
  "giu",
);
const TYPE_CHANGE_POLICY = {
  boundedRewrite: "stella-migration-safety: bounded-type-rewrite",
  metadataOnly: "stella-migration-safety: metadata-only-type-change",
} as const;
const CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS = new Set([
  // This conversion derives a 20-minute execution budget from pg_settings in
  // a DO block, which the token scanner deliberately does not interpret.
  "20260729150000_timestamptz_everywhere/migration.sql",
]);

type TimeoutState = "bounded" | "unbounded" | "unset";

const classifyTimeout = (value: string): TimeoutState => {
  if (ZERO_DURATION.test(value)) {
    return "unbounded";
  }
  if (/^'?[1-9][0-9]*\s*(?:us|ms|s|min|h|d)?'?$/iu.test(value)) {
    return "bounded";
  }
  return "unset";
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

const collectUnsafeTypeChanges = async () => {
  const violations = [];
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
    const isCustomBoundedMigration =
      CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS.has(relativePath);
    const hasMetadataOnlyPolicy = source.includes(
      TYPE_CHANGE_POLICY.metadataOnly,
    );
    const hasBoundedRewritePolicy = source.includes(
      TYPE_CHANGE_POLICY.boundedRewrite,
    );
    if (hasMetadataOnlyPolicy && hasBoundedRewritePolicy) {
      violations.push(`${relativePath}: type change policies conflict`);
    }

    let lockTimeout: TimeoutState = "unset";
    let statementTimeout: TimeoutState = "unset";
    let sawTypeChange = false;

    for (const match of sqlWithoutLineComments.matchAll(
      TYPE_CHANGE_SAFETY_TOKEN,
    )) {
      const token = match[0].replaceAll(/\s+/gu, " ").trim();
      if (/^SET\s/iu.test(token)) {
        const setting = TIMEOUT_SETTING.exec(token)?.groups;
        if (setting?.["name"] === "lock") {
          lockTimeout = classifyTimeout(setting["value"] ?? "");
        } else if (setting?.["name"] === "statement") {
          statementTimeout = classifyTimeout(setting["value"] ?? "");
        }
        continue;
      }

      sawTypeChange = true;
      if (isCustomBoundedMigration) {
        continue;
      }
      if (!hasMetadataOnlyPolicy && !hasBoundedRewritePolicy) {
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
      if (hasMetadataOnlyPolicy && statementTimeout !== "unbounded") {
        violations.push(
          `${relativePath}: type change has a bounded execution timeout`,
        );
      }
      if (hasBoundedRewritePolicy && statementTimeout !== "bounded") {
        violations.push(
          `${relativePath}: type rewrite lacks a bounded execution timeout`,
        );
      }
    }

    if (hasMetadataOnlyPolicy && !sawTypeChange) {
      violations.push(`${relativePath}: metadata-only policy is unused`);
    }
    if (hasBoundedRewritePolicy && !sawTypeChange) {
      violations.push(`${relativePath}: bounded-rewrite policy is unused`);
    }
    if (hasMetadataOnlyPolicy && statementTimeout === "unbounded") {
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

describe("lock-sensitive migration DDL", () => {
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
  });

  test("bounds lock waits without interrupting acquired type changes", async () => {
    expect(await collectUnsafeTypeChanges()).toEqual([]);
  });
});
