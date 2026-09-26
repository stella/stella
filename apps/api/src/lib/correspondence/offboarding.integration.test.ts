import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  correspondence,
  CORRESPONDENCE_OFFBOARDING_SETTING,
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
  correspondenceFilers,
  matterInboundAddresses,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/remove";
import { reassignActiveTaskAssignmentsAndDropMemberships } from "@/api/lib/account-deletion-steps";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  clearCorrespondenceAssignmentsForOffboarding,
  clearOrganizationCorrespondenceAssignments,
} from "./offboarding";

let testDb: TestDatabase;
let ids: TestIds;
const migrationStatements = readFileSync(
  new URL(
    "../../../drizzle/20260926190000_correspondence_core/migration.sql",
    import.meta.url,
  ),
  "utf-8",
).split("--> statement-breakpoint");
const migrationOwnerPolicies = migrationStatements.filter((statement) =>
  statement.includes('CREATE POLICY "correspondence_owner_offboarding_'),
);

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb.execute(
    sql`ALTER TABLE correspondence FORCE ROW LEVEL SECURITY`,
  );
  await testDb.execute(
    sql`ALTER TABLE correspondence_filers FORCE ROW LEVEL SECURITY`,
  );
  await testDb.execute(
    sql`ALTER TABLE correspondence_allowed_senders FORCE ROW LEVEL SECURITY`,
  );
  await testDb.execute(
    sql`ALTER TABLE matter_inbound_addresses FORCE ROW LEVEL SECURITY`,
  );
  await testDb.execute(
    sql`ALTER TABLE correspondence_allowed_sender_matters FORCE ROW LEVEL SECURITY`,
  );
});
afterAll(releaseRlsFixture);

const record = (
  scope: Pick<
    typeof correspondence.$inferInsert,
    "organizationId" | "workspaceId" | "assigneeId"
  >,
) =>
  ({
    ...scope,
    id: createSafeId<"correspondence">(),
    channel: "email",
    direction: "in",
    intake: "direct",
    authenticatedSenderAddress: "sender@example.test",
    originalSignature: null,
    contentHash: "a".repeat(64),
    dedupKey: Bun.randomUUIDv7().replaceAll("-", "").repeat(2),
    from: { address: "sender@example.test", name: null },
    to: [],
    cc: [],
    subject: "Offboarding retention",
    receivedAt: new Date("2026-09-26T12:00:00.000Z"),
    references: [],
    bodyText: "Retained correspondence",
    spf: "pass",
    dkim: "pass",
    dmarc: "pass",
    handlingState: "new",
  }) as const satisfies typeof correspondence.$inferInsert;

