import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import type { DdlFunctionDeclaration } from "./online-ddl-functions";
import { DDL_FUNCTION_NAMES, DDL_FUNCTIONS } from "./online-ddl-functions";

const isOffline = ({ online }: DdlFunctionDeclaration): boolean => !online;

const API_ROOT = path.resolve(import.meta.dir, "../..");

const FUNCTION_HEADER =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/giu;
const BODY_OPENER = /\bAS\s+(\$[A-Za-z_]*\$)/u;
// SQL-standard bodies (`RETURN expr` or `BEGIN ATOMIC ... END`) carry no tag.
const STANDARD_BODY = /\b(?:RETURN|BEGIN\s+ATOMIC)\b/iu;
const STATEMENT_BREAK = "--> statement-breakpoint";
const SQL_COMMENT = /--[^\n]*|\/\*[\S\s]*?\*\//gu;

/** DDL that takes a table lock, as a function body can spell it. */
const TABLE_LOCKING_DDL = [
  /\b(?:create|alter|drop)\s+policy\b/iu,
  /\balter\s+table\b/iu,
  /\b(?:create|drop)\s+(?:unique\s+)?index\b/iu,
  /\breindex\b/iu,
  /\btruncate\b/iu,
  /\block\s+(?:table\s+)?(?:only\s+)?[\w."]+\s+in\b/iu,
];

type MigrationFunction = {
  migration: string;
  name: string;
  body: string;
};

/** Every function a migration defines, with its dollar-quoted body. */
const readMigrationFunctions = async (): Promise<{
  functions: MigrationFunction[];
  unparsed: string[];
}> => {
  const functions: MigrationFunction[] = [];
  const unparsed: string[] = [];
  for await (const file of new Glob("drizzle/**/*.sql").scan(API_ROOT)) {
    const text = await Bun.file(path.join(API_ROOT, file)).text();
    for (const header of text.matchAll(FUNCTION_HEADER)) {
      const name = header[1] ?? "";
      const after = text.slice(header.index + header[0].length);
      // One statement per function: never read the next statement's body.
      const breakAt = after.indexOf(STATEMENT_BREAK);
      const rest = breakAt === -1 ? after : after.slice(0, breakAt);
      const opener = BODY_OPENER.exec(rest);
      const tag = opener?.[1];
      if (opener !== null && tag !== undefined) {
        const start = opener.index + opener[0].length;
        const end = rest.indexOf(tag, start);
        if (end === -1) {
          unparsed.push(`${file}: ${name}`);
          continue;
        }
        functions.push({ migration: file, name, body: rest.slice(start, end) });
        continue;
      }
      const standard = STANDARD_BODY.exec(rest);
      if (standard === null) {
        unparsed.push(`${file}: ${name}`);
        continue;
      }
      functions.push({
        migration: file,
        name,
        body: rest.slice(standard.index),
      });
    }
  }
  return { functions, unparsed };
};

const takesTableLocks = (body: string): boolean => {
  const sql = body.replace(SQL_COMMENT, " ");
  return TABLE_LOCKING_DDL.some((pattern) => pattern.test(sql));
};

describe("database functions that run table-locking DDL", () => {
  test("every one a migration defines is declared, and every declaration is one", async () => {
    const { functions, unparsed } = await readMigrationFunctions();
    expect(unparsed).toEqual([]);
    expect(functions.length).toBeGreaterThan(0);
    const locking = new Set(
      functions
        .filter(({ body }) => takesTableLocks(body))
        .map(({ name }) => name),
    );
    expect(
      [...locking].filter((name) => !DDL_FUNCTION_NAMES.includes(name)),
      "declare each in DDL_FUNCTIONS (online-ddl-functions.ts)",
    ).toEqual([]);
    expect(
      DDL_FUNCTION_NAMES.filter((name) => !locking.has(name)),
      "a declaration names no migration function that runs DDL",
    ).toEqual([]);
  });

  test("the census reads DDL inside a body and ignores it in comments", () => {
    expect(takesTableLocks("BEGIN DROP POLICY p ON t; END")).toBe(true);
    expect(takesTableLocks("BEGIN LOCK public.t IN SHARE MODE; END")).toBe(
      true,
    );
    expect(
      takesTableLocks("BEGIN -- alter table t later\n UPDATE t SET a = 1; END"),
    ).toBe(false);
  });

  test("no database module calls a function the online phase may not call", async () => {
    const offline = Object.entries(DDL_FUNCTIONS)
      .filter(([, declaration]) => isOffline(declaration))
      .map(([name]) => name);
    const calls: string[] = [];
    for await (const file of new Glob("src/db/**/*.ts").scan(API_ROOT)) {
      if (file.endsWith(".test.ts") || file.includes("__fixtures__")) {
        continue;
      }
      const text = await Bun.file(path.join(API_ROOT, file)).text();
      for (const name of offline) {
        if (new RegExp(`\\b${name}\\s*\\(`, "u").test(text)) {
          calls.push(`${file}: ${name}`);
        }
      }
    }
    expect(calls).toEqual([]);
  });
});
