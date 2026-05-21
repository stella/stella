import { describe, expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";

import {
  AUTH_USER_STELLA_SELECT_COLUMN_NAMES,
  AUTH_USER_STELLA_SELECT_COLUMNS,
  jwks,
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
