import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { entities, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationUrl = new URL(
  "../../../drizzle/20261003123500_entity_parent_cycle_repair/migration.sql",
  import.meta.url,
);
const countUrl = new URL("parent-cycle-count.sql", import.meta.url);

// Real Postgres applies the committed SQL, including recursive-array semantics
// and self-referential foreign keys, rather than a second repair algorithm.
describe.skipIf(!databaseUrl || !runPostgresTests)(
  "folder parent repair on Postgres",
  () => {
    test("detaches one smallest cycle member, preserves tails and other fields, and converges on replay", async () => {
      if (!databaseUrl) {
        return panic("Postgres database URL is required");
      }
      const migration = await Bun.file(migrationUrl).text();
      const count = await Bun.file(countUrl).text();
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const organizationId = createSafeId<"organization">();
        const firstMatter = createSafeId<"workspace">();
        const secondMatter = createSafeId<"workspace">();
        const ids = Array.from({ length: 11 }, () =>
          createSafeId<"entity">(),
        ).toSorted();
        const [tail, a, b, c, root, leaf, document, x, y, self, otherRoot] =
          ids;
        if (
          !tail ||
          !a ||
          !b ||
          !c ||
          !root ||
          !leaf ||
          !document ||
          !x ||
          !y ||
          !self ||
          !otherRoot
        ) {
          return panic("Repair fixture must contain eleven entity ids");
        }
        // A tail sorts before the cycle but is not itself a cycle member.
        expect(tail < a).toBe(true);
        await db.insert(organization).values({
          id: organizationId,
          name: "Parent repair tests",
          slug: `parent-repair-${organizationId}`,
          createdAt: new Date(),
        });
        try {
          await db.transaction(async (tx) => {
            await tx.insert(workspaces).values([
              {
                id: firstMatter,
                organizationId,
                name: "First",
                reference: firstMatter,
              },
              {
                id: secondMatter,
                organizationId,
                name: "Second",
                reference: secondMatter,
              },
            ]);
            const folder = {
              kind: "folder" as const,
              workspaceId: firstMatter,
              updatedAt: new Date("2026-01-01T00:00:00Z"),
            };
            await tx.insert(entities).values([
              { ...folder, id: tail, name: "Tail", parentId: b },
              { ...folder, id: a, name: "A", parentId: b },
              { ...folder, id: b, name: "B", parentId: c },
              { ...folder, id: c, name: "C", parentId: a },
              { ...folder, id: root, name: "Root" },
              { ...folder, id: leaf, name: "Leaf", parentId: root },
              {
                ...folder,
                kind: "document",
                id: document,
                name: "Document",
                parentId: c,
              },
              {
                ...folder,
                workspaceId: secondMatter,
                id: x,
                name: "X",
                parentId: y,
              },
              {
                ...folder,
                workspaceId: secondMatter,
                id: y,
                name: "Y",
                parentId: x,
              },
              {
                ...folder,
                workspaceId: secondMatter,
                id: self,
                name: "Self",
                parentId: self,
              },
              {
                ...folder,
                workspaceId: secondMatter,
                id: otherRoot,
                name: "Other root",
              },
            ]);
            // An auto-updatable temporary view scopes the unchanged migration SQL
            // to this fixture, even if another suite left unrelated rows behind.
            // These UUIDs are generated here, never supplied by a caller.
            await tx.execute(
              sql.raw(`CREATE TEMP VIEW entities AS
            SELECT * FROM public.entities
            WHERE workspace_id IN ('${firstMatter}'::uuid, '${secondMatter}'::uuid)`),
            );
            const snapshot = async () =>
              await tx
                .select()
                .from(entities)
                .where(
                  inArray(entities.workspaceId, [firstMatter, secondMatter]),
                )
                .orderBy(asc(entities.id));
            const before = await snapshot();
            const initialCounts = await tx.execute(sql.raw(count));
            expect(
              initialCounts.map((row) => ({
                workspaces: Number(row["workspaces_on_cycles"]),
                entities: Number(row["entities_on_cycles"]),
              })),
            ).toEqual([{ workspaces: 2, entities: 6 }]);

            const apply = async () => {
              for (const statement of migration.split(
                "--> statement-breakpoint",
              )) {
                await tx.execute(sql.raw(statement));
              }
            };
            await apply();
            const repaired = await snapshot();
            const roots = new Set([a, x, self]);
            const expected = structuredClone(before);
            for (const row of expected) {
              if (roots.has(row.id)) {
                row.parentId = null;
              }
            }
            expect(repaired).toEqual(expected);
            const counts = await tx.execute(sql.raw(count));
            expect(
              counts.map((row) => ({
                workspaces: Number(row["workspaces_on_cycles"]),
                entities: Number(row["entities_on_cycles"]),
              })),
            ).toEqual([{ workspaces: 0, entities: 0 }]);
            const parents = new Map(
              repaired.map(({ id, parentId }) => [id, parentId]),
            );
            for (const row of repaired) {
              const seen = new Set<string>();
              let id: typeof row.id | null = row.id;
              while (id !== null) {
                expect(seen.has(id)).toBe(false);
                seen.add(id);
                const parentId = parents.get(id);
                if (parentId === undefined) {
                  return panic("Repair fixture has a missing parent");
                }
                id = parentId;
              }
            }
            await apply();
            expect(await snapshot()).toEqual(repaired);
          });
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
        }
      });
    }, 20_000);
  },
);
