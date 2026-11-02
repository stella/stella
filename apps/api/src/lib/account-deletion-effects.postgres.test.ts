import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { user } from "@/api/db/auth-schema";
import {
  accountDeletionEffectChunks,
  accountDeletionRequests,
} from "@/api/db/schema";
import {
  claimNextAccountDeletionEffectChunk,
  ensureAccountDeletionEffectChunks,
} from "@/api/lib/account-deletion-effect-store";
import { recordAccountDeletionRequest } from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("account deletion storage deadlines", () => {
  test("durable chunks retain publication deadlines through reconstruction", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      // The request row is locked through its owner, so the fixture lives in
      // the real tables and removes only its own rows afterwards.
      const userId = mintAuthProviderId<"user">();
      const requestId = createSafeId<"accountDeletionRequest">();
      await db.insert(user).values({
        id: userId,
        name: "Account deletion fixture",
        email: `${userId}@example.test`,
      });
      try {
        const notBefore = new Date(Date.now() + 60 * 60 * 1000);
        await db.transaction(async (tx) => {
          await recordAccountDeletionRequest({
            tx,
            deletionRequestId: requestId,
            currentUserId: userId,
            organizationIds: [],
            workspaceIds: [],
            taskReassignmentCount: 0,
            s3KeysToDelete: ["account-exports/account/export/attempt.zip"],
            storageCleanupNotBefore: notBefore,
          });
        });
        const readChunks = async () =>
          await db
            .select({
              nextAttemptAt: accountDeletionEffectChunks.nextAttemptAt,
            })
            .from(accountDeletionEffectChunks)
            .where(eq(accountDeletionEffectChunks.requestId, requestId));
        expect(await readChunks()).toEqual([{ nextAttemptAt: null }]);
        expect(
          await claimNextAccountDeletionEffectChunk(requestId, db),
        ).toBeNull();
        await db
          .delete(accountDeletionEffectChunks)
          .where(eq(accountDeletionEffectChunks.requestId, requestId));
        expect(await ensureAccountDeletionEffectChunks(requestId, db)).toBe(1);
        expect(await readChunks()).toEqual([{ nextAttemptAt: null }]);
        expect(
          await claimNextAccountDeletionEffectChunk(requestId, db),
        ).toBeNull();
        await db
          .update(accountDeletionRequests)
          .set({
            storageCleanup: sql`jsonb_set(${accountDeletionRequests.storageCleanup}, '{notBefore}', to_jsonb((clock_timestamp() - INTERVAL '1 second')::text))`,
          })
          .where(eq(accountDeletionRequests.id, requestId));
        expect(
          await claimNextAccountDeletionEffectChunk(requestId, db),
        ).not.toBeNull();
      } finally {
        await db
          .delete(accountDeletionEffectChunks)
          .where(eq(accountDeletionEffectChunks.requestId, requestId));
        await db
          .delete(accountDeletionRequests)
          .where(eq(accountDeletionRequests.id, requestId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
});
