import type { HookEndpointContext } from "better-auth";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { member, organization, user } from "@/api/db/auth-schema";
import { contacts, workspaceMembers, workspaces } from "@/api/db/schema";
import {
  getAuth,
  isSixDigitOtpBody,
  isTwoFactorRedirectResponse,
  resolveMemberAuthorization,
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

describe("session freshness", () => {
  test("freshAge stays disabled so day-old sessions can read list-sessions", () => {
    // Better Auth defaults `freshAge` to 1 day and gates `list-sessions` (the
    // account page's active-sessions read) against `session.createdAt`, which
    // `updateAge` never refreshes — so any login older than a day would 403 and
    // blank the profile page. It must stay 0; genuinely sensitive flows are
    // gated by Stella's own OTP/two-factor, not this global knob. See the
    // `freshAge` comment in auth.ts. If this fails, the footgun is back.
    expect(getAuth().options.session?.freshAge).toBe(0);
  });
});
