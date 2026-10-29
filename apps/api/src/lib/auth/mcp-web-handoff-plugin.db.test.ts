import type { GoogleProfile } from "@better-auth/core/social-providers";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import {
  emailOTP,
  organization as organizationPlugin,
} from "better-auth/plugins";
import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { mcpHandoffRedeemResultSchema } from "@stll/api-contract/mcp-web-handoff";
import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex } from "@stll/sha256/bun";

import {
  account,
  authSchema,
  member,
  oauthClient,
  oauthConsent,
  organization,
  session,
  user,
} from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import { auditLogs } from "@/api/db/schema";
import {
  MCP_WEB_HANDOFF_KINDS,
  mcpWebHandoff,
} from "@/api/db/schema/mcp-web-handoff";
import { AUDIT_ACTION } from "@/api/lib/audit-log.constants";
import { requiresHandoffStepUpForAuthPath } from "@/api/lib/auth/handoff-step-up-policy";
import { createWebHandoffService } from "@/api/lib/auth/mcp-web-handoff";
import { createMcpWebHandoffPlugin } from "@/api/lib/auth/mcp-web-handoff-plugin";
import {
  createSessionLifetime,
  SESSION_LIFETIME_FIELDS,
} from "@/api/lib/auth/session-lifetime";
import { createDatabaseSessionLifetimeStore } from "@/api/lib/auth/session-lifetime-store";
import { toSafeId } from "@/api/lib/branded-types";
import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import {
  queryCountLogger,
  runWithQueryCounter,
} from "@/api/lib/db-query-counter";
import { MCP_RATE_LIMITS } from "@/api/lib/rate-limit/budget-config";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { MCP_OAUTH_SCOPES } from "@/api/mcp/constants";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const baseURL = "https://example.test";
setDefaultTimeout(120_000);
const browserOrganizationId = "00000000-0000-4000-8000-000000000014";
const makeDb = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: databaseRelations, logger: queryCountLogger });
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof makeDb>;
let service: ReturnType<typeof createWebHandoffService>;
let auth: ReturnType<typeof makeAuth>;
let handoffEnabled = true;
let handoffTextEnabled = true;
const deliveredEmailOtps: string[] = [];
const readDeliveredEmailOtp = () => deliveredEmailOtps.at(-1);
const fixture = {
  credentialType: "oauth" as const,
  grantedScopes: [...MCP_OAUTH_SCOPES],
  clientId: "handoff-client",
  consentId: "handoff-consent",
  userId: "00000000-0000-4000-8000-000000000011",
  organizationId: toSafeId<"organization">(
    "00000000-0000-4000-8000-000000000012",
  ),
};
const makeAuth = (
  handoffService = service,
  socialProviders?: BetterAuthOptions["socialProviders"],
) =>
  betterAuth({
    baseURL,
    secret: "handoff-test-secret-long-enough-for-better-auth",
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    advanced: { database: { generateId: () => Bun.randomUUIDv7() } },
    emailAndPassword: { enabled: true },
    ...(socialProviders ? { socialProviders } : {}),
    session: {
      freshAge: 0,
      cookieCache: { enabled: true },
      additionalFields: {
        ...SESSION_LIFETIME_FIELDS,
        activeOrganizationId: { type: "string", required: false },
      },
    },
    plugins: [
      createSessionLifetime({
        store: createDatabaseSessionLifetimeStore(db, {
          expiresIn: 7 * 24 * 60 * 60,
          updateAge: 24 * 60 * 60,
        }),
      }).plugin,
      organizationPlugin(),
      emailOTP({
        disableSignUp: true,
        generateOTP: () => "314159",
        sendVerificationOTP: async ({ otp }) => {
          deliveredEmailOtps.push(otp);
        },
      }),
      createMcpWebHandoffPlugin({
        service: () => handoffService,
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
  await recordNewOrganizationAccessState(db, {
    organizationId: fixture.organizationId,
    now: new Date(),
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
  await recordNewOrganizationAccessState(db, {
    organizationId: toSafeId<"organization">(browserOrganizationId),
    now: new Date(),
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
    textEnabled: () => handoffTextEnabled,
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
type RedeemOptions = {
  confirmation?: "confirmed";
  cookie?: string;
  address?: string;
};
const redeem = async (
  code: string,
  { confirmation, cookie, address }: RedeemOptions = {},
) =>
  await auth.handler(
    new Request(`${baseURL}/api/auth/mcp-handoff/redeem`, {
      method: "POST",
      headers: {
        origin: baseURL,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(address ? { [AUTH_CLIENT_ADDRESS_HEADER]: address } : {}),
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
        const value = cookie.slice(
          0,
          !cookie.includes(";") ? cookie.length : cookie.indexOf(";"),
        );
        // Browsers retain the last Set-Cookie value for a given name.
        return [value.slice(0, value.indexOf("=")), value];
      }),
    ).values(),
  ].join("; ");
const mergeCookies = (...cookieHeaders: string[]) => {
  const cookies = new Map<string, string>();
  for (const cookie of cookieHeaders.flatMap((header) => header.split("; "))) {
    const name = cookie.split("=").at(0);
    if (name) {
      cookies.set(name, cookie);
    }
  }
  return [...cookies.values()].join("; ");
};
describe("MCP link sign-in", () => {
  test("redemption needs a trusted browser origin and preserves an unused link", async () => {
    const code = await mint("click");
    for (const origin of [undefined, "https://foreign.example.test"]) {
      const response = await auth.handler(
        new Request(`${baseURL}/api/auth/mcp-handoff/redeem`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(origin === undefined ? {} : { origin }),
          },
          body: JSON.stringify({ code, path: "/law/example" }),
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ status: "refused" });
      expect(response.headers.getSetCookie()).toEqual([]);
      const receipt = (
        await db
          .select({ consumedAt: mcpWebHandoff.consumedAt })
          .from(mcpWebHandoff)
          .where(eq(mcpWebHandoff.codeHash, sha256Hex(code)))
      ).at(0);
      expect(receipt).toEqual({ consumedAt: null });
    }
    const trusted = await redeem(code, { confirmation: "confirmed" });
    expect(trusted.status).toBe(200);
    expect(await trusted.json()).toEqual({ status: "redeemed" });
    expect(trusted.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  test("a rejected request performs no database work or audit write", async () => {
    const budget = new InMemoryRateLimitContext();
    const limited = createWebHandoffService({
      db,
      budget,
      enabled: () => true,
      textEnabled: () => true,
    });
    try {
      const code = await limited.mint(fixture, ["/law/example"], "click");
      expect(code).not.toBeNull();
      const address = "192.0.2.3";
      const key = `mcp-web-handoff:${sha256Hex(`redeem:address:${address}`)}`;
      for (
        let attempt = 0;
        attempt < MCP_RATE_LIMITS.handoffRedeemAddress.max;
        attempt += 1
      ) {
        budget.increment(key, MCP_RATE_LIMITS.handoffRedeemAddress.windowMs);
      }
      const limitedAuth = makeAuth(limited);
      await limitedAuth.$context;
      const before = await db.$count(auditLogs);
      await runWithQueryCounter(async (counter) => {
        const response = await limitedAuth.handler(
          new Request(`${baseURL}/api/auth/mcp-handoff/redeem`, {
            method: "POST",
            headers: {
              origin: baseURL,
              "content-type": "application/json",
              [AUTH_CLIENT_ADDRESS_HEADER]: address,
            },
            body: JSON.stringify({ code, path: "/law/example" }),
          }),
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ status: "refused" });
        expect(counter.count).toBe(0);
      });
      expect(await db.$count(auditLogs)).toBe(before);
    } finally {
      budget.kill();
    }
  });
  test("a link remains available after an incomplete sign-in and completes once", async () => {
    const retryAuth = makeAuth();
    const context = await retryAuth.$context;
    const createSession = context.internalAdapter.createSession;
    let creation = "unavailable";
    context.internalAdapter.createSession = async (...args) => {
      const created = await createSession(...args);
      if (creation === "unavailable") {
        throw new TypeError("Session creation unavailable");
      }
      return created;
    };
    const code = await mint("click");
    const request = () =>
      new Request(`${baseURL}/api/auth/mcp-handoff/redeem`, {
        method: "POST",
        headers: { origin: baseURL, "content-type": "application/json" },
        body: JSON.stringify({
          code,
          path: "/law/example",
          confirmation: "confirmed",
        }),
      });
    const before = await db.$count(session);
    const incomplete = await retryAuth.handler(request());
    expect(incomplete.status).toBe(403);
    expect(cookieOf(incomplete)).toBe("");
    expect(await db.$count(session)).toBe(before);
    expect((await service.inspect(code))?.handoff.consumedAt).toBeNull();
    creation = "available";
    const completed = await retryAuth.handler(request());
    expect(completed.status).toBe(200);
    expect(cookieOf(completed)).toContain("session_token=");
    expect(await db.$count(session)).toBe(before + 1);
    expect(
      (await service.inspect(code))?.handoff.consumedSessionId,
    ).not.toBeNull();
    expect((await retryAuth.handler(request())).status).toBe(403);
    expect(await db.$count(session)).toBe(before + 1);
  });
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
    expect((await redeem(code, { confirmation: "confirmed" })).status).toBe(
      200,
    );
  });
  test("turning off text links refuses an outstanding text link", async () => {
    const code = await mint("text");
    handoffTextEnabled = false;
    try {
      expect(await service.inspect(code)).toBeNull();
      const response = await redeem(code, { confirmation: "confirmed" });
      expect(
        v.parse(mcpHandoffRedeemResultSchema, await response.json()).status,
      ).toBe("refused");
      expect(
        await service.consume({
          code,
          path: "/law/example",
          request: new Request(`${baseURL}/mcp-handoff/redeem`),
          ipAddress: null,
          previousOrganizationId: null,
          complete: async () => Result.ok(null),
        }),
      ).toBeNull();
    } finally {
      handoffTextEnabled = true;
    }
    expect((await redeem(code, { confirmation: "confirmed" })).status).toBe(
      200,
    );
  });
  test("text links request confirmation before creating a session", async () => {
    const code = await mint("text");
    const first = await redeem(code);
    expect(v.parse(mcpHandoffRedeemResultSchema, await first.json())).toEqual({
      status: "needs_confirmation",
      email: "handoff@example.test",
      organizationName: "Organization",
    });
    const receipt = await service.inspect(code);
    expect(receipt?.handoff.consumedAt).toBeNull();
    expect(
      await db.$count(
        auditLogs,
        and(
          eq(auditLogs.resourceId, receipt!.handoff.id),
          eq(auditLogs.action, AUDIT_ACTION.MCP_WEB_HANDOFF_CONFIRMATION_SHOWN),
        ),
      ),
    ).toBe(1);
    const response = await redeem(code, { confirmation: "confirmed" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(cookieOf(response)).toContain("session_token=");
    const read = await auth.api.getSession({
      headers: { cookie: cookieOf(response) },
    });
    expect(read?.session.activeOrganizationId).toBe(fixture.organizationId);
    expect(read?.session.originConsentId).toBe(fixture.consentId);
    // Session listing returns every session token, so a handoff never reads it.
    expect(
      await rejectionOf(
        auth.api.listSessions({ headers: { cookie: cookieOf(response) } }),
      ),
    ).toMatchObject({ body: { code: "step_up_required" } });
    const stored = (
      await db.select().from(session).where(eq(session.id, read!.session.id))
    ).at(0);
    expect(stored?.originConsentId).toBe(fixture.consentId);
    expect(stored?.handoffAbsoluteExpiresAt?.getTime()).toBeGreaterThan(
      Date.now() + 43_190_000,
    );
    expect(stored?.handoffAbsoluteExpiresAt?.getTime()).toBeLessThanOrEqual(
      Date.now() + 43_200_000,
    );
    expect((await redeem(code, { confirmation: "confirmed" })).status).toBe(
      403,
    );
  });
  test("a click link opened in another signed-out browser confirms the account before any session", async () => {
    // Minted for the fixture account, then opened in a browser with no session.
    const code = await mint("click");
    const sessionsBefore = await db.$count(session);
    const first = await redeem(code, { address: "198.51.100.7" });
    expect(first.status).toBe(200);
    expect(v.parse(mcpHandoffRedeemResultSchema, await first.json())).toEqual({
      status: "needs_confirmation",
      email: "handoff@example.test",
      organizationName: "Organization",
    });
    expect(cookieOf(first)).not.toContain("session_token=");
    expect(await db.$count(session)).toBe(sessionsBefore);
    expect((await service.inspect(code))?.handoff.consumedAt).toBeNull();
    const confirmed = await redeem(code, {
      confirmation: "confirmed",
      address: "198.51.100.7",
    });
    expect(confirmed.status).toBe(200);
    expect(cookieOf(confirmed)).toContain("session_token=");
    expect(await db.$count(session)).toBe(sessionsBefore + 1);
  });
  test("confirmed click links create a normal-lifetime session", async () => {
    const response = await redeem(await mint("click"), {
      confirmation: "confirmed",
    });
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
    const reauthenticated = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          cookie: cookieOf(response),
          origin: baseURL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "handoff@example.test",
          password: "test-fixture-password",
        }),
      }),
    );
    expect(reauthenticated.status).toBe(200);
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
  test("email OTP completion from a handoff cookie creates an ordinary session", async () => {
    const handedOff = await redeem(await mint("click"), {
      confirmation: "confirmed",
    });
    const handoffCookie = cookieOf(handedOff);
    expect(
      (await auth.api.getSession({ headers: { cookie: handoffCookie } }))
        ?.session.originConsentId,
    ).toBe(fixture.consentId);
    deliveredEmailOtps.length = 0;
    const sent = await auth.handler(
      new Request(`${baseURL}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: {
          cookie: handoffCookie,
          origin: baseURL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "handoff@example.test",
          type: "sign-in",
        }),
      }),
    );
    expect(sent.status).toBe(200);
    expect(readDeliveredEmailOtp()).toBe("314159");
    const completed = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/email-otp`, {
        method: "POST",
        headers: {
          cookie: handoffCookie,
          origin: baseURL,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "handoff@example.test",
          otp: readDeliveredEmailOtp(),
        }),
      }),
    );
    expect(completed.status).toBe(200);
    const normalCookie = cookieOf(completed);
    const normalSession = await auth.api.getSession({
      headers: { cookie: normalCookie },
    });
    expect(normalSession?.user.id).toBe(fixture.userId);
    expect(normalSession?.session.originConsentId ?? null).toBeNull();
    try {
      const sensitive = await auth.handler(
        new Request(`${baseURL}/api/auth/change-password`, {
          method: "POST",
          headers: {
            cookie: normalCookie,
            origin: baseURL,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            currentPassword: "test-fixture-password",
            newPassword: "test-fixture-otp-password",
          }),
        }),
      );
      expect(sensitive.status).toBe(200);
    } finally {
      await db
        .update(account)
        .set({
          password: await (
            await auth.$context
          ).password.hash("test-fixture-password"),
        })
        .where(eq(account.id, "handoff-credential"));
    }
  });
  test("Google callback from a handoff cookie creates an ordinary session", async () => {
    const handedOff = await redeem(await mint("click"), {
      confirmation: "confirmed",
    });
    const handoffCookie = cookieOf(handedOff);
    const socialAuth = makeAuth(service, {
      google: {
        clientId: "test-google-client",
        clientSecret: "test-google-secret",
        getUserInfo: async () => ({
          user: {
            name: "Account",
            email: "handoff@example.test",
            emailVerified: true,
          },
          data: {
            aud: "test-google-client",
            azp: "test-google-client",
            email: "handoff@example.test",
            email_verified: true,
            exp: Math.floor(Date.now() / 1000) + 3600,
            family_name: "Fixture",
            given_name: "Account",
            iat: Math.floor(Date.now() / 1000),
            iss: "https://accounts.google.com",
            name: "Account",
            picture: "https://example.test/avatar.png",
            sub: "handoff-social-account",
          } satisfies GoogleProfile,
        }),
      },
    });
    const started = await socialAuth.handler(
      new Request(`${baseURL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          cookie: handoffCookie,
          origin: baseURL,
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      }),
    );
    expect(started.status).toBe(200);
    const { url } = v.parse(
      v.object({ url: v.string() }),
      await started.json(),
    );
    const state = new URL(url).searchParams.get("state");
    expect(state).not.toBeNull();
    const fetchToken = Object.assign(
      async () =>
        await Promise.resolve(
          Response.json({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        ),
      { preconnect: globalThis.fetch.preconnect },
    );
    const tokenExchange = spyOn(globalThis, "fetch").mockImplementation(
      fetchToken,
    );
    let callback: Response;
    try {
      callback = await socialAuth.handler(
        new Request(
          `${baseURL}/api/auth/callback/google?code=code&state=${encodeURIComponent(state ?? "")}`,
          {
            headers: {
              cookie: mergeCookies(handoffCookie, cookieOf(started)),
            },
          },
        ),
      );
    } finally {
      tokenExchange.mockRestore();
    }
    expect(callback.status).toBe(302);
    const normalCookie = mergeCookies(
      handoffCookie,
      cookieOf(started),
      cookieOf(callback),
    );
    const normalSession = await socialAuth.api.getSession({
      headers: { cookie: normalCookie },
    });
    expect(normalSession?.user.id).toBe(fixture.userId);
    expect(normalSession?.session.originConsentId ?? null).toBeNull();
  });
  test.each(
    MCP_WEB_HANDOFF_KINDS.flatMap((priorKind, priorIndex) =>
      MCP_WEB_HANDOFF_KINDS.map(
        (nextKind, nextIndex) =>
          [
            priorKind,
            nextKind,
            `192.0.2.${priorIndex * MCP_WEB_HANDOFF_KINDS.length + nextIndex + 1}`,
          ] as const,
      ),
    ),
  )(
    "%s handoff sessions are replaced by %s sessions owned by the next consent",
    async (priorKind, nextKind, address) => {
      const replacementUserId = Bun.randomUUIDv7();
      const replacementFixture = { ...fixture, userId: replacementUserId };
      await db.insert(user).values({
        id: replacementUserId,
        name: "Account",
        email: `handoff-${replacementUserId}@example.test`,
        emailVerified: true,
      });
      await db.insert(member).values({
        id: Bun.randomUUIDv7(),
        userId: replacementUserId,
        organizationId: fixture.organizationId,
        role: "owner",
        createdAt: new Date(),
      });
      const priorConsentId = Bun.randomUUIDv7();
      const nextConsentId = Bun.randomUUIDv7();
      const priorClientId = Bun.randomUUIDv7();
      const nextClientId = Bun.randomUUIDv7();
      await db.insert(oauthClient).values(
        [priorClientId, nextClientId].map((clientId) => ({
          id: clientId,
          clientId,
          name: "Connected app",
          redirectUris: [],
        })),
      );
      await db.insert(oauthConsent).values(
        [
          { id: priorConsentId, clientId: priorClientId },
          { id: nextConsentId, clientId: nextClientId },
        ].map(({ id, clientId }) => ({
          id,
          clientId,
          userId: replacementUserId,
          referenceId: fixture.organizationId,
          scopes: [...MCP_OAUTH_SCOPES],
        })),
      );
      const priorCode = await service.mint(
        { ...replacementFixture, clientId: priorClientId },
        ["/law/example"],
        priorKind,
      );
      expect(priorCode).not.toBeNull();
      if (priorCode === null) {
        expect.unreachable("Expected prior handoff code");
      }
      const priorResponse = await redeem(priorCode, {
        confirmation: "confirmed",
        address,
      });
      expect(priorResponse.status).toBe(200);
      const prior = await auth.api.getSession({
        headers: { cookie: cookieOf(priorResponse) },
        query: { disableCookieCache: true },
      });
      expect(prior?.session.originConsentId).toBe(priorConsentId);
      if (prior === null) {
        expect.unreachable("Expected prior handoff session");
      }
      const nextCode = await service.mint(
        { ...replacementFixture, clientId: nextClientId },
        ["/law/example"],
        nextKind,
      );
      expect(nextCode).not.toBeNull();
      if (nextCode === null) {
        expect.unreachable("Expected next handoff code");
      }
      const startedAt = Date.now();
      const nextResponse = await redeem(nextCode, {
        confirmation: "confirmed",
        cookie: cookieOf(priorResponse),
        address,
      });
      expect(nextResponse.status).toBe(200);
      const nextCookie = cookieOf(nextResponse);
      const next = await auth.api.getSession({
        headers: { cookie: nextCookie },
        query: { disableCookieCache: true },
      });
      expect(next).not.toBeNull();
      if (next === null) {
        expect.unreachable("Expected next handoff session");
      }
      expect(next.session.id).not.toBe(prior.session.id);
      expect(next.session.token).not.toBe(prior.session.token);
      expect(next.session.originConsentId).toBe(nextConsentId);
      expect((await service.inspect(nextCode))?.handoff.consumedSessionId).toBe(
        next.session.id,
      );
      expect(await db.$count(session, eq(session.id, prior.session.id))).toBe(
        0,
      );
      const stored = (
        await db.select().from(session).where(eq(session.id, next.session.id))
      ).at(0);
      expect(stored).toBeDefined();
      if (nextKind === "text") {
        expect(
          stored?.handoffAbsoluteExpiresAt?.getTime(),
        ).toBeGreaterThanOrEqual(startedAt + 43_200_000);
        expect(stored?.handoffAbsoluteExpiresAt?.getTime()).toBeLessThanOrEqual(
          Date.now() + 43_200_000,
        );
        expect(stored?.expiresAt.getTime()).toBe(
          stored?.handoffAbsoluteExpiresAt?.getTime(),
        );
      } else {
        expect(stored?.handoffAbsoluteExpiresAt).toBeNull();
        expect(stored?.expiresAt.getTime()).toBeGreaterThan(
          Date.now() + 43_200_000,
        );
      }
      await db.delete(oauthConsent).where(eq(oauthConsent.id, priorConsentId));
      expect(
        (
          await auth.api.getSession({
            headers: { cookie: nextCookie },
            query: { disableCookieCache: true },
          })
        )?.session.id,
      ).toBe(next.session.id);
      await db.delete(oauthConsent).where(eq(oauthConsent.id, nextConsentId));
      expect(await db.$count(session, eq(session.id, next.session.id))).toBe(0);
      expect(
        await auth.api.getSession({
          headers: { cookie: nextCookie },
          query: { disableCookieCache: true },
        }),
      ).toBeNull();
    },
  );
  test("an incomplete replacement preserves the prior session and unused link", async () => {
    const priorResponse = await redeem(await mint("click"), {
      confirmation: "confirmed",
      address: "192.0.2.20",
    });
    expect(priorResponse.status).toBe(200);
    const priorCookie = cookieOf(priorResponse);
    const prior = await auth.api.getSession({
      headers: { cookie: priorCookie },
      query: { disableCookieCache: true },
    });
    expect(prior).not.toBeNull();
    if (prior === null) {
      expect.unreachable("Expected prior handoff session");
    }
    const incompleteAuth = makeAuth();
    const context = await incompleteAuth.$context;
    const deleteSession = context.internalAdapter.deleteSession;
    context.internalAdapter.deleteSession = async (token) => {
      await deleteSession(token);
      throw new TypeError("Session replacement unavailable");
    };
    const code = await mint("text");
    const before = await db.$count(session);
    const response = await incompleteAuth.handler(
      new Request(`${baseURL}/api/auth/mcp-handoff/redeem`, {
        method: "POST",
        headers: {
          origin: baseURL,
          "content-type": "application/json",
          cookie: priorCookie,
          [AUTH_CLIENT_ADDRESS_HEADER]: "192.0.2.20",
        },
        body: JSON.stringify({
          code,
          path: "/law/example",
          confirmation: "confirmed",
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await db.$count(session)).toBe(before);
    expect((await service.inspect(code))?.handoff.consumedAt).toBeNull();
    expect(
      (
        await auth.api.getSession({
          headers: { cookie: priorCookie },
          query: { disableCookieCache: true },
        })
      )?.session.id,
    ).toBe(prior.session.id);
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
      .where(eq(session.userId, fixture.userId))
      .orderBy(session.id);
    const response = await redeem(code, { cookie: existingCookie });
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
    const receipt = await service.inspect(code);
    expect(receipt?.handoff.consumedSessionId).toBe(current?.session.id);
    expect(receipt).not.toBeNull();
    const redeemedAudit = await db
      .select({
        organizationId: auditLogs.organizationId,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, receipt!.handoff.id),
          eq(auditLogs.action, AUDIT_ACTION.MCP_WEB_HANDOFF_REDEEMED),
        ),
      );
    expect(redeemedAudit).toEqual([
      {
        organizationId: fixture.organizationId,
        metadata: expect.objectContaining({
          kind: "click",
          clientId: fixture.clientId,
          previousOrganizationId: browserOrganizationId,
          newOrganizationId: fixture.organizationId,
        }),
      },
    ]);
    expect(
      (await auth.api.getSession({ headers: { cookie: existingCookie } }))
        ?.session.id,
    ).toBe(current?.session.id);
    expect(
      await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.userId, fixture.userId))
        .orderBy(session.id),
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
      const response = await redeem(code, { cookie: existingCookie });
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
      { ...fixture, userId: otherUserId },
      ["/law/example"],
      "click",
    );
    if (!code) {
      throw new TypeError("Expected other-account handoff");
    }
    const response = await redeem(code, { cookie: existingCookie });
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
