#!/usr/bin/env bun
// A column can ship on a table, be written by no handler, and be read by no
// consumer for months -- `properties.kinds` did exactly that until the gap
// surfaced as a user-visible defect (the web client had no way to scope
// properties by entity kind; see apps/api/src/handlers/properties/list.ts).
// The type system cannot flag something that is consistently *absent* from
// call sites, so this script greps application source for every schema
// column instead and fails CI when one is referenced nowhere.
//
// Usage: bun scripts/check-dead-columns.ts

import { panic } from "better-result";
import { getColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import * as schema from "../apps/api/src/db/schema";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ALLOWLIST_PATH = path.join(
  REPO_ROOT,
  "scripts/dead-columns.allowlist.json",
);
const SOURCE_ROOTS = ["apps", "packages"] as const;

// Present on nearly every table and referenced so pervasively (auth
// middleware, RLS scoping, base row shapes) that checking them adds no
// signal. Every other column -- including other foreign keys -- stays
// checked; a merely *common* name (e.g. "name") will simply be found
// somewhere in the corpus rather than being excluded, so it never produces a
// false "dead" report. The failure mode this check accepts is one-directional:
// a column referenced nowhere is always reported, a common name never is.
const IGNORED_COLUMN_KEYS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "workspaceId",
  "organizationId",
  "deletedAt",
]);

// The schema definitions themselves obviously reference every column; excluding
// them is what makes this a "used elsewhere" check rather than a tautology.
const EXCLUDED_PATH_PREFIXES = ["apps/api/src/db/schema"] as const;
// Migrations replay column names verbatim and would make every column look
// referenced; generated/vendor output belongs out for the same reason.
const EXCLUDED_PATH_SEGMENTS = new Set(["node_modules", "drizzle"]);

type ColumnInfo = {
  table: string;
  tsKey: string;
  sqlName: string;
};

type AllowlistEntry = {
  table: string;
  column: string;
  reason: string;
};

const allowlistKey = (table: string, column: string): string =>
  `${table}.${column}`;

/**
 * Enumerates every `pgTable` the schema module exports, along with each
 * column's TypeScript property key and its underlying SQL column name.
 */
const collectColumns = (): ColumnInfo[] => {
  const columns: ColumnInfo[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) {
      continue;
    }
    const table = getTableName(value);
    const tableColumns = getColumns(value);
    for (const [tsKey, column] of Object.entries(tableColumns)) {
      if (IGNORED_COLUMN_KEYS.has(tsKey)) {
        continue;
      }
      columns.push({ table, tsKey, sqlName: column.name });
    }
  }
  return columns;
};

/**
 * True when `relativePath` (posix-separated, relative to the repo root)
 * should be scanned for column references: application `.ts`/`.tsx` source,
 * excluding the schema definitions, migrations, generated typings, and tests.
 */
export const shouldScanFile = (relativePath: string): boolean => {
  if (!(relativePath.endsWith(".ts") || relativePath.endsWith(".tsx"))) {
    return false;
  }
  if (relativePath.endsWith(".d.ts")) {
    return false;
  }
  // Also excludes *.integration.test.ts and *.property.test.ts, which share
  // this suffix.
  if (relativePath.endsWith(".test.ts") || relativePath.endsWith(".test.tsx")) {
    return false;
  }
  if (
    EXCLUDED_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  ) {
    return false;
  }
  const segments = relativePath.split("/");
  return !segments.some((segment) => EXCLUDED_PATH_SEGMENTS.has(segment));
};

const walk = (directory: string, out: string[]): void => {
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      if (EXCLUDED_PATH_SEGMENTS.has(entry)) {
        continue;
      }
      walk(absolute, out);
    } else if (stats.isFile()) {
      out.push(absolute);
    }
  }
};

/** Every candidate source file under each workspace's `src` directory. */
const collectSourceFiles = (): string[] => {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const rootDirectory = path.join(REPO_ROOT, root);
    for (const workspaceName of readdirSync(rootDirectory)) {
      const srcDirectory = path.join(rootDirectory, workspaceName, "src");
      if (!statSync(srcDirectory, { throwIfNoEntry: false })?.isDirectory()) {
        continue;
      }
      walk(srcDirectory, files);
    }
  }
  return files.filter((absolute) =>
    shouldScanFile(
      path.relative(REPO_ROOT, absolute).split(path.sep).join("/"),
    ),
  );
};

