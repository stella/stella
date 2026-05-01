import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

/**
 * Safe replacement for `p.jsonb()`.
 *
 * The bun-sql driver binds JS values with the JSONB wire type. When
 * Drizzle's stock `jsonb` column hands the driver a JSON-stringified
 * payload, Postgres receives it as a JSON-string primitive
 * (`jsonb_typeof = 'string'`) rather than the parsed object/array.
 *
 * Routing every write through `${JSON.stringify(value)}::text::jsonb`
 * forces the parameter into text first, then re-parses as JSON, so
 * the value lands as the intended object/array regardless of the
 * driver's wire-type choice. Drizzle's encoder inlines `SQL` chunks
 * returned from `toDriver`, so this hook applies transparently to
 * every insert and update of every column declared with this type.
 *
 * Always use this in place of `p.jsonb()` from `drizzle-orm/pg-core`.
 */
export const jsonb = customType<{
  data: unknown;
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  toDriver: (value) =>
    value === null || value === undefined
      ? null
      : sql`${JSON.stringify(value)}::text::jsonb`,
  fromDriver: (value): unknown => {
    if (typeof value === "string" && /^[{[]/.test(value.trimStart())) {
      try {
        const parsed: unknown = JSON.parse(value);
        return parsed;
      } catch {
        return value;
      }
    }
    return value;
  },
});
