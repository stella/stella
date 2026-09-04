import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { organization, user } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import { aiMemories } from "@/api/db/schema";
import {
  deletePersonalAiMemories,
  finalizeDeletedUserRecord,
  lockUserRowForDeletion,
} from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import { isPgConstraintError } from "@/api/lib/pg-error";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const ACTIVE_USER_GUARD_CONSTRAINT = "ai_memories_active_user_guard";
const CHECK_VIOLATION = "23514";

const dedupKey = (value: string) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

if (!databaseUrl || !runPostgresTests) {
  describe.skip("account deletion AI memory fence (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("account deletion AI memory fence (postgres)", () => {
    test("writers waiting behind deletion cannot restore memory ownership", async () => {
      const deletionClient = new SQL({ url: databaseUrl, max: 1 });
      const writerClient = new SQL({ url: databaseUrl, max: 1 });
      const deletionDb = drizzle({
        client: deletionClient,
        relations: databaseRelations,
      });
      const writerDb = drizzle({
        client: writerClient,
        relations: databaseRelations,
      });
      const organizationId = createSafeId<"organization">();
      const userId = createSafeId<"user">();
      const sharedMemoryId = createSafeId<"aiMemory">();
      const personalMemoryId = createSafeId<"aiMemory">();
      const deletionLocked = Promise.withResolvers<undefined>();
      const releaseDeletion = Promise.withResolvers<undefined>();
      const writerAttempted = Promise.withResolvers<undefined>();
      let deletion: Promise<void> | undefined;
      let writerOutcome:
        | Promise<{ type: "inserted" } | { type: "rejected"; error: unknown }>
        | undefined;

      try {
        await deletionDb.insert(user).values({
          id: userId,
          email: `${userId}@example.test`,
          name: "Memory deletion race user",
        });
        await deletionDb.insert(organization).values({
          id: organizationId,
          createdAt: new Date(),
          name: "Memory deletion race organization",
          slug: `memory-deletion-race-${organizationId}`,
        });

        deletion = deletionDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          await lockUserRowForDeletion(tx, userId);
          deletionLocked.resolve(undefined);
          await releaseDeletion.promise;
          await finalizeDeletedUserRecord(tx, userId);
        });
        await deletionLocked.promise;

        writerOutcome = writerDb
          .transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            writerAttempted.resolve(undefined);
            await tx.insert(aiMemories).values({
              id: sharedMemoryId,
              organizationId,
              scope: "organization",
              kind: "preference",
              content: "This row must not regain a deleted creator",
              dedupKey: dedupKey(sharedMemoryId),
              source: "user",
              createdBy: userId,
            });
          })
          .then(
            () => ({ type: "inserted" }) as const,
            (error: unknown) => ({ type: "rejected", error }) as const,
          );
        await writerAttempted.promise;

        const overtookDeletion = await Promise.race([
          writerOutcome.then(() => true),
          Bun.sleep(100).then(() => false),
        ]);
        expect(overtookDeletion).toBe(false);

        releaseDeletion.resolve(undefined);
        await deletion;
        const outcome = await writerOutcome;
        expect(outcome.type).toBe("rejected");
        if (outcome.type === "rejected") {
          expect(
            isPgConstraintError(
              outcome.error,
              CHECK_VIOLATION,
              ACTIVE_USER_GUARD_CONSTRAINT,
            ),
          ).toBe(true);
        }

        const personalOutcome = await writerDb
          .insert(aiMemories)
          .values({
            id: personalMemoryId,
            organizationId,
            scope: "user",
            userId,
            kind: "preference",
            content: "This row must not outlive its owner",
            dedupKey: dedupKey(personalMemoryId),
            source: "user",
            createdBy: userId,
          })
          .then(
            () => ({ type: "inserted" }) as const,
            (error: unknown) => ({ type: "rejected", error }) as const,
          );
        expect(personalOutcome.type).toBe("rejected");
        if (personalOutcome.type === "rejected") {
          expect(
            isPgConstraintError(
              personalOutcome.error,
              CHECK_VIOLATION,
              ACTIVE_USER_GUARD_CONSTRAINT,
            ),
          ).toBe(true);
        }
      } finally {
        releaseDeletion.resolve(undefined);
        await deletion?.catch(() => undefined);
        await writerOutcome?.catch(() => undefined);
        await deletionDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await deletionDb.delete(user).where(eq(user.id, userId));
        await Promise.all([
          deletionClient.close({ timeout: 0 }),
          writerClient.close({ timeout: 0 }),
        ]);
      }
    });

    test("deletion waits for earlier writers and sweeps every ownership shape", async () => {
      const writerClient = new SQL({ url: databaseUrl, max: 1 });
      const deletionClient = new SQL({ url: databaseUrl, max: 1 });
      const writerDb = drizzle({
        client: writerClient,
        relations: databaseRelations,
      });
      const deletionDb = drizzle({
        client: deletionClient,
        relations: databaseRelations,
      });
      const organizationId = createSafeId<"organization">();
      const userId = createSafeId<"user">();
      const personalMemoryId = createSafeId<"aiMemory">();
      const suggestionId = createSafeId<"aiMemory">();
      const acceptedSharedId = createSafeId<"aiMemory">();
      const writerInserted = Promise.withResolvers<undefined>();
      const releaseWriter = Promise.withResolvers<undefined>();
      const deletionAttempted = Promise.withResolvers<undefined>();
      const deletionLocked = Promise.withResolvers<undefined>();
      let writer: Promise<void> | undefined;
      let deletion: Promise<void> | undefined;

      try {
        await writerDb.insert(user).values({
          id: userId,
          email: `${userId}@example.test`,
          name: "Memory writer race user",
        });
        await writerDb.insert(organization).values({
          id: organizationId,
          createdAt: new Date(),
          name: "Memory writer race organization",
          slug: `memory-writer-race-${organizationId}`,
        });

        writer = writerDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          await tx.insert(aiMemories).values([
            {
              id: personalMemoryId,
              organizationId,
              scope: "user",
              userId,
              kind: "preference",
              content: "Personal concurrent memory",
              dedupKey: dedupKey(personalMemoryId),
              source: "user",
              createdBy: userId,
            },
            {
              id: suggestionId,
              organizationId,
              scope: "organization",
              kind: "instruction",
              content: "Concurrent private suggestion",
              dedupKey: dedupKey(suggestionId),
              source: "extracted",
              status: "suggested",
              createdBy: userId,
            },
            {
              id: acceptedSharedId,
              organizationId,
              scope: "organization",
              kind: "instruction",
              content: "Concurrent accepted shared memory",
              dedupKey: dedupKey(acceptedSharedId),
              source: "user",
              createdBy: userId,
            },
          ]);
          writerInserted.resolve(undefined);
          await releaseWriter.promise;
        });
        await writerInserted.promise;

        deletion = deletionDb.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          deletionAttempted.resolve(undefined);
          await lockUserRowForDeletion(tx, userId);
          deletionLocked.resolve(undefined);
          await deletePersonalAiMemories(tx, userId);
          await finalizeDeletedUserRecord(tx, userId);
        });
        await deletionAttempted.promise;

        const overtookWriter = await Promise.race([
          deletionLocked.promise.then(() => true),
          Bun.sleep(100).then(() => false),
        ]);
        expect(overtookWriter).toBe(false);

        releaseWriter.resolve(undefined);
        await Promise.all([writer, deletion]);

        const remaining = await deletionDb
          .select({ createdBy: aiMemories.createdBy, id: aiMemories.id })
          .from(aiMemories)
          .where(
            inArray(aiMemories.id, [
              personalMemoryId,
              suggestionId,
              acceptedSharedId,
            ]),
          );
        expect(remaining).toEqual([{ createdBy: null, id: acceptedSharedId }]);

        const restorationOutcome = await deletionDb
          .update(aiMemories)
          .set({ createdBy: userId })
          .where(eq(aiMemories.id, acceptedSharedId))
          .then(
            () => ({ type: "updated" }) as const,
            (error: unknown) => ({ type: "rejected", error }) as const,
          );
        expect(restorationOutcome.type).toBe("rejected");
        if (restorationOutcome.type === "rejected") {
          expect(
            isPgConstraintError(
              restorationOutcome.error,
              CHECK_VIOLATION,
              ACTIVE_USER_GUARD_CONSTRAINT,
            ),
          ).toBe(true);
        }
      } finally {
        releaseWriter.resolve(undefined);
        await writer?.catch(() => undefined);
        await deletion?.catch(() => undefined);
        await writerDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await writerDb.delete(user).where(eq(user.id, userId));
        await Promise.all([
          writerClient.close({ timeout: 0 }),
          deletionClient.close({ timeout: 0 }),
        ]);
      }
    });
  });
}
