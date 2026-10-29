import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract/mcp";
import { sha256Hex } from "@stll/sha256/bun";

import {
  member,
  oauthClient,
  oauthConsent,
  organization,
  session,
  user,
} from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import { mcpWebHandoff } from "@/api/db/schema/mcp-web-handoff";
import { envApiServerSchema } from "@/api/env-schema";
import { revokeUserSessionById } from "@/api/lib/auth-artifacts";
import {
  createWebHandoffService,
  WEB_HANDOFF_TTL_MS,
  WebHandoffOperationError,
} from "@/api/lib/auth/mcp-web-handoff";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { MCP_RATE_LIMITS } from "@/api/lib/rate-limit/budget-config";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof makeDb>;
const makeDb = (databaseClient: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client: databaseClient, relations: databaseRelations });
let instant = new Date("2026-01-01T00:00:00Z");
const request = new Request("https://example.test/mcp");
const fixture = {
  credentialType: "oauth" as const,
  grantedScopes: [...MCP_OAUTH_SCOPES],
  clientId: "handoff-client",
  consentId: "handoff-consent",
  userId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  request,
};
let service: ReturnType<typeof createWebHandoffService>;
beforeAll(async () => {
  client = await createTestPglite();
  db = makeDb(client);
  await db.insert(user).values({
    id: fixture.userId,
    name: "Account",
    email: "handoff@example.test",
  });
  await db.insert(organization).values({
    id: fixture.organizationId,
    name: "Organization",
    slug: "handoff",
    createdAt: instant,
  });
  await db.insert(member).values({
    id: "membership",
    userId: fixture.userId,
    organizationId: fixture.organizationId,
    role: "owner",
    createdAt: instant,
  });
  await db.insert(oauthClient).values({
    id: fixture.clientId,
    clientId: fixture.clientId,
    name: "Connected app",
    redirectUris: [],
  });
  await db.insert(oauthConsent).values({
    id: fixture.consentId,
    clientId: fixture.clientId,
    userId: fixture.userId,
    referenceId: fixture.organizationId,
    scopes: [...MCP_OAUTH_SCOPES],
  });
  service = createWebHandoffService({
    db,
    budget: new InMemoryRateLimitContext(),
    now: () => instant,
    enabled: () => true,
    textEnabled: () => true,
  });
});
afterAll(async () => await client.close());
const consume = async (code: string, path = "/matters/example") =>
  await service.consume({
    code,
    path,
    request,
    ipAddress: null,
    complete: async () => Result.ok(null),
    previousOrganizationId: null,
  });
