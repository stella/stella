import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  organizationAccessStates,
  organizationSettings,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  moveKeylessOrganizationsToFree,
  ORGANIZATION_ACCESS_STATE,
} from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

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
