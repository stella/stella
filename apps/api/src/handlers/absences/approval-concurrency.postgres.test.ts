import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { absences } from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { transitionAbsence } from "@/api/lib/billing/absences";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BLOCK_OBSERVATION_ATTEMPTS = 200;

const observeBlockedApproval = async (tx: Transaction, secondPid: number) => {
  for (let attempt = 0; attempt < BLOCK_OBSERVATION_ATTEMPTS; attempt += 1) {
    const [row] = await tx
      .select({
        blocked: sql<boolean>`pg_backend_pid() = ANY(pg_blocking_pids(${secondPid}))`,
      })
      .from(sql`(SELECT 1) AS lock_observation`);
    if (row?.blocked) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(
    "The overlapping approval did not block behind the first owner's transaction",
  );
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("absence approval serialization (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("absence approval serialization (postgres)", () => {
    test("different overlapping requests cannot both approve across concurrent backends", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient({ max: 1 });
        const { db: secondDb } = openClient({ max: 1 });
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const firstId = createSafeId<"absence">();
        const secondId = createSafeId<"absence">();
        const firstSafeDb = createSafeDb(
          markRlsDatabase(firstDb),
          [],
          organizationId,
          userId,
        );
        const secondSafeDb = createSafeDb(
          markRlsDatabase(secondDb),
          [],
          organizationId,
          userId,
        );
        const gateReached = Promise.withResolvers<undefined>();
        const secondStarted = Promise.withResolvers<undefined>();
        const blockObserved = Promise.withResolvers<undefined>();
        const releaseFirst = Promise.withResolvers<undefined>();
        let overlapBlocked = false;
        const recordAudit = createBackgroundAuditRecorder({
          organizationId,
          workspaceId: null,
          userId,
          execution: {
            performer: { type: "user", id: userId },
            trigger: { type: "direct" },
          },
        });
        const [firstBackend] = await firstDb
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(sql`(SELECT 1) AS connection_identity`);
        const [secondBackend] = await secondDb
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(sql`(SELECT 1) AS connection_identity`);
        if (!firstBackend || !secondBackend) {
          throw new Error("Missing concurrent backend identities");
        }
        expect(firstBackend.pid).not.toBe(secondBackend.pid);
        const gatedAudit: AuditRecorder = async (tx, event) => {
          await recordAudit(tx, event);
          gateReached.resolve(undefined);
          try {
            await secondStarted.promise;
            await observeBlockedApproval(tx, secondBackend.pid);
            overlapBlocked = true;
            blockObserved.resolve(undefined);
            await releaseFirst.promise;
          } finally {
            blockObserved.resolve(undefined);
          }
        };
        type ApprovalOptions = {
          safeDb: typeof firstSafeDb;
          id: typeof firstId;
          recordAuditEvent: AuditRecorder;
        };
        const approve = async ({
          safeDb,
          id,
          recordAuditEvent,
        }: ApprovalOptions) =>
          await transitionAbsence({
            safeDb,
            organizationId,
            actorUserId: userId,
            memberRole: { role: "owner" },
            id,
            body: { action: "approve", version: 1 },
            recordAuditEvent,
          });
        const inFlight: Promise<unknown>[] = [];
        try {
          await firstDb.insert(organization).values({
            id: organizationId,
            name: "Absence concurrency fixture",
            slug: `absences-${organizationId}`,
            createdAt: new Date(),
          });
          await firstDb.insert(user).values({
            id: userId,
            name: "Absence owner",
            email: `absences-${userId}@example.test`,
          });
          await firstDb.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await firstDb.insert(absences).values([
            {
              id: firstId,
              organizationId,
              userId,
              kind: "vacation",
              startDate: "2026-10-01",
              endDate: "2026-10-03",
              timezoneId: "Europe/Prague",
              coverage: "full",
            },
            {
              id: secondId,
              organizationId,
              userId,
              kind: "vacation",
              startDate: "2026-10-02",
              endDate: "2026-10-04",
              timezoneId: "Europe/Prague",
              coverage: "full",
            },
          ]);
          // Convert unexpected throws to values so a failure cannot leave an
          // unhandled rejection while the other backend is still gated.
          const firstTask = Result.tryPromise(
            async () =>
              await approve({
                safeDb: firstSafeDb,
                id: firstId,
                recordAuditEvent: gatedAudit,
              }),
          ).then((outcome) => {
            gateReached.resolve(undefined);
            blockObserved.resolve(undefined);
            return outcome;
          });
          inFlight.push(firstTask);
          await gateReached.promise;
          const secondTask = Result.tryPromise(
            async () =>
              await approve({
                safeDb: secondSafeDb,
                id: secondId,
                recordAuditEvent: recordAudit,
              }),
          );
          inFlight.push(secondTask);
          secondStarted.resolve(undefined);
          await blockObserved.promise;
          expect(overlapBlocked).toBe(true);
          releaseFirst.resolve(undefined);
          const firstOutcome = await firstTask;
          const secondOutcome = await secondTask;
          expect(firstOutcome.isOk()).toBe(true);
          expect(secondOutcome.isOk()).toBe(true);
          if (firstOutcome.isOk()) {
            const first = firstOutcome.value;
            expect(first.isOk()).toBe(true);
            if (first.isOk()) {
              expect(first.value).toEqual({
                id: firstId,
                status: "approved",
                version: 2,
              });
            }
          }
          if (secondOutcome.isOk()) {
            const second = secondOutcome.value;
            expect(second.isErr()).toBe(true);
            if (second.isErr()) {
              expect(second.error).toMatchObject({
                status: 409,
                message: "Absence overlaps an approved absence",
              });
            }
          }
          const rows = await firstDb
            .select({
              id: absences.id,
              status: absences.status,
              version: absences.version,
            })
            .from(absences)
            .where(eq(absences.organizationId, organizationId));
          expect(rows).toHaveLength(2);
          expect(rows).toEqual(
            expect.arrayContaining([
              { id: firstId, status: "approved", version: 2 },
              { id: secondId, status: "requested", version: 1 },
            ]),
          );
        } finally {
          secondStarted.resolve(undefined);
          releaseFirst.resolve(undefined);
          await Promise.allSettled(inFlight);
          await firstDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await firstDb.delete(user).where(eq(user.id, userId));
        }
      });
    }, 30_000);
  });
}
