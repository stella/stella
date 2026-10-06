import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { createMembershipFence } from "@/api/lib/review-organization/reset";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// Row locks need two real sessions; PGlite runs one connection, so this
// suite needs a real server.
if (!databaseUrl || !enabled) {
  describe.skip("review organization membership fence (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("review organization membership fence (postgres)", () => {
    test("a join waits for the fenced transaction, and the next transaction refuses", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const reset = openClient();
        const joiner = openClient();
        const reviewUserId = mintAuthProviderId<"user">();
        const otherUserId = mintAuthProviderId<"user">();
        const organizationId = mintAuthProviderId<"organization">();
        const now = new Date();
        await reset.db.insert(user).values(
          [reviewUserId, otherUserId].map((id) => ({
            id,
            name: id,
            email: `${id}@example.test`,
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          })),
        );
        await reset.db.insert(organization).values({
          id: organizationId,
          name: "Fence fixture",
          slug: `fence-${organizationId}`,
          createdAt: now,
        });
        await reset.db.insert(member).values({
          id: Bun.randomUUIDv7(),
          organizationId,
          userId: reviewUserId,
          role: "owner",
          createdAt: now,
        });
        const target = {
          organizationId,
          userId: reviewUserId,
          email: `${reviewUserId}@example.test`,
          role: "owner" as const,
        };
        try {
          const held = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const fence = createMembershipFence(target, async () => {
            held.resolve(undefined);
            await release.promise;
          });
          const fenced = reset.db.transaction(async (tx) => {
            await fence.assert(asTestRaw<Transaction>(tx));
          });
          await held.promise;

          let joined = false;
          const join = joiner.db
            .insert(member)
            .values({
              id: Bun.randomUUIDv7(),
              organizationId,
              userId: otherUserId,
              role: "member",
              createdAt: new Date(),
            })
            .then(() => {
              joined = true;
              return joined;
            });
          // The insert's foreign-key check waits on the locked organization.
          const waited = await Promise.race([
            join.then(() => "joined" as const),
            Bun.sleep(500).then(() => "waiting" as const),
          ]);
          expect(waited).toBe("waiting");
          expect(joined).toBe(false);

          release.resolve(undefined);
          await fenced;
          await join;
          expect(joined).toBe(true);
          expect(fence.tripped).toBe(false);

          // The next fenced transaction sees the new member and refuses.
          const next = createMembershipFence(target, undefined);
          const refused = await Result.tryPromise({
            try: async () =>
              await reset.db.transaction(async (tx) => {
                await next.assert(asTestRaw<Transaction>(tx));
              }),
            catch: (cause) => cause,
          });
          expect(Result.isError(refused)).toBe(true);
          expect(next.tripped).toBe(true);
        } finally {
          await reset.db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await reset.db
            .delete(user)
            .where(inArray(user.id, [reviewUserId, otherUserId]));
        }
      });
    });
  });
}
