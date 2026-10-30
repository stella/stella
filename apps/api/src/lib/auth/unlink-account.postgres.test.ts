import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { account, session, user, verification } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { accountAuditLogs } from "@/api/db/schema";
import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { createSignedSessionCookieValue } from "@/api/lib/auth/signed-session-cookie";
import { createConfirmedAccountUnlinker } from "@/api/lib/auth/unlink-account";
import {
  createConfirmationOtp,
  verifyConfirmationOtp,
} from "@/api/lib/confirmation-otp";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PURPOSE = "unlink-account";
const CONFIRMATION_MILESTONE_TIMEOUT_MS = 10_000;
const unlinkAccountWithConfirmation = createConfirmedAccountUnlinker({
  database: rootDb,
  verifyConfirmation: verifyConfirmationOtp,
});

const expectRefused = (
  result: Awaited<ReturnType<typeof unlinkAccountWithConfirmation>>,
  status: "BAD_REQUEST" | "UNAUTHORIZED" = "BAD_REQUEST",
) => {
  if (Result.isOk(result)) {
    panic("The sign-in method removal should be refused");
  }
  expect(result.error.status).toBe(status);
};

const createFixture = async (db: GatedTestDb, methodCount = 2) => {
  const id = mintAuthProviderIdValue();
  const email = `${id}@sign-in.test`;
  const accountIds = Array.from({ length: methodCount }, () =>
    mintAuthProviderIdValue(),
  );
  await db.insert(user).values({ id, name: "Jana Nováková", email });
  await db.insert(account).values(
    accountIds.map((accountId, index) => ({
      id: accountId,
      accountId,
      providerId: index === 0 ? "google" : "microsoft",
      userId: id,
    })),
  );
  return {
    id,
    email,
    session: { user: { id, email } },
    accountIds,
    targetId: accountIds.at(0) ?? panic("Fixture needs a sign-in method"),
    browserHeaders: async () => {
      const token = mintAuthProviderIdValue();
      const now = new Date();
      await db.insert(session).values({
        id: mintAuthProviderIdValue(),
        userId: id,
        token,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
      });
      const context = await getAuth().$context;
      const value = createSignedSessionCookieValue(token, context.secret);
      return {
        cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(value)}`,
        origin: new URL(getAuthEndpointUrl("unlink-account")).origin,
        "content-type": "application/json",
      };
    },
    issueCode: async () => {
      const result = await createConfirmationOtp({ purpose: PURPOSE, email });
      if (Result.isError(result)) {
        throw result.error;
      }
      return result.value;
    },
    remaining: async () =>
      await db
        .select({ id: account.id })
        .from(account)
        .where(eq(account.userId, id)),
    cleanUp: async () => {
      await db
        .delete(verification)
        .where(
          inArray(verification.identifier, [
            `${PURPOSE}:${email}`,
            `two-factor-manage:${email}`,
          ]),
        );
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.user_id', ${id}, true)`);
        const retainedAudit = await tx.$count(
          accountAuditLogs,
          sql`${accountAuditLogs.userId} = ${id}`,
        );
        if (retainedAudit === 0) {
          await tx.delete(user).where(eq(user.id, id));
          return;
        }
        // Account audit history retains its user reference after removal.
        await tx.delete(account).where(eq(account.userId, id));
        await tx
          .update(user)
          .set({
            name: "Removed account",
            email: `${id}@removed.sign-in.test`,
            deletedAt: new Date(),
          })
          .where(eq(user.id, id));
      });
    },
  };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("confirmed sign-in method removal (postgres)", () => {
    test("requires the PostgreSQL suite", () => {});
  });
} else {
  describe("confirmed sign-in method removal (postgres)", () => {
    test("lists the signed-in account's linked providers", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db);
        const other = await createFixture(db);
        try {
          const response = await getAuth().handler(
            new Request(getAuthEndpointUrl("list-accounts"), {
              headers: await fixture.browserHeaders(),
            }),
          );
          expect(response.status).toBe(200);
          const listed = await response.json();
          expect(listed).toHaveLength(2);
          expect(listed).toEqual(
            expect.arrayContaining(
              fixture.accountIds.map((id, index) =>
                expect.objectContaining({
                  id,
                  providerId: index === 0 ? "google" : "microsoft",
                }),
              ),
            ),
          );
        } finally {
          await other.cleanUp();
          await fixture.cleanUp();
        }
      });
    });

    test("the send endpoint issues an unlink-scoped code for the signed-in account", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db);
        try {
          const response = await getAuth().handler(
            new Request(getAuthEndpointUrl("sign-in-methods/send-otp"), {
              method: "POST",
              headers: await fixture.browserHeaders(),
            }),
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ success: true });
          const issued = await db
            .select({ value: verification.value })
            .from(verification)
            .where(eq(verification.identifier, `${PURPOSE}:${fixture.email}`));
          expect(issued).toHaveLength(1);
          expect(issued.at(0)?.value).toMatch(/^\d{6}$/u);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("the unlink endpoint requires confirmation before removing a linked method", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db);
        try {
          const headers = await fixture.browserHeaders();
          const missing = await getAuth().handler(
            new Request(getAuthEndpointUrl("unlink-account"), {
              method: "POST",
              headers,
              body: JSON.stringify({
                accountId: fixture.targetId,
                providerId: "google",
              }),
            }),
          );
          expect(missing.status).toBe(400);
          expect(await fixture.remaining()).toHaveLength(2);
          const confirmed = await getAuth().handler(
            new Request(getAuthEndpointUrl("unlink-account"), {
              method: "POST",
              headers,
              body: JSON.stringify({
                accountId: fixture.targetId,
                providerId: "google",
                otp: await fixture.issueCode(),
              }),
            }),
          );
          expect(confirmed.status).toBe(200);
          expect(await confirmed.json()).toMatchObject({ status: true });
          expect(await fixture.remaining()).toEqual(
            fixture.accountIds.slice(1).map((id) => ({ id })),
          );
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("removes the selected method and consumes its confirmation", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db);
        try {
          const otp = await fixture.issueCode();
          const result = await unlinkAccountWithConfirmation({
            session: fixture.session,
            body: { accountId: fixture.targetId, otp },
          });
          expect(Result.isOk(result)).toBe(true);
          expect(await fixture.remaining()).toEqual(
            fixture.accountIds.slice(1).map((id) => ({ id })),
          );
          expect(
            await db.$count(
              verification,
              eq(verification.identifier, `${PURPOSE}:${fixture.email}`),
            ),
          ).toBe(0);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("retains the last linked account after a confirmed request", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db, 1);
        try {
          const result = await unlinkAccountWithConfirmation({
            session: fixture.session,
            body: {
              accountId: fixture.targetId,
              otp: await fixture.issueCode(),
            },
          });
          expectRefused(result);
          expect(await fixture.remaining()).toEqual([{ id: fixture.targetId }]);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test.each([
      { name: "missing", code: undefined },
      { name: "empty", code: "" },
      { name: "short", code: "12345" },
      { name: "nonnumeric", code: "abcdef" },
      { name: "unissued", code: "123456" },
    ])("retains methods with a $name confirmation", async ({ code }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db);
        try {
          const result = await unlinkAccountWithConfirmation({
            session: fixture.session,
            body: { accountId: fixture.targetId, otp: code },
          });
          expectRefused(result);
          expect(await fixture.remaining()).toHaveLength(2);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test.each(["incorrect", "expired", "different purpose"] as const)(
      "retains methods with an %s confirmation",
      async (kind) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const fixture = await createFixture(db);
          try {
            const issuedOtp = await fixture.issueCode();
            let otp = issuedOtp;
            switch (kind) {
              case "incorrect":
                otp = otp === "123456" ? "654321" : "123456";
                break;
              case "expired":
                await db
                  .update(verification)
                  .set({ expiresAt: new Date(0) })
                  .where(
                    eq(verification.identifier, `${PURPOSE}:${fixture.email}`),
                  );
                break;
              case "different purpose": {
                await db
                  .delete(verification)
                  .where(
                    eq(verification.identifier, `${PURPOSE}:${fixture.email}`),
                  );
                const issued = await createConfirmationOtp({
                  purpose: "two-factor-manage",
                  email: fixture.email,
                });
                if (Result.isError(issued)) {
                  throw issued.error;
                }
                otp = issued.value;
                break;
              }
              default:
                panic("Unknown confirmation fixture", kind satisfies never);
            }
            const result = await unlinkAccountWithConfirmation({
              session: fixture.session,
              body: { accountId: fixture.targetId, otp },
            });
            expectRefused(result);
            expect(await fixture.remaining()).toHaveLength(2);
            if (kind !== "different purpose") {
              const replay = await unlinkAccountWithConfirmation({
                session: fixture.session,
                body: { accountId: fixture.targetId, otp: issuedOtp },
              });
              expectRefused(replay);
              expect(await fixture.remaining()).toHaveLength(2);
              expect(
                await db.$count(
                  verification,
                  eq(verification.identifier, `${PURPOSE}:${fixture.email}`),
                ),
              ).toBe(0);
            }
          } finally {
            await fixture.cleanUp();
          }
        });
      },
    );

    test("requires a new confirmation for the next method", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db, 3);
        try {
          const otp = await fixture.issueCode();
          const first = await unlinkAccountWithConfirmation({
            session: fixture.session,
            body: { accountId: fixture.targetId, otp },
          });
          expect(Result.isOk(first)).toBe(true);
          const nextId =
            fixture.accountIds.at(1) ?? panic("Fixture needs another method");
          const second = await unlinkAccountWithConfirmation({
            session: fixture.session,
            body: { accountId: nextId, otp },
          });
          expectRefused(second);
          expect(await fixture.remaining()).toHaveLength(2);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("retains another account's method after a confirmed request", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db);
        const other = await createFixture(db);
        try {
          const result = await unlinkAccountWithConfirmation({
            session: fixture.session,
            body: { accountId: other.targetId, otp: await fixture.issueCode() },
          });
          expectRefused(result);
          expect(await fixture.remaining()).toHaveLength(2);
          expect(await other.remaining()).toHaveLength(2);
        } finally {
          await other.cleanUp();
          await fixture.cleanUp();
        }
      });
    });

    test("requires a signed-in account", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await createFixture(db);
        try {
          const result = await unlinkAccountWithConfirmation({
            session: null,
            body: {
              accountId: fixture.targetId,
              otp: await fixture.issueCode(),
            },
          });
          expectRefused(result, "UNAUTHORIZED");
          expect(await fixture.remaining()).toHaveLength(2);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("concurrent confirmed requests retain one linked account", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holder = openClient();
        const { db } = openClient();
        const fixture = await createFixture(db);
        const held = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const firstOtp = await fixture.issueCode();
        const firstConfirmed = Promise.withResolvers<undefined>();
        const secondConfirmed = Promise.withResolvers<undefined>();
        let secondOtp: string | undefined;
        const unlink = createConfirmedAccountUnlinker({
          database: rootDb,
          verifyConfirmation: async (params) => {
            const result = await verifyConfirmationOtp(params);
            if (Result.isOk(result)) {
              if (params.code === firstOtp) {
                firstConfirmed.resolve(undefined);
              } else if (params.code === secondOtp) {
                secondConfirmed.resolve(undefined);
              } else {
                panic("Unexpected confirmation code in concurrent removal");
              }
            }
            return result;
          },
        });
        const lock = holder.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM "user" WHERE id = ${fixture.id} FOR UPDATE`,
          );
          held.resolve(undefined);
          await release.promise;
        });
        const requests: ReturnType<typeof unlinkAccountWithConfirmation>[] = [];
        try {
          await withTimeout(async () => await held.promise, {
            label: "account unlink fixture row lock",
            timeoutMs: CONFIRMATION_MILESTONE_TIMEOUT_MS,
          });
          requests.push(
            unlink({
              session: fixture.session,
              body: { accountId: fixture.targetId, otp: firstOtp },
            }),
          );
          await withTimeout(async () => await firstConfirmed.promise, {
            label: "first account unlink confirmation",
            timeoutMs: CONFIRMATION_MILESTONE_TIMEOUT_MS,
          });
          // The first code is consumed before its transaction waits on the user.
          expect(
            await db.$count(
              verification,
              eq(verification.identifier, `${PURPOSE}:${fixture.email}`),
            ),
          ).toBe(0);
          secondOtp = firstOtp === "123456" ? "654321" : "123456";
          await db.insert(verification).values({
            id: mintAuthProviderIdValue(),
            identifier: `${PURPOSE}:${fixture.email}`,
            value: secondOtp,
            expiresAt: new Date(Date.now() + 300_000),
          });
          requests.push(
            unlink({
              session: fixture.session,
              body: { accountId: fixture.accountIds.at(1), otp: secondOtp },
            }),
          );
          await withTimeout(async () => await secondConfirmed.promise, {
            label: "second account unlink confirmation",
            timeoutMs: CONFIRMATION_MILESTONE_TIMEOUT_MS,
          });
          expect(
            await db.$count(
              verification,
              eq(verification.identifier, `${PURPOSE}:${fixture.email}`),
            ),
          ).toBe(0);
          release.resolve(undefined);
          await lock;
          const results = await Promise.all(requests);
          expect(results.filter((result) => Result.isOk(result))).toHaveLength(
            1,
          );
          expect(
            results.filter((result) => Result.isError(result)),
          ).toHaveLength(1);
          for (const result of results) {
            if (Result.isError(result)) {
              expectRefused(result);
              expect(result.error.body?.code).toBe(
                "FAILED_TO_UNLINK_LAST_ACCOUNT",
              );
            }
          }
          expect(await fixture.remaining()).toHaveLength(1);
        } finally {
          release.resolve(undefined);
          await lock;
          await Promise.all(requests);
          await fixture.cleanUp();
        }
      });
    });
  });
}
