import type { HookEndpointContext } from "better-auth";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";

import { member, organization, user } from "@/api/db/auth-schema";
import { contacts, workspaceMembers, workspaces } from "@/api/db/schema";
import { getAnalytics } from "@/api/lib/analytics/client";
import {
  AUTHORITATIVE_SESSION_PATHS,
  assertNewAccountEmailAllowedForCreation,
  ensureDisplayName,
  getEmailOtpMinimumResponseDuration,
  getAuth,
  getNewAccountEmailOtpAction,
  isSixDigitOtpBody,
  isTwoFactorRedirectResponse,
  NEW_ACCOUNT_OTP_RATE_LIMIT_MODE,
  runEmailOtpRequestOnResponseSchedule,
  resolveMemberAuthorization,
  resolveAuthoritativeSessionForSensitiveAuthPath,
  resolveWorkspaceRealtimeAudience,
  SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
  TWO_FACTOR_MANAGE_PATHS,
  withStellaTwoFactorSignInGate,
} from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

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

beforeAll(async () => {
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

    expect(authorization).toEqual({ role: "owner", workspace: null });
  });

  test("a member belonging to the org but to no workspace still resolves", async () => {
    const authorization = await resolveMemberAuthorization(
      { organizationId: orgFull, userId: loneMemberInFull },
      testDb,
    );
    expect(authorization).toEqual({ role: "member", workspace: null });
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
  test("returns only users with current access to the target workspace", async () => {
    const candidates = [
      ownerInFull,
      memberInFull,
      loneMemberInFull,
      ownerInEmpty,
      strangerUser,
    ];

    const clientMatterAudience = await resolveWorkspaceRealtimeAudience(
      { userIds: candidates, workspaceId: clientWorkspaceId },
      testDb,
    );
    const personalMatterAudience = await resolveWorkspaceRealtimeAudience(
      { userIds: candidates, workspaceId: memberPersonalWorkspaceId },
      testDb,
    );

    expect(clientMatterAudience).toEqual(new Set([ownerInFull]));
    expect(personalMatterAudience).toEqual(new Set([memberInFull]));
  });
});

// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the matcher under test only reads `ctx.path`; the other HookEndpointContext members (context, headers, ...) are irrelevant here and a full instance is heavy to construct for a pure-function unit test.
const fakeCtx = (path: string) => ({ path }) as HookEndpointContext;

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
  const sensitiveCtx = (path: string) => ({
    path,
    request: new Request(`http://localhost/api/auth${path}`),
  });

  test("loads storage-backed session state before OAuth authorization can mint a durable token", async () => {
    const resolvedPaths: string[] = [];

    const handled = await resolveAuthoritativeSessionForSensitiveAuthPath({
      ctx: sensitiveCtx("/oauth2/authorize"),
      resolveSession: async (ctx) => {
        resolvedPaths.push(ctx.path);
        return null;
      },
    });

    expect(handled).toBe(true);
    expect(resolvedPaths).toEqual(["/oauth2/authorize"]);
  });

  test("uses the same authoritative session boundary before two-factor rotation", async () => {
    const resolvedPaths: string[] = [];

    const handled = await resolveAuthoritativeSessionForSensitiveAuthPath({
      ctx: sensitiveCtx("/two-factor/enable"),
      resolveSession: async (ctx) => {
        resolvedPaths.push(ctx.path);
        return null;
      },
    });

    expect(handled).toBe(true);
    expect(resolvedPaths).toEqual(["/two-factor/enable"]);
  });

  test("keeps ordinary endpoints on the cookie-cache fast path", async () => {
    let resolved = false;

    expect(
      await resolveAuthoritativeSessionForSensitiveAuthPath({
        ctx: sensitiveCtx("/get-session"),
        resolveSession: async () => {
          resolved = true;
          return null;
        },
      }),
    ).toBe(false);
    expect(resolved).toBe(false);
  });

  test("declares both OAuth code-flow endpoints as authoritative", () => {
    expect(AUTHORITATIVE_SESSION_PATHS).toEqual(
      new Set([
        ...TWO_FACTOR_MANAGE_PATHS,
        "/oauth2/authorize",
        "/oauth2/consent",
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
          { accountExists: async () => accountExists },
        ),
      ),
    );
    expect(actions).toEqual([{ type: "continue" }, { type: "continue" }]);
  });

  test("rejects a disposable address when creating its account", async () => {
    const rejection: unknown = await Promise.resolve()
      .then(() =>
        assertNewAccountEmailAllowedForCreation({
          email: "blocked@mailinator.com",
          path: "/sign-in/email-otp",
        }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toMatchObject({
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
      assertNewAccountEmailAllowedForCreation({
        email: "provider-user@mailinator.com",
        path,
      });
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

  test("pads only production sign-in OTP requests", () => {
    expect(
      getEmailOtpMinimumResponseDuration({
        isDev: false,
        path: "/email-otp/send-verification-otp",
        type: "sign-in",
      }),
    ).toBeGreaterThan(0);

    for (const input of [
      {
        isDev: true,
        path: "/email-otp/send-verification-otp",
        type: "sign-in",
      },
      {
        isDev: false,
        path: "/email-otp/send-verification-otp",
        type: "forget-password",
      },
      { isDev: false, path: "/email-otp/verify-email", type: "sign-in" },
    ]) {
      expect(getEmailOtpMinimumResponseDuration(input)).toBe(0);
    }
  });
});

describe("session freshness", () => {
  test("freshAge stays disabled so day-old sessions can read list-sessions", () => {
    // Better Auth defaults `freshAge` to 1 day and gates `list-sessions` (the
    // account page's active-sessions read) against `session.createdAt`, which
    // `updateAge` never refreshes — so any login older than a day would 403 and
    // blank the profile page. It must stay 0; genuinely sensitive flows are
    // gated by Stella's own OTP/two-factor, not this global knob. See the
    // `freshAge` comment in auth.ts. If this fails, the footgun is back.
    expect(getAuth().options.session.freshAge).toBe(0);
  });

  test("the other freshness-gated endpoint (unlink-account) stays disabled", () => {
    // `freshAge: 0` is only safe because the one other freshness-gated endpoint
    // Better Auth mounts, `/unlink-account`, is not a Stella feature and is
    // disabled. If it were re-exposed, relaxing freshAge would let an old
    // session unlink a provider. Keep these two decisions coupled.
    expect(getAuth().options.disabledPaths).toContain("/unlink-account");
  });

  test("session cookie cache stays enabled with its pinned revocation window", () => {
    // The cookie cache is what keeps `getSession` off the database for the
    // huge majority of API requests (see the `cookieCache` comment in
    // auth.ts). Its `maxAge` is also the upper bound on how long a REVOKED
    // session's already-issued cookie keeps working, so the window is a
    // security decision, not a tuning knob: widen it deliberately, in both
    // this test and the SESSION_COOKIE_CACHE_MAX_AGE_SECONDS constant,
    // never by dependency-default drift (better-auth defaults to 300s).
    expect(getAuth().options.session.cookieCache).toEqual({
      enabled: true,
      maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
    });
    expect(SESSION_COOKIE_CACHE_MAX_AGE_SECONDS).toBe(60);
  });
});

describe("OAuth resource provisioning", () => {
  test("committed migrations remain the only resource seed owner", () => {
    const oauthPlugin = getAuth().options.plugins.find(
      (plugin) => plugin.id === "oauth-provider",
    );
    if (!oauthPlugin || !("options" in oauthPlugin)) {
      throw new Error("OAuth provider plugin missing from auth config");
    }

    expect(oauthPlugin.options.resourceSeedMode).toBe("none");
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
    if (!orgPlugin || !("options" in orgPlugin)) {
      throw new Error("organization plugin missing from auth config");
    }
    const hooks = orgPlugin.options.organizationHooks;
    expect(hooks.afterCreateOrganization).toBeFunction();
    expect(hooks.afterUpdateOrganization).toBeFunction();

    const identify = spyOn(getAnalytics(), "identifyOrganizationGroup");
    try {
      const organizationId = orgId();
      await hooks.afterUpdateOrganization({
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
