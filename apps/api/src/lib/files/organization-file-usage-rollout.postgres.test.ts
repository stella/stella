/**
 * During a rolling deploy the previous release still settles file accounting
 * on the counter row alone: it locks the row, writes the object, then stores
 * an absolute counter value. The current writers must queue behind that lock
 * so neither release loses the other's bytes and neither deadlocks on the
 * organization row the previous release only key-shares.
 */

import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  organizationFileObjects,
  organizationFileUsage,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { createSafeId } from "@/api/lib/branded-types";
import {
  reconcileOrganizationFileObject,
  reserveOrganizationFileBytes,
} from "@/api/lib/files/organization-file-usage";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;

type FileUsageDb = NonNullable<
  Parameters<typeof reserveOrganizationFileBytes>[1]
>;

const LEGACY_BYTES = 100n;
const CURRENT_BYTES = 50;

describe.skipIf(!runPostgresTests)("file accounting during a rollout", () => {
  // timeout: three PostgreSQL sessions race through a lock barrier.
  test.each(["reservation", "reconciliation"] as const)(
    "a %s queues behind the previous release's counter lock and keeps both deltas",
    async (writer) => {
      await withGatedTestClients(
        databaseUrl ?? panic("Rollout tests need DATABASE_URL"),
        async ({ openClient }) => {
          const setup = openClient({ max: 1 });
          const legacyClient = openClient({ max: 1 });
          const currentClient = openClient({ max: 1 });
          const observer = openClient().sql;
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const policyId = createSafeId<"usagePolicy">();
          const legacyKey = `${organizationId}/legacy-reconciled.bin`;
          const currentKey = `${organizationId}/current-${writer}.bin`;
          const priorFlag =
            envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
          envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = true;
          const held = Promise.withResolvers<number>();
          const release = Promise.withResolvers<undefined>();
          try {
            await setup.db.insert(organization).values({
              id: organizationId,
              name: "File accounting rollout",
              slug: organizationId,
              createdAt: new Date(),
            });
            await recordNewOrganizationAccessState(setup.db, {
              organizationId,
              now: new Date(),
            });
            await setup.db.insert(user).values({
              id: userId,
              name: "File accounting rollout",
              email: `${userId}@example.test`,
            });
            await setup.db.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId,
              userId,
              role: "owner",
              createdAt: new Date(),
            });
            await setup.db.insert(usagePolicies).values({
              id: policyId,
              policyKey: `file-rollout-${policyId}`.slice(0, 64),
              displayName: "File rollout fixture",
              monthlyUsageUnits: 0,
              storageBytesPerAssignment: 1_000_000n,
            });
            await setup.db.insert(usageEntitlements).values({
              id: createSafeId<"usageEntitlement">(),
              organizationId,
              usagePolicyId: policyId,
              status: "active",
              seats: 1,
              currentPeriodStart: new Date(Date.now() - 60_000),
              currentPeriodEnd: new Date(Date.now() + 3_600_000),
              source: "manual",
            });
            await setup.db.insert(usageSeatAssignments).values({
              id: createSafeId<"usageSeatAssignment">(),
              organizationId,
              userId,
            });
            await setup.db.insert(organizationFileUsage).values({
              organizationId,
            });
            const [currentBackend] = await currentClient.db
              .select({ pid: sql<number>`pg_backend_pid()` })
              .from(sql`(SELECT 1) AS backend_identity`);
            const waitingPid =
              currentBackend?.pid ?? panic("Current backend identity missing");

            // The previous release's reconciliation, statement for statement.
            const legacy = legacyClient.db.transaction(async (tx) => {
              await tx
                .insert(organizationFileUsage)
                .values({ organizationId })
                .onConflictDoNothing();
              const counter =
                (
                  await tx
                    .select({
                      committedBytes: organizationFileUsage.committedBytes,
                      reservedBytes: organizationFileUsage.reservedBytes,
                    })
                    .from(organizationFileUsage)
                    .where(
                      eq(organizationFileUsage.organizationId, organizationId),
                    )
                    .for("update")
                ).at(0) ?? panic("Legacy counter missing");
              const [backend] = await tx
                .select({ pid: sql<number>`pg_backend_pid()` })
                .from(sql`(SELECT 1) AS backend_identity`);
              held.resolve(backend?.pid ?? panic("Legacy backend missing"));
              await release.promise;
              await tx.insert(organizationFileObjects).values({
                organizationId,
                objectKey: legacyKey,
                sizeBytes: LEGACY_BYTES,
                status: "committed",
              });
              await tx
                .update(organizationFileUsage)
                .set({
                  committedBytes: counter.committedBytes + LEGACY_BYTES,
                  reservedBytes: counter.reservedBytes,
                  updatedAt: new Date(),
                })
                .where(
                  eq(organizationFileUsage.organizationId, organizationId),
                );
            });
            const holdingPid = await Promise.race([
              held.promise,
              legacy.then(() => null),
            ]);
            if (holdingPid === null) {
              panic("The legacy writer committed before holding its lock");
            }

            const fileUsageDb = asTestRaw<FileUsageDb>(currentClient.db);
            const input = {
              organizationId,
              objectKey: currentKey,
              sizeBytes: CURRENT_BYTES,
            };
            const current =
              writer === "reservation"
                ? reserveOrganizationFileBytes(input, fileUsageDb).then(
                    (result) => Result.isOk(result),
                  )
                : reconcileOrganizationFileObject(input, fileUsageDb).then(
                    (result) => Result.isOk(result),
                  );
            try {
              await waitForBlockedPid(observer, { holdingPid, waitingPid });
            } finally {
              release.resolve(undefined);
            }
            await legacy;
            expect(await current).toBe(true);

            const counter = (
              await setup.db
                .select({
                  committedBytes: organizationFileUsage.committedBytes,
                  reservedBytes: organizationFileUsage.reservedBytes,
                })
                .from(organizationFileUsage)
                .where(eq(organizationFileUsage.organizationId, organizationId))
            ).at(0);
            const currentBytes = BigInt(CURRENT_BYTES);
            expect(counter).toEqual(
              writer === "reservation"
                ? {
                    committedBytes: LEGACY_BYTES,
                    reservedBytes: currentBytes,
                  }
                : {
                    committedBytes: LEGACY_BYTES + currentBytes,
                    reservedBytes: 0n,
                  },
            );
          } finally {
            release.resolve(undefined);
            envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorFlag;
            await setup.db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await setup.db.delete(user).where(eq(user.id, userId));
            await setup.db
              .delete(usagePolicies)
              .where(eq(usagePolicies.id, policyId));
          }
        },
      );
    },
    30_000,
  );
});
