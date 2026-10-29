import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import { Result } from "better-result";
import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, session, user } from "@/api/db/auth-schema";
import {
  contacts,
  featureEnrolments,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { getServerAnalytics } from "@/api/lib/analytics/client";
import {
  AUTHORITATIVE_SESSION_PATHS,
  checkNewAccountEmailAllowedForCreation,
  ensureDisplayName,
  getAuth,
  getEmailOtpMinimumResponseDuration,
  getNewAccountEmailOtpAction,
  isSessionCreatingAuthPath,
  isSixDigitOtpBody,
  isTwoFactorRedirectResponse,
  NEW_ACCOUNT_OTP_RATE_LIMIT_MODE,
  OAUTH_PROVIDER_SESSION_PATHS,
  resolveAuthoritativeSessionForSensitiveAuthPath,
  resolveMemberAuthorization,
  resolveUserRealtimeAuthorization,
  resolveWorkspaceMemberAccess,
  resolveWorkspaceRealtimeAudience,
  runEmailOtpRequestOnResponseSchedule,
  SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
  TWO_FACTOR_MANAGE_PATHS,
  TWO_FACTOR_SESSION_PATHS,
  withStellaTwoFactorSignInGate,
} from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { toSafeId } from "@/api/lib/branded-types";
import { AUTH_RATE_LIMITS } from "@/api/lib/limits";
import { OAUTH_CLIENT_REGISTRATION_PATH } from "@/api/lib/oauth-loopback-registration";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testState = createTestState({ file: import.meta.path, config: env });

setDefaultTimeout(120_000);

// Authentication resolves one organization membership row. A target workspace
// is joined only when supplied, so the common auth query stays one row even as
// the organization accumulates matters.

const tid = () => Bun.randomUUIDv7();
const orgId = () => toSafeId<"organization">(tid());
const userId = () => toSafeId<"user">(tid());
const workspaceId = () => toSafeId<"workspace">(tid());

let testDb: TestDatabase;

// One shared fixture across all tests in this file.
const orgFull = orgId();
const ownerInFull = userId();
const memberInFull = userId();
const loneMemberInFull = userId();

const orgEmpty = orgId();
const ownerInEmpty = userId();
const memberInEmpty = userId();

const strangerUser = userId();
const clientContactId = toSafeId<"contact">(tid());
const clientWorkspaceId = workspaceId();
const memberPersonalWorkspaceId = workspaceId();
const liveOwnerSessionId = tid();
const expiredOwnerSessionId = tid();
const liveMemberSessionId = tid();

testState.beforeAll(async () => {
  testDb = await getTestDb();

  await testDb.insert(user).values(
    [
      ownerInFull,
      memberInFull,
      loneMemberInFull,
      ownerInEmpty,
      memberInEmpty,
      strangerUser,
    ].map((id) => ({
      id,
      name: `user-${id}`,
      email: `${id}@test.local`,
    })),
  );

  await testDb.insert(organization).values([
    {
      id: orgFull,
      name: "Org Full",
      slug: `org-full-${orgFull}`,
      createdAt: new Date(),
    },
    {
      id: orgEmpty,
      name: "Org Empty",
      slug: `org-empty-${orgEmpty}`,
      createdAt: new Date(),
    },
  ]);
  for (const organizationId of [orgFull, orgEmpty]) {
    await recordNewOrganizationAccessState(testDb, {
      organizationId,
      now: new Date(),
    });
  }

  await testDb.insert(member).values([
    {
      id: tid(),
      organizationId: orgFull,
      userId: ownerInFull,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: tid(),
      organizationId: orgFull,
      userId: memberInFull,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: tid(),
      organizationId: orgFull,
      userId: loneMemberInFull,
      role: "member",
      createdAt: new Date(),
    },
    {
      id: tid(),
      organizationId: orgEmpty,
      userId: ownerInEmpty,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: tid(),
      organizationId: orgEmpty,
      userId: memberInEmpty,
      role: "member",
      createdAt: new Date(),
    },
  ]);

  await testDb.insert(session).values([
    {
      id: liveOwnerSessionId,
      token: tid(),
      userId: ownerInFull,
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    },
    {
      id: expiredOwnerSessionId,
      token: tid(),
      userId: ownerInFull,
      expiresAt: new Date("2000-01-01T00:00:00.000Z"),
    },
    {
      id: liveMemberSessionId,
      token: tid(),
      userId: memberInFull,
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    },
  ]);

  await testDb.insert(contacts).values({
    id: clientContactId,
    organizationId: orgFull,
    type: "person",
    displayName: "Client",
  });
  await testDb.insert(workspaces).values([
    {
      id: clientWorkspaceId,
      organizationId: orgFull,
      clientId: clientContactId,
      name: "Client matter",
      reference: "AUTH-CLIENT",
    },
    {
      id: memberPersonalWorkspaceId,
      organizationId: orgFull,
      clientId: null,
      name: "Member personal matter",
      reference: "AUTH-PERSONAL",
    },
  ]);
  await testDb.insert(workspaceMembers).values({
    id: toSafeId<"workspaceMember">(tid()),
    workspaceId: memberPersonalWorkspaceId,
    userId: memberInFull,
  });
});

afterAll(async () => {
  await releaseTestDb();
});

describe("resolveMemberAuthorization", () => {
  test("resolves an owner without loading workspaces", async () => {
    const authorization = await resolveMemberAuthorization(
      { organizationId: orgFull, userId: ownerInFull },
      testDb,
    );

    expect(authorization).toEqual({
      memberId: expect.any(String),
      email: `${ownerInFull}@test.local`,
      role: "owner",
      workspace: null,
      emailVerified: expect.any(Boolean),
      userDeleted: false,
      enrolledFeatureIds: [],
      professionalUse: { status: "required" },
    });
  });

  test("a member belonging to the org but to no workspace still resolves", async () => {
    const authorization = await resolveMemberAuthorization(
      { organizationId: orgFull, userId: loneMemberInFull },
      testDb,
    );
    expect(authorization).toEqual({
      memberId: expect.any(String),
      email: `${loneMemberInFull}@test.local`,
      role: "member",
      workspace: null,
      emailVerified: expect.any(Boolean),
      userDeleted: false,
      enrolledFeatureIds: [],
      professionalUse: { status: "required" },
    });
  });

  test("reads the caller's own feature enrolments in the same lookup, never another member's", async () => {
    const restoreMode = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    await testDb.insert(featureEnrolments).values([
      {
        organizationId: orgFull,
        userId: memberInFull,
        featureId: "time-billing",
      },
      // Same user, another organization: must never surface in orgFull.
      {
        organizationId: orgEmpty,
        userId: loneMemberInFull,
        featureId: "time-billing",
      },
    ]);
    try {
      for (const deployed of [false, true]) {
        testState.setConfig("FEATURE_TIME_BILLING", deployed);
        const enrolled = await resolveMemberAuthorization(
          { organizationId: orgFull, userId: memberInFull },
          testDb,
        );
        const enrolledWithWorkspace = await resolveMemberAuthorization(
          {
            organizationId: orgFull,
            userId: memberInFull,
            workspaceId: memberPersonalWorkspaceId,
          },
          testDb,
        );
        const other = await resolveMemberAuthorization(
          { organizationId: orgFull, userId: ownerInFull },
          testDb,
        );
        expect(enrolled?.enrolledFeatureIds).toEqual(
          deployed ? ["time-billing"] : [],
        );
        expect(enrolledWithWorkspace?.enrolledFeatureIds).toEqual(
          deployed ? ["time-billing"] : [],
        );
        expect(other?.enrolledFeatureIds).toEqual([]);
        const otherOrganization = await resolveMemberAuthorization(
          { organizationId: orgFull, userId: loneMemberInFull },
          testDb,
        );
        expect(otherOrganization?.enrolledFeatureIds).toEqual([]);
      }
    } finally {
      restoreMode();
      await testDb
        .delete(featureEnrolments)
        .where(
          inArray(featureEnrolments.userId, [memberInFull, loneMemberInFull]),
        );
    }
  });

  test("optionally resolves one target workspace without expanding the access set", async () => {
    const ownerClient = await resolveMemberAuthorization(
      {
        organizationId: orgFull,
        userId: ownerInFull,
        workspaceId: clientWorkspaceId,
      },
      testDb,
    );
    const ownerPersonal = await resolveMemberAuthorization(
      {
        organizationId: orgFull,
        userId: ownerInFull,
        workspaceId: memberPersonalWorkspaceId,
      },
      testDb,
    );
    const memberPersonal = await resolveMemberAuthorization(
      {
        organizationId: orgFull,
        userId: memberInFull,
        workspaceId: memberPersonalWorkspaceId,
      },
      testDb,
    );
    const memberClient = await resolveMemberAuthorization(
      {
        organizationId: orgFull,
        userId: memberInFull,
        workspaceId: clientWorkspaceId,
      },
      testDb,
    );

    expect(ownerClient?.workspace?.id).toBe(clientWorkspaceId);
    expect(ownerPersonal?.workspace).toBeNull();
    expect(memberPersonal?.workspace?.id).toBe(memberPersonalWorkspaceId);
    expect(memberClient?.workspace).toBeNull();
  });

  test.each([
    {
      actor: ownerInFull,
      target: clientWorkspaceId,
      expected: clientWorkspaceId,
    },
    { actor: ownerInFull, target: memberPersonalWorkspaceId, expected: null },
    {
      actor: memberInFull,
      target: memberPersonalWorkspaceId,
      expected: memberPersonalWorkspaceId,
    },
    { actor: memberInFull, target: clientWorkspaceId, expected: null },
  ])(
    "worker membership uses the session access rule under RLS: %p",
    async ({ actor, target, expected }) => {
      const lookup = {
        organizationId: orgFull,
        userId: actor,
        workspaceId: target,
      };
      const authorization = await resolveMemberAuthorization(lookup, testDb);
      const workspace = await createScopedDb(
        testDb,
        [target],
        orgFull,
        actor,
      )(async (tx) => await resolveWorkspaceMemberAccess(lookup, tx));
      expect(workspace?.id ?? null).toBe(expected);
      expect(workspace).toEqual(authorization?.workspace ?? null);
    },
  );

  test("organization members with zero workspaces keep their roles", async () => {
    const ownerAuthorization = await resolveMemberAuthorization(
      { organizationId: orgEmpty, userId: ownerInEmpty },
      testDb,
    );
    const memberAuthorization = await resolveMemberAuthorization(
      { organizationId: orgEmpty, userId: memberInEmpty },
      testDb,
    );
    expect(ownerAuthorization?.role).toBe("owner");
    expect(memberAuthorization?.role).toBe("member");
  });

  test("a user with no membership row in the organization resolves to null", async () => {
    const result = await resolveMemberAuthorization(
      { organizationId: orgFull, userId: strangerUser },
      testDb,
    );

    expect(result).toBeNull();
  });

  test("membership in one organization does not leak workspace access when queried against another organization", async () => {
    const result = await resolveMemberAuthorization(
      { organizationId: orgEmpty, userId: ownerInFull },
      testDb,
    );

    expect(result).toBeNull();
  });
});

describe("resolveWorkspaceRealtimeAudience", () => {
  test("returns only live sessions whose users currently access the target workspace", async () => {
    const candidates = [
      liveOwnerSessionId,
      expiredOwnerSessionId,
      liveMemberSessionId,
    ];

    const clientMatterAudience = await resolveWorkspaceRealtimeAudience(
      { sessionIds: candidates, workspaceId: clientWorkspaceId },
      testDb,
    );
    const personalMatterAudience = await resolveWorkspaceRealtimeAudience(
      { sessionIds: candidates, workspaceId: memberPersonalWorkspaceId },
      testDb,
    );

    expect(clientMatterAudience).toEqual(new Set([liveOwnerSessionId]));
    expect(personalMatterAudience).toEqual(new Set([liveMemberSessionId]));
  });
});

describe("resolveUserRealtimeAuthorization", () => {
  test("returns only live sessions for a current organization member", async () => {
    const authorized = await resolveUserRealtimeAuthorization(
      {
        organizationId: orgFull,
        sessionIds: [liveOwnerSessionId, expiredOwnerSessionId],
        userId: ownerInFull,
      },
      testDb,
    );

    expect(authorized).toEqual(new Set([liveOwnerSessionId]));
  });

  test("refuses live sessions after their organization membership is removed", async () => {
    const authorized = await resolveUserRealtimeAuthorization(
      {
        organizationId: orgEmpty,
        sessionIds: [liveMemberSessionId],
        userId: memberInFull,
      },
      testDb,
    );

    expect(authorized).toEqual(new Set());
  });
});

const fakeCtx = (path: string) => asTestRaw<HookEndpointContext>({ path });

describe("withStellaTwoFactorSignInGate", () => {
  test("keeps the after-hook (and its original handler) instead of dropping it", () => {
    const handler = () => undefined;
    const plugin = {
      hooks: {
        after: [{ matcher: (_ctx: HookEndpointContext) => false, handler }],
      },
    };

    const wrapped = withStellaTwoFactorSignInGate(plugin);

    // Guards against a future better-auth upgrade restructuring `hooks`
    // (e.g. renaming/removing `after`) without this call site noticing.
    expect(wrapped.hooks.after).toHaveLength(1);
    expect(wrapped.hooks.after[0]?.handler).toBe(handler);
  });

  test("matches /sign-in/email-otp even when the original matcher does not", () => {
    const plugin = {
      hooks: {
        after: [
          {
            matcher: (_ctx: HookEndpointContext) => false,
            handler: () => undefined,
          },
        ],
      },
    };

    const [wrappedHook] = withStellaTwoFactorSignInGate(plugin).hooks.after;

    expect(wrappedHook?.matcher(fakeCtx("/sign-in/email-otp"))).toBe(true);
  });

  test("matches the social sign-in callback so enrolled users are challenged", () => {
    const plugin = {
      hooks: {
        after: [
          {
            matcher: (_ctx: HookEndpointContext) => false,
            handler: () => undefined,
          },
        ],
      },
    };

    const [wrappedHook] = withStellaTwoFactorSignInGate(plugin).hooks.after;

    expect(wrappedHook?.matcher(fakeCtx("/callback/google"))).toBe(true);
    expect(wrappedHook?.matcher(fakeCtx("/callback/microsoft"))).toBe(true);
  });

  test("still matches whatever the original matcher already matched", () => {
    const plugin = {
      hooks: {
        after: [
          {
            matcher: (ctx: HookEndpointContext) =>
              ctx.path === "/sign-in/email",
            handler: () => undefined,
          },
        ],
      },
    };

    const [wrappedHook] = withStellaTwoFactorSignInGate(plugin).hooks.after;

    expect(wrappedHook?.matcher(fakeCtx("/sign-in/email"))).toBe(true);
  });

  test("does not match an unrelated path", () => {
    const plugin = {
      hooks: {
        after: [
          {
            matcher: (ctx: HookEndpointContext) =>
              ctx.path === "/sign-in/email",
            handler: () => undefined,
          },
        ],
      },
    };

    const [wrappedHook] = withStellaTwoFactorSignInGate(plugin).hooks.after;

    expect(wrappedHook?.matcher(fakeCtx("/two-factor/enable"))).toBe(false);
    // The MCP OAuth provider plugin lives under /oauth2, not /callback.
    expect(wrappedHook?.matcher(fakeCtx("/oauth2/callback"))).toBe(false);
  });
});

describe("isTwoFactorRedirectResponse", () => {
  test("detects the two-factor plugin's pending-challenge marker", () => {
    expect(
      isTwoFactorRedirectResponse({
        twoFactorRedirect: true,
        twoFactorMethods: ["totp"],
      }),
    ).toBe(true);
  });

  test("ignores an ordinary sign-in / OAuth-redirect response", () => {
    expect(isTwoFactorRedirectResponse({ twoFactorRedirect: false })).toBe(
      false,
    );
    expect(isTwoFactorRedirectResponse({ token: "abc" })).toBe(false);
    expect(isTwoFactorRedirectResponse(null)).toBe(false);
    expect(isTwoFactorRedirectResponse(undefined)).toBe(false);
  });
});

describe("isSessionCreatingAuthPath", () => {
  test("covers auth surfaces that set a session", () => {
    // The hosted flow is passwordless email OTP; social providers all land on
    // the shared callback; the credential path serves the self-host bootstrap
    // admin, and first verification signs the new account in.
    expect(isSessionCreatingAuthPath("/mcp-handoff/redeem")).toBe(true);
    expect(isSessionCreatingAuthPath("/sign-in/email-otp")).toBe(true);
    expect(isSessionCreatingAuthPath("/callback/google")).toBe(true);
    expect(isSessionCreatingAuthPath("/callback/microsoft")).toBe(true);
    expect(isSessionCreatingAuthPath("/sign-in/email")).toBe(true);
    expect(isSessionCreatingAuthPath("/email-otp/verify-email")).toBe(true);
    expect(isSessionCreatingAuthPath("/sign-up/email")).toBe(true);
  });

  test("ignores paths that establish no session", () => {
    expect(isSessionCreatingAuthPath("/get-session")).toBe(false);
    expect(isSessionCreatingAuthPath("/email-otp/send-verification-otp")).toBe(
      false,
    );
    expect(isSessionCreatingAuthPath("/oauth2/authorize")).toBe(false);
    expect(isSessionCreatingAuthPath(undefined)).toBe(false);
  });
});

describe("TWO_FACTOR_MANAGE_PATHS", () => {
  test("matches every two-factor management path that exposes or changes the second factor", () => {
    expect(TWO_FACTOR_MANAGE_PATHS.has("/two-factor/enable")).toBe(true);
    expect(TWO_FACTOR_MANAGE_PATHS.has("/two-factor/disable")).toBe(true);
    expect(TWO_FACTOR_MANAGE_PATHS.has("/two-factor/get-totp-uri")).toBe(true);
    expect(
      TWO_FACTOR_MANAGE_PATHS.has("/two-factor/generate-backup-codes"),
    ).toBe(true);
  });

  test("does not match an unrelated two-factor path", () => {
    expect(TWO_FACTOR_MANAGE_PATHS.has("/two-factor/verify-totp")).toBe(false);
    expect(TWO_FACTOR_MANAGE_PATHS.has("/two-factor/verify-backup-code")).toBe(
      false,
    );
    expect(TWO_FACTOR_MANAGE_PATHS.has("/sign-in/email-otp")).toBe(false);
  });
});

describe("resolveAuthoritativeSessionForSensitiveAuthPath", () => {
  const sensitiveCtx = (path: string) => {
    const headers = new Headers({
      cookie: "session-token=token; preference=compact; session-data=snapshot",
    });
    return {
      context: {
        authCookies: {
          sessionData: { name: "session-data" },
          sessionToken: { name: "session-token" },
        },
      },
      headers,
      path,
      request: new Request(`http://localhost/api/auth${path}`, { headers }),
    };
  };

  test("loads storage-backed session state before OAuth authorization can mint a durable token", async () => {
    const resolvedPaths: string[] = [];

    const ctx = sensitiveCtx("/oauth2/authorize");
    const handled = await resolveAuthoritativeSessionForSensitiveAuthPath({
      ctx,
      resolveSession: async (sessionContext) => {
        resolvedPaths.push(sessionContext.path);
        return null;
      },
    });

    expect(Result.isOk(handled) && handled.value).toBeUndefined();
    expect(resolvedPaths).toEqual(["/oauth2/authorize"]);
    expect(ctx.headers.get("cookie")).toBe("preference=compact");
  });

  test("treats a server-side OAuth call carrying a revoked session's cookies as signed out", async () => {
    const resolvedPaths: string[] = [];
    const { request: _request, ...serverCall } =
      sensitiveCtx("/oauth2/consent");

    const handled = await resolveAuthoritativeSessionForSensitiveAuthPath({
      ctx: serverCall,
      resolveSession: async (sessionContext) => {
        resolvedPaths.push(sessionContext.path);
        return null;
      },
    });

    expect(Result.isOk(handled) && handled.value).toBeUndefined();
    expect(resolvedPaths).toEqual(["/oauth2/consent"]);
    expect(serverCall.headers.get("cookie")).toBe("preference=compact");
  });

  test("reads no session for an OAuth call without cookies", async () => {
    let resolved = false;

    const handled = await resolveAuthoritativeSessionForSensitiveAuthPath({
      ctx: { path: "/oauth2/consent", headers: new Headers() },
      resolveSession: async () => {
        resolved = true;
        return null;
      },
    });

    expect(Result.isOk(handled) && handled.value).toBeUndefined();
    expect(resolved).toBe(false);
  });

  test("refuses two-factor management when storage holds no session", async () => {
    const resolvedPaths: string[] = [];

    const handled = await resolveAuthoritativeSessionForSensitiveAuthPath({
      ctx: sensitiveCtx("/two-factor/enable"),
      resolveSession: async (ctx) => {
        resolvedPaths.push(ctx.path);
        return null;
      },
    });

    expect(Result.isError(handled) && handled.error.status).toBe(
      "UNAUTHORIZED",
    );
    expect(resolvedPaths).toEqual(["/two-factor/enable"]);
  });

  test("pins a two-factor challenge endpoint's own session read to storage", async () => {
    const handled = await resolveAuthoritativeSessionForSensitiveAuthPath({
      ctx: { ...sensitiveCtx("/two-factor/verify-totp"), query: { a: "1" } },
      resolveSession: async () => null,
    });

    expect(Result.isOk(handled) && handled.value).toEqual({
      context: { query: { a: "1", disableCookieCache: true } },
    });
  });

  test("keeps ordinary endpoints on the cookie-cache fast path", async () => {
    let resolved = false;

    const handled = await resolveAuthoritativeSessionForSensitiveAuthPath({
      ctx: sensitiveCtx("/get-session"),
      resolveSession: async () => {
        resolved = true;
        return null;
      },
    });
    expect(Result.isOk(handled) && handled.value).toBeUndefined();
    expect(resolved).toBe(false);
  });

  test("declares every session-reading sensitive endpoint as authoritative", () => {
    expect(AUTHORITATIVE_SESSION_PATHS).toEqual(
      new Set([
        ...Object.keys(TWO_FACTOR_SESSION_PATHS),
        ...Object.entries(OAUTH_PROVIDER_SESSION_PATHS).flatMap(
          ([path, use]) => (use === "browser-session" ? [path] : []),
        ),
      ]),
    );
  });
});

describe("isSixDigitOtpBody", () => {
  test("accepts a body with a 6-digit string otp", () => {
    expect(isSixDigitOtpBody({ otp: "123456" })).toBe(true);
  });

  test("rejects a missing body", () => {
    expect(isSixDigitOtpBody(undefined)).toBe(false);
    expect(isSixDigitOtpBody(null)).toBe(false);
  });

  test("rejects a body without an otp field", () => {
    expect(isSixDigitOtpBody({})).toBe(false);
  });

  test("rejects a non-string otp", () => {
    expect(isSixDigitOtpBody({ otp: 123_456 })).toBe(false);
  });

  test("rejects an otp that is not exactly 6 digits", () => {
    expect(isSixDigitOtpBody({ otp: "12345" })).toBe(false);
    expect(isSixDigitOtpBody({ otp: "1234567" })).toBe(false);
    expect(isSixDigitOtpBody({ otp: "12a456" })).toBe(false);
  });
});

describe("ensureDisplayName", () => {
  // The hook feeds the adapter a payload, not a typed user row; widening here
  // keeps the assertions on the shape that actually gets persisted rather than
  // on the union the generic infers per call.
  const resolved = (
    payload: Record<string, unknown>,
  ): Record<string, unknown> => ensureDisplayName(payload);

  test("keeps a name that has content", () => {
    expect(resolved({ name: "Eva Schmidt", email: "eva@example.com" })).toEqual(
      { name: "Eva Schmidt", email: "eva@example.com" },
    );
  });

  test("defaults a blank name to the email local-part on create", () => {
    // Email-OTP signup and some social providers send no name.
    for (const name of ["", "   ", undefined]) {
      expect(resolved({ name, email: "eva@example.com" })).toEqual({
        name: "eva",
        email: "eva@example.com",
      });
    }
  });

  test("falls back to the whole address when it has no local part", () => {
    expect(resolved({ name: "", email: "@example.com" })).toEqual({
      name: "@example.com",
      email: "@example.com",
    });
  });

  test("drops a blank name when no email is available to derive one", () => {
    // Update payloads carry only the changed fields, so `email` is usually
    // absent. Writing the blank through would clear a stored display name;
    // omitting the key leaves the existing value in place.
    expect(resolved({ name: "", timezoneId: "Europe/Prague" })).toEqual({
      timezoneId: "Europe/Prague",
    });
  });

  test("leaves an update payload that does not touch the name alone", () => {
    expect(resolved({ timezoneId: "Europe/Prague" })).toEqual({
      timezoneId: "Europe/Prague",
    });
  });

  // The invariant the column needs: whatever is handed to the adapter must
  // never carry an empty `name`, since `notNull` alone still admits "".
  test("never emits a blank name", () => {
    const names = ["", " ", "\t\n", undefined, null, 42, "Eva"];
    const emails = ["", "   ", undefined, null, "eva@example.com", "@x.com"];
    for (const name of names) {
      for (const email of emails) {
        const result = resolved({ name, email });
        if (!("name" in result)) {
          continue;
        }
        expect(typeof result["name"]).toBe("string");
        expect(String(result["name"]).trim()).not.toBe("");
      }
    }
  });
});

describe("new-account email policy", () => {
  test("does not reveal whether a disposable-address account exists when sending its OTP", async () => {
    const actions = await Promise.all(
      [false, true].map(async (accountExists) =>
        getNewAccountEmailOtpAction(
          {
            body: { email: "blocked@mailinator.com", type: "sign-in" },
            path: "/email-otp/send-verification-otp",
          },
          {
            accountExists: async () => accountExists,
            rateLimitMode: NEW_ACCOUNT_OTP_RATE_LIMIT_MODE.bypassed,
          },
        ),
      ),
    );
    expect(actions).toEqual([{ type: "continue" }, { type: "continue" }]);
  });

  test("rejects a disposable address when creating its account", async () => {
    const checked = checkNewAccountEmailAllowedForCreation({
      email: "blocked@mailinator.com",
      path: "/sign-in/email-otp",
    });

    expect(Result.isError(checked) && checked.error).toMatchObject({
      body: { code: "DISPOSABLE_EMAIL_NOT_ALLOWED" },
      statusCode: 400,
    });
  });

  test("does not apply the OTP blocklist to other user-creation sources", () => {
    const otherCreationPaths = [
      "/callback/google",
      "/sign-up/email",
      undefined,
    ];
    for (const path of otherCreationPaths) {
      expect(
        Result.isOk(
          checkNewAccountEmailAllowedForCreation({
            email: "provider-user@mailinator.com",
            path,
          }),
        ),
      ).toBe(true);
    }
  });

  test("suppresses the OTP side effect for a limited new-account request", async () => {
    const action = await getNewAccountEmailOtpAction(
      {
        body: { email: "new-user@example.com", type: "sign-in" },
        path: "/email-otp/send-verification-otp",
      },
      {
        accountExists: async () => false,
        rateLimitContext: {
          increment: async () => ({
            count: 4,
            nextReset: new Date(Date.now() + 60_000),
            start: Date.now(),
          }),
        },
      },
    );
    expect(action).toEqual({ type: "suppress_otp" });
  });

  test("bypasses the signup limiter with the E2E auth-rate-limit mode", async () => {
    let accountLookupCount = 0;
    let incrementCount = 0;
    const action = await getNewAccountEmailOtpAction(
      {
        body: { email: "new-user@example.com", type: "sign-in" },
        path: "/email-otp/send-verification-otp",
      },
      {
        accountExists: async () => {
          accountLookupCount += 1;
          return false;
        },
        rateLimitContext: {
          increment: async () => {
            incrementCount += 1;
            return {
              count: 1,
              nextReset: new Date(Date.now() + 60_000),
              start: Date.now(),
            };
          },
        },
        rateLimitMode: NEW_ACCOUNT_OTP_RATE_LIMIT_MODE.bypassed,
      },
    );

    expect(action).toEqual({ type: "continue" });
    expect(accountLookupCount).toBe(0);
    expect(incrementCount).toBe(0);
  });
});

describe("email OTP response schedule", () => {
  test("holds an immediate suppression for the fixed response delay", async () => {
    const schedule = Promise.withResolvers<undefined>();
    let settled = false;
    const scheduled = runEmailOtpRequestOnResponseSchedule({
      responseDelayMs: 1000,
      runRequest: async () => {},
      wait: async () => await schedule.promise,
    });
    const observeSettlement = async () => {
      await scheduled;
      settled = true;
    };
    const observed = observeSettlement();

    await Promise.resolve();
    expect(settled).toBe(false);
    schedule.resolve(undefined);
    await observed;
    expect(settled).toBe(true);
  });

  test("returns on schedule while provider delivery is still pending", async () => {
    const delivery = Promise.withResolvers<undefined>();
    const deliveryFinished = Promise.withResolvers<undefined>();
    const schedule = Promise.withResolvers<undefined>();
    let deliverySettled = false;
    const scheduled = runEmailOtpRequestOnResponseSchedule({
      responseDelayMs: 1000,
      runRequest: async () => {
        await delivery.promise;
        deliverySettled = true;
        deliveryFinished.resolve(undefined);
      },
      wait: async () => await schedule.promise,
    });

    schedule.resolve(undefined);
    await scheduled;
    expect(deliverySettled).toBe(false);

    delivery.resolve(undefined);
    await deliveryFinished.promise;
    expect(deliverySettled).toBe(true);
  });

  test("captures a provider failure without changing the response schedule", async () => {
    const deliveryError = new Error("delivery failed");
    const delivery = Promise.withResolvers<undefined>();
    const schedule = Promise.withResolvers<undefined>();
    const observedError = Promise.withResolvers<unknown>();
    const scheduled = runEmailOtpRequestOnResponseSchedule({
      detach: (operation) => {
        operation.catch((error: unknown) => observedError.resolve(error));
      },
      responseDelayMs: 1000,
      runRequest: async () => await delivery.promise,
      wait: async () => await schedule.promise,
    });
    let settled = false;
    const observeSettlement = async () => {
      await scheduled;
      settled = true;
    };
    const observed = observeSettlement();

    await Promise.resolve();
    delivery.reject(deliveryError);
    expect(settled).toBe(false);
    expect(await observedError.promise).toBe(deliveryError);
    schedule.resolve(undefined);

    await observed;
    expect(settled).toBe(true);
  });

  test("preserves synchronous error propagation when no delay is configured", async () => {
    const deliveryError = new Error("delivery failed");
    const outcome = await runEmailOtpRequestOnResponseSchedule({
      responseDelayMs: 0,
      runRequest: async () => {
        throw deliveryError;
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBe(deliveryError);
  });

  test("pads sign-in OTP requests outside local development", () => {
    expect(
      getEmailOtpMinimumResponseDuration({
        path: "/email-otp/send-verification-otp",
        runtimeMode: { mode: RUNTIME_MODE.strict },
        type: "sign-in",
      }),
    ).toBeGreaterThan(0);

    for (const input of [
      {
        path: "/email-otp/send-verification-otp",
        runtimeMode: { mode: RUNTIME_MODE.open },
        type: "sign-in",
      },
      {
        path: "/email-otp/send-verification-otp",
        runtimeMode: { mode: RUNTIME_MODE.strict },
        type: "forget-password",
      },
      {
        path: "/email-otp/verify-email",
        runtimeMode: { mode: RUNTIME_MODE.strict },
        type: "sign-in",
      },
    ] as const) {
      expect(getEmailOtpMinimumResponseDuration(input)).toBe(0);
    }
  });
});

describe("session freshness", () => {
  test("organization leave is not served", async () => {
    const response = await getAuth().handler(
      new Request("http://localhost/api/auth/organization/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgFull }),
      }),
    );

    expect(response.status).toBe(404);
  });

  test("freshAge stays disabled so day-old sessions can read list-sessions", () => {
    // Better Auth defaults `freshAge` to 1 day and gates `list-sessions` (the
    // account page's active-sessions read) against `session.createdAt`, which
    // `updateAge` never refreshes — so any login older than a day would 403 and
    // blank the profile page. It must stay 0; genuinely sensitive flows are
    // gated by Stella's own OTP/two-factor, not this global knob. See the
    // `freshAge` comment in auth.ts. If this fails, the footgun is back.
    expect(getAuth().options.session.freshAge).toBe(0);
  });

  test("account unlinking is available through its confirmation gate", () => {
    expect(getAuth().options.disabledPaths).not.toContain("/unlink-account");
  });

  test("sign-in method confirmation requires a signed-in account", async () => {
    const response = await getAuth().handler(
      new Request(getAuthEndpointUrl("sign-in-methods/send-otp"), {
        method: "POST",
      }),
    );
    expect(response.status).toBe(401);
  });

  test("session cookie cache stays enabled with its pinned revocation window", () => {
    // The cookie cache is what keeps `getSession` off the database for the
    // huge majority of API requests (see the `cookieCache` comment in
    // auth.ts). Its `maxAge` is also the upper bound on how long a REVOKED
    // session's already-issued cookie keeps working, so the window is a
    // security decision, not a tuning knob: widen it deliberately, in both
    // this test and the SESSION_COOKIE_CACHE_MAX_AGE_SECONDS constant,
    // never by dependency-default drift (better-auth defaults to 300s).
    expect(getAuth().options.session.cookieCache).toMatchObject({
      enabled: true,
      maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
    });
    expect(getAuth().options.session.cookieCache.version).toBeFunction();
    expect(SESSION_COOKIE_CACHE_MAX_AGE_SECONDS).toBe(60);
  });
});

describe("OAuth resource provisioning", () => {
  test("committed migrations remain the only resource seed owner", () => {
    const oauthPlugin = getAuth().options.plugins.find(
      (plugin) => plugin.id === "oauth-provider",
    );
    if (
      !oauthPlugin ||
      !("options" in oauthPlugin) ||
      !oauthPlugin.options ||
      !("resourceSeedMode" in oauthPlugin.options)
    ) {
      throw new Error("OAuth provider plugin missing from auth config");
    }

    expect(oauthPlugin.options.resourceSeedMode).toBe("none");
  });

  test("the registration rate limit the plugin enforces is the declared one", () => {
    // Asserts the rule the limiter actually reads, not the option passed in:
    // the plugin silently falls back to its own 5-per-minute default for a
    // misspelled or dropped `rateLimit.register`, and 5 is low enough to
    // refuse a team onboarding together from one address.
    const oauthPlugin = getAuth().options.plugins.find(
      (plugin) => plugin.id === "oauth-provider",
    );
    if (!oauthPlugin || !("rateLimit" in oauthPlugin)) {
      throw new Error("OAuth provider plugin declares no rate-limit rules");
    }

    const registrationRules = oauthPlugin.rateLimit.filter((rule) =>
      rule.pathMatcher(OAUTH_CLIENT_REGISTRATION_PATH),
    );

    expect(registrationRules).toHaveLength(1);
    expect(registrationRules.at(0)).toMatchObject({
      window: AUTH_RATE_LIMITS.oauthClientRegistration.window,
      max: AUTH_RATE_LIMITS.oauthClientRegistration.max,
    });
    // The point of the override: it must differ from the library default.
    expect(AUTH_RATE_LIMITS.oauthClientRegistration.max).toBeGreaterThan(5);
  });

  test("the fragment bridge runs after the OAuth provider", () => {
    const pluginIds = getAuth().options.plugins.map((plugin) => plugin.id);
    const oauthProviderIndex = pluginIds.indexOf("oauth-provider");
    const fragmentBridgeIndex = pluginIds.indexOf(
      "stella-oauth-ui-fragment-bridge",
    );

    expect(oauthProviderIndex).toBeGreaterThanOrEqual(0);
    expect(fragmentBridgeIndex).toBeGreaterThan(oauthProviderIndex);
  });
});

describe("session token responses", () => {
  test("every auth endpoint answer passes the session token redaction", () => {
    const plugins = getAuth().options.plugins;
    const pluginIds = plugins.map((plugin) => plugin.id);
    // Read through the public plugin contract: the census checks what any
    // endpoint matcher receives, not this plugin's literal type.
    const redaction: BetterAuthPlugin | undefined = plugins.find(
      (plugin) => plugin.id === "stella-session-token-redaction",
    );
    const after = redaction?.hooks?.after ?? [];
    expect(after).toHaveLength(1);
    // The matcher accepts every endpoint, so no auth response escapes it.
    expect(
      after.every(({ matcher }) =>
        [
          "/list-sessions",
          "/get-session",
          "/organization/list",
          "/oauth2/token",
          "/oauth2/userinfo",
          "/mcp-handoff/sessions",
          "/x",
        ].every((path) => matcher(fakeCtx(path))),
      ),
    ).toBe(true);
    // Only the refusal log, which records the final answer, runs after it.
    expect(
      pluginIds.slice(pluginIds.indexOf("stella-session-token-redaction") + 1),
    ).toEqual(["stella-auth-refusal-log"]);
  });
});

describe("organization lifecycle hook wiring", () => {
  test("the organization plugin runs the lifecycle hooks against the live analytics sink", async () => {
    // Pins the `...organizationLifecycleHooks` spread inside the plugin
    // config: the hooks themselves are unit-tested in
    // organization-lifecycle-hooks.test.ts; this checks the plugin actually
    // received them and that they reach the analytics singleton.
    const orgPlugin = getAuth().options.plugins.find(
      (plugin) => plugin.id === "organization",
    );
    if (
      !orgPlugin ||
      !("options" in orgPlugin) ||
      !orgPlugin.options ||
      !("organizationHooks" in orgPlugin.options)
    ) {
      throw new Error("organization plugin missing from auth config");
    }
    const hooks = orgPlugin.options.organizationHooks;
    if (
      typeof hooks !== "object" ||
      !("afterCreateOrganization" in hooks) ||
      typeof hooks.afterCreateOrganization !== "function" ||
      !("afterUpdateOrganization" in hooks) ||
      typeof hooks.afterUpdateOrganization !== "function"
    ) {
      throw new Error("organization lifecycle hooks missing from auth config");
    }
    expect(hooks.afterCreateOrganization).toBeFunction();
    const afterUpdateOrganization = hooks.afterUpdateOrganization;
    expect(afterUpdateOrganization).toBeFunction();

    const identify = spyOn(getServerAnalytics(), "identifyOrganizationGroup");
    try {
      const organizationId = orgId();
      await afterUpdateOrganization({
        organization: { id: organizationId, name: "Renamed Org" },
      });
      expect(identify).toHaveBeenCalledWith({
        organizationId,
        properties: { name: "Renamed Org" },
      });
    } finally {
      identify.mockRestore();
    }
  });
});
