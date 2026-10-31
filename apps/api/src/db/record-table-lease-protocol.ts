import { type SQL, sql } from "drizzle-orm";

import { TABLE_LEASE_PROTOCOL } from "./table-lease-protocol";

/** First observation is durable; repeated attempts preserve its original timestamp. */
export const recordTableLeaseProtocol = async (tx: {
  execute: (query: SQL) => PromiseLike<unknown>;
}) => {
  await tx.execute(sql`INSERT INTO scheduler_table_lease_protocol (protocol, first_seen_at)
    VALUES (${TABLE_LEASE_PROTOCOL}, clock_timestamp())
    ON CONFLICT (protocol) DO NOTHING`);
};
