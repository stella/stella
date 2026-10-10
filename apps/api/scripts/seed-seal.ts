/**
 * Seal a seeded local stack, then tell whether it still holds only seeded
 * content. Screenshots of a local stack may be attached to public pull
 * requests only while it does: anything created after the seed (an upload, a
 * typed name, a chat) could carry private data.
 *
 * The seal is a per-table fingerprint of every row, taken right after the
 * seed. Non-content writes have explicit operational or derived-on-read classes;
 * their changes are reported, while content must match. The dev runner
 * seals only a database that was fresh or still matched its seal before the
 * seed ran, so rows entered earlier can never become part of the baseline.
 *
 * `check` prints one of:
 *   {"status":"fresh"}      no user exists yet, so nothing was entered
 *   {"status":"pristine","changes":[...]}   content matches; classified changes
 *   {"status":"modified","tables":[...]}
 *   {"status":"unsealed"}   no seal file
 *
 * Usage:
 *   bun scripts/seed-seal.ts write <seal.json>
 *   bun scripts/seed-seal.ts check <seal.json>
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Content is fingerprinted by default. Every exemption must declare its class;
// derived rows keep a baseline digest so checks report their changes.
type NonContentClassification =
  | { kind: "operational" }
  | {
      kind: "derived-on-read";
      owner: string;
      reason: string;
      rows: { kind: "all" } | { kind: "action"; actionKind: string };
    };

export const NON_CONTENT_TABLES = {
  "public.apikey": { kind: "operational" },
  "public.audit_logs": { kind: "operational" },
  "public.scheduler_job_runs": { kind: "operational" },
  "public.scheduler_jobs": { kind: "operational" },
  "public.session": { kind: "operational" },
  "public.document_review_parties": {
    kind: "derived-on-read",
    owner: "apps/api/src/handlers/document-reviews/parties.ts",
    reason:
      "Party detection cache keyed by entity version and review prompt version.",
    rows: { kind: "all" },
  },
  "public.usage_events": {
    kind: "derived-on-read",
    owner: "apps/api/src/handlers/document-reviews/parties.ts",
    reason:
      "Metering for read-time party detection; other actions remain fingerprinted.",
    rows: { kind: "action", actionKind: "document-reviews.parties" },
  },
} as const satisfies Record<string, NonContentClassification>;

const classifications = new Map<string, NonContentClassification>(
  Object.entries(NON_CONTENT_TABLES),
);

export const classifySealTable = (table: string) =>
  classifications.get(table) ?? { kind: "content" as const };

const MODES = ["write", "check"] as const;
type Mode = (typeof MODES)[number];

type Digests = Record<string, string>;
export type Seal = { content: Digests; nonContent: Digests };

const isMode = (value: string | undefined): value is Mode =>
  MODES.some((mode) => mode === value);

const isDigests = (value: unknown): value is Digests =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((digest) => typeof digest === "string");

export const isSeal = (value: unknown): value is Seal =>
  typeof value === "object" &&
  value !== null &&
  "content" in value &&
  "nonContent" in value &&
  isDigests(value.content) &&
  isDigests(value.nonContent);

export const parseStoredSeal = (value: unknown): Seal | null => {
  if (isSeal(value)) {
    return value;
  }
  // Previous seals used schema-qualified table names as their digest keys.
  // They cannot establish the classified baseline, but must not prevent the
  // runner from starting and making its reset command available.
  if (
    isDigests(value) &&
    Object.keys(value).every((table) => table.includes("."))
  ) {
    return null;
  }
  return panic("Stored seed seal is neither classified nor legacy");
};

const changedTables = (before: Digests, after: Digests) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((table) => before[table] !== after[table])
    .toSorted();

type CheckSealOptions = {
  fresh: boolean;
  sealed: Seal | null;
  current: Seal;
};

export const checkSeal = ({ fresh, sealed, current }: CheckSealOptions) => {
  if (fresh) {
    return { status: "fresh" as const };
  }
  if (sealed === null) {
    return { status: "unsealed" as const };
  }
  const tables = changedTables(sealed.content, current.content);
  const changes = changedTables(sealed.nonContent, current.nonContent).map(
    (table) => {
      const classification = classifySealTable(table);
      if (classification.kind === "content") {
        panic(`Unclassified non-content table: ${table}`);
      }
      return { table, ...classification };
    },
  );
  return tables.length === 0
    ? { status: "pristine" as const, changes }
    : { status: "modified" as const, tables, changes };
};

type SealDb = {
  execute: <Row extends Record<string, unknown>>(
    query: SQL,
  ) => Promise<readonly Row[]>;
};

export const readTableDigests = async (db: SealDb): Promise<Seal> => {
  const tables = await db.execute<{ schema: string; name: string }>(sql`
    SELECT table_schema AS schema, table_name AS name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1, 2
  `);
  const content: [string, string][] = [];
  const nonContent: [string, string][] = [];
  for (const { schema, name } of tables) {
    const table = `${schema}.${name}`;
    const classification = classifySealTable(table);
    const readAll = async () =>
      await readDigest({ db, schema, name, predicate: sql`true` });
    switch (classification.kind) {
      case "content":
        content.push([table, await readAll()]);
        break;
      case "operational":
        nonContent.push([table, await readAll()]);
        break;
      case "derived-on-read": {
        switch (classification.rows.kind) {
          case "all":
            nonContent.push([table, await readAll()]);
            break;
          case "action": {
            const { actionKind } = classification.rows;
            nonContent.push([
              table,
              await readDigest({
                db,
                schema,
                name,
                predicate: sql`action_kind = ${actionKind}`,
              }),
            ]);
            content.push([
              table,
              await readDigest({
                db,
                schema,
                name,
                predicate: sql`action_kind IS DISTINCT FROM ${actionKind}`,
              }),
            ]);
            break;
          }
          default:
            classification.rows satisfies never;
            panic("Unhandled derived row selection");
        }
        break;
      }
      default:
        classification satisfies never;
        panic("Unhandled seal classification");
    }
  }
  return {
    content: Object.fromEntries(content),
    nonContent: Object.fromEntries(nonContent),
  };
};

type ReadDigestOptions = {
  db: SealDb;
  schema: string;
  name: string;
  predicate: SQL;
};

const readDigest = async ({
  db,
  schema,
  name,
  predicate,
}: ReadDigestOptions) => {
  // Row order is not stable, so rows are hashed and the hashes sorted.
  const [row] = await db.execute<{ digest: string }>(sql`
    SELECT count(*) || ':' || md5(coalesce(
      string_agg(md5(t::text), '' ORDER BY md5(t::text)), ''
    )) AS digest
    FROM ${sql.identifier(schema)}.${sql.identifier(name)} AS t
    WHERE ${predicate}
  `);
  return row?.digest ?? panic(`No digest for ${schema}.${name}`);
};

if (import.meta.main) {
  const [mode, sealPath] = process.argv.slice(2);
  if (!isMode(mode) || sealPath === undefined) {
    console.error("Usage: seed-seal.ts <write|check> <seal.json>");
    process.exit(2);
  }
  const { openMaintenanceDb } = await import("@/api/lib/db/maintenance-db");
  const db = openMaintenanceDb({ readOnly: true });
  const digests = await readTableDigests(db);
  switch (mode) {
    case "write": {
      mkdirSync(path.dirname(sealPath), { recursive: true });
      writeFileSync(sealPath, `${JSON.stringify(digests, null, 2)}\n`);
      break;
    }
    case "check": {
      // Every account-bound row needs a user, so no user means no entered content.
      const [row] = await db.execute<{ fresh: boolean }>(sql`
        SELECT NOT EXISTS (SELECT 1 FROM "user") AS fresh
      `);
      let sealed: Seal | null = null;
      if (row?.fresh !== true && existsSync(sealPath)) {
        const parsed: unknown = JSON.parse(readFileSync(sealPath, "utf-8"));
        sealed = parseStoredSeal(parsed);
      }
      console.log(
        JSON.stringify(
          checkSeal({
            fresh: row?.fresh === true,
            sealed,
            current: digests,
          }),
        ),
      );
      break;
    }
    default:
      mode satisfies never;
      panic(`Unhandled seal mode: ${String(mode)}`);
  }
  process.exit(0);
}
