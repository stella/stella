import { sql } from "drizzle-orm";

import { caseLawDecisions as decisions } from "@/api/db/schema";

declare const db: {
  insert: (table: unknown) => { values: (value: unknown) => unknown };
  update: (table: unknown) => { set: (value: unknown) => unknown };
  execute: (statement: unknown) => unknown;
  select: (projection: unknown) => { from: (table: unknown) => unknown };
};
declare const state: unknown;

// oxlint-disable-next-line no-direct-case-law-text-state-write/no-direct-case-law-text-state-write -- fixture: direct updates bypass the verified state owner
db.update(decisions).set({ textState: state });

const payload = { textState: state };
// oxlint-disable-next-line no-direct-case-law-text-state-write/no-direct-case-law-text-state-write -- fixture: aliased insert payloads bypass the verified state owner
db.insert(decisions).values(payload);

db.execute(
  // oxlint-disable-next-line no-direct-case-law-text-state-write/no-direct-case-law-text-state-write -- fixture: raw SQL updates bypass the verified state owner
  sql`UPDATE ${decisions} SET ${decisions.textState} = ${state}`,
);

// expect-clean: no-direct-case-law-text-state-write/no-direct-case-law-text-state-write
db.select({ textState: decisions.textState }).from(decisions);
