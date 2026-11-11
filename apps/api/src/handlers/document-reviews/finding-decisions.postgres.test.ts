import { panic } from "better-result";
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { DOCUMENT_REVIEW_FINDING_DECISION_BACKFILL } from "../../db/document-review-finding-decision-backfill";
import type { OnlineMigrationConnection } from "../../db/online-migration-connection";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** The production repair, pointed at this test's schema instead of public. */
const connectionIn = (
  client: SQL,
  schema: string,
): OnlineMigrationConnection => {
  const scoped = (statement: string) =>
    statement.replaceAll(
      "public.document_review_",
      () => `${schema}.document_review_`,
    );
  return {
    query: async (statement, parameters = []) =>
      await client.unsafe<unknown[]>(scoped(statement), [...parameters]),
    execute: async (statement, parameters = []) => {
      await client.unsafe(scoped(statement), [...parameters]);
    },
    release: () => {},
  };
};

/** One migration's statements, pointed at this test's schema instead of public. */
const migrationIn = async (folder: string, schema: string) =>
  (
    await Bun.file(
      new URL(`../../../drizzle/${folder}/migration.sql`, import.meta.url),
    ).text()
  )
    .replaceAll(
      "public.stella_authorized_workspaces",
      () => `${schema}.stella_authorized_workspaces`,
    )
    .replaceAll(
      "public.stella_document_review_",
      () => `${schema}.stella_document_review_`,
    )
    .replaceAll("public.document_review_", () => `${schema}.document_review_`)
    .split("--> statement-breakpoint");

