import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, TransactionRollbackError } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { aiMemories } from "@/api/db/schema";
import {
  deletePersonalAiMemories,
  finalizeDeletedUserRecord,
} from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

const dedupKey = () =>
  new Bun.CryptoHasher("sha256").update(Bun.randomUUIDv7()).digest("hex");

describe("account deletion AI memory erasure", () => {
  test("purges personal rows and private suggestions while preserving shared memory", async () => {
    try {
      await testDb.transaction(async (tx) => {
        const personalActiveId = createSafeId<"aiMemory">();
        const personalArchivedId = createSafeId<"aiMemory">();
        const privateSuggestionId = createSafeId<"aiMemory">();
        const sharedMatterId = createSafeId<"aiMemory">();
        const sharedFirmId = createSafeId<"aiMemory">();
        const otherUserId = createSafeId<"aiMemory">();

        await tx.insert(aiMemories).values([
          {
            id: personalActiveId,
            organizationId: ids.orgA,
            scope: "user",
            userId: ids.userA1,
            kind: "preference",
            content: "Personal active memory",
            dedupKey: dedupKey(),
            source: "user",
            createdBy: ids.userA1,
          },
          {
            id: personalArchivedId,
            organizationId: ids.orgA,
            scope: "user",
            userId: ids.userA1,
            kind: "instruction",
            content: "Personal archived memory",
            dedupKey: dedupKey(),
            source: "user",
            status: "archived",
            createdBy: ids.userA1,
          },
          {
            id: privateSuggestionId,
            organizationId: ids.orgA,
            scope: "workspace",
            workspaceId: ids.wsA2,
            kind: "fact",
            content: "Private suggested matter memory",
            dedupKey: dedupKey(),
            source: "extracted",
            status: "suggested",
            createdBy: ids.userA1,
            sourceDataWorkspaceIds: [ids.wsA2],
          },
          {
            id: sharedMatterId,
            organizationId: ids.orgA,
            scope: "workspace",
            workspaceId: ids.wsA2,
            kind: "fact",
            content: "Accepted shared matter memory",
            dedupKey: dedupKey(),
            source: "tool",
            createdBy: ids.userA1,
          },
          {
            id: sharedFirmId,
            organizationId: ids.orgA,
            scope: "organization",
            kind: "instruction",
            content: "Shared firm memory",
            dedupKey: dedupKey(),
            source: "user",
            createdBy: ids.userA1,
          },
          {
            id: otherUserId,
            organizationId: ids.orgA,
            scope: "user",
            userId: ids.userA2,
            kind: "preference",
            content: "Another user's memory",
            dedupKey: dedupKey(),
            source: "user",
            createdBy: ids.userA2,
          },
        ]);

        await deletePersonalAiMemories(asTestRaw<Transaction>(tx), ids.userA1);
        await finalizeDeletedUserRecord(asTestRaw<Transaction>(tx), ids.userA1);

        const remaining = await tx
          .select({ createdBy: aiMemories.createdBy, id: aiMemories.id })
          .from(aiMemories)
          .where(
            inArray(aiMemories.id, [
              personalActiveId,
              personalArchivedId,
              privateSuggestionId,
              sharedMatterId,
              sharedFirmId,
              otherUserId,
            ]),
          );

        expect(remaining).toEqual(
          expect.arrayContaining([
            { createdBy: null, id: sharedMatterId },
            { createdBy: null, id: sharedFirmId },
            { createdBy: ids.userA2, id: otherUserId },
          ]),
        );
        expect(remaining).toHaveLength(3);

        tx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }

    throw new Error("Expected the integration test transaction to roll back");
  });
});
