import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import {
  accountDeletionEffectChunks,
  accountDeletionRequests,
  entityDeletionCleanupRequests,
  entityDeletionEffectChunks,
} from "@/api/db/schema";
import {
  claimNextAccountDeletionEffectChunk,
  completeAccountDeletionEffectChunk,
  failAccountDeletionEffectChunk,
} from "@/api/lib/account-deletion-effect-store";
import { recordAccountDeletionRequest } from "@/api/lib/account-deletion-steps";
import { toSafeId } from "@/api/lib/branded-types";
import { createS3DeletionEffectChunks } from "@/api/lib/destructive-effect-chunks";
import {
  claimNextEntityDeletionEffectChunk,
  completeEntityDeletionEffectChunk,
  failEntityDeletionEffectChunk,
} from "@/api/lib/entity-deletion-effect-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

const requestId = toSafeId<"entityDeletionCleanupRequest">(
  "00000000-0000-4000-8000-000000000101",
);
const organizationId = toSafeId<"organization">("org_effect_lease_test");
const workspaceId = toSafeId<"workspace">(
  "00000000-0000-4000-8000-000000000102",
);
const accountRequestId = toSafeId<"accountDeletionRequest">(
  "00000000-0000-4000-8000-000000000104",
);
const userId = toSafeId<"user">("effect-lease-test-user");
let testDb: TestDatabase;

const effectDb = () =>
  asTestRaw<Parameters<typeof claimNextEntityDeletionEffectChunk>[1]>(testDb);
const accountEffectDb = () =>
  asTestRaw<Parameters<typeof claimNextAccountDeletionEffectChunk>[1]>(testDb);

const insertRequestWithChunks = async ({
  keys,
  targetRequestId,
}: {
  keys: string[];
  targetRequestId: typeof requestId;
}) => {
  await testDb.insert(entityDeletionCleanupRequests).values({
    id: targetRequestId,
    organizationId,
    s3Keys: keys,
    workspaceId,
  });
  const chunks = createS3DeletionEffectChunks(keys);
  const requestSuffix = targetRequestId.slice(-3);
  await testDb.insert(entityDeletionEffectChunks).values(
    chunks.map((chunk, index) => ({
      chunkIndex: chunk.chunkIndex,
      effectType: chunk.effectType,
      id: toSafeId<"entityDeletionEffectChunk">(
        `00000000-0000-4000-8000-${requestSuffix}${index.toString().padStart(9, "0")}`,
      ),
      payloadHash: chunk.payloadHash,
      requestId: targetRequestId,
      s3Keys: chunk.s3Keys,
    })),
  );
};

beforeAll(
  async () => {
    testDb = await getTestDb();
    await testDb.insert(user).values({
      email: "effect-lease-test@example.test",
      id: userId,
      name: "Effect Lease Test",
    });
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseTestDb();
});

