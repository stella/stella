import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL } from "@stll/api-contract/desktop-handoff";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { desktopPresence } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { removeOrganizationMemberInTransaction } from "@/api/lib/member-assignment-offboarding";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  DESKTOP_PRESENCE_INSTALLATION_LIMIT,
  readDesktopPresence,
  reportDesktopPresence,
} from "./service";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const installationId = (index: number) =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;

if (!databaseUrl || !runPostgres) {
  describe.skip("desktop installation retention (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  test.each(["first", "second"] as const)(
    "%s writer commits first while concurrent installation reports stay bounded",
    async (firstWriter) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const connection = { lock_timeout: 500, statement_timeout: 10_000 };
        const { db: firstDb } = openClient({ connection });
        const { db: secondDb } = openClient({ connection });
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const firstScoped = asTestRaw<ScopedDb>(
          createScopedDb(markRlsDatabase(firstDb), [], organizationId, userId),
        );
        const secondScoped = asTestRaw<ScopedDb>(
          createScopedDb(markRlsDatabase(secondDb), [], organizationId, userId),
        );
        const report = {
          version: "0.9.48",
          protocol: DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL,
        };
        const reached = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const tasks: Promise<unknown>[] = [];
        await firstDb.insert(user).values({
          id: userId,
          name: "Presence test member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        try {
          await firstDb.insert(organization).values({
            id: organizationId,
            name: "Presence test organization",
            slug: organizationId,
            createdAt: new Date(),
          });
          await firstDb.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId,
            userId,
            role: "owner",
            createdAt: new Date(),
          });
          await firstDb.insert(desktopPresence).values(
            Array.from(
              { length: DESKTOP_PRESENCE_INSTALLATION_LIMIT - 1 },
              (_, index) => ({
                organizationId,
                userId,
                desktopId: installationId(index),
                ...report,
                lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
              }),
            ),
          );
          const holder = firstWriter === "first" ? firstScoped : secondScoped;
          const competitor =
            firstWriter === "first" ? secondScoped : firstScoped;
          const heldScope: ScopedDb = async (fn) =>
            await holder(async (tx) => {
              const result = await fn(tx);
              reached.resolve(undefined);
              await release.promise;
              return result;
            });
          const heldReport = Result.tryPromise(
            async () =>
              await reportDesktopPresence({
                scopedDb: heldScope,
                organizationId,
                userId,
                report: { ...report, desktopId: installationId(100) },
              }),
          );
          tasks.push(heldReport);
          await Promise.race([
            reached.promise,
            heldReport.then(() =>
              panic("Report ended before its commit barrier"),
            ),
          ]);
          const blockedReport = await Result.tryPromise(
            async () =>
              await reportDesktopPresence({
                scopedDb: competitor,
                organizationId,
                userId,
                report: { ...report, desktopId: installationId(101) },
              }),
          );
          expect(blockedReport.isErr()).toBe(true);
          if (blockedReport.isErr()) {
            expect(getPgErrorCode(blockedReport.error)).toBe(
              PG_ERROR.LOCK_NOT_AVAILABLE,
            );
          }
          release.resolve(undefined);
          (await heldReport).unwrap();

          const batchSize = DESKTOP_PRESENCE_INSTALLATION_LIMIT * 2;
          const reportedIds = Array.from({ length: batchSize }, (_, index) =>
            installationId(200 + index),
          );
          const reports = Array.from(
            { length: batchSize },
            async (_, index) =>
              await reportDesktopPresence({
                scopedDb: index % 2 === 0 ? firstScoped : secondScoped,
                organizationId,
                userId,
                report: { ...report, desktopId: installationId(200 + index) },
              }),
          );
          tasks.push(...reports);
          await Promise.all(reports);
          const rows = await firstDb
            .select()
            .from(desktopPresence)
            .where(
              and(
                eq(desktopPresence.organizationId, organizationId),
                eq(desktopPresence.userId, userId),
              ),
            );
          expect(rows).toHaveLength(DESKTOP_PRESENCE_INSTALLATION_LIMIT);
          expect(rows.every((row) => reportedIds.includes(row.desktopId))).toBe(
            true,
          );
          expect(
            await readDesktopPresence({
              scopedDb: firstScoped,
              organizationId,
              userId,
            }),
          ).toMatchObject({ type: "current", desktop: report });
        } finally {
          release.resolve(undefined);
          await Promise.allSettled(tasks);
          await firstDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await firstDb.delete(user).where(eq(user.id, userId));
        }
      });
    },
    30_000,
  );

  test.each(["report", "removal"] as const)(
    "%s commits before its competing presence lifecycle operation",
    async (firstOperation) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const connection = { lock_timeout: 500, statement_timeout: 10_000 };
        const { db: reportingDb } = openClient({ connection });
        const { db: removalDb } = openClient({ connection });
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const actorUserId = mintAuthProviderId<"user">();
        const memberId = mintAuthProviderIdValue();
        const scopedDb = asTestRaw<ScopedDb>(
          createScopedDb(
            markRlsDatabase(reportingDb),
            [],
            organizationId,
            userId,
          ),
        );
        const reached = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const tasks: Promise<unknown>[] = [];
        const report = {
          desktopId: installationId(500),
          version: "0.9.48",
          protocol: DESKTOP_HANDOFF_MIN_SUPPORTED_PROTOCOL,
        };
        const remove = async (hold: "hold" | "commit") =>
          await removalDb.transaction(async (tx) => {
            await removeOrganizationMemberInTransaction(
              asTestRaw<Transaction>(tx),
              { organizationId, memberId, userId, actorUserId },
            );
            if (hold === "hold") {
              reached.resolve(undefined);
              await release.promise;
            }
          });
        const heldScope: ScopedDb = async (fn) =>
          await scopedDb(async (tx) => {
            const result = await fn(tx);
            reached.resolve(undefined);
            await release.promise;
            return result;
          });
        await reportingDb.insert(user).values(
          [userId, actorUserId].map((id) => ({
            id,
            name: "Presence lifecycle member",
            email: `${id}@example.test`,
            emailVerified: true,
          })),
        );
        try {
          await reportingDb.insert(organization).values({
            id: organizationId,
            name: "Presence lifecycle organization",
            slug: organizationId,
            createdAt: new Date(),
          });
          await reportingDb.insert(member).values([
            {
              id: memberId,
              organizationId,
              userId,
              role: "member",
              createdAt: new Date(),
            },
            {
              id: mintAuthProviderIdValue(),
              organizationId,
              userId: actorUserId,
              role: "owner",
              createdAt: new Date(),
            },
          ]);
          const held = Result.tryPromise(async () =>
            firstOperation === "report"
              ? await reportDesktopPresence({
                  scopedDb: heldScope,
                  organizationId,
                  userId,
                  report,
                })
              : await remove("hold"),
          );
          tasks.push(held);
          await Promise.race([
            reached.promise,
            held.then(() =>
              panic("Lifecycle operation ended before its commit barrier"),
            ),
          ]);
          const blocked = await Result.tryPromise(async () =>
            firstOperation === "report"
              ? await remove("commit")
              : await reportDesktopPresence({
                  scopedDb,
                  organizationId,
                  userId,
                  report,
                }),
          );
          expect(blocked.isErr()).toBe(true);
          if (blocked.isErr()) {
            expect(getPgErrorCode(blocked.error)).toBe(
              PG_ERROR.LOCK_NOT_AVAILABLE,
            );
          }
          release.resolve(undefined);
          (await held).unwrap();
          if (firstOperation === "report") {
            expect(
              await readDesktopPresence({ scopedDb, organizationId, userId }),
            ).toMatchObject({ type: "current" });
            await remove("commit");
          }
          expect(
            await reportDesktopPresence({
              scopedDb,
              organizationId,
              userId,
              report: { ...report, desktopId: installationId(501) },
            }),
          ).toBe(false);
          expect(
            await reportingDb.$count(
              desktopPresence,
              and(
                eq(desktopPresence.organizationId, organizationId),
                eq(desktopPresence.userId, userId),
              ),
            ),
          ).toBe(0);
          expect(
            await readDesktopPresence({ scopedDb, organizationId, userId }),
          ).toEqual({ type: "none" });
        } finally {
          release.resolve(undefined);
          await Promise.allSettled(tasks);
          await reportingDb
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await reportingDb.delete(user).where(eq(user.id, userId));
          await reportingDb.delete(user).where(eq(user.id, actorUserId));
        }
      });
    },
    30_000,
  );
}
