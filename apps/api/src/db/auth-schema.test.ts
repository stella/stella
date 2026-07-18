import { describe, expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  AUTH_USER_STELLA_SELECT_COLUMN_NAMES,
  AUTH_USER_STELLA_SELECT_COLUMNS,
  jwks,
  twoFactor,
  user,
} from "@/api/db/auth-schema";

describe("auth schema", () => {
  test("jwks includes the columns Better Auth's jwt plugin writes", () => {
    expect(Object.keys(getColumns(jwks)).toSorted()).toEqual([
      "alg",
      "createdAt",
      "crv",
      "expiresAt",
      "id",
      "privateKey",
      "publicKey",
    ]);
  });

  // Locks the table in sync with node_modules/better-auth/dist/plugins/
  // two-factor/schema.mjs: 1.6.23 writes `failedVerificationCount` and
  // `lockedUntil` in its verification path (account lockout is on by default).
  test("twoFactor includes the columns Better Auth's two-factor plugin writes", () => {
    expect(Object.keys(getColumns(twoFactor)).toSorted()).toEqual([
      "backupCodes",
      "failedVerificationCount",
      "id",
      "lockedUntil",
      "secret",
      "userId",
      "verified",
    ]);
  });

  test("stella user grants account for every Better Auth user column", () => {
    const schemaColumnNamesByField: Record<string, string> = Object.fromEntries(
      Object.entries(getColumns(user)).map(([field, column]) => [
        field,
        column.name,
      ]),
    );
    const expectedColumnNames: string[] = [
      ...AUTH_USER_STELLA_SELECT_COLUMN_NAMES,
    ].toSorted();

    expect(schemaColumnNamesByField).toEqual(AUTH_USER_STELLA_SELECT_COLUMNS);
    expect(Object.values(schemaColumnNamesByField).toSorted()).toEqual(
      expectedColumnNames,
    );
  });
});

describe("two_factor user_id uniqueness (enable-race guard)", () => {
  // Better Auth's `/two-factor/enable` deletes-then-inserts a row per user
  // non-atomically, so two enable requests racing can both insert. A UNIQUE
  // index on user_id is the structural guard that serializes enrollment: the
  // losing insert fails instead of leaving duplicate secrets. Assert the
  // schema declares that uniqueness (the migration mirrors it).
  test("user_id carries a unique index, not a plain one", () => {
    const userIdIndexes = getTableConfig(twoFactor).indexes.filter((index) =>
      index.config.columns.some(
        (column) => "name" in column && column.name === "user_id",
      ),
    );

    expect(userIdIndexes).toHaveLength(1);
    expect(userIdIndexes[0]?.config.unique).toBe(true);
  });
});
