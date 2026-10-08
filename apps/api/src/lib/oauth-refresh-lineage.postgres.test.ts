import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
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
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  oauthClient,
  oauthRefreshToken,
  oauthResource,
  organization,
  user,
} from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { getAuth } from "@/api/lib/auth";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { handleMcpHttpRequest } from "@/api/mcp/server";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  authorizeOAuthClient,
  exchangeOAuthCode,
  grantOAuthClient,
  isOAuthTokenActive,
  refreshOAuthGrant,
  registerOAuthClient,
} from "@/api/tests/helpers/oauth-grant";

const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const tokenSchema = v.looseObject({
  access_token: v.string(),
  refresh_token: v.string(),
});
setDefaultTimeout(120_000);

if (!runPostgres || !process.env["DATABASE_URL"]) {
  describe.skip("OAuth refresh lineage (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {});
  });
} else {
  const auth = getAuth();
  const context = await auth.$context;
  const provider =
    context.getPlugin("oauth-provider") ?? panic("OAuth provider required");
  const originalInterval = provider.options.refreshTokenReuseInterval;
  const originalIncrement = context.adapter.incrementOne;

  const cleanup: (() => Promise<unknown>)[] = [];
  afterAll(async () => {
    for (const remove of cleanup.toReversed()) {
      await remove();
    }
  });
  beforeAll(async () => {
    expect(provider.version).toBe("1.7.6");
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
    provider.options.refreshTokenReuseInterval = originalInterval;
    context.adapter.incrementOne = originalIncrement;
  });

  const fixture = async (reuseInterval: number) => {
    provider.options.refreshTokenReuseInterval = reuseInterval;
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
    const client = await registerOAuthClient();
    cleanup.push(
      async () =>
        await rootDb
          .delete(oauthClient)
          .where(eq(oauthClient.clientId, client.clientId)),
    );
    const grant = await grantOAuthClient(browser, client);
    return { browser, client, grant };
  };

  const expectAccessWorks = async (accessToken: string) => {
    const response = await handleMcpHttpRequest(
      new Request(getMcpResourceUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "list_matters",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "list_matters",
            arguments: {},
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
              [CLIENT_INFO_META_KEY]: {
                name: "rotation-test",
                version: "1.0.0",
              },
              [CLIENT_CAPABILITIES_META_KEY]: {},
            },
          },
        }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { structuredContent: { matters: [] } },
    });
  };

  const countRefreshRows = async (clientId: string) =>
    await rootDb.$count(
      oauthRefreshToken,
      eq(oauthRefreshToken.clientId, clientId),
    );

  for (const interval of [0, 30]) {
    describe(`OAuth refresh lineage with ${String(interval)} seconds reuse (postgres)`, () => {
      test(
        interval === 0
          ? "rejects a discarded-response retry and removes the refresh rows"
          : "reuses a discarded rotation response within the interval",
        async () => {
          const { client, grant } = await fixture(interval);
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
          // Target: a retry receives the same response at a positive reuse interval.
          const retry = await refreshOAuthGrant({
            client,
            refreshToken: grant.refreshToken,
          });
          expect(retry.status).toBe(interval === 0 ? 400 : 200);
          if (interval === 0) {
            expect(await retry.json()).toMatchObject({
              error: "invalid_grant",
            });
            expect(await countRefreshRows(client.clientId)).toBe(0);
            expect(
              (
                await refreshOAuthGrant({
                  client,
                  refreshToken: firstRotation.refresh_token,
                })
              ).status,
            ).toBe(400);
            expect(await countRefreshRows(client.clientId)).toBe(0);
            return;
          }
          const tokens = v.parse(tokenSchema, await retry.json());
          expect(tokens.access_token === firstRotation.access_token).toBe(true);
          expect(tokens.refresh_token === firstRotation.refresh_token).toBe(
            true,
          );
          expect(await countRefreshRows(client.clientId)).toBe(2);
          expect(
            await isOAuthTokenActive({
              client,
              token: tokens.refresh_token,
              tokenTypeHint: "refresh_token",
            }),
          ).toBe(true);
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

      // Characterization: the pinned provider rejects the losing update even
      // with a reuse interval. Both requests read the unrotated row first.
      test("rejects the losing concurrent update and preserves the winning rotation", async () => {
        const { client, grant } = await fixture(interval);
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
        const statuses = responses.map(({ status }) => status).toSorted();
        const accepted =
          responses.find(({ status }) => status === 200) ??
          panic("One rotation must succeed");
        const tokens = v.parse(tokenSchema, await accepted.json());
        expect(
          await isOAuthTokenActive({
            client,
            token: tokens.refresh_token,
            tokenTypeHint: "refresh_token",
          }),
        ).toBe(true);
        // Target at 30 seconds: [200, 200]; current pinned behavior rejects one request.
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
        expect(
          await isOAuthTokenActive({
            client,
            token: nextTokens.refresh_token,
            tokenTypeHint: "refresh_token",
          }),
        ).toBe(true);
        expect(await countRefreshRows(client.clientId)).toBe(3);
      });

      // Characterization: independent authorization should remain usable.
      test("removes both authorizations on replay outside the reuse interval", async () => {
        const { browser, client, grant: loginA } = await fixture(interval);
        const authorizationB = await authorizeOAuthClient(browser, client);
        const loginB = await exchangeOAuthCode({
          client,
          codeVerifier: authorizationB.codeVerifier,
          redirect: authorizationB.redirect,
        });
        const rows = await rootDb
          .select()
          .from(oauthRefreshToken)
          .where(
            and(
              eq(oauthRefreshToken.clientId, client.clientId),
              eq(oauthRefreshToken.userId, browser.userId),
            ),
          );
        expect(rows.length).toBe(2);
        expect(
          new Set(rows.map(({ authorizationCodeId }) => authorizationCodeId))
            .size,
        ).toBe(2);
        expect(
          rows.every(({ authorizationCodeId }) => authorizationCodeId !== null),
        ).toBe(true);
        await expectAccessWorks(loginB.accessToken);
        const rotation = await refreshOAuthGrant({
          client,
          refreshToken: loginA.refreshToken,
        });
        expect(rotation.status).toBe(200);
        const successorA = v.parse(tokenSchema, await rotation.json());
        expect(await countRefreshRows(client.clientId)).toBe(3);
        // Expire only the replay window, without waiting on wall-clock time.
        await rootDb
          .update(oauthRefreshToken)
          .set({ rotationReplayExpiresAt: new Date(0) })
          .where(
            and(
              eq(oauthRefreshToken.clientId, client.clientId),
              eq(oauthRefreshToken.userId, browser.userId),
            ),
          );
        const replay = await refreshOAuthGrant({
          client,
          refreshToken: loginA.refreshToken,
        });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
        expect(await countRefreshRows(client.clientId)).toBe(0);
        expect(
          await isOAuthTokenActive({
            client,
            token: successorA.refresh_token,
            tokenTypeHint: "refresh_token",
          }),
        ).toBe(false);
        expect(
          await isOAuthTokenActive({
            client,
            token: loginB.accessToken,
            tokenTypeHint: "access_token",
          }),
        ).toBe(true);
        await expectAccessWorks(loginB.accessToken);
        const refreshB = await refreshOAuthGrant({
          client,
          refreshToken: loginB.refreshToken,
        });
        // Target: 200 with a usable successor access token.
        expect(refreshB.status).toBe(400);
        expect(await refreshB.json()).toMatchObject({ error: "invalid_grant" });
        expect(
          (
            await refreshOAuthGrant({
              client,
              refreshToken: successorA.refresh_token,
            })
          ).status,
        ).toBe(400);
        expect(await countRefreshRows(client.clientId)).toBe(0);
      });
    });
  }
}
