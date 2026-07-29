import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { savedSearches } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SavedSearchCriteria } from "@/api/lib/saved-searches";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const userA1SavedSearchId = createSafeId<"savedSearch">();
const userA2SavedSearchId = createSafeId<"savedSearch">();

const criteria = {
  version: 1,
  query: "confidentiality",
  workspaceIds: [],
  types: ["document"],
  kinds: [],
  editedByUserIds: [],
  mimeTypes: [],
  sort: "relevance",
} satisfies SavedSearchCriteria;

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;
    await testDb.insert(savedSearches).values([
      {
        id: userA1SavedSearchId,
        organizationId: ids.orgA,
        userId: ids.userA1,
        name: "A1 private search",
        criteria,
      },
      {
        id: userA2SavedSearchId,
        organizationId: ids.orgA,
        userId: ids.userA2,
        name: "A2 private search",
        criteria,
      },
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

describe("saved searches RLS", () => {
  test("never exposes another member's private searches in the same organization", async () => {
    const scoped = createScopedDb(testDb, [], ids.orgA, ids.userA1);
    const rows = await scoped((tx) =>
      tx.select({ id: savedSearches.id }).from(savedSearches),
    );

    expect(rows).toEqual([{ id: userA1SavedSearchId }]);
  });

  test("does not allow a member to update another member's search", async () => {
    const scoped = createScopedDb(testDb, [], ids.orgA, ids.userA1);
    const rows = await scoped((tx) =>
      tx
        .update(savedSearches)
        .set({ name: "attempted cross-user update" })
        .where(eq(savedSearches.id, userA2SavedSearchId))
        .returning({ id: savedSearches.id }),
    );

    expect(rows).toEqual([]);
  });
});
