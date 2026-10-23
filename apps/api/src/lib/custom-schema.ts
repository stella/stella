import * as v from "valibot";

import {
  CURRENCY_CODE_LENGTH,
  CURRENCY_CODE_PATTERN,
} from "@stll/api-contract/currency-code";
import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";
import { safeIdSchema } from "@stll/api-contract/safe-id";
import { UUID_PATTERN } from "@stll/uuid-codec";

import type { SafeId, SafeIdType } from "@/api/lib/branded-types";

/** UUID string (8-4-4-4-12 hex digits), as `Bun.randomUUIDv7()` issues them. */
export const uuidSchema = v.pipe(
  v.string(),
  v.length(36),
  v.regex(new RegExp(UUID_PATTERN, "u")),
);

/**
 * A shared schema with per-use prose. The branded schemas below are module
 * level values reused by many handlers, so a description belongs to the use
 * site; the pipe wraps the shared value instead of mutating it.
 *
 * The description is carried by the capability-catalog exporter into the
 * committed catalog's `inputSchema`, where it becomes the generated CLI flag's
 * `--help` text and the property prose an MCP client sees.
 */
export const withDescription = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  description: string,
) => v.pipe(schema, v.description(description));

/** Metadata keys `resourcesAreVisible` and the capability exporter read. */
export const RESOURCE_KIND_METADATA_KEY = "x-stella-resource-kind";
export const RESOURCE_USAGE_METADATA_KEY = "x-stella-resource-usage";

/**
 * The id of a stored resource. The metadata names its kind, so the safe
 * handler factories prove every referenced id is visible to the caller before
 * the handler runs; a `creation` id names a resource the request creates.
 */
export const resourceIdSchema = <T extends SafeIdType>(
  resourceKind: T,
  {
    usage = "reference",
    description,
  }: {
    description?: string;
    usage?: "reference" | "creation";
  } = {},
) =>
  v.pipe(
    uuidSchema,
    safeIdSchema,
    v.transform((id): SafeId<T> => id),
    // One metadata step with a fixed shape: a spread of optional steps would
    // leave `v.pipe` without a typed overload, and the id's input type with it.
    v.metadata({
      [RESOURCE_KIND_METADATA_KEY]: resourceKind,
      [RESOURCE_USAGE_METADATA_KEY]: usage,
      ...(description === undefined ? {} : { description }),
    }),
  );

/**
 * A file a multipart body carries, at most `maxBytes` long. Agents and the
 * generated CLI see it as a binary string (`format: "binary"`), which is what
 * a capability's file-input transport is checked against.
 */
export const fileSchema = ({ maxBytes }: { maxBytes: number }) =>
  v.pipe(
    v.file(),
    v.maxSize(maxBytes, `The file is larger than ${String(maxBytes)} bytes`),
  );

export const userIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
);

export const defaultVarcharSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DEFAULT_VARCHAR_MAX_LENGTH),
);

/** A JSON object with caller-defined keys and values; scalars are rejected. */
export const jsonObjectSchema = v.record(v.string(), v.unknown());

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
export const currencyCodeSchema = v.pipe(
  v.string(),
  v.length(CURRENCY_CODE_LENGTH),
  v.regex(new RegExp(CURRENCY_CODE_PATTERN, "u")),
);

export const paginationLimitSchema = (maximum: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum));

/**
 * A monetary amount in the currency's minor units.
 *
 * The column is `bigint`, so the database would take far more; the ceiling is
 * JavaScript's. The value crosses this boundary as a JSON number and
 * `bigint({ mode: "number" })` reads it back as one, so past
 * `Number.MAX_SAFE_INTEGER` the amount stored is no longer the amount sent --
 * silently, which is the whole reason money carries a brand here.
 */
export const minorUnitAmountSchema = (minimum: number) =>
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(minimum),
    v.maxValue(Number.MAX_SAFE_INTEGER),
  );

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

export const paginationCursorSchema = ({
  maxChars = PAGINATION_CURSOR_MAX_CHARS,
  description = PAGINATION_CURSOR_DESCRIPTION,
}: PaginationCursorOptions = {}) =>
  v.pipe(v.string(), v.maxLength(maxChars), v.description(description));

/** The params of a route mounted under a `:workspaceId` prefix. */
export type WorkspaceParamsSchema = v.GenericSchema<
  { workspaceId: string },
  { workspaceId: SafeId<"workspace"> }
>;

export const workspaceParams = <TEntries extends v.ObjectEntries>(
  extra: TEntries,
) => v.object({ workspaceId: resourceIdSchema("workspace"), ...extra });

/** The `:workspaceId` segment every matter route is mounted under. */
export const workspaceSegmentSchema = v.looseObject({
  workspaceId: resourceIdSchema("workspace"),
});

/**
 * Every item of the array distinct, as JSON Schema's `uniqueItems`. Items are
 * compared by identity; an array of objects names the primitive `key` two
 * equal items share.
 */
export const uniqueItems = <TItem>(
  key: (item: TItem) => unknown = (item) => item,
) =>
  v.check(
    (items: TItem[]) => new Set(items.map(key)).size === items.length,
    "Items must be unique",
  );