const buildCorpus = (files: readonly string[]): string =>
  files.map((file) => readFileSync(file, "utf-8")).join("\n");

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A column counts as referenced when its TS key or SQL name appears as a
 * whole word anywhere in the corpus. `\b` word boundaries alone cover every
 * shape called out by the spec -- `.key` member access, `key:` object
 * literal/destructure keys (including shorthand `{ key }`), quoted `"key"`
 * string keys, and `${key}` template interpolation -- because each of those
 * contexts places a non-word character (`.`, `:`, quote, `{`/`}`) directly
 * against the identifier. It also matches the SQL name inside a `` sql`...` ``
 * template or a plain string for the same reason.
 */
export const isColumnReferenced = ({
  corpus,
  tsKey,
  sqlName,
}: {
  corpus: string;
  tsKey: string;
  sqlName: string;
}): boolean => {
  const tsKeyPattern = new RegExp(`\\b${escapeRegExp(tsKey)}\\b`, "u");
  if (tsKeyPattern.test(corpus)) {
    return true;
  }
  if (sqlName === tsKey) {
    return false;
  }
  const sqlNamePattern = new RegExp(`\\b${escapeRegExp(sqlName)}\\b`, "u");
  return sqlNamePattern.test(corpus);
};

const isAllowlistEntry = (value: unknown): value is AllowlistEntry =>
  typeof value === "object" &&
  value !== null &&
  "table" in value &&
  "column" in value &&
  "reason" in value &&
  typeof value.table === "string" &&
  typeof value.column === "string" &&
  typeof value.reason === "string";

const loadAllowlist = (): AllowlistEntry[] => {
  const raw = readFileSync(ALLOWLIST_PATH, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isAllowlistEntry)) {
    return panic(
      `${path.relative(REPO_ROOT, ALLOWLIST_PATH)} must be a JSON array of { table, column, reason } entries`,
    );
  }
  return parsed;
};

const main = (): void => {
  const columns = collectColumns();
  const files = collectSourceFiles();
  const corpus = buildCorpus(files);

  const deadColumns = columns.filter(
    (column) =>
      !isColumnReferenced({
        corpus,
        tsKey: column.tsKey,
        sqlName: column.sqlName,
      }),
  );
  const deadColumnKeys = new Set(
    deadColumns.map((column) => allowlistKey(column.table, column.tsKey)),
  );
  const validColumnKeys = new Set(
    columns.map((column) => allowlistKey(column.table, column.tsKey)),
  );

  const allowlist = loadAllowlist();
  let failed = false;

  for (const entry of allowlist) {
    const key = allowlistKey(entry.table, entry.column);
    if (!validColumnKeys.has(key)) {
      failed = true;
      console.error(
        `stale allowlist entry: ${entry.table}.${entry.column} does not match any current schema column -- remove it from ${path.relative(REPO_ROOT, ALLOWLIST_PATH)}`,
      );
    } else if (!deadColumnKeys.has(key)) {
      failed = true;
      console.error(
        `stale allowlist entry: ${entry.table}.${entry.column} is no longer dead -- remove it from ${path.relative(REPO_ROOT, ALLOWLIST_PATH)}`,
      );
    }
  }

  const allowlistedKeys = new Set(
    allowlist.map((entry) => allowlistKey(entry.table, entry.column)),
  );
  const unallowlistedDead = deadColumns.filter(
    (column) => !allowlistedKeys.has(allowlistKey(column.table, column.tsKey)),
  );

  for (const column of unallowlistedDead) {
    failed = true;
    console.error(
      `dead column: ${column.table}.${column.tsKey} (sql ${column.sqlName})`,
    );
  }

  if (failed) {
    process.exit(1);
  }

  const tableCount = new Set(columns.map((column) => column.table)).size;
  const referencedCount = columns.length - deadColumns.length;
  console.log(
    `check-dead-columns: OK, ${referencedCount} columns across ${tableCount} tables referenced.`,
  );
};

if (import.meta.main) {
  main();
}
