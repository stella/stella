/**
 * Seal a seeded local stack, then tell whether it still holds only seeded
 * content. Screenshots of a local stack may be attached to public pull
 * requests only while it does: anything created after the seed (an upload, a
 * typed name, a chat) could carry private data.
 *
 * The seal is a per-table fingerprint of every row, taken right after the
 * seed. Tables that change merely because the app is used (sessions, audit
 * events, queues) are ignored; everything else must match. The dev runner
 * seals only a database that was fresh or still matched its seal before the
 * seed ran, so rows entered earlier can never become part of the baseline.
 *
 * `check` prints one of:
 *   {"status":"fresh"}      no user exists yet, so nothing was entered
 *   {"status":"pristine"}   every table matches the seal
 *   {"status":"modified","tables":[...]}
 *   {"status":"unsealed"}   no seal file
 *
 * Usage:
 *   bun scripts/seed-seal.ts write <seal.json>
 *   bun scripts/seed-seal.ts check <seal.json>
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import {
  changedSealTables,
  readTableDigests,
  type Seal,
} from "@/api/lib/scheduler/seed-seal";

const MODES = ["write", "check"] as const;
type Mode = (typeof MODES)[number];

const isMode = (value: string | undefined): value is Mode =>
  MODES.some((mode) => mode === value);

const isSeal = (value: unknown): value is Seal =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((digest) => typeof digest === "string");

const [mode, sealPath] = process.argv.slice(2);
if (!isMode(mode) || sealPath === undefined) {
  console.error("Usage: seed-seal.ts <write|check> <seal.json>");
  process.exit(2);
}

// Every account-bound row needs a user, so a database without one has
// received no content from anyone.
const isFresh = async () => {
  const [row] = await openMaintenanceDb({ readOnly: true }).execute<{
    fresh: boolean;
  }>(sql`SELECT NOT EXISTS (SELECT 1 FROM "user") AS fresh`);
  return row?.fresh === true;
};

const digests = await withAggregateTransaction(
  openMaintenanceDb({ readOnly: true }),
  readTableDigests,
);
switch (mode) {
  case "write": {
    mkdirSync(path.dirname(sealPath), { recursive: true });
    writeFileSync(sealPath, `${JSON.stringify(digests, null, 2)}\n`);
    break;
  }
  case "check": {
    if (await isFresh()) {
      console.log(JSON.stringify({ status: "fresh" }));
      break;
    }
    if (!existsSync(sealPath)) {
      console.log(JSON.stringify({ status: "unsealed" }));
      break;
    }
    const sealed: unknown = JSON.parse(readFileSync(sealPath, "utf-8"));
    if (!isSeal(sealed)) {
      panic(`${sealPath} is not a seal`);
    }
    const tables = changedSealTables(sealed, digests);
    console.log(
      JSON.stringify(
        tables.length === 0
          ? { status: "pristine" }
          : { status: "modified", tables },
      ),
    );
    break;
  }
  default: {
    mode satisfies never;
    panic(`Unhandled seal mode: ${String(mode)}`);
  }
}
process.exit(0);
