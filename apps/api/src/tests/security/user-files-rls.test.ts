import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, TransactionRollbackError } from "drizzle-orm";
import nodePath from "node:path";

import { chatThreads, userFiles, workspaces } from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";
import { installPgliteMigration } from "@/api/tests/pglite-schema";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type {
  TestDatabase,
  TestDatabaseTransaction,
  createDryScopedQuery,
  createScopedQuery,
} from "@/api/tests/security/test-utils";

let ids: TestIds;
let testDb: TestDatabase;
let scopedQuery: ReturnType<typeof createScopedQuery>;
let dryScopedQuery: ReturnType<typeof createDryScopedQuery>;

const POLICY_MIGRATION = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20260830110000_user_files_thread_scope/migration.sql",
);

beforeAll(async () => {
  const fixture = await getRlsFixture();
  ids = fixture.ids;
  testDb = fixture.testDb;
  scopedQuery = fixture.scopedQuery;
  dryScopedQuery = fixture.dryScopedQuery;
  await installPgliteMigration({ db: testDb, migrationPath: POLICY_MIGRATION });
});

afterAll(async () => {
  await releaseRlsFixture();
});

const captureError = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

const insertFile = async (
  tx: TestDatabaseTransaction,
  id: SafeId<"userFile">,
  threadId: SafeId<"chatThread">,
) =>
  await tx.insert(userFiles).values({
    id,
    userId: ids.userA1,
    fileName: "new.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    sha256Hex: "1".repeat(64),
    s3Key: `user-files/${id}`,
    threadId,
  });

const createFileId = () => toSafeId<"userFile">(Bun.randomUUIDv7());

