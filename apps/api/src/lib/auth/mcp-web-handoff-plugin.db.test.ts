import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { organization as organizationPlugin } from "better-auth/plugins";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { mcpHandoffRedeemResultSchema } from "@stll/api-contract/mcp-web-handoff";

import {
  authSchema,
  account,
  member,
  oauthClient,
  oauthConsent,
  organization,
  session,
  user,
} from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import { requiresHandoffStepUpForAuthPath } from "@/api/lib/auth/handoff-step-up-policy";
import { createMcpWebHandoffPlugin } from "@/api/lib/auth/mcp-web-handoff-plugin";
import { SESSION_LIFETIME_FIELDS } from "@/api/lib/auth/session-lifetime";
import { createWebHandoffService } from "@/api/lib/mcp-web-handoff";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const baseURL = "https://example.test";
const browserOrganizationId = "00000000-0000-4000-8000-000000000014";
const makeDb = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: databaseRelations });
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof makeDb>;
let service: ReturnType<typeof createWebHandoffService>;
let auth: ReturnType<typeof makeAuth>;
let handoffEnabled = true;
const fixture = {
  credentialType: "oauth" as const,
  grantedScopes: [...MCP_OAUTH_SCOPES],
  clientId: "handoff-client",
  consentId: "handoff-consent",
  userId: "00000000-0000-4000-8000-000000000011",
  organizationId: "00000000-0000-4000-8000-000000000012",
};
const makeAuth = () =>
  betterAuth({
    baseURL,
    secret: "handoff-test-secret-long-enough-for-better-auth",
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    advanced: { database: { generateId: () => Bun.randomUUIDv7() } },
    emailAndPassword: { enabled: true },
    session: {
      freshAge: 0,
      cookieCache: { enabled: true },
      additionalFields: {
        ...SESSION_LIFETIME_FIELDS,
        activeOrganizationId: { type: "string", required: false },
      },
    },
    plugins: [
      organizationPlugin(),
      createMcpWebHandoffPlugin({
        service: () => service,
        textSessionMaxSeconds: () => 43_200,
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path && requiresHandoffStepUpForAuthPath(ctx.path)) {
          const current = await getAuthoritativeSessionFromCtx(ctx);
          if (current?.session["originConsentId"]) {
            throw new APIError("FORBIDDEN", {
              code: "step_up_required",
              message: "Sign in again to continue.",
            });
          }
        }
      }),
    },
  });
