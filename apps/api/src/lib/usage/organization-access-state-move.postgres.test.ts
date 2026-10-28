import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { DAY_IN_MS } from "@stll/time";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  ORGANIZATION_ACCESS_STATE,
  ORGANIZATION_ACCESS_STATE_ORIGIN,
  organizationAccessStates,
  organizationSettings,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  moveKeylessOrganizationsToFree,
  recordNewOrganizationAccessState,
} from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const testState = createTestState({ file: import.meta.path, config: env });

type Database = PgAsyncDatabase<PgQueryResultHKT>;

const seedOrganizations = async (
  db: Database,
  ids: readonly SafeId<"organization">[],
): Promise<void> => {
  await db.insert(organization).values(
    ids.map((id) => ({
      id,
      name: "Keyless move race fixture",
      slug: `keyless-race-${id}`,
      createdAt: new Date(),
    })),
  );
  await db.insert(organizationAccessStates).values(
    ids.map((organizationId) => ({
      organizationId,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      origin: ORGANIZATION_ACCESS_STATE_ORIGIN.legacyReconcile,
    })),
  );
};

const readStates = async (
  db: Database,
  ids: readonly SafeId<"organization">[],
): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await db
        .select({
          organizationId: organizationAccessStates.organizationId,
          state: organizationAccessStates.state,
        })
        .from(organizationAccessStates)
        .where(inArray(organizationAccessStates.organizationId, [...ids]))
    ).map(({ organizationId, state }) => [organizationId, state]),
  );

if (!databaseUrl || !runPostgres) {
  describe.skip("keyless organization move serialization (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  describe("keyless organization move serialization (postgres)", () => {
    test("concurrent creation supersedes one legacy row and audits once", async () => {
      testState.setConfig("FEATURE_ORG_ACCESS_STATE", true);
      testState.setConfig("ORG_EVALUATION_PERIOD_DAYS", 3);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient({ max: 1 });
        const { db: secondDb } = openClient({ max: 1 });
        const organizationId = mintAuthProviderId<"organization">();
        const creationTimes = [
          new Date("2026-10-27T10:00:00.000Z"),
          new Date("2026-10-27T11:00:00.000Z"),
        ] as const;
        try {
          await seedOrganizations(firstDb, [organizationId]);
          await Promise.all([
            recordNewOrganizationAccessState(firstDb, {
              organizationId,
              now: creationTimes[0],
            }),
            recordNewOrganizationAccessState(secondDb, {
              organizationId,
              now: creationTimes[1],
            }),
          ]);

          const finalState = await firstDb
            .select({
              state: organizationAccessStates.state,
              origin: organizationAccessStates.origin,
              evaluationStartedAt: organizationAccessStates.evaluationStartedAt,
              evaluationEndsAt: organizationAccessStates.evaluationEndsAt,
            })
            .from(organizationAccessStates)
            .where(
              inArray(organizationAccessStates.organizationId, [
                organizationId,
              ]),
            );
          expect(finalState).toHaveLength(1);
          const final = finalState.at(0);
          expect(final).toMatchObject({
            state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
            origin: ORGANIZATION_ACCESS_STATE_ORIGIN.creation,
          });
          expect(creationTimes.map((time) => time.getTime())).toContain(
            final?.evaluationStartedAt?.getTime(),
          );
          expect(
            creationTimes.map((time) => time.getTime() + 3 * DAY_IN_MS),
          ).toContain(final?.evaluationEndsAt?.getTime());

          expect(final?.evaluationEndsAt?.getTime()).toBe(
            (final?.evaluationStartedAt?.getTime() ??
              panic("Missing evaluation start")) +
              3 * DAY_IN_MS,
          );

          const creationAudits = await firstDb
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.organizationId, organizationId),
                eq(
                  auditLogs.resourceType,
                  AUDIT_RESOURCE_TYPE.ORGANIZATION_ACCESS_STATE,
                ),
                eq(auditLogs.triggerSource, "organization-creation"),
              ),
            );
          expect(creationAudits).toHaveLength(1);
        } finally {
          await firstDb
            .delete(organization)
            .where(inArray(organization.id, [organizationId]));
        }
      });
    });

    test.each([
      ["inserts the first settings row", false],
      ["updates an existing settings row", true],
    ] as const)(
      "a configuration write that %s keeps its organization off the free floor",
      async (_label, hasSettingsRow) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: writerDb } = openClient({ max: 1 });
          const { db: moverDb } = openClient({ max: 1 });
          const configuring = mintAuthProviderId<"organization">();
          const keyless = mintAuthProviderId<"organization">();
          const ids = [configuring, keyless];
          try {
            await seedOrganizations(writerDb, ids);
            if (hasSettingsRow) {
              await writerDb.insert(organizationSettings).values({
                id: createSafeId<"organizationSettings">(),
                organizationId: configuring,
              });
            }
            const backendPid = async (db: Database) =>
              (
                await db
                  .select({ pid: sql<number>`pg_backend_pid()` })
                  .from(sql`(SELECT 1) AS backend`)
              ).at(0)?.pid ?? panic("The test connection has no backend");
            const writerPid = await backendPid(writerDb);
            const moverPid = await backendPid(moverDb);

            const written = Promise.withResolvers<undefined>();
            const release = Promise.withResolvers<undefined>();
            const write = writerDb.transaction(async (tx) => {
              await tx
                .insert(organizationSettings)
                .values({
                  id: createSafeId<"organizationSettings">(),
                  organizationId: configuring,
                  aiConfigEncrypted: Buffer.from("encrypted-org-ai-config"),
                  aiConfigIv: Buffer.from("iv"),
                })
                .onConflictDoUpdate({
                  target: organizationSettings.organizationId,
                  set: {
                    aiConfigEncrypted: Buffer.from("encrypted-org-ai-config"),
                    aiConfigIv: Buffer.from("iv"),
                  },
                });
              written.resolve(undefined);
              await release.promise;
            });
            await written.promise;

            const move = withAggregateTransaction(moverDb, async (tx) =>
              moveKeylessOrganizationsToFree(asTestRaw<Transaction>(tx), {
                now: new Date(),
                actor: "operator:test",
              }),
            );
            const { sql: observer } = openClient({ max: 1 });
            await waitForBlockedPid(observer, {
              waitingPid: moverPid,
              holdingPid: writerPid,
            });
            release.resolve(undefined);
            await write;
            const moved = await move;

            expect(moved.filter((id) => ids.includes(id))).toEqual([keyless]);
            expect(await readStates(writerDb, ids)).toEqual({
              [configuring]: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
              [keyless]: ORGANIZATION_ACCESS_STATE.evaluationEnded,
            });
          } finally {
            await writerDb
              .delete(organization)
              .where(inArray(organization.id, ids));
          }
        });
      },
    );
  });
}
