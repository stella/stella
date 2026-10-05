import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legalListClaims,
  legalListClaimReviewEvents,
  legalListVerificationRuns,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { completeVerificationRun } from "@/api/lib/lists/verification/run-persistence";
import {
  processListVerificationRun,
  reconcileQueuedListVerificationRuns,
  reconcileStuckListVerificationRuns,
} from "@/api/lib/lists/verification/run-queue";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedListVerificationRunId } from "@/api/lib/safe-id-boundaries";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("list verification row security", () => {
  test("forced policies preserve scoped reads, scheduler maintenance and worker writes", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client, db } = openClient();
      const schema = `verification_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const ownerRole = `verification_owner_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const organizationId = toSafeId<"organization">("verification_org");
      const workspaceId = createSafeId<"workspace">();
      const userId = toSafeId<"user">("verification_user");
      const runId = createSafeId<"legalListVerificationRun">();
      const claimId = createSafeId<"legalListClaim">();
      const scopedDatabase = markRlsDatabase({
        transaction: async <T>(fn: (tx: Transaction) => Promise<T>) =>
          await db.transaction(fn),
      });
      const actor = createRootRunActor(
        { organizationId, workspaceId, userId, runId },
        brandPersistedListVerificationRunId,
        scopedDatabase,
      );

      await client.unsafe(`CREATE SCHEMA ${schema}`);
      try {
        await client.unsafe(`SET search_path TO ${schema}, public`);
        await client.unsafe(
          `CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        await client.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO stella, ${ownerRole}`,
        );
        // Only unrelated FK targets are fixtures; verification tables and
        // policies come from the shipped migrations.
        await client.unsafe(`
          CREATE TABLE organization (id varchar(128) PRIMARY KEY);
          CREATE TABLE "user" (id text PRIMARY KEY);
          CREATE TABLE workspaces (id uuid PRIMARY KEY, organization_id varchar(128), UNIQUE (id, organization_id));
          CREATE TABLE legal_list_items (entity_id uuid, list_id uuid, workspace_id uuid, UNIQUE (entity_id, list_id, workspace_id));
          CREATE TABLE fields (id uuid, workspace_id uuid, entity_version_id uuid, content jsonb);
          GRANT SELECT ON fields TO stella;
          CREATE VIEW stella_authorized_workspaces AS SELECT NULL::uuid AS authorized_workspace_id WHERE false;
          GRANT SELECT ON stella_authorized_workspaces TO stella;
        `);
        for (const migration of [
          "20260925220000_legal_list_verifications",
          "20260928132500_legal_list_verification_blocks",
          "20261005120200_list_verification_force_rls",
        ]) {
          const source = await Bun.file(
            new URL(
              `../../drizzle/${migration}/migration.sql`,
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
        }
        const posture = await client<
          { name: string; enabled: boolean; forced: boolean }[]
        >`
          SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced
          FROM pg_class WHERE relnamespace = ${schema}::regnamespace
            AND relname IN ('legal_list_verification_runs', 'legal_list_claims', 'legal_list_claim_review_events')
          ORDER BY relname`;
        expect(posture).toEqual([
          {
            name: "legal_list_claim_review_events",
            enabled: true,
            forced: true,
          },
          { name: "legal_list_claims", enabled: true, forced: true },
          { name: "legal_list_verification_runs", enabled: true, forced: true },
        ]);
        await client`INSERT INTO organization VALUES (${organizationId})`;
        await client`INSERT INTO "user" VALUES (${userId})`;
        await client`INSERT INTO workspaces VALUES (${workspaceId}, ${organizationId})`;
        await db.insert(legalListVerificationRuns).values({
          id: runId,
          organizationId,
          workspaceId,
          requestedBy: userId,
          entityId: createSafeId<"entity">(),
          fileFieldId: createSafeId<"field">(),
          entityVersionId: createSafeId<"entityVersion">(),
          contentSha256: "a".repeat(64),
          evidence: { listId: createSafeId<"legalList">(), facts: [] },
        });
        const claim = {
          id: claimId,
          runId,
          workspaceId,
          position: 0,
          type: "fact",
          framing: "asserted",
          state: "nocover",
          text: "A dated meeting.",
          anchor: { type: "docx-block", blockId: "p1", start: 0, end: 16 },
        } as const satisfies typeof legalListClaims.$inferInsert;
        await db.insert(legalListClaims).values(claim);
        await db.insert(legalListClaimReviewEvents).values({
          id: createSafeId<"legalListClaimReviewEvent">(),
          runId,
          claimId,
          workspaceId,
          kind: "note",
          payload: { kind: "note", note: "Reviewed." },
          actorId: userId,
        });

        for (const table of [
          "legal_list_verification_runs",
          "legal_list_claims",
          "legal_list_claim_review_events",
          "legal_list_verification_blocks",
        ]) {
          await client.unsafe(`ALTER TABLE ${table} OWNER TO ${ownerRole}`);
        }
        await client.unsafe(
          `GRANT SELECT ON fields, stella_authorized_workspaces TO ${ownerRole}`,
        );
        await client.unsafe(`SET ROLE ${ownerRole}`);
        expect(
          await client`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
        ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
        expect(await db.select().from(legalListVerificationRuns)).toHaveLength(
          1,
        );
        expect(await db.select().from(legalListClaims)).toHaveLength(0);
        expect(await db.select().from(legalListClaimReviewEvents)).toHaveLength(
          0,
        );

        const handedOff: string[] = [];
        const queue = {
          getJob: async () => undefined,
          add: async (_name: string, data: { runId: string }) => {
            handedOff.push(data.runId);
          },
        };
        const recovered = await reconcileQueuedListVerificationRuns({
          db,
          queue,
        });
        expect(recovered).toEqual({
          scanned: 1,
          handedOff: 1,
          unattributed: 0,
        });
        expect(handedOff).toEqual([runId]);
        // A rollback-only policy mutation proves the owner path needs this policy.
        await client.unsafe("BEGIN");
        try {
          await client.unsafe(
            "DROP POLICY legal_list_verification_runs_owner_access ON legal_list_verification_runs",
          );
          expect(
            await db.select().from(legalListVerificationRuns),
          ).toHaveLength(0);
          expect(
            await reconcileQueuedListVerificationRuns({ db, queue }),
          ).toEqual({ scanned: 0, handedOff: 0, unattributed: 0 });
        } finally {
          await client.unsafe("ROLLBACK");
        }
        await db
          .update(legalListVerificationRuns)
          .set({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
          .where(eq(legalListVerificationRuns.id, runId));
        expect(await reconcileStuckListVerificationRuns(db)).toBe(1);
        expect(
          (await db.select().from(legalListVerificationRuns)).at(0)?.status,
        ).toBe("failed");
        await db
          .update(legalListVerificationRuns)
          .set({
            status: "queued",
            errorCode: null,
            finishedAt: null,
            createdAt: new Date(),
          })
          .where(eq(legalListVerificationRuns.id, runId));

        for (const tenant of [
          { organization: "", workspaces: "{}", expected: 0 },
          {
            organization: "other_org",
            workspaces: `{${Bun.randomUUIDv7()}}`,
            expected: 0,
          },
          {
            organization: organizationId,
            workspaces: `{${workspaceId}}`,
            expected: 1,
          },
        ]) {
          await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT set_config('role', 'stella', true),
              set_config('app.organization_id', ${tenant.organization}, true),
              set_config('app.workspace_ids', ${tenant.workspaces}, true),
              set_config('app.user_id', '', true)`);
            const expected = tenant.expected;
            expect(
              await tx.select().from(legalListVerificationRuns),
            ).toHaveLength(expected);
            expect(await tx.select().from(legalListClaims)).toHaveLength(
              expected,
            );
            expect(
              await tx.select().from(legalListClaimReviewEvents),
            ).toHaveLength(expected);
          });
        }

        // An unresolved pin stops execution before any document or model I/O.
        // It still exercises the queue's conditional claim and terminal write.
        await processListVerificationRun(actor);
        const failed = await db
          .select()
          .from(legalListVerificationRuns)
          .where(eq(legalListVerificationRuns.id, runId));
        expect(failed.at(0)).toMatchObject({
          status: "failed",
          errorCode: "pin_unresolved",
        });
        expect(failed.at(0)?.startedAt).toBeInstanceOf(Date);
        expect(failed.at(0)?.finishedAt).toBeInstanceOf(Date);
        await processListVerificationRun(actor);
        expect(await db.select().from(legalListVerificationRuns)).toEqual(
          failed,
        );

        await db
          .update(legalListVerificationRuns)
          .set({ status: "running", errorCode: null })
          .where(eq(legalListVerificationRuns.id, runId));
        await actor.writeDb(async (tx) => {
          await completeVerificationRun({
            tx,
            runId,
            workspaceId,
            blocks: [
              {
                id: "p1",
                text: "A dated meeting.",
                source: { type: "docx-block", blockId: "p1" },
              },
            ],
            claims: [claim],
          });
        });
        expect(
          (await db.select().from(legalListVerificationRuns)).at(0)?.status,
        ).toBe("completed");
        expect(
          await actor.writeDb(
            async (tx) => await tx.select().from(legalListClaims),
          ),
        ).toHaveLength(1);
        expect(
          await actor.writeDb(
            async (tx) =>
              await tx.execute(
                sql`SELECT text FROM legal_list_verification_blocks`,
              ),
          ),
        ).toEqual([{ text: "A dated meeting." }]);
      } finally {
        await client.unsafe("RESET ROLE");
        await client.unsafe("RESET search_path");
        await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await client.unsafe(`DROP ROLE ${ownerRole}`);
      }
    });
  });
});
