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

export const tPaginationLimit = (maximum: number) =>
  t.Integer({ minimum: 1, maximum });

export const workspaceParams = <T extends TProperties>(extra: T) =>
  t.Object({ workspaceId: tSafeId("workspace"), ...extra });
