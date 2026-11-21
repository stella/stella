import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { entityVersions, fields } from "@/api/db/schema";
import { readVersionFileMetadata } from "@/api/handlers/entities/versions/list";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("version metadata scaling on Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("version metadata stays bounded when unrelated fields grow", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      let statements = 0;
      const { db } = openClient({
        logger: {
          logQuery: () => {
            statements += 1;
          },
        },
      });
      await db.transaction(async (tx) => {
        // Transaction-local relations isolate cardinality from other suites;
        // Drizzle still renders and executes the production projection.
        await tx.execute(
          sql`CREATE TEMP TABLE entity_versions (id uuid PRIMARY KEY, deleted_at timestamptz) ON COMMIT DROP`,
        );
        await tx.execute(
          sql`CREATE TEMP TABLE fields (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, entity_version_id uuid NOT NULL, property_id uuid NOT NULL, content jsonb NOT NULL) ON COMMIT DROP`,
        );
        await tx.execute(
          sql`CREATE INDEX version_metadata_file_idx ON fields (workspace_id, (content->>'mimeType'), entity_version_id, id) WHERE content->>'type' = 'file'`,
        );
        const workspaceId = createSafeId<"workspace">();
        const versionIds = Array.from({ length: 10 }, () =>
          createSafeId<"entityVersion">(),
        );
        await tx.execute(
          sql`INSERT INTO entity_versions (id) VALUES ${sql.join(
            versionIds.map((id) => sql`(${id}::uuid)`),
            sql`, `,
          )}`,
        );
        const measurements = [];
        for (const propertyCount of [10, 200]) {
          await tx.execute(sql`TRUNCATE fields`);
          const propertyIds = Array.from({ length: propertyCount }, () =>
            createSafeId<"property">(),
          );
          const rows = versionIds.flatMap((entityVersionId) =>
            propertyIds.map((propertyId, index) => ({
              id: createSafeId<"field">(),
              workspaceId,
              entityVersionId,
              propertyId,
              content:
                index === 0
                  ? {
                      type: "file" as const,
                      version: 1 as const,
                      id: createSafeId<"userFile">(),
                      fileName: "document.docx",
                      mimeType:
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                      sizeBytes: 42,
                      s3Key: "synthetic",
                      sha256: "a".repeat(64),
                    }
                  : {
                      type: "text" as const,
                      version: 1 as const,
                      value: "x".repeat(propertyCount * 10),
                    },
            })),
          );
          await tx.execute(
            sql`INSERT INTO fields (id, workspace_id, entity_version_id, property_id, content) VALUES ${sql.join(
              rows.map(
                (row) =>
                  sql`(${row.id}::uuid, ${row.workspaceId}::uuid, ${row.entityVersionId}::uuid, ${row.propertyId}::uuid, ${JSON.stringify(row.content)}::text::jsonb)`,
              ),
              sql`, `,
            )}`,
          );
          await tx.execute(sql`ANALYZE fields`);
          const start = statements;
          const query = readVersionFileMetadata(tx, {
            workspaceId,
            pageVersionIds: versionIds,
            filePropertyId: undefined,
            pageSize: 10,
          });
          const selected = await query;
          const selectedStatements = statements - start;
          if (propertyCount === 200) {
            const plan = await tx.execute(
              sql`EXPLAIN (FORMAT JSON) ${query.getSQL()}`,
            );
            expect(JSON.stringify(plan)).toContain("version_metadata_file_idx");
          }
          const fullFields = await tx
            .select({
              id: fields.id,
              entityVersionId: fields.entityVersionId,
              propertyId: fields.propertyId,
              content: fields.content,
            })
            .from(fields)
            .innerJoin(
              entityVersions,
              eq(entityVersions.id, fields.entityVersionId),
            )
            .where(
              and(
                inArray(fields.entityVersionId, versionIds),
                eq(fields.workspaceId, workspaceId),
                isNull(entityVersions.deletedAt),
              ),
            );
          expect(fullFields).toHaveLength(propertyCount * versionIds.length);
          expect(selected).toHaveLength(versionIds.length);
          expect(new Set(selected.map((row) => row.entityVersionId)).size).toBe(
            versionIds.length,
          );
          expect(
            selected.every(
              (row) => row.fileName === "document.docx" && row.sizeBytes === 42,
            ),
          ).toBe(true);
          expect(selectedStatements).toBe(1);
          measurements.push({
            propertyCount,
            beforeRows: fullFields.length,
            afterRows: selected.length,
            beforeBytes: Buffer.byteLength(JSON.stringify(fullFields)),
            afterBytes: Buffer.byteLength(JSON.stringify(selected)),
            statements: selectedStatements,
          });
        }
        const [small, large] = measurements;
        expect(small).toBeDefined();
        expect(large).toBeDefined();
        if (!small || !large) {
          panic("Scaling fixture must include both cardinalities");
        }
        expect(large.afterBytes / small.afterBytes).toBeLessThanOrEqual(1.2);
        expect(large.afterRows).toBe(small.afterRows);
        expect(large.statements).toBe(small.statements);
        console.info("version-metadata-scaling", JSON.stringify(measurements));
      });
    });
  });
}
