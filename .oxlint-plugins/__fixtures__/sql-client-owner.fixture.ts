// Passive regression fixture for `sql-client-owner/sql-client-owner`: Bun SQL
// clients and drizzle's bun-sql factory are reached only through the owner.

import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

// oxlint-disable-next-line sql-client-owner/sql-client-owner -- constructs a client without bigint
export const client = new SQL({ max: 1 });
// oxlint-disable-next-line sql-client-owner/sql-client-owner -- drizzle's factory sets bigint after construction
export const builder = drizzle.mock();
// expect-clean: sql-client-owner/sql-client-owner
export const isClient = (value: unknown): boolean => value instanceof SQL;
