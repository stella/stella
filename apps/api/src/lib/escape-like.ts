import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * LIKE's metacharacters under its default escape, the escape itself first:
 * escaping it later would re-escape the backslashes the other two add.
 */
const LIKE_METACHARACTERS = ["\\", "%", "_"] as const;

/** Escape SQL LIKE metacharacters so they match literally. */
export const escapeLike = (value: string) => {
  let escaped = value;
  for (const metacharacter of LIKE_METACHARACTERS) {
    escaped = escaped.replaceAll(metacharacter, () => `\\${metacharacter}`);
  }
  return escaped;
};

/**
 * `escapeLike` applied by the database, for a value only the database can
 * compute. A folded term is one: `unaccent` maps full-width `％`, `＿` and
 * `＼` to their ASCII metacharacters, so a term escaped before the fold could
 * still turn into a wildcard after it.
 */
export const escapeLikeSql = (value: SQL): SQL => {
  let escaped = value;
  for (const metacharacter of LIKE_METACHARACTERS) {
    escaped = sql`replace(${escaped}, ${metacharacter}, ${`\\${metacharacter}`})`;
  }
  return escaped;
};
