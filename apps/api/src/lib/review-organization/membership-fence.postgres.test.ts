import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { defaultMatterVisibilityFor } from "@stll/api-contract/matter-visibility";

import type { Transaction } from "@/api/db/root";
import { workspaceMembers } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { createMembershipFence } from "@/api/lib/review-organization/reset";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { insertWorkspaceRowsInTransaction } from "@/api/lib/workspaces/create-workspace-row";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// Row locks need two real sessions; PGlite runs one connection, so this
// suite needs a real server with the committed migrations applied.
if (!databaseUrl || !enabled) {
  describe.skip("review organization membership fence (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("review organization membership fence (postgres)", () => {
    test("a join and a new matter wait for the fenced transaction, and the next transaction refuses", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const reset = openClient();
        const joiner = openClient();
        const joiner2 = openClient();
        const lateMatterId = createSafeId<"workspace">();
        const reviewUserId = mintAuthProviderId<"user">();
        const otherUserId = mintAuthProviderId<"user">();
        const organizationId = mintAuthProviderId<"organization">();
        const joinedMemberId = Bun.randomUUIDv7();
        await reset.sql`
          INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
          VALUES
            (${reviewUserId}, 'Review', ${`${reviewUserId}@example.test`}, true, now(), now()),
            (${otherUserId}, 'Other', ${`${otherUserId}@example.test`}, true, now(), now())`;
        await reset.sql`
          INSERT INTO organization (id, name, slug, created_at)
          VALUES (${organizationId}, 'Fence fixture', ${`fence-${organizationId}`}, now())`;
        await recordNewOrganizationAccessState(reset.db, {
          organizationId,
          now: new Date(),
        });
        await reset.sql`
          INSERT INTO member (id, organization_id, user_id, role, created_at)
          VALUES (${Bun.randomUUIDv7()}, ${organizationId}, ${reviewUserId}, 'owner', now())`;
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

          // The insert's foreign-key check takes FOR KEY SHARE on the
          // organization row the fenced transaction holds FOR UPDATE.
          const join = joiner.sql`
            INSERT INTO member (id, organization_id, user_id, role, created_at)
            VALUES (${joinedMemberId}, ${organizationId}, ${otherUserId}, 'member', now())`.then(
            () => "joined" as const,
          );
          // A matter insert checks its foreign key to the same row, so a
          // matter cannot appear while the sweep counts them either.
          const matter = joiner2.db.transaction(async (tx) => {
            await insertWorkspaceRowsInTransaction({
              tx,
              rows: [
                {
                  id: lateMatterId,
                  organizationId,
                  name: "Late matter",
                  reference: "LATE-1",
                  visibility: defaultMatterVisibilityFor({ hasClient: false }),
                  leadUserId: reviewUserId,
                },
              ],
            });
            await tx
              .insert(workspaceMembers)
              .values({ workspaceId: lateMatterId, userId: reviewUserId });
            return "created" as const;
          });
          const waited = await Promise.race([
            join,
            matter,
            Bun.sleep(500).then(() => "waiting" as const),
          ]);
          expect(waited).toBe("waiting");

          release.resolve(undefined);
          await fenced;
          expect(await join).toBe("joined");
          expect(await matter).toBe("created");
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
          await reset.sql`DELETE FROM organization WHERE id = ${organizationId}`;
          await reset.sql`DELETE FROM "user" WHERE id IN (${reviewUserId}, ${otherUserId})`;
        }
      });
    });
  });
}
