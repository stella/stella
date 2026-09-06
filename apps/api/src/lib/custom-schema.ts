import type { TProperties, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { t } from "elysia";

import type { SafeId, SafeIdType } from "@/api/lib/branded-types";

/**
 * UUID v4 format: 8-4-4-4-12 hex digits (case-insensitive).
 *
 * Uses explicit [0-9a-fA-F] ranges instead of the `i` flag
 * because Elysia consumes `.source` (which strips flags).
 */
const UUID_REGEX: RegExp =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export const isUuid = (value: string): boolean => UUID_REGEX.test(value);

/**
 * Elysia schema for UUID string validation.
 *
 * Validates UUID format (8-4-4-4-12 hex digits).
 * Previously named `tNanoid` when the project used nanoid;
 * renamed to `tUuid` after migrating to `Bun.randomUUIDv7()`.
 */
export const tUuid = t.String({
  minLength: 36,
  maxLength: 36,
  pattern: UUID_REGEX.source,
});

/**
 * A copy of a shared schema carrying per-property prose. The branded schemas
 * below (`tUserId`, `tDefaultVarchar`, …) are single module-level instances
 * reused by many handlers, so a description belongs to the USE SITE, not to the
 * shared value; mutating the shared one would leak the prose everywhere. Object
 * spread copies TypeBox's own enumerable symbol metadata (the `Kind` marker),
 * so the copy validates exactly as the original does.
 *
 * The resulting `description` is carried by the capability-catalog exporter
 * into the committed catalog's `inputSchema`, where it becomes the generated
 * CLI flag's `--help` text and the property prose an MCP client sees.
 */
export const withDescription = <T extends TSchema>(
  schema: T,
  description: string,
): T => ({ ...schema, description });

export const tSafeId = <T extends SafeIdType>(
  _type: T,
  options?: { description: string },
) => Type.Unsafe<SafeId<T>>({ ...tUuid, ...options });

export const tUserId = t.String({
  minLength: 1,
  maxLength: 128,
});

export const tDefaultVarchar = t.String({
  minLength: 1,
  maxLength: 256,
});

/** A JSON object with caller-defined keys and values. `t.Record` does not
 * reject scalar JSON values in Elysia's runtime validator, so intersect it
 * with an object schema at every boundary that requires a map. */
export const tJsonObject = t.Intersect([
  t.Object({}, { additionalProperties: true }),
  t.Record(t.String(), t.Unknown()),
]);

/**
 * ISO 4217 alphabetic code, upper case, for a column that stores money.
 *
 * Three LETTERS, not three characters: a stored "A1C" satisfies a length check
 * and then makes `Intl.NumberFormat` throw the moment something formats it. An
 * unknown-but-well-formed code ("ZZZ") is accepted, because `Intl` accepts it.
 *
 * Case is part of the contract here, unlike the workspace field-currency schema
 * in `db/schema-validators.ts`, which still admits either case. `Intl` resolves
 * "jpy" and "JPY" alike, so a mixed-case column would look fine and still be
 * two currencies to anything that groups or joins on the code — including the
 * migration that rescaled these amounts to true minor units, and `MoneyTotals`,
 * which buckets by the raw string.
 */
export const tCurrencyCode = t.String({
  minLength: 3,
  maxLength: 3,
  pattern: "^[A-Z]{3}$",
});

export const tPaginationLimit = (maximum: number) =>
  t.Integer({ minimum: 1, maximum });

/**
 * A monetary amount in the currency's minor units.
 *
 * The column is `bigint`, so the database would take far more; the ceiling is
 * JavaScript's. The value crosses this boundary as a JSON number and
 * `bigint({ mode: "number" })` reads it back as one, so past
 * `Number.MAX_SAFE_INTEGER` the amount stored is no longer the amount sent --
 * silently, which is the whole reason money carries a brand here.
 */
export const tMinorUnitAmount = (minimum: number) =>
  t.Integer({ minimum, maximum: Number.MAX_SAFE_INTEGER });

export const PAGINATION_CURSOR_MAX_CHARS = 512;

const PAGINATION_CURSOR_DESCRIPTION =
  "Opaque cursor from a previous page to fetch the next page";

type PaginationCursorOptions = {
  // Endpoints whose cursor encodes more than a keyset (a window, a delegated
  // upstream token) raise the cap; everything else takes the shared one.
  readonly maxChars?: number;
  // The prose an MCP client reads before calling the tool. Name the tool the
  // cursor came from when the generic sentence would leave the caller guessing.
  readonly description?: string;
};

export const tPaginationCursor = ({
  maxChars = PAGINATION_CURSOR_MAX_CHARS,
  description = PAGINATION_CURSOR_DESCRIPTION,
}: PaginationCursorOptions = {}) =>
  t.String({ maxLength: maxChars, description });

export const workspaceParams = <T extends TProperties>(extra: T) =>
  t.Object({ workspaceId: tSafeId("workspace"), ...extra });
