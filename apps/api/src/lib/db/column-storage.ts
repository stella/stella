import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const typedColumnParam = (value: unknown, column: AnyPgColumn) =>
  sql`${sql.param(value, column)}::${sql.raw(column.getSQLType())}`;

/** Compare the number PostgreSQL stores, using the column's declared representation. */
export const persistedColumnNumber = (
  column: AnyPgColumn,
  value: unknown,
): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    return panic(`Invalid persisted column number for ${column.name}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return panic(`Invalid persisted column number for ${column.name}`);
  }
  switch (column.getSQLType()) {
    case "real":
      return Math.fround(number);
    case "double precision":
      return number;
    case "integer":
      if (
        !Number.isInteger(number) ||
        number < -2_147_483_648 ||
        number > 2_147_483_647
      ) {
        return panic(`Invalid persisted column integer for ${column.name}`);
      }
      return number;
    default:
      return panic(`Unsupported numeric column ${column.name}`);
  }
};

/** Raw VALUES writes and comparison keys use the same stored numeric representation. */
export const numericColumnParam = (column: AnyPgColumn, value: unknown) =>
  typedColumnParam(persistedColumnNumber(column, value), column);
