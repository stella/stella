import { sql } from "drizzle-orm";

type PgArrayType = "entity_kind" | "text" | "uuid";

export const typedPgArray = (values: readonly unknown[], pgType: PgArrayType) =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::${sql.raw(pgType)}[]`;
