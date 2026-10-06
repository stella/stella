import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import {
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationBlocks,
  legalListVerificationReadReceipts,
  legalListVerificationRuns,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { VERIFICATION_RUN_STATUSES } from "@/api/lib/lists/verification/contract";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migrationName = "20261005120600_verification_document_cascade";

describe.skipIf(!enabled)("document-owned verification history", () => {
  test("migration removes unowned history and every run status cascades with its document", async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client, db } = openClient();
      const schema = `document_history_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const organizationId = toSafeId<"organization">(
        `org_${Bun.randomUUIDv7()}`,
      );
      const workspaceId = createSafeId<"workspace">();
      const documentId = createSafeId<"entity">();
      const retainedDocumentId = createSafeId<"entity">();
      const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
      await client.unsafe(`CREATE SCHEMA ${schema}`);
      try {
        await client.unsafe(`SET search_path TO ${schema}, public`);
        // The verification tables come from committed migrations; only their
        // external parent relations are minimal fixtures.
        await client.unsafe(`
          CREATE TABLE organization (id varchar(128) PRIMARY KEY);
          CREATE TABLE "user" (id text PRIMARY KEY);
          CREATE TABLE workspaces (id uuid PRIMARY KEY, organization_id varchar(128), UNIQUE (id, organization_id));
          CREATE TABLE entities (id uuid PRIMARY KEY, workspace_id uuid, UNIQUE (id, workspace_id));
          CREATE TABLE legal_list_items (entity_id uuid, list_id uuid, workspace_id uuid, UNIQUE (entity_id, list_id, workspace_id));
          CREATE VIEW stella_authorized_workspaces AS SELECT NULL::uuid AS authorized_workspace_id WHERE false;
          GRANT USAGE ON SCHEMA ${schema} TO stella;
          GRANT SELECT ON stella_authorized_workspaces TO stella;
          GRANT SELECT, DELETE ON entities TO stella;
        `);
        const applyMigration = async (name: string) => {
          const source = await Bun.file(
            new URL(
              `../../../../drizzle/${name}/migration.sql`,
              import.meta.url,
            ),
          ).text();
          await db.transaction(async (tx) => {
            for (const statement of source
              .replaceAll(
                "public.stella_authorized_workspaces",
                () => `${schema}.stella_authorized_workspaces`,
              )
              .replaceAll(
                "public.legal_list_verification_runs",
                () => `${schema}.legal_list_verification_runs`,
              )
              .split("--> statement-breakpoint")) {
              await tx.execute(sql.raw(statement));
            }
          });
        };
        for (const name of [
          "20260925220000_legal_list_verifications",
          "20260928132500_legal_list_verification_blocks",
          "20261005120200_list_verification_force_rls",
          "20261005120400_verification_read_receipts",
        ]) {
          await applyMigration(name);
        }
        await client`INSERT INTO organization VALUES (${organizationId})`;
        await client`INSERT INTO "user" VALUES (${userId})`;
        await client`INSERT INTO workspaces VALUES (${workspaceId}, ${organizationId})`;
        await client`INSERT INTO entities VALUES (${documentId}, ${workspaceId}), (${retainedDocumentId}, ${workspaceId})`;

        const seedRun = async (
          entityId: typeof documentId,
          status: (typeof VERIFICATION_RUN_STATUSES)[number],
        ) => {
          const runId = createSafeId<"legalListVerificationRun">();
          const claimId = createSafeId<"legalListClaim">();
          await db.insert(legalListVerificationRuns).values({
            id: runId,
            organizationId,
            workspaceId,
            entityId,
            fileFieldId: createSafeId<"field">(),
            entityVersionId: createSafeId<"entityVersion">(),
            contentSha256: "a".repeat(64),
            evidence: { listId: createSafeId<"legalList">(), facts: [] },
            status,
            errorCode: status === "failed" ? "internal" : null,
          });
          await db.insert(legalListVerificationBlocks).values({
            runId,
            workspaceId,
            ordinal: 0,
            blockId: "p1",
            kind: "docx-block",
            text: "Pinned document text.",
          });
          await db.insert(legalListClaims).values({
            id: claimId,
            runId,
            workspaceId,
            position: 0,
            type: "fact",
            state: "nocover",
            text: "Pinned quotation.",
            anchor: { type: "docx-block", blockId: "p1", start: 0, end: 16 },
          });
          await db.insert(legalListClaimReviewEvents).values({
            id: createSafeId<"legalListClaimReviewEvent">(),
            runId,
            claimId,
            workspaceId,
            kind: "note",
            payload: { kind: "note", note: "Reviewed." },
            actorId: userId,
          });
          await db.insert(legalListVerificationReadReceipts).values({
            organizationId,
            workspaceId,
            runId,
            userId,
            auditedDay: "2026-10-06",
          });
          return runId;
        };
        // Discover every dependent content table through the actual FK graph,
        // so adding another dependent automatically joins the deletion census.
        const dependents = await client<{ name: string }[]>`
          WITH RECURSIVE descendants(oid) AS (
            SELECT ${`${schema}.legal_list_verification_runs`}::regclass::oid
            UNION
            SELECT constraint_row.conrelid FROM pg_constraint constraint_row
            JOIN descendants ON constraint_row.confrelid = descendants.oid
            WHERE constraint_row.contype = 'f'
          )
          SELECT relname AS name FROM pg_class JOIN descendants ON pg_class.oid = descendants.oid
          ORDER BY relname`;
        expect(dependents.length).toBeGreaterThanOrEqual(5);
        const counts = async () => {
          const result: Record<string, number> = {};
          for (const { name } of dependents) {
            const rows = await client.unsafe<{ count: number }[]>(
              `SELECT count(*)::int AS count FROM "${schema}"."${name}"`,
            );
            const row = rows.at(0);
            if (row === undefined) {
              panic("Expected verification census count");
            }
            result[name] = row.count;
          }
          return result;
        };
        await seedRun(createSafeId<"entity">(), "completed");
        expect(Object.values(await counts())).toEqual(dependents.map(() => 1));
        await applyMigration(migrationName);
        await applyMigration(
          "20261005120700_validate_verification_document_cascade",
        );
        expect(Object.values(await counts())).toEqual(dependents.map(() => 0));
        for (const status of VERIFICATION_RUN_STATUSES) {
          await seedRun(documentId, status);
        }
        await seedRun(retainedDocumentId, "completed");
        expect(Object.values(await counts())).toEqual(
          dependents.map(() => VERIFICATION_RUN_STATUSES.length + 1),
        );
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella`);
          await tx.execute(
            sql`SELECT set_config('app.workspace_ids', ${`{${workspaceId}}`}, true)`,
          );
          await tx.execute(
            sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
          );
          await tx.execute(
            sql`SELECT set_config('app.user_id', ${userId}, true)`,
          );
          await tx.execute(
            sql`DELETE FROM entities WHERE id = ${documentId} AND workspace_id = ${workspaceId}`,
          );
        });
        expect(Object.values(await counts())).toEqual(dependents.map(() => 1));
        const remaining = await client<
          { entity_id: string }[]
        >`SELECT entity_id FROM legal_list_verification_runs`;
        expect(remaining).toEqual([{ entity_id: retainedDocumentId }]);
      } finally {
        await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  });
});