const dryMembershipQuery = async (
  serverValidatedWorkspaceIds: SafeId<"workspace">[],
  fn: (tx: TestDatabaseTransaction) => Promise<void>,
) => {
  const membershipDb = createMembershipScopedDb(testDb, {
    organizationId: ids.orgA,
    serverValidatedWorkspaceIds,
    userId: ids.userA1,
  });
  try {
    await membershipDb(async (tx) => {
      await fn(tx);
      tx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) {
      return;
    }
    throw error;
  }
};

describe("user_files RLS follows the owning chat thread", () => {
  test("same user cannot read files after switching organizations", async () => {
    const globalCount = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) =>
        tx.$count(userFiles, eq(userFiles.id, ids.userFileGlobalB1UserA1)),
      ids.userA1,
    );
    const workspaceCount = await scopedQuery(
      [ids.wsB1],
      ids.orgA,
      (tx) =>
        tx.$count(userFiles, eq(userFiles.id, ids.userFileWorkspaceB1UserA1)),
      ids.userA1,
    );

    expect(globalCount).toBe(0);
    expect(workspaceCount).toBe(0);
  });

  test("workspace files require current access to their workspace", async () => {
    const count = await scopedQuery(
      [],
      ids.orgA,
      (tx) => tx.$count(userFiles, eq(userFiles.id, ids.userFileWorkspaceA1)),
      ids.userA1,
    );

    expect(count).toBe(0);
  });

  test("global and workspace files remain visible in their owning scope", async () => {
    const globalCount = await scopedQuery(
      [],
      ids.orgA,
      (tx) => tx.$count(userFiles, eq(userFiles.id, ids.userFileGlobalA1)),
      ids.userA1,
    );
    const workspaceCount = await scopedQuery(
      [ids.wsA1],
      ids.orgA,
      (tx) => tx.$count(userFiles, eq(userFiles.id, ids.userFileWorkspaceA1)),
      ids.userA1,
    );

    expect(globalCount).toBe(1);
    expect(workspaceCount).toBe(1);
  });

  test("the same user's files remain visible inside their second organization", async () => {
    const globalCount = await scopedQuery(
      [],
      ids.orgB,
      (tx) =>
        tx.$count(userFiles, eq(userFiles.id, ids.userFileGlobalB1UserA1)),
      ids.userA1,
    );
    const workspaceCount = await scopedQuery(
      [ids.wsB1],
      ids.orgB,
      (tx) =>
        tx.$count(userFiles, eq(userFiles.id, ids.userFileWorkspaceB1UserA1)),
      ids.userA1,
    );

    expect(globalCount).toBe(1);
    expect(workspaceCount).toBe(1);
  });

  test("global-file visibility follows embedded workspace access", async () => {
    await dryMembershipQuery([], async (tx) => {
      await tx
        .update(userFiles)
        .set({ fileName: "still-visible.txt" })
        .where(eq(userFiles.id, ids.userFileGlobalA1));

      const visibleBeforeSeal = await tx.$count(
        userFiles,
        eq(userFiles.id, ids.userFileGlobalA1),
      );
      expect(visibleBeforeSeal).toBe(1);

      await tx
        .update(chatThreads)
        .set({ dataWorkspaceIds: [ids.wsA1] })
        .where(eq(chatThreads.id, ids.chatThreadGlobalA1));
      await tx
        .update(workspaces)
        .set({ status: "deleting" })
        .where(eq(workspaces.id, ids.wsA1));

      const hiddenAfterSeal = await tx.$count(
        userFiles,
        eq(userFiles.id, ids.userFileGlobalA1),
      );
      expect(hiddenAfterSeal).toBe(0);
    });
  });

  test("a validated deletion pin preserves attachment cleanup access", async () => {
    await dryMembershipQuery([ids.wsA1], async (tx) => {
      await tx
        .update(workspaces)
        .set({ status: "deleting" })
        .where(eq(workspaces.id, ids.wsA1));

      const deleted = await tx
        .delete(userFiles)
        .where(eq(userFiles.id, ids.userFileWorkspaceA1))
        .returning({ id: userFiles.id });
      expect(deleted).toEqual([{ id: ids.userFileWorkspaceA1 }]);
    });
  });

  test("insert, update, and delete still work in the owning workspace", async () => {
    await dryScopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) => {
        const fileId = createFileId();
        await insertFile(tx, fileId, ids.chatThreadWorkspaceA1);

        const updated = await tx
          .update(userFiles)
          .set({ fileName: "updated.txt" })
          .where(eq(userFiles.id, fileId))
          .returning({ id: userFiles.id });
        expect(updated).toEqual([{ id: fileId }]);

        const deleted = await tx
          .delete(userFiles)
          .where(eq(userFiles.id, fileId))
          .returning({ id: userFiles.id });
        expect(deleted).toEqual([{ id: fileId }]);
      },
      ids.userA1,
    );
  });

  test("insert cannot attach a file to another organization's thread", async () => {
    const error = await captureError(async () => {
      await dryScopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) => {
          await insertFile(tx, createFileId(), ids.chatThreadWorkspaceB1UserA1);
        },
        ids.userA1,
      );
    });

    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });

  test("update cannot move a file to another organization's thread", async () => {
    const error = await captureError(async () => {
      await dryScopedQuery(
        [ids.wsA1],
        ids.orgA,
        async (tx) => {
          await tx
            .update(userFiles)
            .set({ threadId: ids.chatThreadWorkspaceB1UserA1 })
            .where(eq(userFiles.id, ids.userFileWorkspaceA1));
        },
        ids.userA1,
      );
    });

    expect(isPgError(error, PG_ERROR.INSUFFICIENT_PRIVILEGE)).toBe(true);
  });

  test("foreign rows cannot be updated or deleted", async () => {
    await dryScopedQuery(
      [ids.wsA1],
      ids.orgA,
      async (tx) => {
        const updated = await tx
          .update(userFiles)
          .set({ fileName: "hidden.txt" })
          .where(eq(userFiles.id, ids.userFileGlobalB1UserA1))
          .returning({ id: userFiles.id });
        const deleted = await tx
          .delete(userFiles)
          .where(eq(userFiles.id, ids.userFileGlobalB1UserA1))
          .returning({ id: userFiles.id });

        expect(updated).toEqual([]);
        expect(deleted).toEqual([]);
      },
      ids.userA1,
    );
  });
});
