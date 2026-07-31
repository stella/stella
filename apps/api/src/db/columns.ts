import { sql } from "drizzle-orm";
import { customType, timestamp } from "drizzle-orm/pg-core";

import {
  decryptSsoConfigFromStorage,
  encryptSsoConfigForStorage,
} from "@/api/lib/sso-config-encryption";

/**
 * Safe replacement for `p.jsonb()`.
 *
 * Drizzle's stock `jsonb` column hands bun-sql a raw structured value.
 * The driver then serializes that value in a way Postgres receives as a
 * JSON-string primitive (`jsonb_typeof = 'string'`) rather than the
 * parsed object/array.
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
    if (typeof value === "string" && /^[{[]/u.test(value.trimStart())) {
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

/** Encrypted text storage matching Better Auth's serialized SSO config API. */
export const encryptedSsoConfig = customType<{
  data: string;
  driverData: string;
}>({
  dataType: () => "text",
  toDriver: encryptSsoConfigForStorage,
  fromDriver: decryptSsoConfigFromStorage,
});

/**
 * Safe replacement for `p.timestamp()`.
 *
 * A naive `timestamp` column stores no UTC anchoring, so its meaning
 * silently depends on every writer's session time zone. This helper
 * always produces `timestamptz`, keeping stored instants unambiguous
 * regardless of server or tooling configuration.
 *
 * Always use this in place of `timestamp()` from drizzle-orm/pg-core;
 * the `require-timestamptz-column` lint rule enforces it.
 */
export const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true });