describe.skipIf(!enabled)("document review finding decision history", () => {
  test("backfills through the production repair, converges, and enforces append-only workspace isolation", async () => {
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
          GRANT SELECT ON document_review_findings TO stella;
          INSERT INTO "user" VALUES ('${actorId}');
          INSERT INTO document_review_findings VALUES
            ('${acceptedFinding}', '${visibleWorkspace}', 'accepted', '${actorId}', '2026-01-01T00:00:00Z'),
            ('${dismissedFinding}', '${hiddenWorkspace}', 'dismissed', '${actorId}', '2026-01-02T00:00:00Z'),
            ('${openFinding}', '${visibleWorkspace}', 'open', NULL, NULL);
        `);

        const source = await Bun.file(
          new URL(
            "../../../drizzle/20261028130100_document_review_finding_decision_history/migration.sql",
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
              "public.document_review_",
              () => `${schema}.document_review_`,
            )
            .split("--> statement-breakpoint")) {
            await tx.execute(sql.raw(statement));
          }
        });

        // The accepted finding already has history (a handler write after
        // the migration); the backfill must not give it a second event.
        await client.unsafe(`
          INSERT INTO document_review_finding_decisions
            (id, workspace_id, finding_id, decision, actor_id, created_at)
          VALUES (gen_random_uuid(), '${visibleWorkspace}', '${acceptedFinding}',
            'accepted', '${actorId}', '2026-01-01T00:00:00Z')
        `);

        const connection = connectionIn(client, schema);
        const repair = DOCUMENT_REVIEW_FINDING_DECISION_BACKFILL;
        expect(await repair.readCompletion(connection)).toMatchObject({
          type: "pending",
        });
        expect(await repair.repair(connection)).toEqual({
          type: "complete",
        });
        expect(await repair.readCompletion(connection)).toEqual({
          type: "complete",
        });
        // A second run on a completed database changes nothing.
        expect(await repair.repair(connection)).toEqual({
          type: "complete",
        });

        const backfill = await client<
          { findingId: string; decision: string | null; actorId: string }[]
        >`SELECT finding_id AS "findingId", decision, actor_id AS "actorId"
          FROM document_review_finding_decisions ORDER BY created_at`;
        expect([...backfill]).toEqual([
          { findingId: acceptedFinding, decision: "accepted", actorId },
          { findingId: dismissedFinding, decision: "rejected", actorId },
        ]);
        // The backfilled baseline takes its finding's id, the key the decide
        // handler also writes it under, so the two cannot both add it.
        const baselines = await client<{ id: string }[]>`
          SELECT id::text AS id FROM document_review_finding_decisions
          WHERE finding_id = ${dismissedFinding}`;
        expect([...baselines]).toEqual([{ id: dismissedFinding }]);

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

        // A finding in the event's own workspace can be decided.
        await client.unsafe(`
          INSERT INTO document_review_finding_decisions
            (id, workspace_id, finding_id, decision, actor_id)
          VALUES (gen_random_uuid(), '${visibleWorkspace}', '${openFinding}',
            'accepted', '${actorId}')
        `);
        // A visible workspace cannot be paired with another workspace's
        // finding to forge that finding's history.
        expect(
          await rejectionOf(
            client.unsafe(`
              INSERT INTO document_review_finding_decisions
                (id, workspace_id, finding_id, decision, actor_id)
              VALUES (gen_random_uuid(), '${visibleWorkspace}', '${dismissedFinding}',
                'accepted', '${actorId}')
            `),
          ),
        ).toMatchObject({
          message: expect.stringMatching(/row-level security/u),
        });
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

  /**
   * The history is the database's, so no writer can skip it: raw SQL that
   * names no handler, no helper and no event table still leaves every decided
   * finding with its events, and the online repair reading complete. This is
   * what keeps the repair from regressing under any future write path.
   */
  test("every decision change gets its event, whichever statement makes it", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }

    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client, db } = openClient();
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const schema = `finding_decision_trigger_${suffix}`;
      const workspace = Bun.randomUUIDv7();
      const decidedBeforeHistory = Bun.randomUUIDv7();
      const insertedDecided = Bun.randomUUIDv7();
      const reviewed = Bun.randomUUIDv7();
      const decider = `decider_${suffix}`;
      const reopener = `reopener_${suffix}`;

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
          INSERT INTO "user" VALUES ('${decider}'), ('${reopener}');
          INSERT INTO document_review_findings VALUES
            ('${decidedBeforeHistory}', '${workspace}', 'accepted', '${decider}', '2026-01-01T00:00:00Z'),
            ('${reviewed}', '${workspace}', 'open', NULL, NULL);
        `);
        await db.transaction(async (tx) => {
          for (const folder of [
            "20261028130100_document_review_finding_decision_history",
            "20261111150000_document_review_finding_decision_trigger",
          ]) {
            for (const statement of await migrationIn(folder, schema)) {
              await tx.execute(sql.raw(statement));
            }
          }
        });

        const history = async (findingId: string) => [
          ...(await client<
            { id: string; decision: string | null; actorId: string | null }[]
          >`SELECT id::text AS id, decision, actor_id AS "actorId"
              FROM document_review_finding_decisions
             WHERE finding_id = ${findingId}
             ORDER BY created_at, id`),
        ];

        // Inserted already decided: the insert itself is the decision.
        await client.unsafe(`
          INSERT INTO document_review_findings VALUES
            ('${insertedDecided}', '${workspace}', 'dismissed', '${decider}', '2026-02-01T00:00:00Z')
        `);
        expect(await history(insertedDecided)).toEqual([
          expect.objectContaining({ decision: "rejected", actorId: decider }),
        ]);

        // Decided, changed, restated and reopened by plain UPDATEs.
        await client.unsafe(`
          UPDATE document_review_findings
             SET decision = 'accepted', decided_by = '${decider}', decided_at = '2026-03-01T00:00:00Z'
           WHERE id = '${reviewed}'
        `);
        await client.unsafe(`
          UPDATE document_review_findings SET decided_at = decided_at
           WHERE id = '${reviewed}'
        `);
        await client.begin(async (tx) => {
          await tx.unsafe(
            `SELECT set_config('app.user_id', '${reopener}', true)`,
          );
          await tx.unsafe(`
            UPDATE document_review_findings
               SET decision = 'open', decided_by = NULL, decided_at = NULL
             WHERE id = '${reviewed}'
          `);
        });
        expect(await history(reviewed)).toEqual([
          expect.objectContaining({ decision: "accepted", actorId: decider }),
          expect.objectContaining({ decision: null, actorId: reopener }),
        ]);

        // Decided before the history began: its baseline comes first, keyed
        // by the finding, then the change.
        await client.unsafe(`
          UPDATE document_review_findings
             SET decision = 'dismissed', decided_by = '${reopener}', decided_at = '2026-04-01T00:00:00Z'
           WHERE id = '${decidedBeforeHistory}'
        `);
        expect(await history(decidedBeforeHistory)).toEqual([
          { id: decidedBeforeHistory, decision: "accepted", actorId: decider },
          expect.objectContaining({ decision: "rejected", actorId: reopener }),
        ]);

        // So the repair has nothing left to do, whatever wrote the rows.
        expect(
          await DOCUMENT_REVIEW_FINDING_DECISION_BACKFILL.readCompletion(
            connectionIn(client, schema),
          ),
        ).toEqual({ type: "complete" });
      } finally {
        await client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    });
  });
});
