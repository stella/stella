import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

export const decisionTypeFilterSql = (column: SQLWrapper, stated: string) =>
  sql`lower(${column}) = lower(${stated})`;
