import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("document review finding decision history", () => {
  test("backfills decisions and enforces append-only workspace isolation", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }

    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client, db } = openClient();
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const schema = `finding_decisions_${suffix}`;
      const visibleWorkspace = Bun.randomUUIDv7();
      const hiddenWorkspace = Bun.randomUUIDv7();
      const acceptedFinding = Bun.randomUUIDv7();
      const dismissedFinding = Bun.randomUUIDv7();
      const openFinding = Bun.randomUUIDv7();
      const actorId = `actor_${suffix}`;

      await client.unsafe(`CREATE SCHEMA ${schema}`);
      try {
        await client.unsafe(`SET search_path TO ${schema}, public`);
        await client.unsafe(`
          CREATE TABLE "user" (id text PRIMARY KEY);
          CREATE TABLE document_review_findings (
            id uuid PRIMARY KEY,
            workspace_id uuid NOT NULL,
            decision text NOT NULL,
            decided_by text,
            decided_at timestamptz
          );
          CREATE VIEW stella_authorized_workspaces AS
            SELECT NULL::uuid AS authorized_workspace_id WHERE false;
          GRANT USAGE ON SCHEMA ${schema} TO stella;
          GRANT SELECT ON stella_authorized_workspaces TO stella;
          INSERT INTO "user" VALUES ('${actorId}');
          INSERT INTO document_review_findings VALUES
            ('${acceptedFinding}', '${visibleWorkspace}', 'accepted', '${actorId}', '2026-01-01T00:00:00Z'),
            ('${dismissedFinding}', '${hiddenWorkspace}', 'dismissed', '${actorId}', '2026-01-02T00:00:00Z'),
            ('${openFinding}', '${visibleWorkspace}', 'open', NULL, NULL);
        `);

        const source = await Bun.file(
          new URL(
            "../../../drizzle/20261028120100_document_review_finding_decision_history/migration.sql",
            import.meta.url,
          ),
        ).text();
        await db.transaction(async (tx) => {
          for (const statement of source
            .replaceAll(
              "public.stella_authorized_workspaces",
              () => `${schema}.stella_authorized_workspaces`,
            )
            .split("--> statement-breakpoint")) {
            await tx.execute(sql.raw(statement));
          }
        });
        await client.unsafe(`
          INSERT INTO document_review_finding_decisions
            (id, workspace_id, finding_id, decision, reason, actor_id, created_at)
          SELECT gen_random_uuid(), workspace_id, id,
            CASE decision WHEN 'accepted' THEN 'accepted' WHEN 'dismissed' THEN 'rejected' END,
            NULL, decided_by, decided_at
          FROM document_review_findings WHERE decision <> 'open'
        `);

        const backfill = await client<
          { findingId: string; decision: string | null }[]
        >`SELECT finding_id AS "findingId", decision
          FROM document_review_finding_decisions ORDER BY created_at`;
        expect([...backfill]).toEqual([
          { findingId: acceptedFinding, decision: "accepted" },
          { findingId: dismissedFinding, decision: "rejected" },
        ]);

        await client.unsafe(`SET ROLE stella`);
        await client.unsafe(
          `SELECT set_config('app.workspace_ids', '{${visibleWorkspace}}', false)`,
        );
        const visible = await client<
          { findingId: string; decision: string | null }[]
        >`SELECT finding_id AS "findingId", decision FROM document_review_finding_decisions`;
        expect([...visible]).toEqual([
          { findingId: acceptedFinding, decision: "accepted" },
        ]);
        expect(
          await rejectionOf(
            client`UPDATE document_review_finding_decisions SET reason = 'changed'`,
          ),
        ).toMatchObject({
          message: expect.stringMatching(/permission denied/u),
        });
        expect(
          await rejectionOf(
            client`DELETE FROM document_review_finding_decisions`,
          ),
        ).toMatchObject({
          message: expect.stringMatching(/permission denied/u),
        });
      } finally {
        // swallow-ok: cleanup must continue if the transaction already reset the role
        await client.unsafe("RESET ROLE").catch(() => undefined);
        await client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  });
});
