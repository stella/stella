import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import {
  member,
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
  organization,
  user,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { getAuth } from "@/api/lib/auth";
import {
  CredentialIssuanceFence,
  removeOrganizationMemberWithAuthArtifacts,
  revokeAllUserDurableCredentials,
} from "@/api/lib/auth-artifacts";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  authorizeOAuthClient,
  consentAndExchange,
  grantOAuthClient,
  refreshOAuthGrant,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

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
    const coOwnerId = mintAuthProviderId<"user">();
    await rootDb.insert(user).values({
      id: coOwnerId,
      name: "Reset race co-owner",
      email: `${coOwnerId.toLowerCase()}@example.test`,
    });
    cleanup.push(
      async () => await rootDb.delete(user).where(eq(user.id, coOwnerId)),
    );
    cleanup.push(
      async () =>
        await rootDb.delete(organization).where(eq(organization.id, firm.id)),
    );
    await rootDb.insert(member).values({
      id: mintAuthProviderIdValue(),
      organizationId: firm.id,
      userId: coOwnerId,
      role: "owner",
      createdAt: new Date(),
    });
    await browser.setActiveOrganization(firm.id);
    const client = await registerOAuthClient();
    const organizationId = brandPersistedOrganizationId(firm.id);
    cleanup.push(
      async () =>
        await rootDb
          .delete(oauthClient)
          .where(eq(oauthClient.clientId, client.clientId)),
    );
    return { browser, client, organizationId };
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

    test("a refresh that rotated before a member removal cannot issue its successor", async () => {
      const { browser, client, organizationId } = await fixture();
      const grant = await grantOAuthClient(browser, client);
      const userId = brandPersistedUserId(browser.userId);
      let removed = false;
      context.adapter.incrementOne = async <T>(
        args: Parameters<typeof originalIncrement>[0],
      ) => {
        const rotated = await originalIncrement<T>(args);
        if (args.model === "oauthRefreshToken" && !removed) {
          removed = true;
          // The removal commits between the rotation and the successor's write.
          await rootDb.transaction(async (tx) => {
            const [membership] = await tx
              .select({ id: member.id })
              .from(member)
              .where(
                and(
                  eq(member.userId, userId),
                  eq(member.organizationId, organizationId),
                ),
              );
            await removeOrganizationMemberWithAuthArtifacts(tx, {
              memberId:
                membership?.id ?? panic("The fixture member must exist"),
              organizationId,
              userId,
            });
          });
        }
        return rotated;
      };
      const refreshed = await refreshOAuthGrant({
        client,
        refreshToken: grant.refreshToken,
      });
      expect(removed).toBe(true);
      expect(refreshed.status).toBe(400);
      expect(await refreshed.json()).toMatchObject({ error: "invalid_grant" });
      expect(await countTokenRows(client.clientId)).toEqual({
        refreshTokens: 0,
        accessTokens: 0,
      });
    });

    test("a member removal waits for a held issuance and then deletes its token", async () => {
      const databaseUrl =
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
      const { browser, client, organizationId } = await fixture();
      await grantOAuthClient(browser, client);
      const userId = brandPersistedUserId(browser.userId);
      const [issued] = await rootDb
        .select({
          authorizationCodeId: oauthRefreshToken.authorizationCodeId,
          scopes: oauthRefreshToken.scopes,
        })
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.clientId, client.clientId));
      if (!issued || issued.authorizationCodeId === null) {
        panic("The grant must name its authorization code");
      }
      const grantId = issued.authorizationCodeId;
      const [membership] = await rootDb
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.userId, userId),
            eq(member.organizationId, organizationId),
          ),
        );
      const memberId = membership?.id ?? panic("The fixture member must exist");
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: issueDb } = openClient();
        const { db: removalDb } = openClient();
        const { sql: observer } = openClient();
        const [removalWorker] = await removalDb
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(member)
          .where(eq(member.id, memberId));
        if (!removalWorker) {
          panic("The removal session must exist");
        }
        let removal: Promise<void> | undefined;
        // Issuance holds the fence for an organization-scoped token; the
        // removal must wait for it rather than delete the membership under it.
        await issueDb.transaction(async (tx) => {
          const [issuer] = await tx
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(member)
            .where(eq(member.id, memberId));
          if (!issuer) {
            panic("The issuing session must exist");
          }
          const fence = await CredentialIssuanceFence.holdForGrant(tx, {
            userId,
            sessionId: null,
            grantId,
            organizationId,
          });
          expect(fence).not.toBeNull();
          removal = removalDb.transaction(
            async (removalTx) =>
              await removeOrganizationMemberWithAuthArtifacts(removalTx, {
                memberId,
                organizationId,
                userId,
              }),
          );
          await waitForBlockedPid(observer, {
            waitingPid: removalWorker.pid,
            holdingPid: issuer.pid,
          });
          await tx.insert(oauthRefreshToken).values({
            id: Bun.randomUUIDv7(),
            token: Bun.randomUUIDv7(),
            clientId: client.clientId,
            userId,
            referenceId: organizationId,
            authorizationCodeId: grantId,
            scopes: issued.scopes,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          });
        });
        if (removal === undefined) {
          panic("The racing removal must have started");
        }
        await removal;
      });
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
