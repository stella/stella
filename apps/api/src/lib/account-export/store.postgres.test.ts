import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { accountAuditLogs, accountExports } from "@/api/db/schema";
import { ACCOUNT_EXPORT_LIMITS } from "@/api/lib/account-export/constants";
import {
  canReclaimAccountExportAttempt,
  canReclaimAccountExportObjects,
  claimAccountExport,
  clearAccountExportObjects,
  completeAccountExport,
  expireAccountExport,
  failAccountExport,
  listRecoverableAccountExports,
  readAccountExport,
  readLatestAccountExport,
  recordAccountExportDownload,
  requestAccountExport,
} from "@/api/lib/account-export/store";
import { toSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("account export lifecycle", () => {
  test("durable transitions retain one active export and bounded recovery", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client, db } = openClient();
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const schema = `export_${suffix}`;
      const ownerRole = `export_owner_${suffix}`;
      const recoveryUserId = toSafeId<"user">("export_account_a");
      const userId = toSafeId<"user">("export_account_b");
      await client.unsafe(`CREATE SCHEMA ${schema}`);
      try {
        await client.unsafe(`SET search_path TO ${schema}, public`);
        await client.unsafe(
          `CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
        );
        // The test connection is a non-superuser CREATEROLE owner, so it
        // needs explicit membership to hand tables to and act as this role.
        await client.unsafe(
          `GRANT ${ownerRole} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`,
        );
        await client.unsafe(
          `GRANT USAGE ON SCHEMA ${schema} TO stella, ${ownerRole}; GRANT CREATE ON SCHEMA ${schema} TO ${ownerRole}`,
        );
        await client.unsafe(
          `CREATE TABLE "user" (id text PRIMARY KEY, deleted_at timestamptz); GRANT SELECT, UPDATE ON "user" TO ${ownerRole}`,
        );
        await client`INSERT INTO "user" (id) VALUES (${recoveryUserId}), (${userId})`;
        for (const migration of [
          "20261010005100_account_audit_scope",
          "20261016100500_account_exports",
        ]) {
          const source = await Bun.file(
            new URL(
              `../../../drizzle/${migration}/migration.sql`,
              import.meta.url,
            ),
          ).text();
          await db.transaction(async (tx) => {
            for (const statement of source
              .replaceAll(
                "public.account_audit_logs",
                () => `${schema}.account_audit_logs`,
              )
              .replaceAll(
                "public.account_exports",
                () => `${schema}.account_exports`,
              )
              .split("--> statement-breakpoint")) {
              await tx.execute(sql.raw(statement));
            }
          });
        }
        await client.unsafe(
          `ALTER TABLE account_exports OWNER TO ${ownerRole}; ALTER TABLE account_audit_logs OWNER TO ${ownerRole}`,
        );
        await client.unsafe(`SET ROLE ${ownerRole}`);
        const requested = (
          await requestAccountExport(userId, {
            db,
          })
        ).unwrap();
        expect((await requestAccountExport(userId, { db })).unwrap().id).toBe(
          requested.id,
        );
        const concurrentRetries = await Promise.all(
          Array.from(
            { length: ACCOUNT_EXPORT_LIMITS.requestsPerWindow + 1 },
            async () => {
              const { sql: retryClient, db: retryDb } = openClient();
              await retryClient.unsafe(
                `SET search_path TO ${schema}, public; SET ROLE ${ownerRole}`,
              );
              return (
                await requestAccountExport(userId, { db: retryDb })
              ).unwrap().id;
            },
          ),
        );
        expect(new Set(concurrentRetries)).toEqual(new Set([requested.id]));
        expect(requested.status).toBe("requested");
        expect((await readLatestAccountExport(userId, db))?.id).toBe(
          requested.id,
        );
        expect(
          (await readAccountExport({ id: requested.id, userId, db }))?.id,
        ).toBe(requested.id);
        const firstClaim = await claimAccountExport(requested.id, db);
        if (firstClaim === null) {
          panic("Requested export claim required");
        }
        expect(await claimAccountExport(requested.id, db)).toBeNull();
        expect((await requestAccountExport(userId, { db })).unwrap().id).toBe(
          requested.id,
        );
        expect(await failAccountExport(firstClaim, db)).toBe(true);
        expect(await failAccountExport(firstClaim, db)).toBe(false);
        const claim = await claimAccountExport(requested.id, db);
        if (claim === null) {
          panic("Retry export claim required");
        }
        expect(claim.objectKey).not.toBe(firstClaim.objectKey);
        expect(
          await completeAccountExport({
            claim,
            objectKey: claim.objectKey,
            db,
          }),
        ).toBe(true);
        expect(
          await completeAccountExport({
            claim,
            objectKey: claim.objectKey,
            db,
          }),
        ).toBe(false);
        const ready = await recordAccountExportDownload({
          id: requested.id,
          userId,
          db,
        });
        expect((await requestAccountExport(userId, { db })).unwrap().id).toBe(
          requested.id,
        );
        expect(ready?.status).toBe("ready");
        expect(
          (
            await recordAccountExportDownload({
              id: requested.id,
              userId,
              db,
            })
          )?.id,
        ).toBe(requested.id);
        if (ready === null) {
          panic("Ready account export required");
        }
        if (ready.expiresAt === null) {
          panic("Ready account export expiry required");
        }
        expect(ready.expiresAt.getTime() - ready.updatedAt.getTime()).toBe(
          ACCOUNT_EXPORT_LIMITS.ttlMs,
        );
        expect(await canReclaimAccountExportAttempt(firstClaim, db)).toBe(true);
        expect(await canReclaimAccountExportAttempt(claim, db)).toBe(false);
        expect(ready.attemptObjectKeys).toEqual([
          firstClaim.objectKey,
          claim.objectKey,
        ]);
        const audits = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.user_id', ${userId}, true)`,
          );
          return await tx
            .select({ eventType: accountAuditLogs.eventType })
            .from(accountAuditLogs)
            .where(eq(accountAuditLogs.resourceId, requested.id))
            .orderBy(accountAuditLogs.eventType);
        });
        expect(audits.map(({ eventType }) => eventType)).toEqual([
          "account.data_export.downloaded",
          "account.data_export.downloaded",
          "account.data_export.ready",
          "account.data_export.requested",
        ]);
        // As the application role, another account sees no row for this
        // export's id and cannot record a download of it.
        const otherAccount = await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella`);
          await tx.execute(
            sql`SELECT set_config('app.user_id', ${recoveryUserId}, true)`,
          );
          return await tx
            .select({ id: accountExports.id })
            .from(accountExports)
            .where(eq(accountExports.id, requested.id));
        });
        expect(otherAccount).toEqual([]);
        expect(
          await readAccountExport({
            id: requested.id,
            userId: recoveryUserId,
            db,
          }),
        ).toBeNull();
        expect(
          await recordAccountExportDownload({
            id: requested.id,
            userId: recoveryUserId,
            db,
          }),
        ).toBeNull();
        const downloadsAfter = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.user_id', ${userId}, true)`,
          );
          return await tx
            .select({ eventType: accountAuditLogs.eventType })
            .from(accountAuditLogs)
            .where(eq(accountAuditLogs.resourceId, requested.id));
        });
        expect(
          downloadsAfter.filter(
            ({ eventType }) => eventType === "account.data_export.downloaded",
          ),
        ).toHaveLength(2);
        await db.transaction(async (tx) => {
          await tx
            .update(accountExports)
            .set({ expiresAt: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'` })
            .where(eq(accountExports.id, requested.id));
        });
        expect(
          (await expireAccountExport(requested.id, db))?.attemptObjectKeys,
        ).toEqual([firstClaim.objectKey, claim.objectKey]);
        expect(await expireAccountExport(requested.id, db)).toBeNull();
        expect(
          await recordAccountExportDownload({
            id: requested.id,
            userId,
            db,
          }),
        ).toBeNull();
        expect(await canReclaimAccountExportObjects(requested.id, db)).toBe(
          false,
        );
        await clearAccountExportObjects(requested.id, db);
        expect(
          (await readAccountExport({ id: requested.id, userId, db }))
            ?.attemptObjectKeys,
        ).toEqual([firstClaim.objectKey, claim.objectKey]);
        expect((await listRecoverableAccountExports(db)).items).toEqual([]);
        await db.transaction(async (tx) => {
          await tx
            .update(accountExports)
            .set({
              updatedAt: sql`clock_timestamp() - (${ACCOUNT_EXPORT_LIMITS.leaseMs + ACCOUNT_EXPORT_LIMITS.publicationCancellationMarginMs + 1000} * INTERVAL '1 millisecond')`,
            })
            .where(eq(accountExports.id, requested.id));
        });
        expect(await canReclaimAccountExportObjects(requested.id, db)).toBe(
          true,
        );
        await clearAccountExportObjects(requested.id, db);
        expect(
          (await readAccountExport({ id: requested.id, userId, db }))
            ?.attemptObjectKeys,
        ).toEqual([]);

        const retrying = (
          await requestAccountExport(userId, {
            db,
          })
        ).unwrap();
        for (
          let attempt = 0;
          attempt < ACCOUNT_EXPORT_LIMITS.attempts;
          attempt += 1
        ) {
          const retry = await claimAccountExport(retrying.id, db);
          if (retry === null) {
            panic("Retry budget claim required");
          }
          expect(await failAccountExport(retry, db)).toBe(true);
        }
        expect(
          (await readAccountExport({ id: retrying.id, userId, db }))?.status,
        ).toBe("failed");
        expect((await readLatestAccountExport(userId, db))?.id).toBe(
          retrying.id,
        );
        expect(await claimAccountExport(retrying.id, db)).toBeNull();
        expect((await listRecoverableAccountExports(db)).items).toEqual([]);
        await db.transaction(async (tx) => {
          await tx
            .update(accountExports)
            .set({
              updatedAt: sql`clock_timestamp() - (${ACCOUNT_EXPORT_LIMITS.leaseMs + ACCOUNT_EXPORT_LIMITS.publicationCancellationMarginMs + 1000} * INTERVAL '1 millisecond')`,
            })
            .where(eq(accountExports.id, retrying.id));
        });
        expect(
          (await listRecoverableAccountExports(db)).items.map(({ id }) => id),
        ).toEqual([retrying.id]);
        const lastSlot = (await requestAccountExport(userId, { db })).unwrap();
        const locking = Promise.withResolvers<null>();
        const { sql: racingClient, db: racingDb } = openClient({
          logger: {
            logQuery: (query) => {
              if (
                query.includes('"account_exports"') &&
                query.toLowerCase().includes("for no key update")
              ) {
                locking.resolve(null);
              }
            },
          },
        });
        await racingClient.unsafe(
          `SET search_path TO ${schema}, public; SET ROLE ${ownerRole}`,
        );
        // The initial lookup sees the requested row; its lock then waits for
        // a worker's terminal transition. Recheck the status after locking.
        const { pending: requestAfterTransition } = await db.transaction(
          async (tx) => {
            await tx
              .update(accountExports)
              .set({ status: "failed" })
              .where(eq(accountExports.id, lastSlot.id));
            const pending = requestAccountExport(userId, { db: racingDb });
            await locking.promise;
            return { pending };
          },
        );
        const refused = await requestAfterTransition;
        expect(Result.isError(refused) ? refused.error : null).toMatchObject({
          status: 429,
          code: "account_export_request_limited",
        });
        expect((await readLatestAccountExport(userId, db))?.id).toBe(
          lastSlot.id,
        );
        await db.transaction(async (tx) => {
          await tx
            .update(accountExports)
            .set({
              createdAt: sql`CURRENT_TIMESTAMP - (${ACCOUNT_EXPORT_LIMITS.requestWindowMs + 1000} * INTERVAL '1 millisecond')`,
            })
            .where(eq(accountExports.userId, userId));
        });
        expect(Result.isOk(await requestAccountExport(userId, { db }))).toBe(
          true,
        );
        const recovering = (
          await requestAccountExport(recoveryUserId, {
            db,
          })
        ).unwrap();
        const abandoned = await claimAccountExport(recovering.id, db);
        if (abandoned === null) {
          panic("Initial recovery claim required");
        }
        await db.transaction(async (tx) => {
          await tx
            .update(accountExports)
            .set({
              leaseExpiresAt: sql`CURRENT_TIMESTAMP - INTERVAL '1 second'`,
            })
            .where(eq(accountExports.id, recovering.id));
        });
        const recovered = await claimAccountExport(recovering.id, db);
        if (recovered === null) {
          panic("Expired lease recovery claim required");
        }
        expect(recovered.objectKey).not.toBe(abandoned.objectKey);
        expect(
          await completeAccountExport({
            claim: abandoned,
            objectKey: abandoned.objectKey,
            db,
          }),
        ).toBe(false);
        expect(await canReclaimAccountExportAttempt(abandoned, db)).toBe(true);
        expect(
          await completeAccountExport({
            claim: recovered,
            objectKey: recovered.objectKey,
            db,
          }),
        ).toBe(true);
      } finally {
        await client.unsafe("RESET ROLE; RESET search_path");
        await client.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await client.unsafe(`DROP ROLE IF EXISTS ${ownerRole}`);
      }
    });
  });
});