const mint = async (kind: "text" | "click" = "text") => {
  const code = await service.mint(
    fixture,
    ["/matters/example", "/law/example"],
    kind,
  );
  expect(code).toMatch(/^sh1_[A-Za-z0-9_-]{43}$/u);
  if (!code) {
    throw new TypeError("Expected handoff fixture");
  }
  return code;
};
describe("MCP web handoff lifecycle", () => {
  test("one receipt contains canonical destinations and the kind lifetime", async () => {
    for (const kind of ["text", "click"] as const) {
      const code = await mint(kind);
      const grant = await service.inspect(code);
      expect(grant?.handoff.allowedPaths).toEqual([
        "/matters/example",
        "/law/example",
      ]);
      expect(grant?.handoff.expiresAt.getTime()).toBe(
        instant.getTime() + WEB_HANDOFF_TTL_MS[kind],
      );
      expect(grant?.handoff.codeHash).not.toContain(code);
    }
  });
  test("a receipt is consumed once and only for one of its destinations", async () => {
    const code = await mint();
    expect(await consume(code, "/matters/another")).toBeNull();
    expect(await consume(code)).not.toBeNull();
    expect(await consume(code)).toBeNull();
  });
  test("an expired receipt cannot be consumed", async () => {
    const code = await mint("click");
    instant = new Date(instant.getTime() + WEB_HANDOFF_TTL_MS.click);
    expect(await consume(code)).toBeNull();
  });
  test("API key credentials and read-only consent produce plain links", async () => {
    expect(
      await service.mint(
        { ...fixture, credentialType: "api-key" },
        ["/law/example"],
        "text",
      ),
    ).toBeNull();
    const code = await mint();
    await db
      .update(oauthConsent)
      .set({ scopes: ["stella:read"] })
      .where(eq(oauthConsent.id, fixture.consentId));
    expect(await service.mint(fixture, ["/law/example"], "text")).toBeNull();
    expect(await consume(code)).toBeNull();
    await db
      .update(oauthConsent)
      .set({ scopes: [...MCP_OAUTH_SCOPES] })
      .where(eq(oauthConsent.id, fixture.consentId));
  });
  test("read-only credentials keep plain links when consent permits more operations", async () => {
    expect(
      await service.mint(
        { ...fixture, grantedScopes: ["stella:read"] },
        ["/law/example"],
        "text",
      ),
    ).toBeNull();
    expect(
      await service.mint(
        {
          ...fixture,
          grantedScopes: MCP_DEFAULT_RESOURCE_SCOPES.filter(
            (scope) => scope !== "stella:documents_write",
          ),
        },
        ["/law/example"],
        "click",
      ),
    ).toBeNull();
  });
  test("an incomplete consent keeps plain links and additional permissions are allowed", async () => {
    await db
      .update(oauthConsent)
      .set({
        scopes: MCP_DEFAULT_RESOURCE_SCOPES.filter(
          (scope) => scope !== "stella:documents_write",
        ),
      })
      .where(eq(oauthConsent.id, fixture.consentId));
    expect(await service.mint(fixture, ["/law/example"], "text")).toBeNull();
    await db
      .update(oauthConsent)
      .set({ scopes: [...MCP_DEFAULT_RESOURCE_SCOPES] })
      .where(eq(oauthConsent.id, fixture.consentId));
    expect(
      await service.mint(fixture, ["/law/example"], "text"),
    ).not.toBeNull();
    await db
      .update(oauthConsent)
      .set({ scopes: [...MCP_OAUTH_SCOPES] })
      .where(eq(oauthConsent.id, fixture.consentId));
    expect(
      await service.mint(fixture, ["/law/example"], "text"),
    ).not.toBeNull();
  });
  test("issuance uses the latest matching consent", async () => {
    const latestId = Bun.randomUUIDv7();
    await db.insert(oauthConsent).values({
      id: latestId,
      clientId: fixture.clientId,
      userId: fixture.userId,
      referenceId: fixture.organizationId,
      scopes: [...MCP_OAUTH_SCOPES],
      updatedAt: new Date(Date.now() + 60_000),
    });
    try {
      const code = await mint("click");
      expect((await service.inspect(code))?.handoff.consentId).toBe(latestId);
    } finally {
      await db.delete(oauthConsent).where(eq(oauthConsent.id, latestId));
    }
  });
  test("disabled issuance keeps connected-app links plain", async () => {
    const disabled = createWebHandoffService({
      db,
      budget: new InMemoryRateLimitContext(),
      now: () => instant,
      enabled: () => false,
      textEnabled: () => true,
    });
    for (const kind of ["text", "click"] as const) {
      expect(await disabled.mint(fixture, ["/law/example"], kind)).toBeNull();
    }
  });
  test("text links require independent opt-in when minting is enabled", async () => {
    const config = v.parse(
      v.object({
        MCP_WEB_HANDOFF_MINT_ENABLED:
          envApiServerSchema.MCP_WEB_HANDOFF_MINT_ENABLED,
        MCP_WEB_HANDOFF_TEXT_ENABLED:
          envApiServerSchema.MCP_WEB_HANDOFF_TEXT_ENABLED,
      }),
      { MCP_WEB_HANDOFF_MINT_ENABLED: "true" },
    );
    expect(config.MCP_WEB_HANDOFF_MINT_ENABLED).toBe(true);
    expect(config.MCP_WEB_HANDOFF_TEXT_ENABLED).toBe("0");
    const defaultService = createWebHandoffService({
      db,
      budget: new InMemoryRateLimitContext(),
      now: () => instant,
      enabled: () => config.MCP_WEB_HANDOFF_MINT_ENABLED,
      textEnabled: () => config.MCP_WEB_HANDOFF_TEXT_ENABLED === "1",
    });
    expect(
      await defaultService.mint(fixture, ["/law/example"], "text"),
    ).toBeNull();
    expect(
      await defaultService.mint(fixture, ["/law/example"], "click"),
    ).not.toBeNull();
  });
  test("text codes can be disabled without changing click links", async () => {
    const disabled = createWebHandoffService({
      db,
      budget: new InMemoryRateLimitContext(),
      now: () => instant,
      enabled: () => true,
      textEnabled: () => false,
    });
    expect(await disabled.mint(fixture, ["/law/example"], "text")).toBeNull();
    expect(
      await disabled.mint(fixture, ["/law/example"], "click"),
    ).not.toBeNull();
  });
  test("mint budget bounds receipt issuance", async () => {
    const limited = createWebHandoffService({
      db,
      budget: {
        increment: async () => ({
          count: 1_000_001,
          nextReset: instant,
          start: instant.getTime(),
        }),
        complete: async () => {},
      },
      now: () => instant,
      enabled: () => true,
      textEnabled: () => true,
    });
    expect(await limited.mint(fixture, ["/law/example"], "text")).toBeNull();
  });
  test("address-budget refusals leave the shared redemption count unchanged", async () => {
    const budget = new InMemoryRateLimitContext();
    const limited = createWebHandoffService({
      db,
      budget,
      enabled: () => true,
      textEnabled: () => true,
    });
    const blockedAddress = "192.0.2.1";
    const addressKey = `mcp-web-handoff:${sha256Hex(`redeem:address:${blockedAddress}`)}`;
    const globalKey = `mcp-web-handoff:${sha256Hex("redeem:global")}`;
    try {
      for (
        let index = 0;
        index < MCP_RATE_LIMITS.handoffRedeemAddress.max;
        index += 1
      ) {
        budget.increment(
          addressKey,
          MCP_RATE_LIMITS.handoffRedeemAddress.windowMs,
        );
      }
      expect(await limited.admitRedeem("192.0.2.2")).toBe(true);
      expect(budget.read(globalKey)?.count).toBe(1);
      for (let index = 0; index < 3; index += 1) {
        expect(await limited.admitRedeem(blockedAddress)).toBe(false);
        expect(budget.read(globalKey)?.count).toBe(1);
      }
    } finally {
      budget.kill();
    }
  });
  test("an absolute session deadline remains authoritative after refresh", async () => {
    const token = "handoff-session-token";
    const deadline = new Date(instant.getTime() + 12 * 60 * 60 * 1000);
    await db.insert(session).values({
      id: "handoff-session",
      token,
      userId: fixture.userId,
      originConsentId: fixture.consentId,
      handoffAbsoluteExpiresAt: deadline,
      lastSeenAt: instant,
      expiresAt: deadline,
      updatedAt: instant,
    });
    const store = createDatabaseSessionLifetimeStore(db, {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    });
    const before = new Date(deadline.getTime() - 1);
    await db
      .update(session)
      .set({ lastSeenAt: before })
      .where(eq(session.token, token));
    const refreshed = await store.refresh({
      token,
      now: before,
      expiresAt: new Date(deadline.getTime() + 7 * 24 * 60 * 60 * 1000),
      credentialMode: "cookie",
    });
    expect(refreshed?.expiresAt).toEqual(deadline);
    expect(
      (
        await db.select().from(session).where(eq(session.id, "handoff-session"))
      ).at(0)?.expiresAt,
    ).toEqual(deadline);
    expect(
      await store.observe({ token, now: deadline, boundary: "activity" }),
    ).toBeNull();
  });
  test("handoff sessions enforce their idle limit independently of rollout policies", async () => {
    const idleAt = new Date(instant.getTime() - 60 * 60 * 1000);
    await db.insert(session).values({
      id: "idle-handoff-session",
      token: "idle-handoff-token",
      userId: fixture.userId,
      originConsentId: fixture.consentId,
      lastSeenAt: idleAt,
      expiresAt: new Date(instant.getTime() + 24 * 60 * 60 * 1000),
      updatedAt: idleAt,
    });
    const store = createDatabaseSessionLifetimeStore(db, {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    });
    expect(
      await store.observe({
        token: "idle-handoff-token",
        now: instant,
        boundary: "activity",
      }),
    ).toBeNull();
  });
  test("session labels refuse an incomplete read instead of truncating it", async () => {
    const consentId = Bun.randomUUIDv7();
    const expiresAt = new Date(instant.getTime() + 60_000);
    const sessions = Array.from({ length: 101 }, () => {
      const id = Bun.randomUUIDv7();
      return {
        id,
        token: id,
        userId: fixture.userId,
        originConsentId: consentId,
        expiresAt,
        updatedAt: instant,
      };
    });
    await db.insert(oauthConsent).values({
      id: consentId,
      clientId: fixture.clientId,
      userId: fixture.userId,
      referenceId: fixture.organizationId,
      scopes: [...MCP_OAUTH_SCOPES],
    });
    try {
      await db.insert(session).values(sessions);
      const result = await service.listSessionClients(
        brandPersistedUserId(fixture.userId),
      );
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBeInstanceOf(WebHandoffOperationError);
        expect(result.error.operation).toBe("list_session_clients");
        expect(result.error.cause).toEqual({ cap: 100 });
      }
    } finally {
      await Promise.all(
        sessions.map(
          async ({ id }) =>
            await revokeUserSessionById(db, {
              sessionId: id,
              userId: brandPersistedUserId(fixture.userId),
            }),
        ),
      );
      await db.delete(oauthConsent).where(eq(oauthConsent.id, consentId));
    }
  });
  test("session client listing reports tagged database failures", async () => {
    const failedClient = await createTestPglite();
    const failedService = createWebHandoffService({
      db: makeDb(failedClient),
      budget: new InMemoryRateLimitContext(),
      now: () => instant,
      enabled: () => true,
      textEnabled: () => true,
    });
    await failedClient.close();

    const result = await failedService.listSessionClients(
      brandPersistedUserId(fixture.userId),
    );
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(WebHandoffOperationError);
      expect(result.error.operation).toBe("list_session_clients");
      expect(result.error.message).toBe(
        "Active handoff sessions could not be listed.",
      );
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });
  test("disconnect removes receipts and the sessions created from them", async () => {
    const code = await mint();
    await db.delete(oauthConsent).where(eq(oauthConsent.id, fixture.consentId));
    expect(await consume(code)).toBeNull();
    expect(
      await db
        .select()
        .from(mcpWebHandoff)
        .where(eq(mcpWebHandoff.consentId, fixture.consentId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(session)
        .where(
          and(
            eq(session.userId, fixture.userId),
            eq(session.originConsentId, fixture.consentId),
          ),
        ),
    ).toEqual([]);
  });
});
