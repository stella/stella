import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import * as v from "valibot";

import {
  oauthAccessToken,
  oauthClient,
  oauthRefreshToken,
  oauthResource,
  organization,
  user,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { getAuth } from "@/api/lib/auth";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  grantOAuthClient,
  isOAuthTokenActive,
  refreshOAuthGrant,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

const CLIENT_AUTH_METHODS = ["client_secret_post", "none"] as const;

const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const tokenSchema = v.looseObject({
  access_token: v.string(),
  refresh_token: v.string(),
  scope: v.string(),
  token_type: v.string(),
  expires_at: v.number(),
  expires_in: v.number(),
});
type OAuthTokens = v.InferOutput<typeof tokenSchema>;

const expectReplayedTokens = (replayed: OAuthTokens, original: OAuthTokens) => {
  expect(replayed.access_token).toBe(original.access_token);
  expect(replayed.refresh_token).toBe(original.refresh_token);
  expect(replayed.scope).toBe(original.scope);
  expect(replayed.token_type).toBe(original.token_type);
  expect(replayed.expires_at).toBe(original.expires_at);
  expect(replayed.expires_in).toBeGreaterThanOrEqual(0);
  expect(replayed.expires_in).toBeLessThanOrEqual(original.expires_in);
};
setDefaultTimeout(120_000);

if (!runPostgres || !process.env["DATABASE_URL"]) {
  describe.skip("OAuth refresh reuse window (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  const auth = getAuth();
  const context = await auth.$context;
  const provider =
    context.getPlugin("oauth-provider") ?? panic("OAuth provider required");
  const originalIncrement = context.adapter.incrementOne;

  const cleanup: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const remove of cleanup.toReversed()) {
      await remove();
    }
  });
  beforeAll(async () => {
    expect(provider.version).toBe("1.7.6");
    expect(provider.options.refreshTokenReuseInterval).toBe(30);
    await rootDb
      .insert(oauthResource)
      .values(
        getBetterAuthOAuthResources().map((resource) => ({
          id: Bun.randomUUIDv7(),
          ...resource,
        })),
      )
      .onConflictDoNothing();
  });
  afterEach(() => {
    context.adapter.incrementOne = originalIncrement;
  });

  const fixture = async (
    tokenEndpointAuthMethod:
      | "client_secret_post"
      | "none" = "client_secret_post",
  ) => {
    const browser = await signInHuman(
      `rotation-${Bun.randomUUIDv7()}@example.test`,
    );
    cleanup.push(
      async () => await rootDb.delete(user).where(eq(user.id, browser.userId)),
    );
    const firm = await auth.api.createOrganization({
      body: { name: "Rotation", slug: `rotation-${Bun.randomUUIDv7()}` },
      headers: browser.headers(),
    });
    cleanup.push(
      async () =>
        await rootDb.delete(organization).where(eq(organization.id, firm.id)),
    );
    await browser.setActiveOrganization(firm.id);
    const client = await registerOAuthClient(
      undefined,
      tokenEndpointAuthMethod,
    );
    cleanup.push(
      async () =>
        await rootDb
          .delete(oauthClient)
          .where(eq(oauthClient.clientId, client.clientId)),
    );
    const grant = await grantOAuthClient(browser, client);
    return { browser, client, grant };
  };

  const countRefreshRows = async (clientId: string) =>
    await rootDb.$count(
      oauthRefreshToken,
      eq(oauthRefreshToken.clientId, clientId),
    );

  const countTokenRows = async (clientId: string) => {
    const [refreshTokens, accessTokens] = await Promise.all([
      countRefreshRows(clientId),
      rootDb.$count(oauthAccessToken, eq(oauthAccessToken.clientId, clientId)),
    ]);
    return { refreshTokens, accessTokens };
  };

  describe("OAuth refresh reuse window (postgres)", () => {
    test.each(CLIENT_AUTH_METHODS)(
      "reuses a discarded %s rotation response without minting tokens and preserves its successor",
      async (method) => {
        const { client, grant } = await fixture(method);
        expect(await countRefreshRows(client.clientId)).toBe(1);
        const discarded = await refreshOAuthGrant({
          client,
          refreshToken: grant.refreshToken,
        });
        expect(discarded.status).toBe(200);
        expect(await countRefreshRows(client.clientId)).toBe(2);
        // Observe a copy for assertions; the retry uses only the original grant.
        const firstRotation = v.parse(
          tokenSchema,
          await discarded.clone().json(),
        );
        const rowsBeforeReplay = await countTokenRows(client.clientId);
        const retry = await refreshOAuthGrant({
          client,
          refreshToken: grant.refreshToken,
        });
        expect(retry.status).toBe(200);
        const tokens = v.parse(tokenSchema, await retry.json());
        expectReplayedTokens(tokens, firstRotation);
        expect(tokens.refresh_token).not.toBe(grant.refreshToken);
        expect(await countTokenRows(client.clientId)).toEqual(rowsBeforeReplay);
        expect(await countRefreshRows(client.clientId)).toBe(2);
        // Public clients cannot authenticate introspection; redemption below
        // proves that their replayed successor remains live.
        if (method === "client_secret_post") {
          expect(
            await isOAuthTokenActive({
              client,
              token: tokens.refresh_token,
              tokenTypeHint: "refresh_token",
            }),
          ).toBe(true);
        }
        expect(
          (
            await refreshOAuthGrant({
              client,
              refreshToken: tokens.refresh_token,
            })
          ).status,
        ).toBe(200);
        expect(await countRefreshRows(client.clientId)).toBe(3);
      },
    );
    test.each(CLIENT_AUTH_METHODS)(
      "rejects a %s retry after the reuse window and ends the refresh family",
      async (method) => {
        const { client, grant } = await fixture(method);
        const rotation = await refreshOAuthGrant({
          client,
          refreshToken: grant.refreshToken,
        });
        expect(rotation.status).toBe(200);
        const successor = v.parse(tokenSchema, await rotation.json());
        expect(await countRefreshRows(client.clientId)).toBe(2);
        const expired = await rootDb
          .update(oauthRefreshToken)
          .set({ rotationReplayExpiresAt: new Date(Date.now() - 1000) })
          .where(
            and(
              eq(oauthRefreshToken.clientId, client.clientId),
              isNotNull(oauthRefreshToken.rotatedAt),
            ),
          )
          .returning({ id: oauthRefreshToken.id });
        expect(expired).toHaveLength(1);
        const retry = await refreshOAuthGrant({
          client,
          refreshToken: grant.refreshToken,
        });
        expect(retry.status).toBe(400);
        expect(await retry.json()).toMatchObject({ error: "invalid_grant" });
        expect(await countTokenRows(client.clientId)).toEqual({
          refreshTokens: 0,
          accessTokens: 0,
        });
        const successorRetry = await refreshOAuthGrant({
          client,
          refreshToken: successor.refresh_token,
        });
        expect(successorRetry.status).toBe(400);
        expect(await successorRetry.json()).toMatchObject({
          error: "invalid_grant",
        });
      },
    );
    // Both requests read the unrotated row before the conditional update.
    test.each(CLIENT_AUTH_METHODS)(
      "rejects the losing concurrent update and preserves the winning %s rotation",
      async (method) => {
        const { client, grant } = await fixture(method);
        expect(await countRefreshRows(client.clientId)).toBe(1);
        let arrived = 0;
        let release = () => {};
        const bothArrived = new Promise<void>((resolve) => {
          release = resolve;
        });
        context.adapter.incrementOne = async (args) => {
          if (args.model === "oauthRefreshToken") {
            arrived += 1;
            if (arrived === 2) {
              release();
            }
            await bothArrived;
          }
          return await originalIncrement(args);
        };
        const responses = await Promise.all([
          refreshOAuthGrant({ client, refreshToken: grant.refreshToken }),
          refreshOAuthGrant({ client, refreshToken: grant.refreshToken }),
        ]);
        context.adapter.incrementOne = originalIncrement;
        expect(arrived).toBe(2);
        expect(await countRefreshRows(client.clientId)).toBe(2);
        const statuses = responses
          .map(({ status }) => status)
          .toSorted((left, right) => left - right);
        const accepted =
          responses.find(({ status }) => status === 200) ??
          panic("One rotation must succeed");
        const tokens = v.parse(tokenSchema, await accepted.json());
        // Public clients cannot authenticate introspection; redeem the winner
        // and its successor to prove both remain live after the losing request.
        if (method === "client_secret_post") {
          expect(
            await isOAuthTokenActive({
              client,
              token: tokens.refresh_token,
              tokenTypeHint: "refresh_token",
            }),
          ).toBe(true);
        }
        expect(statuses).toEqual([200, 400]);
        const rejected =
          responses.find(({ status }) => status === 400) ??
          panic("One rotation must be rejected");
        expect(await rejected.json()).toMatchObject({ error: "invalid_grant" });
        const nextRotation = await refreshOAuthGrant({
          client,
          refreshToken: tokens.refresh_token,
        });
        expect(nextRotation.status).toBe(200);
        const nextTokens = v.parse(tokenSchema, await nextRotation.json());
        expect(await countRefreshRows(client.clientId)).toBe(3);
        if (method === "client_secret_post") {
          expect(
            await isOAuthTokenActive({
              client,
              token: nextTokens.refresh_token,
              tokenTypeHint: "refresh_token",
            }),
          ).toBe(true);
        } else {
          const thirdRotation = await refreshOAuthGrant({
            client,
            refreshToken: nextTokens.refresh_token,
          });
          expect(thirdRotation.status).toBe(200);
          const thirdTokens = v.parse(tokenSchema, await thirdRotation.json());
          expect(thirdTokens.refresh_token).not.toBe(nextTokens.refresh_token);
          expect(await countRefreshRows(client.clientId)).toBe(4);
        }
      },
    );
  });
}