describe("correspondence offboarding", () => {
  test.each(
    (["schema", "migration"] as const).flatMap((policySource) =>
      (["account", "organization"] as const).map((scope) => ({
        policySource,
        scope,
      })),
    ),
  )(
    "a non-bypass owner clears only its bounded assignments: %j",
    async ({ policySource, scope }) => {
      try {
        await testDb.transaction(async (tx) => {
          const owned = record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            assigneeId: ids.userA1,
          });
          const otherUser = record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            assigneeId: ids.userA2,
          });
          const otherOrg = record({
            organizationId: ids.orgB,
            workspaceId: ids.wsB1,
            assigneeId: ids.userA1,
          });
          const unassigned = record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            assigneeId: null,
          });
          const additionalAssignments =
            policySource === "schema" && scope === "account"
              ? Array.from({ length: 512 }, () =>
                  record({
                    organizationId: ids.orgB,
                    workspaceId: ids.wsB1,
                    assigneeId: ids.userA1,
                  }),
                )
              : [];
          const records = [
            owned,
            otherUser,
            otherOrg,
            unassigned,
            ...additionalAssignments,
          ];
          await tx.insert(correspondence).values(records);
          await tx.execute(
            sql`CREATE ROLE correspondence_offboarding_owner_probe NOLOGIN NOSUPERUSER NOBYPASSRLS`,
          );
          await tx.execute(
            sql`GRANT USAGE ON SCHEMA public TO correspondence_offboarding_owner_probe`,
          );
          await tx.execute(
            sql`ALTER TABLE correspondence OWNER TO correspondence_offboarding_owner_probe`,
          );
          if (policySource === "migration") {
            expect(migrationOwnerPolicies).toHaveLength(2);
            await tx.execute(
              sql`DROP POLICY correspondence_owner_offboarding_select ON correspondence`,
            );
            await tx.execute(
              sql`DROP POLICY correspondence_owner_offboarding_update ON correspondence`,
            );
            for (const statement of migrationOwnerPolicies) {
              await tx.execute(sql.raw(statement));
            }
          }
          await tx.execute(
            sql`CREATE ROLE correspondence_offboarding_reader_probe NOLOGIN NOSUPERUSER NOBYPASSRLS`,
          );
          await tx.execute(
            sql`GRANT USAGE ON SCHEMA public TO correspondence_offboarding_reader_probe`,
          );
          await tx.execute(
            sql`GRANT SELECT, UPDATE ON correspondence TO correspondence_offboarding_reader_probe`,
          );
          // A separate SELECT grant makes UPDATE denial independent of row
          // invisibility; the ordinary role still has no update policy.
          await tx.execute(
            sql`CREATE POLICY offboarding_reader_fixture ON correspondence FOR SELECT TO correspondence_offboarding_reader_probe USING (true)`,
          );
          await tx.execute(
            sql`SET LOCAL ROLE correspondence_offboarding_owner_probe`,
          );

          expect(
            await tx.select({ id: correspondence.id }).from(correspondence),
          ).toEqual([]);
          expect(
            await tx
              .update(correspondence)
              .set({ assigneeId: null })
              .where(eq(correspondence.assigneeId, ids.userA1))
              .returning({ id: correspondence.id }),
          ).toEqual([]);
          await tx.execute(sql`SELECT
          set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.userId}, ${ids.userA1}, true),
          set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.organizationId}, ${ids.orgA}, true),
            set_config(${CORRESPONDENCE_OFFBOARDING_SETTING.scope}, 'organization', true)
          `);
          await tx.execute(sql`SET LOCAL ROLE stella`);
          expect(
            await tx.select({ id: correspondence.id }).from(correspondence),
          ).toEqual([]);
          await tx.execute(
            sql`SET LOCAL ROLE correspondence_offboarding_reader_probe`,
          );
          expect(
            await tx
              .select({ id: correspondence.id })
              .from(correspondence)
              .where(eq(correspondence.id, owned.id)),
          ).toEqual([{ id: owned.id }]);
          expect(
            await tx
              .update(correspondence)
              .set({ assigneeId: null })
              .where(eq(correspondence.id, owned.id))
              .returning({ id: correspondence.id }),
          ).toEqual([]);
          await tx.execute(
            sql`SET LOCAL ROLE correspondence_offboarding_owner_probe`,
          );
          expect(
            await tx.select({ id: correspondence.id }).from(correspondence),
          ).toEqual([{ id: owned.id }]);
          expect(
            await tx
              .update(correspondence)
              .set({ assigneeId: null })
              .where(eq(correspondence.id, otherUser.id))
              .returning({ id: correspondence.id }),
          ).toEqual([]);
          expect(
            await tx
              .update(correspondence)
              .set({ assigneeId: null })
              .where(eq(correspondence.id, otherOrg.id))
              .returning({ id: correspondence.id }),
          ).toEqual([]);
          await expect(
            tx.transaction(async (savepoint) => {
              await savepoint
                .update(correspondence)
                .set({ assigneeId: ids.userA2 })
                .where(eq(correspondence.id, owned.id));
            }),
          ).rejects.toMatchObject({ cause: { code: "42501" } });

          await clearCorrespondenceAssignmentsForOffboarding({
            tx: asTestRaw<Transaction>(tx),
            userId: ids.userA1,
            scope:
              scope === "account"
                ? { type: "account" }
                : { type: "organization", organizationId: ids.orgA },
          });
          expect(
            await tx.select({ id: correspondence.id }).from(correspondence),
          ).toEqual([]);
          await tx.execute(sql`RESET ROLE`);
          expect(
            await tx
              .select({
                id: correspondence.id,
                assigneeId: correspondence.assigneeId,
              })
              .from(correspondence)
              .where(
                inArray(
                  correspondence.id,
                  records.map(({ id }) => id),
                ),
              ),
          ).toEqual(
            expect.arrayContaining([
              { id: owned.id, assigneeId: null },
              { id: otherUser.id, assigneeId: ids.userA2 },
              {
                id: otherOrg.id,
                assigneeId: scope === "account" ? null : ids.userA1,
              },
              { id: unassigned.id, assigneeId: null },
              ...additionalAssignments.map(({ id }) => ({
                id,
                assigneeId: null,
              })),
            ]),
          );
          tx.rollback();
        });
      } catch (error) {
        if (error instanceof TransactionRollbackError) {
          return;
        }
        throw error;
      }
      throw new Error("Expected integration transaction rollback");
    },
  );
  test.each(["schema", "migration"] as const)(
    "owner lookup policies follow table ownership and exclude ordinary roles (%s)",
    async (policySource) => {
      try {
        await testDb.transaction(async (tx) => {
          const addressId = createSafeId<"matterInboundAddress">();
          const senderId = createSafeId<"correspondenceAllowedSender">();
          const scopeId = createSafeId<"correspondenceAllowedSenderMatter">();
          await tx.insert(matterInboundAddresses).values({
            id: addressId,
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            token: addressId,
          });
          await tx.insert(correspondenceAllowedSenders).values({
            id: senderId,
            organizationId: ids.orgA,
            address: `${senderId}@example.test`,
            kind: "shared_mailbox",
            scope: "matters",
            approvedBy: ids.userA1,
          });
          await tx.insert(correspondenceAllowedSenderMatters).values({
            id: scopeId,
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            allowedSenderId: senderId,
          });
          await tx.execute(
            sql`CREATE ROLE correspondence_lookup_owner_probe NOLOGIN NOSUPERUSER NOBYPASSRLS`,
          );
          await tx.execute(
            sql`CREATE ROLE correspondence_lookup_reader_probe NOLOGIN NOSUPERUSER NOBYPASSRLS`,
          );
          await tx.execute(
            sql`GRANT USAGE ON SCHEMA public TO correspondence_lookup_owner_probe, correspondence_lookup_reader_probe`,
          );
          const lookups = [
            { table: matterInboundAddresses, id: addressId },
            { table: correspondenceAllowedSenders, id: senderId },
            { table: correspondenceAllowedSenderMatters, id: scopeId },
          ];
          for (const { table } of lookups) {
            await tx.execute(
              sql`ALTER TABLE ${table} OWNER TO correspondence_lookup_owner_probe`,
            );
            await tx.execute(
              sql`GRANT SELECT ON ${table} TO correspondence_lookup_reader_probe`,
            );
            if (policySource === "migration") {
              const policies = getTableConfig(table).policies.filter(
                ({ name }) => name.endsWith("_owner_lookup"),
              );
              expect(policies).toHaveLength(1);
              for (const policy of policies) {
                const statements = migrationStatements.filter((statement) =>
                  statement.includes(`CREATE POLICY "${policy.name}"`),
                );
                expect(statements).toHaveLength(1);
                await tx.execute(
                  sql`DROP POLICY ${sql.identifier(policy.name)} ON ${table}`,
                );
                for (const statement of statements)
                  {await tx.execute(sql.raw(statement));}
              }
            }
          }
          await tx.execute(
            sql`SET LOCAL ROLE correspondence_lookup_owner_probe`,
          );
          for (const { table, id } of lookups) {
            expect(
              await tx
                .select({ id: table.id })
                .from(table)
                .where(eq(table.id, id)),
            ).toEqual([{ id }]);
          }
          for (const role of ["stella", "correspondence_lookup_reader_probe"]) {
            await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(role)}`);
            for (const { table, id } of lookups) {
              expect(
                await tx
                  .select({ id: table.id })
                  .from(table)
                  .where(eq(table.id, id)),
              ).toEqual([]);
            }
          }
          await tx.execute(sql`RESET ROLE`);
          tx.rollback();
        });
      } catch (error) {
        if (error instanceof TransactionRollbackError) {return;}
        throw error;
      }
      throw new Error("Expected integration transaction rollback");
    },
  );
  test.each(["matter", "organization", "account"] as const)(
    "%s removal clears only its assignments and preserves historical attribution",
    async (scope) => {
      try {
        await testDb.transaction(async (tx) => {
          const matterRecord = record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            assigneeId: ids.userA1,
          });
          const otherMatterRecord = record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA1,
            assigneeId: ids.userA1,
          });
          const otherUserRecord = record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            assigneeId: ids.userA2,
          });
          const otherOrganizationRecord = record({
            organizationId: ids.orgB,
            workspaceId: ids.wsB1,
            assigneeId: ids.userA1,
          });
          const records = [
            matterRecord,
            otherMatterRecord,
            otherUserRecord,
            otherOrganizationRecord,
          ];
          await tx.insert(correspondence).values(records);
          const filerId = createSafeId<"correspondenceFiler">();
          await tx.insert(correspondenceFilers).values({
            id: filerId,
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            correspondenceId: matterRecord.id,
            filedByUserId: ids.userA1,
          });
          const senderId = createSafeId<"correspondenceAllowedSender">();
          await tx.insert(correspondenceAllowedSenders).values({
            id: senderId,
            organizationId: ids.orgA,
            address: `${senderId}@example.test`,
            kind: "shared_mailbox",
            scope: "organization",
            approvedBy: ids.userA1,
          });

          switch (scope) {
            case "matter": {
              const safeDb = asTestRaw<SafeDb>(
                createSafeDb(
                  markRlsDatabase(tx),
                  [ids.wsA2],
                  ids.orgA,
                  ids.userA2,
                ),
              );
              const result = await Result.gen(() =>
                removeWorkspaceMemberHandler({
                  safeDb,
                  workspaceId: ids.wsA2,
                  userId: ids.userA1,
                  actorUserId: ids.userA2,
                  recordAuditEvent: createAuditRecorder({
                    organizationId: ids.orgA,
                    workspaceId: ids.wsA2,
                    userId: ids.userA2,
                    request: new Request("https://api.example.test/members"),
                    server: null,
                  }),
                  dependencies: {
                    broadcastSessionEvent: () => undefined,
                    broadcastWorkspaceResourceSetUpdated: () => undefined,
                    closeSessionConnections: () => undefined,
                    revokeWorkspaceSseAccess: async () => undefined,
                  },
                }),
              );
              expect(result.isOk()).toBe(true);
              await tx.execute(sql`RESET ROLE`);
              break;
            }
            case "organization":
              await clearOrganizationCorrespondenceAssignments({
                tx: asTestRaw<Transaction>(tx),
                organizationId: ids.orgA,
                userId: ids.userA1,
              });
              break;
            case "account":
              await reassignActiveTaskAssignmentsAndDropMemberships({
                tx: asTestRaw<Transaction>(tx),
                currentUserId: ids.userA1,
                deletionRequestId: createSafeId<"accountDeletionRequest">(),
                reassignments: [],
              });
              break;
          }

          const rows = await tx
            .select({
              id: correspondence.id,
              assigneeId: correspondence.assigneeId,
              handlingState: correspondence.handlingState,
            })
            .from(correspondence)
            .where(
              inArray(
                correspondence.id,
                records.map(({ id }) => id),
              ),
            );
          expect(rows).toEqual(
            expect.arrayContaining([
              { id: matterRecord.id, assigneeId: null, handlingState: "new" },
              {
                id: otherMatterRecord.id,
                assigneeId: scope === "matter" ? ids.userA1 : null,
                handlingState: "new",
              },
              {
                id: otherUserRecord.id,
                assigneeId: ids.userA2,
                handlingState: "new",
              },
              {
                id: otherOrganizationRecord.id,
                assigneeId: scope === "account" ? null : ids.userA1,
                handlingState: "new",
              },
            ]),
          );
          if (scope !== "account") {
            const audits = await tx
              .select({ metadata: auditLogs.metadata })
              .from(auditLogs)
              .where(
                eq(
                  auditLogs.resourceId,
                  scope === "matter" ? ids.memberA1wsA2 : ids.orgA,
                ),
              );
            expect(audits).toEqual(
              expect.arrayContaining([
                {
                  metadata: expect.objectContaining({
                    correspondenceAssignmentDisposition: "cleared",
                  }),
                },
              ]),
            );
          }
          expect(
            await tx
              .select({ userId: correspondenceFilers.filedByUserId })
              .from(correspondenceFilers)
              .where(eq(correspondenceFilers.id, filerId)),
          ).toEqual([{ userId: ids.userA1 }]);
          expect(
            await tx
              .select({ userId: correspondenceAllowedSenders.approvedBy })
              .from(correspondenceAllowedSenders)
              .where(eq(correspondenceAllowedSenders.id, senderId)),
          ).toEqual([{ userId: ids.userA1 }]);
          tx.rollback();
        });
      } catch (error) {
        if (error instanceof TransactionRollbackError) {
          return;
        }
        throw error;
      }
      throw new Error("Expected integration transaction rollback");
    },
  );
});
