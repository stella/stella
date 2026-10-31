import { panic } from "better-result";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { MATTER_VISIBILITY } from "@stll/api-contract/matter-visibility";

import { workspaceMembers, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { insertWorkspaceRowsInTransaction } from "./create-workspace-row";

let testDb: TestDatabase;
let ids: TestIds;
const createdIds: SafeId<"workspace">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});
afterEach(async () => {
  if (createdIds.length > 0) {
    await testDb.delete(workspaces).where(inArray(workspaces.id, createdIds));
  }
  createdIds.length = 0;
});
afterAll(releaseRlsFixture);

test.each([1, 2, 3])(
  "the creation owner commits a private matter batch of %i with generated identities and assigned stewards",
  async (size) => {
    const rows = Array.from({ length: size }, (_, index) => ({
      organizationId: index % 2 === 0 ? ids.orgA : ids.orgB,
      leadUserId: index % 2 === 0 ? ids.userA1 : ids.userB1,
      visibility: MATTER_VISIBILITY.assignedOnly,
      name: `Private batch matter ${index}`,
      reference: `CREATION-${Bun.randomUUIDv7()}`,
    }));
    const created = await testDb.transaction(async (tx) => {
      // This call owns the complete batch prefix, including the IDs it mints.
      const inserted = await insertWorkspaceRowsInTransaction({ tx, rows });
      createdIds.push(...inserted.map((row) => row.id));
      await tx.insert(workspaceMembers).values(
        inserted.map((row) => {
          if (row.leadUserId === null) {
            return panic("Private creation fixture requires a named steward");
          }
          return { workspaceId: row.id, userId: row.leadUserId };
        }),
      );
      return inserted;
    });

    expect(created).toHaveLength(size);
    expect(new Set(created.map((row) => row.id)).size).toBe(size);
    const committed = await testDb
      .select({
        id: workspaces.id,
        organizationId: workspaces.organizationId,
        leadUserId: workspaces.leadUserId,
        visibility: workspaces.visibility,
        name: workspaces.name,
        reference: workspaces.reference,
      })
      .from(workspaces)
      .where(inArray(workspaces.id, createdIds));
    expect(committed).toHaveLength(size);
    expect(committed).toEqual(
      expect.arrayContaining(
        rows.map((row) => ({ ...row, id: expect.any(String) })),
      ),
    );
    expect(new Set(committed.map((row) => row.id))).toEqual(
      new Set(createdIds),
    );
    const assignments = await testDb
      .select({
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
      })
      .from(workspaceMembers)
      .where(inArray(workspaceMembers.workspaceId, createdIds));
    expect(assignments).toHaveLength(size);
    expect(assignments).toEqual(
      expect.arrayContaining(
        committed.map((row) => ({
          workspaceId: row.id,
          userId: row.leadUserId,
        })),
      ),
    );
  },
);
