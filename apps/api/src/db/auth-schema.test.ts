import { describe, expect, test } from "bun:test";
import { getColumns } from "drizzle-orm";

import { jwks } from "@/api/db/auth-schema";

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
});