describe("destructive-effect lease fencing", () => {
  test("account cleanup rejects stale success and failure settlement", async () => {
    const chunk = createS3DeletionEffectChunks(["user/object-a"])[0];
    if (!chunk) {
      throw new Error("Expected account effect chunk");
    }
    await testDb.insert(accountDeletionRequests).values({
      id: accountRequestId,
      organizationIds: [],
      status: "pending",
      storageCleanup: { s3Keys: chunk.s3Keys },
      userId,
      workspaceIds: [],
    });
    await testDb.insert(accountDeletionEffectChunks).values({
      ...chunk,
      id: toSafeId<"accountDeletionEffectChunk">(
        "00000000-0000-4000-8000-000000000105",
      ),
      requestId: accountRequestId,
    });
    const first = await claimNextAccountDeletionEffectChunk(
      accountRequestId,
      accountEffectDb(),
    );
    if (!first) {
      throw new Error("Expected first account effect claim");
    }
    await testDb
      .update(accountDeletionEffectChunks)
      .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(accountDeletionEffectChunks.id, first.chunkId));
    const successor = await claimNextAccountDeletionEffectChunk(
      accountRequestId,
      accountEffectDb(),
    );
    if (!successor) {
      throw new Error("Expected successor account effect claim");
    }

    expect(
      await completeAccountDeletionEffectChunk(first, accountEffectDb()),
    ).toBe(false);
    expect(
      await failAccountDeletionEffectChunk(
        first,
        new Error("stale failure"),
        accountEffectDb(),
      ),
    ).toBe(false);
    const owned = (
      await testDb
        .select({
          leaseToken: accountDeletionEffectChunks.leaseToken,
          status: accountDeletionEffectChunks.status,
        })
        .from(accountDeletionEffectChunks)
        .where(eq(accountDeletionEffectChunks.id, successor.chunkId))
        .limit(1)
    ).at(0);
    expect(owned).toEqual({
      leaseToken: successor.lease.token,
      status: "processing",
    });
    expect(
      await completeAccountDeletionEffectChunk(successor, accountEffectDb()),
    ).toBe(true);
    const parent = (
      await testDb
        .select({
          status: accountDeletionRequests.status,
          storageCleanup: accountDeletionRequests.storageCleanup,
        })
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, accountRequestId))
        .limit(1)
    ).at(0);
    expect(parent).toEqual({
      status: "completed",
      storageCleanup: { s3Keys: [] },
    });
  });

  test("the account-deletion producer atomically writes bounded effects", async () => {
    const producerRequestId = toSafeId<"accountDeletionRequest">(
      "00000000-0000-4000-8000-000000000107",
    );
    const keys = Array.from(
      { length: 51 },
      (_, index) => `user/producer-object-${index.toString().padStart(2, "0")}`,
    );

    await testDb.transaction(async (tx) => {
      await recordAccountDeletionRequest({
        currentUserId: userId,
        deletionRequestId: producerRequestId,
        organizationIds: [],
        s3KeysToDelete: keys,
        taskReassignmentCount: 0,
        tx: asTestRaw(tx),
        workspaceIds: [],
      });
    });

    const chunks = await testDb
      .select({
        chunkIndex: accountDeletionEffectChunks.chunkIndex,
        s3Keys: accountDeletionEffectChunks.s3Keys,
      })
      .from(accountDeletionEffectChunks)
      .where(eq(accountDeletionEffectChunks.requestId, producerRequestId))
      .orderBy(accountDeletionEffectChunks.chunkIndex);
    expect(
      chunks.map(({ chunkIndex, s3Keys }) => ({
        chunkIndex,
        size: s3Keys.length,
      })),
    ).toEqual([
      { chunkIndex: 0, size: 50 },
      { chunkIndex: 1, size: 1 },
    ]);
  });

  test("a stale worker cannot complete or fail a successor's lease", async () => {
    await insertRequestWithChunks({
      keys: ["tenant/object-a"],
      targetRequestId: requestId,
    });
    const first = await claimNextEntityDeletionEffectChunk(
      requestId,
      effectDb(),
    );
    if (!first) {
      throw new Error("Expected first effect claim");
    }
    await testDb
      .update(entityDeletionEffectChunks)
      .set({ leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(entityDeletionEffectChunks.id, first.chunkId));
    const successor = await claimNextEntityDeletionEffectChunk(
      requestId,
      effectDb(),
    );
    if (!successor) {
      throw new Error("Expected successor effect claim");
    }

    expect(successor.lease.token).not.toBe(first.lease.token);
    expect(await completeEntityDeletionEffectChunk(first, effectDb())).toBe(
      false,
    );
    expect(
      await failEntityDeletionEffectChunk(
        first,
        new Error("stale failure"),
        effectDb(),
      ),
    ).toBe(false);

    const owned = (
      await testDb
        .select({
          leaseToken: entityDeletionEffectChunks.leaseToken,
          status: entityDeletionEffectChunks.status,
        })
        .from(entityDeletionEffectChunks)
        .where(eq(entityDeletionEffectChunks.id, successor.chunkId))
        .limit(1)
    ).at(0);
    expect(owned).toEqual({
      leaseToken: successor.lease.token,
      status: "processing",
    });

    expect(await completeEntityDeletionEffectChunk(successor, effectDb())).toBe(
      true,
    );
    const parent = (
      await testDb
        .select({ status: entityDeletionCleanupRequests.status })
        .from(entityDeletionCleanupRequests)
        .where(eq(entityDeletionCleanupRequests.id, requestId))
        .limit(1)
    ).at(0);
    expect(parent?.status).toBe("completed");
  });

  test("one failed chunk does not poison later chunks", async () => {
    const poisonRequestId = toSafeId<"entityDeletionCleanupRequest">(
      "00000000-0000-4000-8000-000000000103",
    );
    const keys = Array.from(
      { length: 51 },
      (_, index) => `tenant/object-${index.toString().padStart(2, "0")}`,
    );
    await insertRequestWithChunks({ keys, targetRequestId: poisonRequestId });
    const poison = await claimNextEntityDeletionEffectChunk(
      poisonRequestId,
      effectDb(),
    );
    if (!poison) {
      throw new Error("Expected poison chunk claim");
    }
    await failEntityDeletionEffectChunk(
      poison,
      new Error("provider rejected chunk"),
      effectDb(),
    );

    const failedParent = (
      await testDb
        .select({
          nextAttemptAt: entityDeletionCleanupRequests.nextAttemptAt,
          status: entityDeletionCleanupRequests.status,
        })
        .from(entityDeletionCleanupRequests)
        .where(eq(entityDeletionCleanupRequests.id, poisonRequestId))
        .limit(1)
    ).at(0);
    const failedChunk = (
      await testDb
        .select({ nextAttemptAt: entityDeletionEffectChunks.nextAttemptAt })
        .from(entityDeletionEffectChunks)
        .where(eq(entityDeletionEffectChunks.id, poison.chunkId))
        .limit(1)
    ).at(0);
    expect(failedParent).toEqual({
      nextAttemptAt: failedChunk?.nextAttemptAt,
      status: "failed",
    });
    expect(failedParent?.nextAttemptAt).toBeInstanceOf(Date);

    const later = await claimNextEntityDeletionEffectChunk(
      poisonRequestId,
      effectDb(),
    );
    if (!later) {
      throw new Error("Expected later chunk claim");
    }
    expect(later.chunkId).not.toBe(poison.chunkId);
    expect(later.s3Keys).toHaveLength(1);
    await completeEntityDeletionEffectChunk(later, effectDb());

    const states = await testDb
      .select({ status: entityDeletionEffectChunks.status })
      .from(entityDeletionEffectChunks)
      .where(
        and(
          eq(entityDeletionEffectChunks.requestId, poisonRequestId),
          eq(entityDeletionEffectChunks.status, "failed"),
        ),
      );
    expect(states).toEqual([{ status: "failed" }]);
  });

  test("refuses to execute a payload that drifted from its hash", async () => {
    const driftedRequestId = toSafeId<"entityDeletionCleanupRequest">(
      "00000000-0000-4000-8000-000000000108",
    );
    await insertRequestWithChunks({
      keys: ["tenant/drifted-object"],
      targetRequestId: driftedRequestId,
    });
    await testDb
      .update(entityDeletionEffectChunks)
      .set({ payloadHash: "0".repeat(64) })
      .where(eq(entityDeletionEffectChunks.requestId, driftedRequestId));

    const rejection: unknown = await claimNextEntityDeletionEffectChunk(
      driftedRequestId,
      effectDb(),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      message: expect.stringContaining("payload hash"),
    });

    const row = (
      await testDb
        .select({ status: entityDeletionEffectChunks.status })
        .from(entityDeletionEffectChunks)
        .where(eq(entityDeletionEffectChunks.requestId, driftedRequestId))
        .limit(1)
    ).at(0);
    expect(row?.status).toBe("pending");
  });
});
