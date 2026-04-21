import type { TProperties } from "@sinclair/typebox";
import { t } from "elysia";

/**
 * UUID v4 format: 8-4-4-4-12 hex digits (case-insensitive).
 *
 * Uses explicit [0-9a-fA-F] ranges instead of the `i` flag
 * because Elysia consumes `.source` (which strips flags).
 */
const UUID_REGEX: RegExp =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Elysia schema for UUID string validation.
 *
 * Validates UUID v4 format (8-4-4-4-12 hex digits).
 * Previously named `tNanoid` when the project used nanoid;
 * renamed to `tUuid` after migrating to `crypto.randomUUID()`.
 */
export const tUuid = t.String({
  minLength: 36,
  maxLength: 36,
  pattern: UUID_REGEX.source,
});

export const tDefaultVarchar = t.String({
  minLength: 1,
  maxLength: 256,
});

export const workspaceParams = <T extends TProperties>(extra: T) =>
  t.Object({ workspaceId: tUuid, ...extra });
