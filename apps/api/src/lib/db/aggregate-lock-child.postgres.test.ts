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
import {
  withAggregateLock,
  withAggregateRowQuery,
} from "@/api/lib/db/aggregate-lock";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("joined aggregate source locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("a joined source acquisition fences the entity, version and field until commit", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const workspaceId = createSafeId<"workspace">();
      const entityId = createSafeId<"entity">();
      const versionId = createSafeId<"entityVersion">();
      const fieldId = createSafeId<"field">();
      const propertyId = createSafeId<"property">();
      const source = {
        aggregate: "entity",
        id: { id: entityId, workspaceId },
      } as const;
      const children = [
        { aggregate: "entityVersion", id: { id: versionId, workspaceId } },
        { aggregate: "field", id: { id: fieldId, workspaceId } },
      ] as const;
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Source locks",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Source locks",
          reference: workspaceId,
        });
        await db.insert(entities).values({
          id: entityId,
          workspaceId,
          kind: "document",
          name: "Source locks",
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
          schedules: [
            ["a.source", "b.probe", "a.commit", "b.waitSource", "b.commit"],
          ],
          a: {
            steps: [
              {
                name: "source",
                run: async (tx) => {
                  const result = await withAggregateRowQuery({
                    ...source,
                    tx,
                    children,
                    mode: "update",
                    select: () =>
                      tx
                        .select({
                          entityId: entities.id,
                          workspaceId: entities.workspaceId,
                          versionId: entityVersions.id,
                          versionWorkspaceId: entityVersions.workspaceId,
                          fieldId: fields.id,
                          fieldWorkspaceId: fields.workspaceId,
                        })
                        .from(entities)
                        .innerJoin(
                          entityVersions,
                          eq(entityVersions.entityId, entities.id),
                        )
                        .innerJoin(
                          fields,
                          eq(fields.entityVersionId, entityVersions.id),
                        ),
                  });
                  expect(result.status).toBe("locked");
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "probe",
                run: async (tx) => {
                  for (const identity of [source, ...children]) {
                    expect(
                      (
                        await withAggregateLock({
                          ...identity,
                          tx,
                          mode: "update",
                          wait: "nowait",
                        })
                      ).status,
                    ).toBe("busy");
                  }
                },
              },
              {
                name: "waitSource",
                run: async (tx) => {
                  for (const identity of [source, ...children]) {
                    expect(
                      await withAggregateLock({
                        ...identity,
                        tx,
                        mode: "update",
                      }),
                    ).toEqual({ status: "locked" });
                  }
                },
              },
            ],
          },
          reset: async () => {},
          readState: async () =>
            await db
              .select({ id: fields.id })
              .from(fields)
              .where(eq(fields.id, fieldId)),
          invariant: ({ outcomes, state, sessions }) => {
            expect(sessions.a.pid).not.toBe(sessions.b.pid);
            expect(outcomes.a).toEqual({ status: "committed" });
            expect(outcomes.b).toEqual({ status: "committed" });
            expect(state).toEqual([{ id: fieldId }]);
          },
        });
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
    });
  });
}
