import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { contacts, sanctionsContactMarks } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { drainSanctionsContactMarks } from "@/api/lib/lists/sanctions/monitoring-drain";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const now = new Date("2026-09-29T12:00:00Z");
const BLOCK_OBSERVATION_ATTEMPTS = 200;
const CLAIM_INSPECTED = "Monitoring contact claim inspected";
const errorSummary = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return `${error.name}: ${error.message} ${"cause" in error ? errorSummary(error.cause) : ""}`;
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("monitoring contact claims on PostgreSQL", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  test("contact drains skip a locked earlier mark and roll available work back before commit", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: lockerDb } = openClient({
        connection: { statement_timeout: 10_000 },
      });
      const { db: workerDb } = openClient({
        connection: { statement_timeout: 10_000 },
      });
      const organizationId = mintAuthProviderId<"organization">();
      const lockedContactId = createSafeId<"contact">();
      const availableContactId = createSafeId<"contact">();
      const lockedAt = new Date(now.getTime() - 1000);
      const availableAt = new Date(now.getTime() - 500);
      const locked = Promise.withResolvers<undefined>();
      const observe = Promise.withResolvers<undefined>();
      const observed = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const controller = new AbortController();
      const running: Promise<unknown>[] = [];
      let claimFinished = false;
      try {
        await lockerDb.insert(organization).values({
          id: organizationId,
          name: "Monitoring claim fixture",
          slug: `monitoring-claim-${lockedContactId}`,
          createdAt: now,
        });
        await lockerDb.insert(contacts).values([
          {
            id: lockedContactId,
            organizationId,
            type: "person",
            displayName: "Synthetic Locked Contact",
          },
          {
            id: availableContactId,
            organizationId,
            type: "person",
            displayName: "Synthetic Available Contact",
          },
        ]);
        await lockerDb
          .update(sanctionsContactMarks)
          .set({ scheduledAt: lockedAt })
          .where(eq(sanctionsContactMarks.contactId, lockedContactId));
        await lockerDb
          .update(sanctionsContactMarks)
          .set({ scheduledAt: availableAt })
          .where(eq(sanctionsContactMarks.contactId, availableContactId));
        const workerPid =
          (
            await workerDb.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            )
          ).at(0)?.pid ?? panic("Missing claim worker backend");
        const locking = lockerDb.transaction(async (tx) => {
          const held = await tx
            .select()
            .from(sanctionsContactMarks)
            .where(eq(sanctionsContactMarks.contactId, lockedContactId))
            .for("update");
          expect(held).toHaveLength(1);
          expect(held.at(0)?.scheduledAt).toEqual(lockedAt);
          locked.resolve(undefined);
          await observe.promise;
          // A competing claim must finish while this earlier row is still locked.
          // A server-observed dependency is an immediate failure, not a timeout oracle.
          for (
            let attempt = 0;
            attempt < BLOCK_OBSERVATION_ATTEMPTS;
            attempt += 1
          ) {
            if (claimFinished) {
              break;
            }
            const blocked =
              (
                await tx.execute<{ blocked: boolean }>(sql`
              SELECT pg_backend_pid() = ANY(pg_blocking_pids(${workerPid})) AS blocked
            `)
              ).at(0) ?? panic("Missing contact claim lock observation");
            expect(blocked.blocked).toBe(false);
            await Bun.sleep(10);
          }
          expect(claimFinished).toBe(true);
          observed.resolve(undefined);
          await release.promise;
        });
        running.push(locking);
        void locking.catch((error: unknown) => {
          locked.reject(error);
          observed.reject(error);
        });
        await locked.promise;
        const scopedDb: ScopedDb = async (run) =>
          await workerDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE stella`);
            await tx.execute(
              sql`SELECT set_config('app.organization_id', ${organizationId}, true)`,
            );
            const drained = await run(asTestRaw<Transaction>(tx));
            if (
              typeof drained !== "object" ||
              drained === null ||
              !("claimed" in drained) ||
              !("terminal" in drained)
            ) {
              panic("Contact drain result missing");
            }
            expect(drained.claimed).toBe(1);
            expect(drained.terminal).toBe(1);
            claimFinished = true;
            // Inspect a completed run while its transaction can still roll back.
            controller.abort(new DOMException(CLAIM_INSPECTED, "AbortError"));
            controller.signal.throwIfAborted();
            return drained;
          });
        const draining = drainSanctionsContactMarks({
          db: scopedDb,
          organizationId,
          now,
          signal: controller.signal,
        });
        running.push(draining);
        observe.resolve(undefined);
        await observed.promise;
        const result = await draining;
        if (result.isOk()) {
          panic(
            "Expected contact drain to stop before its transaction commits",
          );
        }
        expect(errorSummary(result.error)).toContain("AbortError");
        expect(errorSummary(result.error)).toContain(CLAIM_INSPECTED);
        const marks = await workerDb
          .select()
          .from(sanctionsContactMarks)
          .where(eq(sanctionsContactMarks.organizationId, organizationId));
        expect(marks).toHaveLength(2);
        expect(
          marks.find(({ contactId }) => contactId === lockedContactId),
        ).toMatchObject({ generation: 1n, scheduledAt: lockedAt });
        expect(
          marks.find(({ contactId }) => contactId === availableContactId),
        ).toMatchObject({ generation: 1n, scheduledAt: availableAt });
        release.resolve(undefined);
        await locking;
      } finally {
        observe.resolve(undefined);
        release.resolve(undefined);
        await Promise.allSettled(running);
        await lockerDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
    });
  }, 120_000);
}
