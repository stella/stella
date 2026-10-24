import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";

import {
  apikey,
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
  session,
  user,
} from "@/api/db/auth-schema";
import {
  revokeAllUserApiKeys,
  revokeAllUserDurableCredentials,
  revokeAllUserOAuthTokens,
  revokeAllUserSessions,
} from "@/api/lib/auth-artifacts";
import { toSafeId } from "@/api/lib/branded-types";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

/**
 * Account deletion soft-deletes the user row, so the `user` cascades on
 * `session` and the OAuth token tables never fire. The account-wide helpers
 * have to end every one of the leaving user's credentials, in every
 * organization and for every client, while leaving other users' rows alone.
 */

const LEAVER = "user-account-wide-leaver";
const OTHER = "user-account-wide-other";
const CLIENT = "client-account-wide";
const ORG_A = "org-account-wide-a";
const ORG_B = "org-account-wide-b";
const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60 * 1000);

let testDb: TestDatabase;

const seedSessions = async (): Promise<void> => {
  await testDb.transaction(async (tx) => {
    await revokeAllUserSessions(tx, toSafeId<"user">(LEAVER));
    await revokeAllUserSessions(tx, toSafeId<"user">(OTHER));
  });
  const sessionRow = (id: string, userId: string, org: string | null) => ({
    activeOrganizationId: org,
    expiresAt: IN_AN_HOUR(),
    id,
    token: `token-${id}`,
    updatedAt: new Date(),
    userId,
  });
  await testDb
    .insert(session)
    .values([
      sessionRow("session-leaver-a", LEAVER, ORG_A),
      sessionRow("session-leaver-b", LEAVER, ORG_B),
      sessionRow("session-leaver-none", LEAVER, null),
      sessionRow("session-other-a", OTHER, ORG_A),
    ]);
};

const seedTokens = async (): Promise<void> => {
  await testDb.transaction(async (tx) => {
    await revokeAllUserOAuthTokens(tx, toSafeId<"user">(LEAVER));
    await revokeAllUserOAuthTokens(tx, toSafeId<"user">(OTHER));
  });
  const tokenRow = (
    id: string,
    userId: string,
    referenceId: string | null,
  ) => ({
    clientId: CLIENT,
    expiresAt: IN_AN_HOUR(),
    id,
    referenceId,
    scopes: ["openid"],
    token: `token-${id}`,
    userId,
  });
  await testDb
    .insert(oauthRefreshToken)
    .values([
      tokenRow("refresh-leaver-a", LEAVER, ORG_A),
      tokenRow("refresh-leaver-none", LEAVER, null),
      tokenRow("refresh-other-a", OTHER, ORG_A),
    ]);
  await testDb
    .insert(oauthAccessToken)
    .values([
      tokenRow("access-leaver-a", LEAVER, ORG_A),
      tokenRow("access-leaver-b", LEAVER, ORG_B),
      tokenRow("access-other-a", OTHER, ORG_A),
    ]);
};

const seedApiKeys = async (): Promise<void> => {
  await testDb.delete(apikey).where(eq(apikey.referenceId, LEAVER));
  await testDb.delete(apikey).where(eq(apikey.referenceId, OTHER));
  await testDb.insert(apikey).values([
    {
      configId: "machine",
      id: "key-leaver-a",
      key: "digest-key-leaver-a",
      metadata: JSON.stringify({ organizationId: ORG_A }),
      referenceId: LEAVER,
    },
    {
      configId: "desktop",
      id: "key-leaver-b",
      key: "digest-key-leaver-b",
      metadata: JSON.stringify({ organizationId: ORG_B }),
      referenceId: LEAVER,
    },
    {
      configId: "machine",
      id: "key-other-a",
      key: "digest-key-other-a",
      metadata: JSON.stringify({ organizationId: ORG_A }),
      referenceId: OTHER,
    },
  ]);
};

const sessionIdsOf = async (userId: string): Promise<string[]> =>
  (
    await testDb
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, userId))
  )
    .map(({ id }) => id)
    .toSorted();

const tokenIdsOf = async (userId: string): Promise<string[]> => {
  const access = await testDb
    .select({ id: oauthAccessToken.id })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.userId, userId));
  const refresh = await testDb
    .select({ id: oauthRefreshToken.id })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, userId));
  return [...access, ...refresh].map(({ id }) => id).toSorted();
};

const apiKeysOf = async (userId: string) =>
  await testDb
    .select({ enabled: apikey.enabled, id: apikey.id })
    .from(apikey)
    .where(eq(apikey.referenceId, userId))
    .then((rows) =>
      rows.toSorted((left, right) => compareCodeUnit(left.id, right.id)),
    );

beforeAll(async () => {
  testDb = await getTestDb();

  await testDb
    .insert(user)
    .values([
      { email: `${LEAVER}@example.test`, id: LEAVER, name: "Leaver" },
      { email: `${OTHER}@example.test`, id: OTHER, name: "Other" },
    ])
    .onConflictDoNothing();
  await testDb
    .insert(oauthClient)
    .values({ clientId: CLIENT, id: CLIENT, redirectUris: [] })
    .onConflictDoNothing();
});

afterAll(async () => {
  await releaseTestDb();
});

describe("account-wide auth revocation", () => {
  test("ends every session the user holds, in any organization or none", async () => {
    await seedSessions();

    await testDb.transaction(
      async (tx) => await revokeAllUserSessions(tx, toSafeId<"user">(LEAVER)),
    );

    expect(await sessionIdsOf(LEAVER)).toEqual([]);
    expect(await sessionIdsOf(OTHER)).toEqual(["session-other-a"]);
  });

  test("revokes every access and refresh token the user holds", async () => {
    await seedTokens();

    await testDb.transaction(
      async (tx) =>
        await revokeAllUserOAuthTokens(tx, toSafeId<"user">(LEAVER)),
    );

    expect(await tokenIdsOf(LEAVER)).toEqual([]);
    expect(await tokenIdsOf(OTHER)).toEqual([
      "access-other-a",
      "refresh-other-a",
    ]);
  });

  test("disables every API key the user holds across organizations and configurations", async () => {
    await seedApiKeys();

    await testDb.transaction(
      async (tx) => await revokeAllUserApiKeys(tx, toSafeId<"user">(LEAVER)),
    );

    expect(await apiKeysOf(LEAVER)).toEqual([
      { enabled: false, id: "key-leaver-a" },
      { enabled: false, id: "key-leaver-b" },
    ]);
    expect(await apiKeysOf(OTHER)).toEqual([
      { enabled: true, id: "key-other-a" },
    ]);
  });

  test("access recovery revokes every session and durable credential owned by the user", async () => {
    await seedSessions();
    await seedApiKeys();
    await seedTokens();

    await testDb.transaction(
      async (tx) =>
        await revokeAllUserDurableCredentials(tx, toSafeId<"user">(LEAVER)),
    );

    expect(await apiKeysOf(LEAVER)).toEqual([
      { enabled: false, id: "key-leaver-a" },
      { enabled: false, id: "key-leaver-b" },
    ]);
    expect(await tokenIdsOf(LEAVER)).toEqual([]);
    expect(await sessionIdsOf(LEAVER)).toEqual([]);
    expect(await sessionIdsOf(OTHER)).toEqual(["session-other-a"]);
    expect(await apiKeysOf(OTHER)).toEqual([
      { enabled: true, id: "key-other-a" },
    ]);
    expect(await tokenIdsOf(OTHER)).toEqual([
      "access-other-a",
      "refresh-other-a",
    ]);
  });
});
