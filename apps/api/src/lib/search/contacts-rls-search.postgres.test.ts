import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  contacts,
  contactSearchDocuments,
  workspaceContacts,
  workspaces,
  workspaceSearchDocuments,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { rebuildSupplementalSearchIndex } from "@/api/lib/search/index-global";
import {
  createSearchProjectionRepairDeps,
  drainSearchProjectionRepairQueue,
  enqueueContactSearchRepairs,
  enqueueWorkspaceSearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("contact search under forced row security", () => {
  test("projects contacts and their matters in each organization scope", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationA = mintAuthProviderId<"organization">();
      const organizationB = mintAuthProviderId<"organization">();
      const contactA = createSafeId<"contact">();
      const partyA = createSafeId<"contact">();
      const contactB = createSafeId<"contact">();
      const partyB = createSafeId<"contact">();
      const workspaceA = createSafeId<"workspace">();
      const workspaceB = createSafeId<"workspace">();
      const clientAName = "Aster Client";
      const partyAName = "Aster Party";
      const clientBName = "Birch Client";
      const partyBName = "Birch Party";
      const contactNames = [clientAName, partyAName, clientBName, partyBName];

      await db.insert(organization).values([
        {
          id: organizationA,
          name: "Search organization A",
          slug: organizationA,
          createdAt: new Date(),
        },
        {
          id: organizationB,
          name: "Search organization B",
          slug: organizationB,
          createdAt: new Date(),
        },
      ]);

      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.organization_id', ${organizationA}, true)`,
          );
          await tx.insert(contacts).values([
            {
              id: contactA,
              organizationId: organizationA,
              type: "person",
              displayName: clientAName,
              firstName: "Aster",
              lastName: "Client",
            },
            {
              id: partyA,
              organizationId: organizationA,
              type: "person",
              displayName: partyAName,
              firstName: "Aster",
              lastName: "Party",
            },
          ]);
        });
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.organization_id', ${organizationB}, true)`,
          );
          await tx.insert(contacts).values([
            {
              id: contactB,
              organizationId: organizationB,
              type: "person",
              displayName: clientBName,
              firstName: "Birch",
              lastName: "Client",
            },
            {
              id: partyB,
              organizationId: organizationB,
              type: "person",
              displayName: partyBName,
              firstName: "Birch",
              lastName: "Party",
            },
          ]);
        });
        await db.insert(workspaces).values([
          {
            id: workspaceA,
            organizationId: organizationA,
            clientId: contactA,
            name: "Aster matter",
            reference: "ASTER-1",
          },
          {
            id: workspaceB,
            organizationId: organizationB,
            clientId: contactB,
            name: "Birch matter",
            reference: "BIRCH-1",
          },
        ]);
        await db.insert(workspaceContacts).values([
          {
            id: createSafeId<"workspaceContact">(),
            organizationId: organizationA,
            workspaceId: workspaceA,
            contactId: partyA,
            role: "opposing_party",
          },
          {
            id: createSafeId<"workspaceContact">(),
            organizationId: organizationB,
            workspaceId: workspaceB,
            contactId: partyB,
            role: "opposing_party",
          },
        ]);

        const deps = createSearchProjectionRepairDeps(db);
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.organization_id', ${organizationA}, true)`,
          );
          await enqueueContactSearchRepairs(tx, [contactA, partyA]);
        });
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.organization_id', ${organizationB}, true)`,
          );
          await enqueueContactSearchRepairs(tx, [contactB, partyB]);
        });
        expect(
          await drainSearchProjectionRepairQueue({ deps, limit: 10 }),
        ).toEqual({ failed: 0, repaired: 4 });

        expect(
          await db
            .select({ title: contactSearchDocuments.title })
            .from(contactSearchDocuments)
            .where(
              inArray(contactSearchDocuments.contactId, [
                contactA,
                partyA,
                contactB,
                partyB,
              ]),
            )
            .orderBy(contactSearchDocuments.title),
        ).toEqual(contactNames.map((title) => ({ title })));
        expect(
          await db
            .select({
              id: workspaceSearchDocuments.workspaceId,
              text: workspaceSearchDocuments.searchableText,
            })
            .from(workspaceSearchDocuments)
            .where(
              inArray(workspaceSearchDocuments.workspaceId, [
                workspaceA,
                workspaceB,
              ]),
            )
            .orderBy(workspaceSearchDocuments.workspaceId),
        ).toEqual([
          {
            id: workspaceA,
            text: "ASTER-1 Aster Client Aster Client opposing_party Aster Party Aster Party",
          },
          {
            id: workspaceB,
            text: "BIRCH-1 Birch Client Birch Client opposing_party Birch Party Birch Party",
          },
        ]);

        await db
          .delete(workspaceSearchDocuments)
          .where(
            inArray(workspaceSearchDocuments.workspaceId, [
              workspaceA,
              workspaceB,
            ]),
          );
        await db.transaction(async (tx) => {
          await enqueueWorkspaceSearchRepairs(tx, [workspaceA, workspaceB]);
        });
        expect(
          await drainSearchProjectionRepairQueue({ deps, limit: 10 }),
        ).toEqual({ failed: 0, repaired: 2 });
        expect(
          await db
            .select({ text: workspaceSearchDocuments.searchableText })
            .from(workspaceSearchDocuments)
            .where(
              inArray(workspaceSearchDocuments.workspaceId, [
                workspaceA,
                workspaceB,
              ]),
            )
            .orderBy(workspaceSearchDocuments.workspaceId),
        ).toEqual([
          {
            text: "ASTER-1 Aster Client Aster Client opposing_party Aster Party Aster Party",
          },
          {
            text: "BIRCH-1 Birch Client Birch Client opposing_party Birch Party Birch Party",
          },
        ]);

        await db
          .delete(contactSearchDocuments)
          .where(
            inArray(contactSearchDocuments.contactId, [
              contactA,
              partyA,
              contactB,
              partyB,
            ]),
          );
        await db
          .delete(workspaceSearchDocuments)
          .where(
            inArray(workspaceSearchDocuments.workspaceId, [
              workspaceA,
              workspaceB,
            ]),
          );
        await rebuildSupplementalSearchIndex(organizationA);
        await rebuildSupplementalSearchIndex(organizationB);
        expect(
          await db
            .select({ title: contactSearchDocuments.title })
            .from(contactSearchDocuments)
            .where(
              inArray(contactSearchDocuments.contactId, [
                contactA,
                partyA,
                contactB,
                partyB,
              ]),
            )
            .orderBy(contactSearchDocuments.title),
        ).toEqual(contactNames.map((title) => ({ title })));
        expect(
          await db
            .select({ text: workspaceSearchDocuments.searchableText })
            .from(workspaceSearchDocuments)
            .where(
              inArray(workspaceSearchDocuments.workspaceId, [
                workspaceA,
                workspaceB,
              ]),
            )
            .orderBy(workspaceSearchDocuments.workspaceId),
        ).toEqual([
          {
            text: "ASTER-1 Aster Client Aster Client opposing_party Aster Party Aster Party",
          },
          {
            text: "BIRCH-1 Birch Client Birch Client opposing_party Birch Party Birch Party",
          },
        ]);
      } finally {
        await db.delete(organization).where(eq(organization.id, organizationA));
        await db.delete(organization).where(eq(organization.id, organizationB));
      }
    });
  });
});
