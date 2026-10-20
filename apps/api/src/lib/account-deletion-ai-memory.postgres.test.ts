import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/node";

import { organization, user } from "@/api/db/auth-schema";
import { aiMemories } from "@/api/db/schema";
import { deletePersonalAiMemories } from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("memory account lifecycle (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("memory ownership waits for the account lifecycle fence (postgres)", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const deletion = openClient().db;
      const writer = openClient().db;
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const locked = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<undefined>();
      let deleting: Promise<void> | undefined;
      const memoryId = createSafeId<"aiMemory">();
      const values = {
        id: memoryId,
        organizationId,
        scope: "user",
        userId,
        kind: "preference",
        content: "Use numbered paragraphs",
        dedupKey: sha256Hex(memoryId),
        source: "user",
        createdBy: userId,
      } as const;
      try {
        await deletion.insert(organization).values({
          id: organizationId,
          name: "Memory settings",
          slug: organizationId,
          createdAt: new Date(),
        });
        await deletion.insert(user).values({
          id: userId,
          name: "Memory settings",
          email: `${userId}@example.test`,
        });
        deleting = deletion.transaction(async (tx) => {
          // Match lockAccountRow's NO KEY UPDATE acquisition exactly.
          await tx.execute(
            sql`SELECT id FROM public."user" WHERE id = ${userId} FOR NO KEY UPDATE`,
          );
          locked.resolve(undefined);
          await finish.promise;
          await deletePersonalAiMemories(tx, userId);
          await tx
            .update(user)
            .set({ deletedAt: new Date() })
            .where(eq(user.id, userId));
        });
        await Promise.race([locked.promise, deleting]);
        const blocked = await rejectionOf(
          writer.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
            await tx.insert(aiMemories).values(values);
          }),
        );
        expect(getPgErrorCode(blocked)).toBe("55P03");
        finish.resolve(undefined);
        await deleting;
        const refused = await rejectionOf(
          writer.insert(aiMemories).values(values),
        );
        expect(getPgErrorCode(refused)).toBe("23514");
        expect(
          await deletion.$count(aiMemories, eq(aiMemories.id, memoryId)),
        ).toBe(0);
      } finally {
        finish.resolve(undefined);
        if (deleting) {
          await Promise.allSettled([deleting]);
        }
        await deletion
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await deletion.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
