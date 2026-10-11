import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import type { CorrespondenceActorDisplay } from "@stll/api-contract/correspondence";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  correspondence,
  CORRESPONDENCE_ERASURE_SETTING,
  CORRESPONDENCE_OFFBOARDING_SETTING,
  CORRESPONDENCE_REVIEW_RESET_SETTING,
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
import { resolveInboundSender } from "@/api/lib/email/inbound/sender";
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
  eraseCorrespondenceActorDisplays,
} from "./offboarding";

const actorDisplay = {
  status: "active",
  name: "Original actor",
  email: "original-actor@example.test",
} as const satisfies CorrespondenceActorDisplay;
const otherActorDisplay = {
  status: "active",
  name: "Other actor",
  email: "other-actor@example.test",
} as const satisfies CorrespondenceActorDisplay;

let testDb: TestDatabase;
let ids: TestIds;
const migrationStatements = readFileSync(
  new URL(
    "../../../../drizzle/20260928090000_correspondence_core/migration.sql",
    import.meta.url,
  ),
  "utf-8",
).split("--> statement-breakpoint");
const migrationOwnerPolicies = migrationStatements.filter((statement) =>
  statement.includes('CREATE POLICY "correspondence_owner_offboarding_'),
);
const inboundMigrationStatements = readFileSync(
  new URL(
    "../../../../drizzle/20260928150200_inbound_token_lookup/migration.sql",
    import.meta.url,
  ),
  "utf-8",
).split("--> statement-breakpoint");

