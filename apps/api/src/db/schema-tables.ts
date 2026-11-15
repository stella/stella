import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

/** Reflect table metadata without carrying the union of every schema export. */
export const schemaTables = (
  schema: Readonly<Record<string, unknown>>,
): PgTable[] => Object.values(schema).filter((value) => is(value, PgTable));
