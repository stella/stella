import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects direct UUIDs across auth provider brands", async () => {
  expect(
    await lintSingleRule(
      "no-minted-auth-provider-id",
      'toSafeId<"user">(Bun.randomUUIDv7());\ntoSafeId<"organization">(crypto.randomUUID());\ntoSafeId<"entity" | "user">(randomUUID());\ntoSafeId<AuthProviderIdType>(Bun.randomUUIDv7());\nbrandPersistedUserId(Bun.randomUUIDv7());\nbrandPersistedOrganizationId(randomUUID());',
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("rejects UUID import aliases and stored minted bindings", async () => {
  expect(
    await lintSingleRule(
      "no-minted-auth-provider-id",
      'import { randomUUID as mint } from "node:crypto";\nconst id = mint();\ntoSafeId<"user">(id);\nbrandPersistedOrganizationId(mint());',
    ),
  ).toEqual([3, 4]);
});

test("accepts provider IDs stored values and unrelated generics", async () => {
  expect(
    await lintSingleRule(
      "no-minted-auth-provider-id",
      'mintAuthProviderId<"user">();\ntoSafeId<"user">(row.userId);\ntoSafeId<"entity">(Bun.randomUUIDv7());\nfetchFixture<"user">(Bun.randomUUIDv7());',
    ),
  ).toEqual([]);
});

test("does not infer a minted value from a name also bound to stored data", async () => {
  expect(
    await lintSingleRule(
      "no-minted-auth-provider-id",
      'const id = Bun.randomUUIDv7();\nfunction read() { const id = row.userId; return toSafeId<"user">(id); }',
    ),
  ).toEqual([]);
});