const authContext = async () => await makeAuth().$context;
beforeAll(async () => {
  client = await createTestPglite();
  db = makeDb(client);
  await db.insert(user).values({
    id: fixture.userId,
    name: "Account",
    email: "handoff@example.test",
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: fixture.organizationId,
    name: "Organization",
    slug: "handoff-plugin",
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: "plugin-member",
    userId: fixture.userId,
    organizationId: fixture.organizationId,
    role: "owner",
    createdAt: new Date(),
  });
  const otherOwnerId = "00000000-0000-4000-8000-000000000015";
  await db.insert(user).values({
    id: otherOwnerId,
    name: "Other owner",
    email: "other-owner@example.test",
    emailVerified: true,
  });
  await db.insert(member).values({
    id: "plugin-other-owner",
    userId: otherOwnerId,
    organizationId: fixture.organizationId,
    role: "owner",
    createdAt: new Date(),
  });
  await db.insert(organization).values({
    id: browserOrganizationId,
    name: "Browser organization",
    slug: "handoff-browser",
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: "browser-member",
    userId: fixture.userId,
    organizationId: browserOrganizationId,
    role: "owner",
    createdAt: new Date(),
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
  const context = await authContext();
  await db.insert(account).values({
    id: "handoff-credential",
    providerId: "credential",
    accountId: fixture.userId,
    userId: fixture.userId,
    password: await context.password.hash("test-fixture-password"),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  service = createWebHandoffService({
    db,
    budget: new InMemoryRateLimitContext(),
    enabled: () => handoffEnabled,
    textEnabled: () => true,
  });
  auth = makeAuth();
});
afterAll(async () => await client.close());
const mint = async (kind: "text" | "click") => {
  const code = await service.mint(fixture, ["/law/example"], kind);
  if (!code) {
    throw new TypeError("Expected handoff fixture");
  }
  return code;
};
const redeem = async (
  code: string,
  confirmation?: "confirmed",
  cookie?: string,
) =>
  await auth.handler(
    new Request(`${baseURL}/api/auth/mcp-handoff/redeem`, {
      method: "POST",
      headers: {
        origin: baseURL,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({
        code,
        path: "/law/example",
        ...(confirmation ? { confirmation } : {}),
      }),
    }),
  );
const cookieOf = (response: Response) =>
  [
    ...new Map(
      response.headers.getSetCookie().map((cookie) => {
        // SAFETY: String.split always returns at least one segment.
        const value = cookie.split(";")[0];
        // Browsers retain the last Set-Cookie value for a given name.
        return [value.slice(0, value.indexOf("=")), value];
      }),
    ).values(),
  ].join("; ");
describe("MCP link sign-in", () => {
  test("the server switch keeps links plain and refuses outstanding handoffs", async () => {
    const code = await mint("click");
    handoffEnabled = false;
    try {
      expect(await service.mint(fixture, ["/law/example"], "click")).toBeNull();
      const response = await redeem(code);
      expect(response.status).toBe(403);
      expect(
        v.parse(mcpHandoffRedeemResultSchema, await response.json()),
      ).toEqual({ status: "refused" });
      expect((await service.inspect(code))?.handoff.consumedAt).toBeNull();
    } finally {
      handoffEnabled = true;
    }
    expect((await redeem(code)).status).toBe(200);
  });
  test("text links request confirmation before creating a session", async () => {
    const code = await mint("text");
    const first = await redeem(code);
    expect(v.parse(mcpHandoffRedeemResultSchema, await first.json())).toEqual({
      status: "needs_confirmation",
      email: "handoff@example.test",
      organizationName: "Organization",
    });
    expect((await service.inspect(code))?.handoff.consumedAt).toBeNull();
    const response = await redeem(code, "confirmed");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(cookieOf(response)).toContain("session_token=");
    const read = await auth.api.getSession({
      headers: { cookie: cookieOf(response) },
    });
    expect(read?.session.activeOrganizationId).toBe(fixture.organizationId);
    expect(read?.session.originConsentId).toBe(fixture.consentId);
    const stored = (
      await db.select().from(session).where(eq(session.id, read!.session.id))
    ).at(0);
    expect(stored?.handoffAbsoluteExpiresAt?.getTime()).toBeGreaterThan(
      Date.now() + 43_190_000,
    );
    expect(stored?.handoffAbsoluteExpiresAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + 43_200_000,
    );
    expect((await redeem(code, "confirmed")).status).toBe(403);
  });
  test("click links create a normal-lifetime session without confirmation", async () => {
    const response = await redeem(await mint("click"));
    expect(response.status).toBe(200);
    const read = await auth.api.getSession({
      headers: { cookie: cookieOf(response) },
    });
    const stored = (
      await db.select().from(session).where(eq(session.id, read!.session.id))
    ).at(0);
    expect(stored?.handoffAbsoluteExpiresAt).toBeNull();
    const sensitive = await auth.handler(
      new Request(`${baseURL}/api/auth/change-password`, {
        method: "POST",
        headers: {
          cookie: cookieOf(response),
          origin: baseURL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "test-fixture-password",
          newPassword: "test-fixture-new-password",
        }),
      }),
    );
    expect(sensitive.status).toBe(403);
    expect(await sensitive.json()).toMatchObject({ code: "step_up_required" });
    const reauthenticated = await auth.api.signInEmail({
      body: {
        email: "handoff@example.test",
        password: "test-fixture-password",
      },
      asResponse: true,
    });
    const normalCookie = cookieOf(reauthenticated);
    expect(
      (await auth.api.getSession({ headers: { cookie: normalCookie } }))
        ?.session.originConsentId,
    ).toBeNull();
    const normal = await auth.handler(
      new Request(`${baseURL}/api/auth/change-password`, {
        method: "POST",
        headers: {
          cookie: normalCookie,
          origin: baseURL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          currentPassword: "test-fixture-password",
          newPassword: "test-fixture-new-password",
        }),
      }),
    );
    expect(normal.status).toBe(200);
    await db
      .update(account)
      .set({
        password: await (
          await auth.$context
        ).password.hash("test-fixture-password"),
      })
      .where(eq(account.id, "handoff-credential"));
  });
  test("a same-account browser switches to the link organization while keeping its session", async () => {
    const signedIn = await auth.api.signInEmail({
      body: {
        email: "handoff@example.test",
        password: "test-fixture-password",
      },
      asResponse: true,
    });
    const switched = await auth.api.setActiveOrganization({
      body: { organizationId: browserOrganizationId },
      headers: { cookie: cookieOf(signedIn) },
      asResponse: true,
    });
    const existingCookie = cookieOf(switched);
    const current = await auth.api.getSession({
      headers: { cookie: existingCookie },
    });
    expect(current).not.toBeNull();
    expect(current?.session.activeOrganizationId).toBe(browserOrganizationId);
    const code = await mint("click");
    const before = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, fixture.userId));
    const response = await redeem(code, undefined, existingCookie);
    expect(response.status).toBe(200);
    expect(cookieOf(response)).toContain("session_token=");
    const retained = await auth.api.getSession({
      headers: { cookie: cookieOf(response) },
    });
    expect(retained?.session.activeOrganizationId).toBe(fixture.organizationId);
    expect(retained?.session.id).toBe(current?.session.id);
    expect(retained?.session.token).toBe(current?.session.token);
    expect(retained?.session.createdAt).toEqual(current?.session.createdAt);
    expect(retained?.session.expiresAt).toEqual(current?.session.expiresAt);
    expect(retained?.session.originConsentId).toBe(
      current?.session.originConsentId,
    );
    expect((await service.inspect(code))?.handoff.consumedSessionId).toBe(
      current?.session.id,
    );
    expect(
      (await auth.api.getSession({ headers: { cookie: existingCookie } }))
        ?.session.id,
    ).toBe(current?.session.id);
    expect(
      await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, fixture.userId)),
    ).toEqual(before);
  });
  test("a removed link-organization membership leaves the browser organization unchanged", async () => {
    const signedIn = await auth.api.signInEmail({
      body: {
        email: "handoff@example.test",
        password: "test-fixture-password",
      },
      asResponse: true,
    });
    const switched = await auth.api.setActiveOrganization({
      body: { organizationId: browserOrganizationId },
      headers: { cookie: cookieOf(signedIn) },
      asResponse: true,
    });
    const existingCookie = cookieOf(switched);
    const current = await auth.api.getSession({
      headers: { cookie: existingCookie },
    });
    expect(current?.session.activeOrganizationId).toBe(browserOrganizationId);
    const code = await mint("click");
    await db.delete(member).where(eq(member.id, "plugin-member"));
    try {
      const response = await redeem(code, undefined, existingCookie);
      expect(response.status).toBe(403);
      expect(
        v.parse(mcpHandoffRedeemResultSchema, await response.json()),
      ).toEqual({
        status: "refused",
      });
      const retained = await auth.api.getSession({
        headers: { cookie: existingCookie },
      });
      expect(retained?.session.activeOrganizationId).toBe(
        browserOrganizationId,
      );
      expect(retained?.session.id).toBe(current?.session.id);
    } finally {
      await db.insert(member).values({
        id: "plugin-member",
        userId: fixture.userId,
        organizationId: fixture.organizationId,
        role: "owner",
        createdAt: new Date(),
      });
    }
  });
  test("a different account is confirmed before its browser session changes", async () => {
    const otherUserId = "00000000-0000-4000-8000-000000000013";
    await db.insert(user).values({
      id: otherUserId,
      email: "another@example.test",
      name: "Other account",
      emailVerified: true,
    });
    await db.insert(member).values({
      id: "other-member",
      userId: otherUserId,
      organizationId: fixture.organizationId,
      role: "member",
      createdAt: new Date(),
    });
    await db.insert(oauthConsent).values({
      id: "other-consent",
      clientId: fixture.clientId,
      userId: otherUserId,
      referenceId: fixture.organizationId,
      scopes: [...MCP_OAUTH_SCOPES],
    });
    const signedIn = await auth.api.signInEmail({
      body: {
        email: "handoff@example.test",
        password: "test-fixture-password",
      },
      asResponse: true,
    });
    const existingCookie = cookieOf(signedIn);
    const code = await service.mint(
      { ...fixture, userId: otherUserId, consentId: "other-consent" },
      ["/law/example"],
      "click",
    );
    if (!code) {
      throw new TypeError("Expected other-account handoff");
    }
    const response = await redeem(code, undefined, existingCookie);
    expect(
      v.parse(mcpHandoffRedeemResultSchema, await response.json()).status,
    ).toBe("needs_confirmation");
    expect((await service.inspect(code))?.handoff.consumedAt).toBeNull();
    expect(
      (await auth.api.getSession({ headers: { cookie: existingCookie } }))?.user
        .email,
    ).toBe("handoff@example.test");
  });
});
