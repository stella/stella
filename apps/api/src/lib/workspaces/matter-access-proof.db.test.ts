import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { contacts, workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withMatterAccess } from "@/api/lib/workspaces/matter-access-proof";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)("matter access proofs (postgres)", () => {
  test("mints only after the transaction-bound access and write decisions", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const memberUserId = mintAuthProviderId<"user">();
      const externalUserId = mintAuthProviderId<"user">();
      const nonMemberUserId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const clientId = createSafeId<"contact">();
      await db.insert(organization).values({
        id: organizationId,
        name: "Matter proof fixture",
        slug: organizationId,
        createdAt: new Date(),
      });
      await db.insert(user).values(
        [memberUserId, externalUserId, nonMemberUserId].map((id) => ({
          id,
          name: "Matter proof fixture",
          email: `${id}@example.test`,
        })),
      );
      await db.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: memberUserId,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: externalUserId,
          role: "external",
          createdAt: new Date(),
        },
      ]);
      await db.insert(contacts).values({
        id: clientId,
        organizationId,
        type: "person",
        displayName: "Matter proof client",
      });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        clientId,
        name: "Matter proof fixture",
        reference: "PROOF-1",
      });
      await db.insert(workspaceMembers).values([
        { workspaceId, userId: memberUserId },
        { workspaceId, userId: externalUserId },
      ]);

      try {
        const order: string[] = [];
        await db.transaction(async (tx) => {
          const allowed = await withMatterAccess(
            {
              tx,
              organizationId,
              userId: memberUserId,
              workspaceId,
              need: "read",
              lock: async () => {
                order.push("lock");
              },
            },
            async ({ tx: checkedTx, matter, proof }) => {
              order.push("run");
              expect(checkedTx.value).toBe(tx);
              expect(matter.value).toBe(workspaceId);
              expect(proof.kind).toBe("MatterReadable");
              return Result.ok("read");
            },
          );
          expect(allowed).toEqual(Result.ok("read"));

          let deniedRan = false;
          const denied = await withMatterAccess(
            {
              tx,
              organizationId,
              userId: nonMemberUserId,
              workspaceId,
              need: "read",
            },
            async () => {
              deniedRan = true;
              return Result.ok(undefined);
            },
          );
          expect(Result.isError(denied)).toBe(true);
          expect(deniedRan).toBe(false);

          let writeRan = false;
          const writeDenied = await withMatterAccess(
            {
              tx,
              organizationId,
              userId: externalUserId,
              workspaceId,
              need: "write",
            },
            async () => {
              writeRan = true;
              return Result.ok(undefined);
            },
          );
          expect(Result.isError(writeDenied)).toBe(true);
          expect(writeRan).toBe(false);
        });
        expect(order).toEqual(["lock", "run"]);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, memberUserId));
        await db.delete(user).where(eq(user.id, externalUserId));
        await db.delete(user).where(eq(user.id, nonMemberUserId));
      }
    });
  });
});
