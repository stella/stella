import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { createSafeId } from "@/api/lib/branded-types";
import { PG_ERROR, getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { withAggregateLock } from "./aggregate-lock";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type LockTransaction = Pick<Transaction, "execute">;

const advisoryCases = () => {
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const otherUserId = mintAuthProviderId<"user">();
  return [
    {
      name: "contact capacity",
      acquire: (tx: LockTransaction) =>
        withAggregateLock({
          aggregate: "contactCapacity",
          id: { organizationId },
          tx,
        }),
      acquireOther: (tx: LockTransaction) =>
        withAggregateLock({
          aggregate: "contactCapacity",
          id: { organizationId: otherOrganizationId },
          tx,
        }),
      tryLegacy: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtext('contact_capacity'), hashtext(${organizationId})) AS acquired`,
        ),
      acquireLegacy: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('contact_capacity'), hashtext(${organizationId}))`,
        ),
    },
    {
      name: "personal catalog",
      acquire: (tx: LockTransaction) =>
        withAggregateLock({
          aggregate: "personalCatalog",
          id: { organizationId, userId },
          tx,
        }),
      acquireOther: (tx: LockTransaction) =>
        withAggregateLock({
          aggregate: "personalCatalog",
          id: { organizationId, userId: otherUserId },
          tx,
        }),
      tryLegacy: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${organizationId}), hashtext(${userId})) AS acquired`,
        ),
      acquireLegacy: (tx: LockTransaction) =>
        tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${userId}))`,
        ),
    },
  ];
};

if (!databaseUrl || !enabled) {
  describe.skip("aggregate locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("aggregate locks (postgres)", () => {
    test("missing rows consume no rank and workspace locks preserve tenant scope on reacquisition", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`CREATE TEMPORARY TABLE workspaces (id uuid PRIMARY KEY, organization_id text NOT NULL, status text NOT NULL) ON COMMIT DROP`,
          );
          await tx.execute(
            sql`CREATE TEMPORARY TABLE organization (id text PRIMARY KEY) ON COMMIT DROP`,
          );
          const organizationId = mintAuthProviderId<"organization">();
          const otherOrganizationId = mintAuthProviderId<"organization">();
          const workspaceId = createSafeId<"workspace">();
          await tx.execute(
            sql`INSERT INTO organization (id) VALUES (${organizationId})`,
          );
          expect(
            await withAggregateLock({
              aggregate: "workspace",
              id: { id: workspaceId, organizationId },
              tx,
            }),
          ).toEqual({ status: "missing" });
          expect(
            await withAggregateLock({
              aggregate: "organization",
              id: organizationId,
              tx,
            }),
          ).toEqual({ status: "locked" });
          await tx.execute(
            sql`INSERT INTO workspaces (id, organization_id, status) VALUES (${workspaceId}::uuid, ${organizationId}, 'archived')`,
          );
          expect(
            await withAggregateLock({
              aggregate: "workspace",
              id: { id: workspaceId, organizationId },
              tx,
            }),
          ).toEqual({ status: "locked" });
          const state = await tx.execute(
            sql`SELECT status FROM workspaces WHERE id = ${workspaceId}::uuid`,
          );
          expect(state.at(0)?.["status"]).toBe("archived");
          expect(
            await withAggregateLock({
              aggregate: "workspace",
              id: { id: workspaceId, organizationId: otherOrganizationId },
              tx,
            }),
          ).toEqual({ status: "missing" });
          expect(
            await withAggregateLock({
              aggregate: "workspace",
              id: { id: workspaceId, organizationId },
              tx,
            }),
          ).toEqual({ status: "locked" });
        });
      });
    });

    test("rejects a lower-ranked lock before sending its statement", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const statements: string[] = [];
        const { db } = openClient({
          logger: { logQuery: (query) => statements.push(query) },
        });
        await db.transaction(async (tx) => {
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          await withAggregateLock({
            aggregate: "personalCatalog",
            id: { organizationId, userId },
            tx,
          });
          const countBeforeInversion = statements.length;
          expect(
            await rejectionOf(
              withAggregateLock({
                aggregate: "organization",
                id: organizationId,
                tx,
              }),
            ),
          ).toMatchObject({ message: "Aggregate lock rank inversion" });
          expect(statements.length).toBe(countBeforeInversion);
        });
      });
    });

    for (const name of ["contact capacity", "personal catalog"]) {
      test(`${name} serializes its physical key and permits independent keys`, async () => {
        const fixture = advisoryCases().find(
          (candidate) => candidate.name === name,
        );
        if (!fixture) {
          panic("Missing advisory fixture");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const holder = openClient();
          const contender = openClient({
            connection: { lock_timeout: 1000, statement_timeout: 5000 },
          });
          await holder.db.transaction(async (tx) => {
            expect(await fixture.acquire(tx)).toEqual({ status: "locked" });
            await contender.db.transaction(async (otherTx) => {
              const rows = await fixture.tryLegacy(otherTx);
              expect(rows.at(0)?.["acquired"]).toBe(false);
              expect(await fixture.acquireOther(otherTx)).toEqual({
                status: "locked",
              });
            });
            const blocked = await Result.tryPromise(() =>
              contender.db.transaction(
                async (otherTx) => await fixture.acquire(otherTx),
              ),
            );
            expect(blocked.isErr()).toBe(true);
            if (blocked.isErr()) {
              expect(getPgErrorCode(blocked.error)).toBe(
                PG_ERROR.LOCK_NOT_AVAILABLE,
              );
            }
          });
          await contender.db.transaction(async (tx) => {
            const rows = await fixture.tryLegacy(tx);
            expect(rows.at(0)?.["acquired"]).toBe(true);
          });
        });
      });

      test(`${name} contends with legacy writers and releases after rollback`, async () => {
        const fixture = advisoryCases().find(
          (candidate) => candidate.name === name,
        );
        if (!fixture) {
          panic("Missing advisory fixture");
        }
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const holder = openClient();
          const contender = openClient({
            connection: { lock_timeout: 1000, statement_timeout: 5000 },
          });
          await holder.db.transaction(async (tx) => {
            await fixture.acquireLegacy(tx);
            const blocked = await Result.tryPromise(() =>
              contender.db.transaction(
                async (otherTx) => await fixture.acquire(otherTx),
              ),
            );
            expect(blocked.isErr()).toBe(true);
            if (blocked.isErr()) {
              expect(getPgErrorCode(blocked.error)).toBe(
                PG_ERROR.LOCK_NOT_AVAILABLE,
              );
            }
          });
          const rolledBack = await Result.tryPromise(() =>
            holder.db.transaction(async (tx) => {
              expect(await fixture.acquire(tx)).toEqual({ status: "locked" });
              tx.rollback();
            }),
          );
          expect(rolledBack.isErr()).toBe(true);
          if (rolledBack.isErr()) {
            expect(rolledBack.error.cause).toBeInstanceOf(
              TransactionRollbackError,
            );
          }
          await contender.db.transaction(async (tx) => {
            const rows = await fixture.tryLegacy(tx);
            expect(rows.at(0)?.["acquired"]).toBe(true);
            expect(await fixture.acquire(tx)).toEqual({ status: "locked" });
          });
        });
      });
    }
  });
}
