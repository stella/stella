import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { account, user, verification } from "@/api/db/auth-schema";
import { accountAuditLogs } from "@/api/db/schema";
import { createConfirmedAccountUnlinker } from "@/api/lib/auth/unlink-account";
import { consumeConfirmationOtp } from "@/api/lib/confirmation-otp";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getTestDb,
  releaseTestDb,
  type TestDatabase,
} from "@/api/tests/security/test-utils";

const OTP = "123456";
const PURPOSE = "unlink-account";

const createFixture = async (db: TestDatabase, methodCount = 2) => {
  const id = mintAuthProviderId<"user">();
  const email = `${id}@sign-in.test`;
  const accountIds = Array.from({ length: methodCount }, () =>
    mintAuthProviderIdValue(),
  );
  await db.insert(user).values({ id, name: "Jana Nováková", email });
  await db.insert(account).values(
    accountIds.map((accountId, index) => ({
      id: accountId,
      accountId,
      userId: id,
      providerId: index === 0 ? "google" : "microsoft",
    })),
  );
  return {
    session: { user: { id, email } },
    accountIds,
    targetId: accountIds.at(0) ?? panic("Fixture needs a linked method"),
    issueCode: async (purpose = PURPOSE) => {
      await db.insert(verification).values({
        id: mintAuthProviderIdValue(),
        identifier: `${purpose}:${email}`,
        value: OTP,
        expiresAt: new Date(Date.now() + 300_000),
      });
      return OTP;
    },
    remaining: async () =>
      await db
        .select({ id: account.id })
        .from(account)
        .where(eq(account.userId, id)),
    auditRecords: async () =>
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${id}, true)`);
        return await tx
          .select({
            userId: accountAuditLogs.userId,
            eventType: accountAuditLogs.eventType,
            resourceId: accountAuditLogs.resourceId,
          })
          .from(accountAuditLogs)
          .where(sql`${accountAuditLogs.userId} = ${id}`);
      }),
  };
};

const withDatabase = async (run: (db: TestDatabase) => Promise<void>) => {
  const db = await getTestDb();
  try {
    await run(db);
  } finally {
    await releaseTestDb();
  }
};

const createUnlinker = (db: TestDatabase) =>
  createConfirmedAccountUnlinker({
    database:
      asTestRaw<
        Parameters<typeof createConfirmedAccountUnlinker>[0]["database"]
      >(db),
    verifyConfirmation: async (params) =>
      await consumeConfirmationOtp(db, params),
  });

const expectRefused = (
  result: Awaited<ReturnType<ReturnType<typeof createUnlinker>>>,
) => {
  if (Result.isOk(result)) {
    panic("The linked method removal should be refused");
  }
  expect(result.error.status).toBe("BAD_REQUEST");
  return result.error;
};

describe("confirmed linked method persistence", () => {
  test("audit constraint replacement replays without a blocking validation scan", async () => {
    const migration = await Bun.file(
      new URL(
        "../../../drizzle/20261029000200_sign_in_method_audit_event/migration.sql",
        import.meta.url,
      ),
    ).text();
    await withDatabase(async (db) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        // db-await-in-loop: replay the bounded statements from the owning migration.
        await db.execute(sql`BEGIN`);
        for (const statement of migration.split("--> statement-breakpoint")) {
          // db-await-in-loop: migration statements execute in their declared order.
          await db.execute(sql.raw(statement));
        }
        // db-await-in-loop: close the schema transaction; online repair validates later.
        await db.execute(sql`COMMIT`);
        // db-await-in-loop: every replay must leave the expanded check unvalidated.
        const pending = await db.execute(sql`
          SELECT convalidated FROM pg_constraint
          WHERE conrelid = 'account_audit_logs'::regclass
            AND conname = 'account_audit_logs_event_type_check'
        `);
        expect(pending.rows).toEqual([{ convalidated: false }]);
      }
      await db.execute(sql`
        ALTER TABLE account_audit_logs
          VALIDATE CONSTRAINT account_audit_logs_event_type_check
      `);
      const validation = await db.execute(sql`
        SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'account_audit_logs'::regclass
          AND conname = 'account_audit_logs_event_type_check'
      `);
      expect(validation.rows).toEqual([{ convalidated: true }]);
    });
  });

  test("a confirmed removal preserves the other method", async () => {
    await withDatabase(async (db) => {
      const fixture = await createFixture(db);
      const unlink = createUnlinker(db);
      const result = await unlink({
        session: fixture.session,
        body: { accountId: fixture.targetId, otp: await fixture.issueCode() },
      });
      expect(Result.isOk(result)).toBe(true);
      expect(await fixture.remaining()).toEqual(
        fixture.accountIds.slice(1).map((id) => ({ id })),
      );
      expect(await fixture.auditRecords()).toEqual([
        {
          userId: fixture.session.user.id,
          eventType: "account.sign_in_method.disconnected",
          resourceId: fixture.targetId,
        },
      ]);
    });
  });

  test("confirmed removal retains the last linked account", async () => {
    await withDatabase(async (db) => {
      const fixture = await createFixture(db, 1);
      const result = await createUnlinker(db)({
        session: fixture.session,
        body: { accountId: fixture.targetId, otp: await fixture.issueCode() },
      });
      expect(expectRefused(result).body).toMatchObject({
        code: "FAILED_TO_UNLINK_LAST_ACCOUNT",
      });
      expect(await fixture.remaining()).toEqual([{ id: fixture.targetId }]);
      expect(await fixture.auditRecords()).toEqual([]);
    });
  });

  test("a consumed confirmation cannot remove another linked method", async () => {
    await withDatabase(async (db) => {
      const fixture = await createFixture(db, 3);
      const unlink = createUnlinker(db);
      const otp = await fixture.issueCode();
      const first = await unlink({
        session: fixture.session,
        body: { accountId: fixture.targetId, otp },
      });
      expect(Result.isOk(first)).toBe(true);
      const nextId =
        fixture.accountIds.at(1) ?? panic("Fixture needs another method");
      const replay = await unlink({
        session: fixture.session,
        body: { accountId: nextId, otp },
      });
      expect(expectRefused(replay).body).toMatchObject({
        message: "Could not confirm sign-in method removal",
      });
      expect(await fixture.remaining()).toHaveLength(2);
    });
  });

  test("another confirmation purpose leaves linked methods unchanged", async () => {
    await withDatabase(async (db) => {
      const fixture = await createFixture(db);
      const otp = await fixture.issueCode("two-factor-manage");
      const result = await createUnlinker(db)({
        session: fixture.session,
        body: { accountId: fixture.targetId, otp },
      });
      expect(expectRefused(result).body).toMatchObject({
        message: "Could not confirm sign-in method removal",
      });
      expect(await fixture.remaining()).toHaveLength(2);
    });
  });

  test("a confirmed request retains another account's linked method", async () => {
    await withDatabase(async (db) => {
      const fixture = await createFixture(db);
      const other = await createFixture(db);
      const result = await createUnlinker(db)({
        session: fixture.session,
        body: { accountId: other.targetId, otp: await fixture.issueCode() },
      });
      expect(expectRefused(result).body).toMatchObject({
        code: "ACCOUNT_NOT_FOUND",
      });
      expect(await fixture.remaining()).toHaveLength(2);
      expect(await other.remaining()).toHaveLength(2);
    });
  });
});
