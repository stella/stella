import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { ParsedCorrespondence } from "@stll/api-contract/correspondence";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  correspondenceAllowedSenders,
  correspondenceFilers,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import createAllowedSender from "@/api/handlers/organization-settings/correspondence/allowed-senders/create";
import {
  assertUserIsNotSoleOrgOwner,
  reassignActiveTaskAssignmentsAndDropMemberships,
} from "@/api/lib/account-deletion-steps";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import {
  anonymizeDeletedAccountRow,
  lockAccountRow,
} from "@/api/lib/db/account-row";
import { createCorrespondence } from "@/api/lib/email/correspondence/create";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const WRITER_GATE_SETTING = "test.correspondence_writer_gate";
const BLOCK_OBSERVATION_ATTEMPTS = 200;

const waitForWriterGate = async (
  tx: Transaction,
  writerPid: number,
): Promise<void> => {
  for (let attempt = 0; attempt < BLOCK_OBSERVATION_ATTEMPTS; attempt += 1) {
    const rows = await tx.execute<{ blocked: boolean }>(sql`
      SELECT pg_backend_pid() = ANY(pg_blocking_pids(${writerPid})) AS blocked
    `);
    if (rows.at(0)?.blocked) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("The production writer did not reach the insert gate");
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("correspondence account erasure lock ordering (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("correspondence account erasure lock ordering (postgres)", () => {
    test.each(["filing", "approval"] as const)(
      "%s completes before concurrent account cleanup erases its snapshot",
      async (writerKind) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: writerDb } = openClient({ max: 1 });
          const { db: deletionDb } = openClient({ max: 1 });
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const remainingOwnerId = mintAuthProviderId<"user">();
          const workspaceId = createSafeId<"workspace">();
          const suffix = Bun.randomUUIDv7().replaceAll("-", "");
          const functionName = `correspondence_gate_${suffix}`;
          const triggerName = `correspondence_gate_${suffix}`;
          const targetTable =
            writerKind === "filing"
              ? "correspondence"
              : "correspondence_allowed_senders";
          const gateKey = BigInt(`0x${suffix.slice(-15)}`);
          const safeDb = createSafeDb(
            markRlsDatabase(writerDb),
            [workspaceId],
            organizationId,
            userId,
          );
          const recordAuditEvent = createBackgroundAuditRecorder({
            organizationId,
            workspaceId,
            userId,
            execution: {
              performer: { type: "user", id: userId },
              trigger: { type: "system", source: "correspondence_lock_test" },
            },
          });
          const write = async (database: SafeDb) => {
            if (writerKind === "approval") {
              const result = await createAllowedSender.handler(
                asTestRaw<Parameters<typeof createAllowedSender.handler>[0]>({
                  safeDb: database,
                  memberRole: sessionMemberRole("owner"),
                  session: { activeOrganizationId: organizationId },
                  user: { id: userId },
                  request: new Request(
                    "https://api.example.test/correspondence/allowed-senders",
                  ),
                  body: {
                    address: `mailbox-${Bun.randomUUIDv7()}@example.test`,
                    scope: "organization",
                  },
                  recordAuditEvent,
                }),
              );
              expect(result).toHaveProperty("id");
              return;
            }
            const parsed = {
              channel: "email",
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
              messageId: `<${Bun.randomUUIDv7()}@example.test>`,
              contentHash: "a".repeat(64),
              from: { address: "sender@example.test", name: null },
              to: [],
              cc: [],
              subject: "Concurrent filing",
              sentAt: null,
              receivedAt: "2026-09-27T00:00:00.000Z",
              inReplyTo: null,
              references: [],
              bodyText: "Fixture message",
              bodyHtml: null,
            } satisfies ParsedCorrespondence;
            const result = await createCorrespondence({
              safeDb: database,
              workspaceId,
              organizationId,
              filer: { type: "user", userId },
              parsed,
              attachments: [],
              recordAuditEvent,
            });
            expect(result).toMatchObject({ type: "ok", created: true });
          };
          try {
            await writerDb.insert(organization).values({
              id: organizationId,
              name: "Correspondence lock fixture",
              slug: `correspondence-lock-${suffix}`,
              createdAt: new Date(),
            });
            await writerDb.insert(user).values({
              id: userId,
              name: "Writer profile",
              email: `writer-${suffix}@example.test`,
            });
            await writerDb.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId,
              userId,
              role: "owner",
              createdAt: new Date(),
            });
            await writerDb.insert(user).values({
              id: remainingOwnerId,
              name: "Remaining owner",
              email: `owner-${suffix}@example.test`,
            });
            await writerDb.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId,
              userId: remainingOwnerId,
              role: "owner",
              createdAt: new Date(),
            });
            await writerDb.insert(workspaces).values({
              id: workspaceId,
              organizationId,
              name: "Concurrent matter",
              reference: suffix,
            });
            await writerDb.insert(workspaceMembers).values({
              workspaceId,
              userId,
            });
            await writerDb.transaction(async (tx) => {
              await assertUserIsNotSoleOrgOwner(tx, userId);
            });
            await write(safeDb);
            // Gate the real INSERT after its authorization locks, before its FK
            // acquires KEY SHARE on the account. The GUC isolates this writer.
            await writerDb.execute(sql`
              CREATE FUNCTION ${sql.identifier(functionName)}() RETURNS trigger
              LANGUAGE plpgsql AS $gate$
              BEGIN
                IF NULLIF(current_setting('test.correspondence_writer_gate', true), '') IS NOT NULL THEN
                  PERFORM pg_advisory_xact_lock(current_setting('test.correspondence_writer_gate')::bigint);
                END IF;
                RETURN NEW;
              END
              $gate$
            `);
            await writerDb.execute(sql`
              CREATE TRIGGER ${sql.identifier(triggerName)}
              BEFORE INSERT ON ${sql.identifier(targetTable)}
              FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(functionName)}()
            `);
            const pids = await writerDb.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            );
            const writerPid = pids.at(0)?.pid;
            if (writerPid === undefined) {
              throw new Error("Missing writer connection identity");
            }
            const gateHeld = Promise.withResolvers<undefined>();
            const gatedSafeDb: SafeDb = async (work, retry) =>
              await safeDb(async (tx) => {
                await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
                await tx.execute(
                  sql`SELECT set_config(${WRITER_GATE_SETTING}, ${String(gateKey)}, true)`,
                );
                return await work(tx);
              }, retry);
            const deleting = deletionDb.transaction(async (tx) => {
              try {
                await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
                await tx.execute(sql`SELECT pg_advisory_lock(${gateKey})`);
                gateHeld.resolve(undefined);
                await waitForWriterGate(tx, writerPid);
                await lockAccountRow(tx, userId);
                await tx.execute(sql`SELECT pg_advisory_unlock(${gateKey})`);
                await reassignActiveTaskAssignmentsAndDropMemberships({
                  tx,
                  currentUserId: userId,
                  deletionRequestId: createSafeId<"accountDeletionRequest">(),
                  reassignments: undefined,
                });
                await anonymizeDeletedAccountRow(tx, userId);
              } finally {
                gateHeld.resolve(undefined);
              }
            });
            const writing = (async () => {
              await gateHeld.promise;
              await write(gatedSafeDb);
            })();
            expect(await Promise.allSettled([deleting, writing])).toEqual([
              { status: "fulfilled", value: undefined },
              { status: "fulfilled", value: undefined },
            ]);
            const snapshots =
              writerKind === "filing"
                ? await writerDb
                    .select({ display: correspondenceFilers.filedByDisplay })
                    .from(correspondenceFilers)
                    .where(eq(correspondenceFilers.filedByUserId, userId))
                : await writerDb
                    .select({
                      display: correspondenceAllowedSenders.approvedByDisplay,
                    })
                    .from(correspondenceAllowedSenders)
                    .where(eq(correspondenceAllowedSenders.approvedBy, userId));
            expect(snapshots).toEqual([
              { display: { status: "deleted" } },
              { display: { status: "deleted" } },
            ]);
            expect(
              await writerDb
                .select({ userId: member.userId, role: member.role })
                .from(member)
                .where(eq(member.organizationId, organizationId)),
            ).toEqual([{ userId: remainingOwnerId, role: "owner" }]);
          } finally {
            await deletionDb.execute(
              sql`SELECT pg_advisory_unlock(${gateKey})`,
            );
            await writerDb.execute(
              sql`DROP TRIGGER IF EXISTS ${sql.identifier(triggerName)} ON ${sql.identifier(targetTable)}`,
            );
            await writerDb.execute(
              sql`DROP FUNCTION IF EXISTS ${sql.identifier(functionName)}()`,
            );
            await writerDb
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await writerDb.delete(user).where(eq(user.id, userId));
            await writerDb.delete(user).where(eq(user.id, remainingOwnerId));
          }
        });
      },
    );
  });
}
