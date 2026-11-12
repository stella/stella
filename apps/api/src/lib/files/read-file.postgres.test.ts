import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { lockLiveVersionField } from "@/api/lib/files/read-file";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const createdAt = new Date("2026-01-01T00:00:00.000Z");
const tombstonedAt = new Date("2026-02-01T00:00:00.000Z");

if (!databaseUrl || !enabled) {
  describe.skip("live version field lock (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("a version tombstone never completes between the live lookup and the work it guards", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const workspaceId = createSafeId<"workspace">();
      const entityId = createSafeId<"entity">();
      const versionId = createSafeId<"entityVersion">();
      const fieldId = createSafeId<"field">();
      const propertyId = createSafeId<"property">();
      // Per schedule: what the reader saw, and whether the tombstone had
      // already returned when the reader acted on a live row.
      let found: boolean | null = null;
      let tombstoned = false;
      let actedAfterTombstone = false;
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Live version lock",
          slug: organizationId,
          createdAt,
        });
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Live version lock",
          reference: workspaceId,
        });
        await db.insert(entities).values({
          id: entityId,
          workspaceId,
          kind: "document",
          name: "Live version lock",
        });
        await db
          .insert(entityVersions)
          .values({ id: versionId, entityId, workspaceId });
        await db.insert(properties).values({
          id: propertyId,
          workspaceId,
          name: "Text",
          content: { type: "text", version: 1 },
          tool: { type: "manual-input", version: 1 },
          status: "fresh",
          kinds: ["document"],
        });
        await db.insert(fields).values({
          id: fieldId,
          propertyId,
          workspaceId,
          entityVersionId: versionId,
          content: { type: "text", version: 1, value: "Source" },
        });
        await withInterleaving({
          databaseUrl,
          a: {
            steps: [
              {
                name: "lookup",
                run: async (tx) => {
                  found =
                    (await lockLiveVersionField(tx, fieldId, workspaceId)) !==
                    null;
                },
              },
              {
                // Stands in for signing and auditing a link to the version.
                name: "act",
                run: async () => {
                  if (found === true && tombstoned) {
                    actedAfterTombstone = true;
                  }
                },
              },
            ],
          },
          b: {
            steps: [
              {
                // The version-delete order: entity row for update, then the
                // tombstone write.
                name: "tombstone",
                run: async (tx) => {
                  await tx
                    .select({ id: entities.id })
                    .from(entities)
                    .where(eq(entities.id, entityId))
                    .for("update");
                  await tx
                    .update(entityVersions)
                    .set({ deletedAt: tombstonedAt })
                    .where(eq(entityVersions.id, versionId));
                  tombstoned = true;
                },
              },
            ],
          },
          reset: async () => {
            found = null;
            tombstoned = false;
            actedAfterTombstone = false;
            await db
              .update(entityVersions)
              .set({ deletedAt: null })
              .where(eq(entityVersions.id, versionId));
          },
          readState: async () =>
            await db
              .select({ deletedAt: entityVersions.deletedAt })
              .from(entityVersions)
              .where(eq(entityVersions.id, versionId)),
          invariant: ({ executed, outcomes, state }) => {
            expect(outcomes.a).toEqual({ status: "committed" });
            expect(outcomes.b).toEqual({ status: "committed" });
            expect(state.at(0)?.deletedAt).toBeInstanceOf(Date);
            expect(actedAfterTombstone).toBe(false);
            if (executed.indexOf("b.commit") < executed.indexOf("a.lookup")) {
              expect(found).toBe(false);
            }
          },
        });
      } finally {
        await deleteOrganizationsForTest(db, [organizationId]);
      }
    });
  });
}
