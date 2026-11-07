import { Column, getColumnTable, getTableName, is, sql } from "drizzle-orm";
import type { SQLWrapper, Table } from "drizzle-orm";

/**
 * References the query row's column from a reusable SQL fragment, so the
 * fragment renders the same wherever a caller places it.
 *
 * Drizzle renders a column bare (`"id"`) when its fragment sits in the
 * selection of a single-table select. Inside a subquery, a bare name binds to
 * the nearest table that has it, so `inner.invoice_id = "id"` silently
 * compares the inner row with itself. An explicit table identifier keeps the
 * subquery correlated to the outer row wherever the fragment is placed.
 */
export const outerColumnReference = (value: SQLWrapper): SQLWrapper =>
  is(value, Column)
    ? sql`${sql.identifier(getTableName(getColumnTable<Table>(value)))}.${sql.identifier(value.name)}`
    : value;