const senderLookupMigrationStatements = readFileSync(
  new URL(
    "../../../../drizzle/20261005120900_correspondence_sender_lookup_scope/migration.sql",
    import.meta.url,
  ),
  "utf-8",
).split("--> statement-breakpoint");

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
  test("organization cleanup audits only a real assignment change, including retries", async () => {
    try {
      await testDb.transaction(async (tx) => {
        const options = {
          tx: asTestRaw<Transaction>(tx),
          organizationId: ids.orgA,
          userId: ids.userA1,
        };
        await clearOrganizationCorrespondenceAssignments(options);
        expect(
          await tx
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.organizationId, ids.orgA),
                eq(auditLogs.resourceType, "organization_settings"),
              ),
            ),
        ).toEqual([]);
        await tx.insert(correspondence).values([
          record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA1,
            assigneeId: ids.userA1,
          }),
          record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            assigneeId: ids.userA1,
          }),
          record({
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            assigneeId: ids.userA2,
          }),
          record({
            organizationId: ids.orgB,
            workspaceId: ids.wsB1,
            assigneeId: ids.userA1,
          }),
        ]);
        await clearOrganizationCorrespondenceAssignments(options);
        await clearOrganizationCorrespondenceAssignments(options);
        expect(
          await tx
            .select({ changes: auditLogs.changes })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.organizationId, ids.orgA),
                eq(auditLogs.resourceType, "organization_settings"),
              ),
            ),
        ).toEqual([
          {
            changes: {
              correspondenceAssigneeId: { old: ids.userA1, new: null },
            },
          },
        ]);
        tx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }
    throw new Error("Expected integration transaction rollback");
  });
  test.each(["schema", "migration"] as const)(
    "actor erasure is bounded, owner-only, isolated and idempotent (%s)",
    async (policySource) => {
      try {
        await testDb.transaction(async (tx) => {
          const records = Array.from(
            { length: policySource === "schema" ? 512 : 2 },
            (_, index) =>
              record({
                organizationId: index % 2 === 0 ? ids.orgA : ids.orgB,
                workspaceId: index % 2 === 0 ? ids.wsA1 : ids.wsB1,
                assigneeId: null,
              }),
          );
          await tx.insert(correspondence).values(records);
          const filers = records.map((row) => ({
            id: createSafeId<"correspondenceFiler">(),
            organizationId: row.organizationId,
            workspaceId: row.workspaceId,
            correspondenceId: row.id,
            filedByUserId: ids.userA1,
            filedByDisplay: actorDisplay,
          }));
          const senders = records.map((row) => {
            const id = createSafeId<"correspondenceAllowedSender">();
            return {
              id,
              organizationId: row.organizationId,
              address: `${id}@example.test`,
              kind: "shared_mailbox",
              scope: "organization",
              approvedBy: ids.userA1,
              approvedByDisplay: actorDisplay,
            } as const;
          });
          const first = records.at(0);
          if (first === undefined) {
            throw new Error("Expected nonempty erasure fixture");
          }
          const otherFiler = {
            id: createSafeId<"correspondenceFiler">(),
            organizationId: first.organizationId,
            workspaceId: first.workspaceId,
            correspondenceId: first.id,
            filedByUserId: ids.userA2,
            filedByDisplay: otherActorDisplay,
          };
          const otherSenderId = createSafeId<"correspondenceAllowedSender">();
          const otherSender = {
            id: otherSenderId,
            organizationId: ids.orgA,
            address: `${otherSenderId}@example.test`,
            kind: "shared_mailbox",
            scope: "organization",
            approvedBy: ids.userA2,
            approvedByDisplay: otherActorDisplay,
          } as const;
          await tx.insert(correspondenceFilers).values([...filers, otherFiler]);
          await tx
            .insert(correspondenceAllowedSenders)
            .values([...senders, otherSender]);
          await tx.execute(
            sql`CREATE ROLE correspondence_erasure_owner_probe NOLOGIN NOSUPERUSER NOBYPASSRLS`,
          );
          await tx.execute(
            sql`CREATE ROLE correspondence_erasure_reader_probe NOLOGIN NOSUPERUSER NOBYPASSRLS`,
          );
          await tx.execute(
            sql`GRANT USAGE ON SCHEMA public TO correspondence_erasure_owner_probe, correspondence_erasure_reader_probe`,
          );
          for (const table of [
            correspondenceFilers,
            correspondenceAllowedSenders,
          ]) {
            await tx.execute(
              sql`ALTER TABLE ${table} OWNER TO correspondence_erasure_owner_probe`,
            );
            await tx.execute(
              sql`GRANT SELECT, UPDATE ON ${table} TO correspondence_erasure_reader_probe`,
            );
            await tx.execute(
              sql`CREATE POLICY erasure_reader_fixture ON ${table} FOR SELECT TO correspondence_erasure_reader_probe USING (true)`,
            );
            if (policySource === "migration") {
              const policies = getTableConfig(table).policies.filter(
                ({ name }) => name.includes("_owner_erasure_"),
              );
              expect(policies.length).toBeGreaterThan(0);
              for (const policy of policies) {
                const statements = migrationStatements.filter((statement) =>
                  statement.includes(`CREATE POLICY "${policy.name}"`),
                );
                expect(statements).toHaveLength(1);
                await tx.execute(
                  sql`DROP POLICY ${sql.identifier(policy.name)} ON ${table}`,
                );
                for (const statement of statements) {
                  await tx.execute(sql.raw(statement));
                }
              }
            }
          }
          await tx.execute(
            sql`SET LOCAL ROLE correspondence_erasure_owner_probe`,
          );
          expect(
            await tx
              .select({ id: correspondenceFilers.id })
              .from(correspondenceFilers),
          ).toEqual([]);
          await tx.execute(
            sql`SELECT set_config(${CORRESPONDENCE_ERASURE_SETTING.userId}, ${ids.userA1}, true), set_config(${CORRESPONDENCE_ERASURE_SETTING.recordIds}, '', true)`,
          );
          const unbatchedUpdate = await Result.tryPromise({
            try: async () =>
              await tx.transaction(async (savepoint) => {
                await savepoint
                  .update(correspondenceFilers)
                  .set({ filedByDisplay: { status: "deleted" } })
                  .where(eq(correspondenceFilers.filedByUserId, ids.userA1));
              }),
            catch: (cause) => cause,
          });
          expect(unbatchedUpdate).toMatchObject({
            error: { cause: { code: "42501" } },
          });
          await tx.execute(
            sql`SELECT set_config(${CORRESPONDENCE_ERASURE_SETTING.recordIds}, ${`{${[...filers.map(({ id }) => id), ...senders.map(({ id }) => id), otherFiler.id, otherSender.id].join(",")}}`}, true)`,
          );
          expect(
            await tx
              .update(correspondenceFilers)
              .set({ filedByDisplay: { status: "deleted" } })
              .where(eq(correspondenceFilers.id, otherFiler.id))
              .returning({ id: correspondenceFilers.id }),
          ).toEqual([]);
          expect(
            await tx
              .update(correspondenceAllowedSenders)
              .set({ approvedByDisplay: { status: "deleted" } })
              .where(eq(correspondenceAllowedSenders.id, otherSender.id))
              .returning({ id: correspondenceAllowedSenders.id }),
          ).toEqual([]);
          await tx.execute(
            sql`SET LOCAL ROLE correspondence_erasure_reader_probe`,
          );
          expect(
            await tx
              .select({ id: correspondenceFilers.id })
              .from(correspondenceFilers)
              .where(eq(correspondenceFilers.id, otherFiler.id)),
          ).toEqual([{ id: otherFiler.id }]);
          expect(
            await tx
              .update(correspondenceFilers)
              .set({ filedByDisplay: { status: "deleted" } })
              .where(eq(correspondenceFilers.filedByUserId, ids.userA1))
              .returning({ id: correspondenceFilers.id }),
          ).toEqual([]);
          expect(
            await tx
              .update(correspondenceAllowedSenders)
              .set({ approvedByDisplay: { status: "deleted" } })
              .where(eq(correspondenceAllowedSenders.approvedBy, ids.userA1))
              .returning({ id: correspondenceAllowedSenders.id }),
          ).toEqual([]);
          await tx.execute(
            sql`SET LOCAL ROLE correspondence_erasure_owner_probe`,
          );
          const invalidReplacement = await Result.tryPromise({
            try: async () =>
              await tx.transaction(async (savepoint) => {
                await savepoint
                  .update(correspondenceAllowedSenders)
                  .set({ approvedByDisplay: otherActorDisplay })
                  .where(
                    eq(correspondenceAllowedSenders.approvedBy, ids.userA1),
                  );
              }),
            catch: (cause) => cause,
          });
          expect(invalidReplacement).toMatchObject({
            error: { cause: { code: "42501" } },
          });
          await eraseCorrespondenceActorDisplays({
            tx: asTestRaw<Transaction>(tx),
            userId: ids.userA1,
          });
          await eraseCorrespondenceActorDisplays({
            tx: asTestRaw<Transaction>(tx),
            userId: ids.userA1,
          });
          expect(
            await tx
              .select({ id: correspondenceFilers.id })
              .from(correspondenceFilers),
          ).toEqual([]);
          await tx.execute(sql`RESET ROLE`);
          expect(
            await tx
              .select({
                id: correspondenceFilers.id,
                userId: correspondenceFilers.filedByUserId,
                display: correspondenceFilers.filedByDisplay,
              })
              .from(correspondenceFilers)
              .where(
                inArray(correspondenceFilers.id, [
                  ...filers.map(({ id }) => id),
                  otherFiler.id,
                ]),
              ),
          ).toEqual(
            expect.arrayContaining([
              ...filers.map(({ id }) => ({
                id,
                userId: ids.userA1,
                display: { status: "deleted" },
              })),
              {
                id: otherFiler.id,
                userId: ids.userA2,
                display: otherActorDisplay,
              },
            ]),
          );
          expect(
            await tx
              .select({
                id: correspondenceAllowedSenders.id,
                userId: correspondenceAllowedSenders.approvedBy,
                display: correspondenceAllowedSenders.approvedByDisplay,
              })
              .from(correspondenceAllowedSenders)
              .where(
                inArray(correspondenceAllowedSenders.id, [
                  ...senders.map(({ id }) => id),
                  otherSender.id,
                ]),
              ),
          ).toEqual(
            expect.arrayContaining([
              ...senders.map(({ id }) => ({
                id,
                userId: ids.userA1,
                display: { status: "deleted" },
              })),
              {
                id: otherSender.id,
                userId: ids.userA2,
                display: otherActorDisplay,
              },
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
          const deniedAssignment = await Result.tryPromise({
            try: async () =>
              await tx.transaction(async (savepoint) => {
                await savepoint
                  .update(correspondence)
                  .set({ assigneeId: ids.userA2 })
                  .where(eq(correspondence.id, owned.id));
              }),
            catch: (cause) => cause,
          });
          expect(Result.isError(deniedAssignment)).toBe(true);
          if (Result.isError(deniedAssignment)) {
            expect(deniedAssignment.error).toMatchObject({
              cause: { code: "42501" },
            });
          }

          const clearedCount =
            await clearCorrespondenceAssignmentsForOffboarding({
              tx: asTestRaw<Transaction>(tx),
              userId: ids.userA1,
              scope:
                scope === "account"
                  ? { type: "account" }
                  : { type: "organization", organizationId: ids.orgA },
            });
          expect(clearedCount).toBe(
            1 + (scope === "account" ? 1 + additionalAssignments.length : 0),
          );
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
    "delivery token limits owner address lookup while erasure retains owner approval lookup (%s)",
    async (policySource) => {
      try {
        await testDb.transaction(async (tx) => {
          const addressId = createSafeId<"matterInboundAddress">();
          const otherAddressId = createSafeId<"matterInboundAddress">();
          const senderId = createSafeId<"correspondenceAllowedSender">();
          const scopeId = createSafeId<"correspondenceAllowedSenderMatter">();
          const otherSenderId = createSafeId<"correspondenceAllowedSender">();
          const otherOrgSenderId =
            createSafeId<"correspondenceAllowedSender">();
          await tx.insert(matterInboundAddresses).values([
            {
              id: addressId,
              organizationId: ids.orgA,
              workspaceId: ids.wsA2,
              token: addressId,
            },
            {
              id: otherAddressId,
              organizationId: ids.orgA,
              workspaceId: ids.wsA1,
              token: otherAddressId,
            },
          ]);
          await tx.insert(correspondenceAllowedSenders).values({
            id: senderId,
            organizationId: ids.orgA,
            address: `${senderId}@example.test`,
            kind: "shared_mailbox",
            scope: "matters",
            approvedBy: ids.userA1,
            approvedByDisplay: actorDisplay,
          });
          await tx.insert(correspondenceAllowedSenders).values([
            {
              id: otherSenderId,
              organizationId: ids.orgA,
              address: `${otherSenderId}@example.test`,
              kind: "shared_mailbox",
              scope: "organization",
              approvedBy: ids.userA2,
              approvedByDisplay: otherActorDisplay,
            },
            {
              id: otherOrgSenderId,
              organizationId: ids.orgB,
              address: `${senderId}@example.test`,
              kind: "shared_mailbox",
              scope: "organization",
              approvedBy: ids.userB1,
              approvedByDisplay: otherActorDisplay,
            },
          ]);
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
          }
          if (policySource === "schema") {
            expect(
              getTableConfig(matterInboundAddresses).policies.filter(
                ({ name }) =>
                  name === "matter_inbound_addresses_owner_token_lookup",
              ),
            ).toHaveLength(1);
            expect(
              getTableConfig(correspondenceAllowedSenders).policies.filter(
                ({ name }) =>
                  name === "correspondence_allowed_senders_owner_lookup",
              ),
            ).toHaveLength(1);
            expect(
              getTableConfig(
                correspondenceAllowedSenderMatters,
              ).policies.filter(({ name }) => name.endsWith("_owner_lookup")),
            ).toHaveLength(0);
          } else {
            const coreLookups = migrationStatements.filter(
              (statement) =>
                statement.includes(
                  'CREATE POLICY "matter_inbound_addresses_owner_lookup"',
                ) ||
                statement.includes(
                  'CREATE POLICY "correspondence_allowed_senders_owner_lookup"',
                ) ||
                statement.includes(
                  'CREATE POLICY "correspondence_allowed_sender_matters_owner_lookup"',
                ),
            );
            expect(coreLookups).toHaveLength(3);
            await tx.execute(
              sql`DROP POLICY matter_inbound_addresses_owner_token_lookup ON matter_inbound_addresses`,
            );
            await tx.execute(
              sql`DROP POLICY correspondence_allowed_senders_owner_lookup ON correspondence_allowed_senders`,
            );
            for (const statement of coreLookups) {
              await tx.execute(sql.raw(statement));
            }
            const inboundLookups = inboundMigrationStatements.filter(
              (statement) =>
                statement.includes(
                  'CREATE POLICY "matter_inbound_addresses_owner_token_lookup"',
                ) ||
                statement.includes(
                  'DROP POLICY "matter_inbound_addresses_owner_lookup"',
                ) ||
                statement.includes(
                  'DROP POLICY "correspondence_allowed_sender_matters_owner_lookup"',
                ),
            );
            expect(inboundLookups).toHaveLength(3);
            for (const statement of inboundLookups) {
              await tx.execute(sql.raw(statement));
            }
            await tx.execute(
              sql`DROP POLICY correspondence_allowed_senders_owner_review_reset_delete ON correspondence_allowed_senders`,
            );
            await tx.execute(
              sql`DROP POLICY correspondence_allowed_senders_owner_lifecycle_lookup ON correspondence_allowed_senders`,
            );
            for (const statement of senderLookupMigrationStatements) {
              await tx.execute(sql.raw(statement));
            }
          }
          await tx.execute(
            sql`SET LOCAL ROLE correspondence_lookup_owner_probe`,
          );
          const addresses = async () =>
            await tx
              .select({ id: matterInboundAddresses.id })
              .from(matterInboundAddresses)
              .where(
                inArray(matterInboundAddresses.id, [addressId, otherAddressId]),
              );
          expect(await addresses()).toEqual([]);
          const senders = async () =>
            await tx
              .select({ id: correspondenceAllowedSenders.id })
              .from(correspondenceAllowedSenders);
          expect(await senders()).toHaveLength(3);
          await tx.execute(
            sql`SELECT set_config(${CORRESPONDENCE_ERASURE_SETTING.userId}, ${ids.userA1}, true)`,
          );
          expect(await senders()).toHaveLength(3);
          await tx.execute(
            sql`SELECT set_config(${CORRESPONDENCE_ERASURE_SETTING.userId}, '', true)`,
          );
          expect(await senders()).toHaveLength(3);
          await tx.execute(
            sql`SELECT set_config('app.inbound_token', ${createSafeId<"matterInboundAddress">()}, true)`,
          );
          expect(await addresses()).toEqual([]);
          await tx.execute(
            sql`SELECT set_config('app.inbound_token', ${addressId}, true)`,
          );
          expect(await addresses()).toEqual([{ id: addressId }]);
          for (const { table, id } of lookups.slice(2)) {
            expect(
              await tx
                .select({ id: table.id })
                .from(table)
                .where(eq(table.id, id)),
            ).toEqual([]);
          }
          await tx.execute(
            sql`SELECT set_config(${CORRESPONDENCE_ERASURE_SETTING.userId}, ${ids.userA1}, true)`,
          );
          await tx.execute(
            sql`SELECT set_config(${CORRESPONDENCE_REVIEW_RESET_SETTING.organizationId}, ${ids.orgA}, true)`,
          );
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
          await tx.execute(sql`SET LOCAL ROLE stella`);
          await tx.execute(sql`SELECT
            set_config(${SETTING_ORGANIZATION_ID}, ${ids.orgA}, true),
            set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true),
            set_config(${SETTING_WORKSPACE_IDS}, ${`{${ids.wsA2}}`}, true)
          `);
          expect(await senders()).toEqual(
            expect.arrayContaining([{ id: senderId }, { id: otherSenderId }]),
          );
          expect(await senders()).toHaveLength(2);
          expect(
            await resolveInboundSender({
              tx: asTestRaw<Transaction>(tx),
              organizationId: ids.orgA,
              workspaceId: ids.wsA2,
              sender: `${senderId}@example.test`,
              receivedAt: "2026-09-26T12:00:00.000Z",
              primaryUserId: null,
            }),
          ).toMatchObject({
            status: "allowed",
            filer: { type: "shared_mailbox", allowedSenderId: senderId },
          });
          expect(
            await resolveInboundSender({
              tx: asTestRaw<Transaction>(tx),
              organizationId: ids.orgA,
              workspaceId: ids.wsA1,
              sender: `${senderId}@example.test`,
              receivedAt: "2026-09-26T12:00:00.000Z",
              primaryUserId: null,
            }),
          ).toEqual({ status: "denied" });
          await tx.execute(sql`RESET ROLE`);
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
            filedByDisplay: actorDisplay,
          });
          const senderId = createSafeId<"correspondenceAllowedSender">();
          await tx.insert(correspondenceAllowedSenders).values({
            id: senderId,
            organizationId: ids.orgA,
            address: `${senderId}@example.test`,
            kind: "shared_mailbox",
            scope: "organization",
            approvedBy: ids.userA1,
            approvedByDisplay: actorDisplay,
          });
          const otherFilerId = createSafeId<"correspondenceFiler">();
          await tx.insert(correspondenceFilers).values({
            id: otherFilerId,
            organizationId: ids.orgA,
            workspaceId: ids.wsA2,
            correspondenceId: matterRecord.id,
            filedByUserId: ids.userA2,
            filedByDisplay: otherActorDisplay,
          });
          const otherSenderId = createSafeId<"correspondenceAllowedSender">();
          await tx.insert(correspondenceAllowedSenders).values({
            id: otherSenderId,
            organizationId: ids.orgA,
            address: `${otherSenderId}@example.test`,
            kind: "shared_mailbox",
            scope: "organization",
            approvedBy: ids.userA2,
            approvedByDisplay: otherActorDisplay,
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
              .select({
                userId: correspondenceFilers.filedByUserId,
                display: correspondenceFilers.filedByDisplay,
              })
              .from(correspondenceFilers)
              .where(inArray(correspondenceFilers.id, [filerId, otherFilerId])),
          ).toEqual(
            expect.arrayContaining([
              {
                userId: ids.userA1,
                display:
                  scope === "account" ? { status: "deleted" } : actorDisplay,
              },
              { userId: ids.userA2, display: otherActorDisplay },
            ]),
          );
          expect(
            await tx
              .select({
                userId: correspondenceAllowedSenders.approvedBy,
                display: correspondenceAllowedSenders.approvedByDisplay,
              })
              .from(correspondenceAllowedSenders)
              .where(
                inArray(correspondenceAllowedSenders.id, [
                  senderId,
                  otherSenderId,
                ]),
              ),
          ).toEqual(
            expect.arrayContaining([
              {
                userId: ids.userA1,
                display:
                  scope === "account" ? { status: "deleted" } : actorDisplay,
              },
              { userId: ids.userA2, display: otherActorDisplay },
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
});
