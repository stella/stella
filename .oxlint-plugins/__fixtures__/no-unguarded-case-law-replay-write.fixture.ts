import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { replayWrite } from "@/api/lib/case-law/replay-write";

declare const table: PgTable;
declare const db: {
  update: (table: unknown) => { set: (set: Record<string,unknown>) => {where:(where:SQL)=>Promise<void>} };
  insert: (table: unknown) => {values:(values:Record<string,unknown>)=>{onConflictDoUpdate:(options: {target:unknown;set:Record<string,unknown>;setWhere?:SQL})=>Promise<void>}};
  execute: (query:SQL)=>Promise<void>;
};

// oxlint-disable-next-line no-unguarded-case-law-replay-write/no-unguarded-case-law-replay-write -- fixture: direct updates require a coupled predicate
await db.update(table).set({value:1}).where(sql`true`);

const write = replayWrite(table,{value:1});
// expect-clean: no-unguarded-case-law-replay-write/no-unguarded-case-law-replay-write
await db.update(table).set(write.set).where(write.setWhere);

// oxlint-disable-next-line no-unguarded-case-law-replay-write/no-unguarded-case-law-replay-write -- fixture: conflict updates require a coupled predicate
await db.insert(table).values({value:1}).onConflictDoUpdate({target:[],set:{value:1}});

// expect-clean: no-unguarded-case-law-replay-write/no-unguarded-case-law-replay-write
await db.insert(table).values({value:1}).onConflictDoUpdate({target:[],...write});

// oxlint-disable-next-line no-unguarded-case-law-replay-write/no-unguarded-case-law-replay-write -- fixture: raw updates cannot escape the replay boundary
await db.execute(sql`UPDATE decisions SET value = ${1}`);

// expect-clean: no-unguarded-case-law-replay-write/no-unguarded-case-law-replay-write
await db.execute(sql`SELECT 1`);
