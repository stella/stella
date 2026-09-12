import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { count, eq } from "drizzle-orm";

import { account, session } from "@/api/db/auth-schema";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

const HISTORICAL_CREDENTIAL_ISSUER = "local:credential";

let database: TestDatabase;

beforeAll(async () => {
  database = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

test("credential sign-in resolves rows with historical and null issuers", async () => {
  const suffix = Bun.randomUUIDv7();
  const email = `auth-account-key-${suffix}@example.invalid`;
  const password = "a sufficiently long test password";
  const baseURL = "http://better-auth-account-key.test";
  const auth = betterAuth({
    baseURL,
    database: drizzleAdapter(database, AUTH_DATABASE_ADAPTER_OPTIONS),
    emailAndPassword: {
      autoSignIn: false,
      enabled: true,
      requireEmailVerification: false,
    },
    plugins: [bearer()],
    rateLimit: { enabled: false },
    secret: `test-secret-${suffix}`,
    trustedOrigins: [baseURL],
  });

  const signUpResponse = await auth.api.signUpEmail({
    body: {
      email,
      name: "Account key compatibility",
      password,
    },
  });
  const userId = signUpResponse.user.id;
  const [createdAccount] = await database
    .select()
    .from(account)
    .where(eq(account.userId, userId));
  if (!createdAccount) {
    throw new TypeError("Expected Better Auth to create a credential account");
  }
  expect(createdAccount.providerId).toBe("credential");
  expect(createdAccount.issuer).toBeNull();

  await database
    .update(account)
    .set({ issuer: HISTORICAL_CREDENTIAL_ISSUER })
    .where(eq(account.id, createdAccount.id));

  const historicalSignIn = await auth.api.signInEmail({
    body: { email, password },
  });
  expect(historicalSignIn.user.id).toBe(userId);
  if (!historicalSignIn.token) {
    throw new TypeError(
      "Expected historical sign-in to create a session token",
    );
  }
  const historicalSession = await auth.api.getSession({
    headers: new Headers({
      authorization: `Bearer ${historicalSignIn.token}`,
    }),
  });
  expect(historicalSession?.user.id).toBe(userId);

  const sessionsAfterHistoricalSignIn = await database
    .select({ count: count() })
    .from(session)
    .where(eq(session.userId, userId));
  expect(sessionsAfterHistoricalSignIn.at(0)?.count).toBe(1);

  await database
    .update(account)
    .set({ issuer: null })
    .where(eq(account.id, createdAccount.id));

  const historicalSessionAfterIssuerChange = await auth.api.getSession({
    headers: new Headers({
      authorization: `Bearer ${historicalSignIn.token}`,
    }),
  });
  expect(historicalSessionAfterIssuerChange?.user.id).toBe(userId);

  const nullIssuerSignIn = await auth.api.signInEmail({
    body: { email, password },
  });
  expect(nullIssuerSignIn.user.id).toBe(userId);
  if (!nullIssuerSignIn.token) {
    throw new TypeError(
      "Expected null-issuer sign-in to create a session token",
    );
  }
  const nullIssuerSession = await auth.api.getSession({
    headers: new Headers({
      authorization: `Bearer ${nullIssuerSignIn.token}`,
    }),
  });
  expect(nullIssuerSession?.user.id).toBe(userId);

  const [preservedAccount] = await database
    .select()
    .from(account)
    .where(eq(account.userId, userId));
  expect(preservedAccount?.id).toBe(createdAccount.id);
  expect(preservedAccount?.issuer).toBeNull();
  const sessionsAfterNullIssuerSignIn = await database
    .select({ count: count() })
    .from(session)
    .where(eq(session.userId, userId));
  expect(sessionsAfterNullIssuerSignIn.at(0)?.count).toBe(2);
});
