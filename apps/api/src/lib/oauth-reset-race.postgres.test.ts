import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import {
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
  organization,
  user,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { getAuth } from "@/api/lib/auth";
import { revokeAllUserDurableCredentials } from "@/api/lib/auth-artifacts";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  authorizeOAuthClient,
  consentAndExchange,
  grantOAuthClient,
  refreshOAuthGrant,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
// timeout: each case signs in, registers a client and completes a grant first
setDefaultTimeout(120_000);

if (!runPostgres || !process.env["DATABASE_URL"]) {
  describe.skip("OAuth token issuance racing an access reset (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  const auth = getAuth();
  const context = await auth.$context;
  const originalIncrement = context.adapter.incrementOne;
  const originalCreate = context.adapter.create;

  const cleanup: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const remove of cleanup.toReversed()) {
      await remove();
    }
  });
  afterEach(() => {
    context.adapter.incrementOne = originalIncrement;
    context.adapter.create = originalCreate;
  });

  const fixture = async () => {
    const browser = await signInHuman(
      `reset-race-${Bun.randomUUIDv7()}@example.test`,
    );
    cleanup.push(
      async () => await rootDb.delete(user).where(eq(user.id, browser.userId)),
    );
    const firm = await auth.api.createOrganization({
      body: { name: "Reset race", slug: `reset-race-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    cleanup.push(
      async () =>
        await rootDb.delete(organization).where(eq(organization.id, firm.id)),
    );
    await browser.setActiveOrganization(firm.id);
    const client = await registerOAuthClient();
    cleanup.push(
      async () =>
        await rootDb
          .delete(oauthClient)
          .where(eq(oauthClient.clientId, client.clientId)),
    );
    return { browser, client };
  };

  const resetAccess = async (userId: string) =>
    await rootDb.transaction(
      async (tx) =>
        await revokeAllUserDurableCredentials(tx, brandPersistedUserId(userId)),
    );

  const countTokenRows = async (clientId: string) => ({
    refreshTokens: await rootDb.$count(
      oauthRefreshToken,
      eq(oauthRefreshToken.clientId, clientId),
    ),
    accessTokens: await rootDb.$count(
      oauthAccessToken,
      eq(oauthAccessToken.clientId, clientId),
    ),
  });

  describe("OAuth token issuance racing an access reset (postgres)", () => {
    test("a refresh outliving its browser session still rotates", async () => {
      const { browser, client } = await fixture();
      const grant = await grantOAuthClient(browser, client);
      // Signing out ends the session the grant was approved in; the grant's
      // own earlier token keeps authorizing its refreshes.
      await auth.api.signOut({ headers: browser.headers() });
      const refreshed = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      expect(refreshed.status).toBe(200);
    });

    test("a refresh that rotated before a reset cannot issue its successor", async () => {
      const { browser, client } = await fixture();
      const grant = await grantOAuthClient(browser, client);
      await auth.api.signOut({ headers: browser.headers() });
      let reset = false;
      context.adapter.incrementOne = async <T>(
        args: Parameters<typeof originalIncrement>[0],
      ) => {
        const rotated = await originalIncrement<T>(args);
        if (args.model === "oauthRefreshToken" && !reset) {
          reset = true;
          // The reset commits between the rotation and the successor's write.
          await resetAccess(browser.userId);
        }
        return rotated;
      };
      const refreshed = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      expect(reset).toBe(true);
      expect(refreshed.status).toBe(400);
      expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
      expect(await countTokenRows(client.clientId)).toEqual({
        refreshTokens: 0,
        accessTokens: 0,
      });
    });

    test("a code exchanged across a reset issues no token", async () => {
      const { browser, client } = await fixture();
      const { codeVerifier, redirect } = await authorizeOAuthClient(
        browser,
        client,
      );
      let reset = false;
      context.adapter.create = async (args) => {
        if (
          (args.model === "oauthRefreshToken" ||
            args.model === "oauthAccessToken") &&
          !reset
        ) {
          reset = true;
          // The reset commits after the code is redeemed, before any token.
          await resetAccess(browser.userId);
        }
        return await originalCreate(args);
      };
      const exchanged = await consentAndExchange({
        browser,
        client,
        codeVerifier,
        consentPage: redirect,
      }).then(
        () => panic("A code exchanged across a reset must not issue tokens"),
        (error: unknown) => error,
      );
      expect(reset).toBe(true);
      expect(String(exchanged)).toContain("OAuth step failed with 400");
      expect(await countTokenRows(client.clientId)).toEqual({
        refreshTokens: 0,
        accessTokens: 0,
      });
    });
  });
}
