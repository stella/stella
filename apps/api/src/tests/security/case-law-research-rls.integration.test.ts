import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { CaseLawResearchSavedQuery } from "@stll/api-contract";

import {
  caseLawResearchTableDecisions,
  caseLawResearchTables,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const orgATableId = createSafeId<"caseLawResearchTable">();
const orgBTableId = createSafeId<"caseLawResearchTable">();

const savedQuery = {
  version: 1,
  query: "nájemní smlouva",
  country: "CZE",
} satisfies CaseLawResearchSavedQuery;

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;
    await testDb.insert(caseLawResearchTables).values([
      {
        id: orgATableId,
        organizationId: ids.orgA,
        ownerUserId: ids.userA1,
        name: "Org A leases",
        savedQuery,
      },
      {
        id: orgBTableId,
        organizationId: ids.orgB,
        ownerUserId: ids.userB1,
        name: "Org B leases",
        savedQuery,
      },
    ]);
    await testDb.insert(caseLawResearchTableDecisions).values([
      {
        tableId: orgATableId,
        organizationId: ids.orgA,
        decisionId: ids.caseLawDecisionA,
        disposition: "pinned",
        position: 1,
        addedBy: ids.userA1,
      },
      {
        tableId: orgBTableId,
        organizationId: ids.orgB,
        decisionId: ids.caseLawDecisionB,
        disposition: "excluded",
        position: 0,
        addedBy: ids.userB1,
      },
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

describe("case-law research tables RLS", () => {
  test("a member sees every table of their organization and none of another's", async () => {
    // A2 did not create the table; organization-wide visibility is the v1 rule.
    const scoped = createScopedDb(testDb, [], ids.orgA, ids.userA2);
    const tables = await scoped((tx) =>
      tx.select({ id: caseLawResearchTables.id }).from(caseLawResearchTables),
    );
    expect(tables).toEqual([{ id: orgATableId }]);

    const dispositions = await scoped((tx) =>
      tx
        .select({ tableId: caseLawResearchTableDecisions.tableId })
        .from(caseLawResearchTableDecisions),
    );
    expect(dispositions).toEqual([{ tableId: orgATableId }]);
  });

  test("another organization can neither update nor pin into the table", async () => {
    const scoped = createScopedDb(testDb, [], ids.orgB, ids.userB1);
    const renamed = await scoped((tx) =>
      tx
        .update(caseLawResearchTables)
        .set({ name: "attempted cross-organization rename" })
        .where(eq(caseLawResearchTables.id, orgATableId))
        .returning({ id: caseLawResearchTables.id }),
    );
    expect(renamed).toEqual([]);

    // The child row names org A's table with org B's tenant column: the
    // composite foreign key refuses the pair even before RLS is consulted.
    const pinned: unknown = await scoped((tx) =>
      tx
        .insert(caseLawResearchTableDecisions)
        .values({
          tableId: orgATableId,
          organizationId: ids.orgB,
          decisionId: ids.caseLawDecisionB,
          disposition: "pinned",
          position: 1,
          addedBy: ids.userB1,
        })
        .returning({ tableId: caseLawResearchTableDecisions.tableId }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(pinned).toBeInstanceOf(Error);
  });
});
