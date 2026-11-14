/**
 * One definition of "the same email address" for every identity decision:
 * account lookups, demo, review and system account checks, rate-limit and
 * one-time-code keys, identity linking and allowed-sender matching.
 *
 * The rule is `trim()` and then `toLowerCase()`, the form Better Auth writes
 * to `user.email` and uses for its own lookups and one-time-code identifiers.
 * Better Auth's address validator accepts only ASCII addresses without
 * surrounding whitespace, so on every address an account can hold the trim
 * changes nothing. JavaScript lowercase must agree with PostgreSQL `lower()`
 * under the configured supported collation; database parity tests verify
 * that requirement. `toLowerCase()` ignores the host
 * locale, so a Turkish locale never turns `I` into dotless `ı`; `ı` and the
 * long `ſ` are already lowercase and stay distinct from `i` and `s`.
 *
 * Outside ASCII the runtimes may differ (`İ`, a word-final `Σ`), so SQL folds
 * only the stored column and compares it with a key folded here; the key is a
 * fixed point of the database's `lower()` (normalized-email.db.test.ts).
 * `no-adhoc-email-fold` refuses a hand-written fold anywhere else in the API.
 */
import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

declare const normalizedEmailBrand: unique symbol;

/** An address folded by `normalizeEmail`; compare and key only these. */
export type NormalizedEmail = string & {
  readonly [normalizedEmailBrand]: true;
};

const fold = (raw: string): string => raw.trim().toLowerCase();

const isNormalizedEmail = (value: string): value is NormalizedEmail =>
  fold(value) === value;

export const normalizeEmail = (raw: string): NormalizedEmail => {
  const folded = fold(raw);
  return isNormalizedEmail(folded)
    ? folded
    : panic("Email normalization must be idempotent");
};

/**
 * A configured or claimed address, normalized and then validated. The output
 * stays a plain string so configuration and fixtures keep their shapes;
 * comparisons and keys still go through `normalizeEmail`.
 */
export const emailAddressSchema = v.pipe(
  v.string(),
  v.transform((raw): string => normalizeEmail(raw)),
  v.email(),
);

/**
 * The stored address column equals `email`. The column is folded by the
 * database so a row stored in another case still matches; the key side is
 * never folded in SQL.
 */
export const emailColumnMatches = (
  column: SQLWrapper,
  email: NormalizedEmail,
): SQL => sql`lower(${column}) = ${email}`;
