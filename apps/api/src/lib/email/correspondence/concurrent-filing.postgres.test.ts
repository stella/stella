import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";
import { waitForExternalState } from "@stll/property-testing/external-state";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  correspondence,
  correspondenceFilers,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const INSERT_GATE_SETTING = "test.correspondence_insert_gate";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("concurrent correspondence filing (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(Boolean(databaseUrl) && runPostgresTests).toBe(false);
    });
  });
} else {
  describe("concurrent correspondence filing (postgres)", () => {
    test("two filings of one message that both planned no record converge on one", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: adminDb } = openClient({ max: 1 });
        const writers = [openClient({ max: 1 }), openClient({ max: 1 })];
        const organizationId = mintAuthProviderId<"organization">();
        const userIds = [
          mintAuthProviderId<"user">(),
          mintAuthProviderId<"user">(),
        ];
        const workspaceId = createSafeId<"workspace">();
        const suffix = Bun.randomUUIDv7().replaceAll("-", "");
        const functionName = `correspondence_insert_gate_${suffix}`;
        const gateKey = BigInt(`0x${suffix.slice(-15)}`);
        const messageId = `<${Bun.randomUUIDv7()}@example.test>`;
        const parsed = {
          channel: "email",
          dataBox: null,
          direction: "in",
          source: "delivery",
          intake: "direct",
          originalSignature: null,
          authenticatedSender: {
            address: "sender@example.test",
            spf: "pass",
            dkim: "none",
            dmarc: "pass",
            alignedIdentifier: "example.test",
          },
          messageId,
          contentHash: "c".repeat(64),
          from: { address: "sender@example.test", name: null },
          to: [],
          cc: [],
          subject: "Filed twice at once",
          sentAt: null,
          receivedAt: "2026-10-31T00:00:00.000Z",
          inReplyTo: null,
          references: [],
          bodyText: "Fixture message",
          bodyHtml: null,
        } satisfies ParsedCorrespondence;
        try {
          await adminDb.insert(organization).values({
            id: organizationId,
            name: "Concurrent filing fixture",
            slug: `concurrent-filing-${suffix}`,
            createdAt: new Date(),
          });
          await recordNewOrganizationAccessState(adminDb, {
            organizationId,
            now: new Date(),
          });
          await adminDb.insert(workspaces).values({
            id: workspaceId,
            organizationId,
            name: "Concurrent filing matter",
            reference: suffix,
          });
          for (const [index, userId] of userIds.entries()) {
            await adminDb.insert(user).values({
              id: userId,
              name: `Filer ${String(index)}`,
              email: `filer-${String(index)}-${suffix}@example.test`,
            });
            await adminDb.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId,
              userId,
              role: "owner",
              createdAt: new Date(),
            });
            await adminDb.insert(workspaceMembers).values({
              workspaceId,
              userId,
            });
          }
          // Both writers plan before either inserts: the gate holds every
          // insert of this test's filings until both are waiting at it.
          await adminDb.execute(sql`
            CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
            LANGUAGE plpgsql AS $gate$
            BEGIN
              IF NULLIF(current_setting('test.correspondence_insert_gate', true), '') IS NOT NULL THEN
                PERFORM pg_advisory_xact_lock_shared(current_setting('test.correspondence_insert_gate')::bigint);
              END IF;
              RETURN NEW;
            END
            $gate$
          `);
          await adminDb.execute(sql`
            CREATE TRIGGER ${sql.identifier(functionName)}
            BEFORE INSERT ON correspondence
            FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
          `);
          await adminDb.execute(sql`SELECT pg_advisory_lock(${gateKey})`);
          const [adminPid] = await adminDb.execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          const filings = writers.map(async ({ db: writerDb }, index) => {
            const userId = userIds[index];
            if (userId === undefined) {
              throw new Error("Missing filer");
            }
            const safeDb = createSafeDb(
              markRlsDatabase(writerDb),
              [workspaceId],
              organizationId,
              userId,
            );
            const gatedSafeDb: SafeDb = async (work, retry) =>
              await safeDb(async (tx) => {
                await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
                await tx.execute(
                  sql`SELECT set_config(${INSERT_GATE_SETTING}, ${String(gateKey)}, true)`,
                );
                return await work(tx);
              }, retry);
            return await createCorrespondence({
              safeDb: gatedSafeDb,
              workspaceId,
              organizationId,
              filer: { type: "user", userId },
              parsed,
              attachments: [],
              recordAuditEvent: createBackgroundAuditRecorder({
                organizationId,
                workspaceId,
                userId,
                execution: {
                  performer: { type: "user", id: userId },
                  trigger: {
                    type: "system",
                    source: "concurrent_filing_test",
                  },
                },
              }),
            });
          });
          await waitForExternalState({
            description: "both filings wait at the insert gate",
            read: async () =>
              (
                await adminDb.execute<{ waiting: number }>(sql`
                  SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
                  WHERE ${adminPid?.pid ?? 0} = ANY(pg_catalog.pg_blocking_pids(pid))
                `)
              ).at(0)?.waiting === 2,
          });
          await adminDb.execute(sql`SELECT pg_advisory_unlock(${gateKey})`);
          const outcomes = await Promise.all(filings);

          const ids = outcomes.map((outcome) =>
            outcome.type === "ok" ? outcome.id : outcome.type,
          );
          expect(ids[0]).toBe(ids[1]);
          expect(
            outcomes
              .map((outcome) =>
                outcome.type === "ok" ? outcome.created : null,
              )
              .toSorted(),
          ).toEqual([false, true]);
          expect(
            outcomes.map((outcome) =>
              outcome.type === "ok" ? outcome.filerAdded : null,
            ),
          ).toEqual([true, true]);
          const records = await adminDb
            .select({ id: correspondence.id })
            .from(correspondence)
            .where(eq(correspondence.workspaceId, workspaceId));
          expect(records.map(({ id }) => String(id))).toEqual([String(ids[0])]);
          const filers = await adminDb
            .select({ userId: correspondenceFilers.filedByUserId })
            .from(correspondenceFilers)
            .where(eq(correspondenceFilers.workspaceId, workspaceId));
          expect(filers.map(({ userId }) => userId).toSorted()).toEqual(
            userIds.toSorted(),
          );
        } finally {
          await adminDb.execute(sql`SELECT pg_advisory_unlock_all()`);
          await adminDb.execute(
            sql`DROP TRIGGER IF EXISTS ${sql.identifier(functionName)} ON correspondence`,
          );
          await adminDb.execute(
            sql`DROP FUNCTION IF EXISTS ${sql.identifier(functionName)}()`,
          );
          await adminDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          for (const userId of userIds) {
            await adminDb.delete(user).where(eq(user.id, userId));
          }
        }
      });
    });
  });
}
