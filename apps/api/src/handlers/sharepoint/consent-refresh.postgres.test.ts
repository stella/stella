import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  organizationSettings,
  sharepointConnections,
  sharepointOAuthState,
} from "@/api/db/schema";
import { createSharepointOAuthCallback } from "@/api/handlers/sharepoint/oauth-callback";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import {
  grantedCapabilities,
  scopeSet,
} from "@/api/lib/auth/microsoft365/capabilities";
import {
  decryptSharepointSecret,
  encryptSharepointSecret,
} from "@/api/lib/auth/microsoft365/crypto";
import { ensureSharepointAccessToken } from "@/api/lib/auth/microsoft365/graph-token";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;
const noWorkspaces: SafeId<"workspace">[] = [];

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  scopedQuery = createScopedQuery(testDb);
});

afterAll(async () => {
  await testDb
    .delete(sharepointConnections)
    .where(inArray(sharepointConnections.organizationId, [ids.orgA, ids.orgB]));
  await testDb
    .delete(sharepointOAuthState)
    .where(inArray(sharepointOAuthState.organizationId, [ids.orgA, ids.orgB]));
  await releaseTestDb();
});

const safeDbForOwner =
  ({
    organizationId,
    userId,
  }: {
    organizationId: SafeId<"organization">;
    userId: SafeId<"user">;
  }): SafeDb =>
  async (run) =>
    Result.ok(
      await scopedQuery(
        noWorkspaces,
        organizationId,
        async (tx) => await run(asTestRaw(tx)),
        userId,
      ),
    );

test("calendar consent stores only the requested grant and consumes its state once", async () => {
  await testDb.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_catalog.set_config('app.microsoft365_capability_policy_org', ${ids.orgA}, true)`,
    );
    await tx
      .update(organizationSettings)
      .set({
        sharepointConnectionEnabled: false,
        microsoft365CalendarReadEnabled: true,
      })
      .where(eq(organizationSettings.organizationId, ids.orgA));
  });
  const state = `calendar-consent-${createSafeId<"sharepointConnection">()}`;
  await testDb.insert(sharepointOAuthState).values({
    state,
    organizationId: ids.orgA,
    userId: ids.userA1,
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/v1/sharepoint/oauth/callback",
    requestedScope: "User.Read Calendars.Read",
  });
  let exchanges = 0;
  const callback = createSharepointOAuthCallback({
    deploymentEnabled: () => true,
    getSharepointOAuthConfig: () =>
      Result.ok({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
      }),
    exchangeAuthorizationCode: async ({ scope }) => {
      exchanges += 1;
      expect(scopeSet(scope ?? null)).toEqual(["calendars.read", "user.read"]);
      return Result.ok({
        access_token: "calendar-access",
        refresh_token: "calendar-refresh",
        scope: "User.Read Calendars.Read Files.Read.All",
        expires_in: 3600,
      });
    },
    fetchAccountLabel: async () => Result.ok(null),
  });
  const audit: unknown[] = [];
  const requestContext = (stateToken = state) =>
    asTestRaw<Parameters<typeof callback.handler>[0]>({
      route: "/v1/sharepoint/oauth/callback" satisfies ApiRoutePath,
      query: { code: "consent-code", state: stateToken },
      request: new Request(
        "https://api.example.test/v1/sharepoint/oauth/callback",
      ),
      safeDb: safeDbForOwner({ organizationId: ids.orgA, userId: ids.userA1 }),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async (_tx: unknown, event: unknown) => {
        audit.push(event);
      },
    });
  const first = await callback.handler(requestContext());
  if (!(first instanceof Response)) {
    return panic("Expected OAuth callback redirect");
  }
  expect(
    new URL(first.headers.get("Location") ?? "").searchParams.get("status"),
  ).toBe("connected");
  const connection = await testDb.query.sharepointConnections.findFirst({
    where: {
      organizationId: { eq: ids.orgA },
      userId: { eq: ids.userA1 },
    },
  });
  if (!connection) {
    return panic("Expected stored delegated connection");
  }
  expect(scopeSet(connection.scope)).toEqual(["calendars.read", "user.read"]);
  expect(grantedCapabilities(connection.scope)).toEqual(["calendar.read"]);
  expect(
    String(
      (
        await decryptSharepointSecret({
          purpose: "sharepoint_access_token",
          ciphertext: connection.accessTokenEncrypted,
          iv: connection.accessTokenIv,
          organizationId: ids.orgA,
          userId: ids.userA1,
        })
      ).unwrap(),
    ),
  ).toBe("calendar-access");
  expect(audit).toMatchObject([
    {
      metadata: {
        operation: "sharepoint_oauth_connect",
        grantedScopes: ["calendars.read", "user.read"],
        grantedCapabilities: ["calendar.read"],
      },
    },
  ]);
  expect(
    await testDb
      .select({ state: sharepointOAuthState.state })
      .from(sharepointOAuthState)
      .where(eq(sharepointOAuthState.state, state)),
  ).toEqual([]);

  const replay = await callback.handler(requestContext());
  if (!(replay instanceof Response)) {
    return panic("Expected OAuth replay redirect");
  }
  expect(
    new URL(replay.headers.get("Location") ?? "").searchParams.get("reason"),
  ).toBe("expired-state");
  expect(exchanges).toBe(1);

  const rejectedState = `missing-calendar-grant-${createSafeId<"sharepointConnection">()}`;
  await testDb.insert(sharepointOAuthState).values({
    state: rejectedState,
    organizationId: ids.orgA,
    userId: ids.userA1,
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/v1/sharepoint/oauth/callback",
    requestedScope: "User.Read Calendars.Read",
  });
  const missingGrant = createSharepointOAuthCallback({
    deploymentEnabled: () => true,
    getSharepointOAuthConfig: () =>
      Result.ok({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
      }),
    exchangeAuthorizationCode: async () =>
      Result.ok({
        access_token: "ungranted-access",
        scope: "User.Read",
        expires_in: 3600,
      }),
    fetchAccountLabel: async () => Result.ok(null),
  });
  const rejected = await missingGrant.handler(requestContext(rejectedState));
  if (!(rejected instanceof Response)) {
    return panic("Expected missing-grant callback redirect");
  }
  expect(
    new URL(rejected.headers.get("Location") ?? "").searchParams.get("reason"),
  ).toBe("capability-not-granted");
  const retained = await testDb.query.sharepointConnections.findFirst({
    where: { organizationId: { eq: ids.orgA }, userId: { eq: ids.userA1 } },
  });
  expect(retained?.scope).toBe(connection.scope);
  expect(retained?.accessTokenEncrypted).toEqual(
    connection.accessTokenEncrypted,
  );
});

test("a legacy pending file consent cannot become a calendar grant", async () => {
  await testDb
    .update(organizationSettings)
    .set({
      sharepointConnectionEnabled: true,
      microsoft365CalendarReadEnabled: true,
    })
    .where(eq(organizationSettings.organizationId, ids.orgB));
  const state = `legacy-file-consent-${createSafeId<"sharepointConnection">()}`;
  await testDb.insert(sharepointOAuthState).values({
    state,
    organizationId: ids.orgB,
    userId: ids.userA1,
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/v1/sharepoint/oauth/callback",
    requestedScope: null,
  });
  const callback = createSharepointOAuthCallback({
    deploymentEnabled: () => true,
    getSharepointOAuthConfig: () =>
      Result.ok({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
      }),
    exchangeAuthorizationCode: async ({ scope }) => {
      expect(scopeSet(scope ?? null)).not.toContain("calendars.read");
      expect(scopeSet(scope ?? null)).toContain("files.read.all");
      return Result.ok({
        access_token: "legacy-file-access",
        scope: "User.Read Files.Read.All Sites.Read.All Calendars.Read",
        expires_in: 3600,
      });
    },
    fetchAccountLabel: async () => Result.ok(null),
  });
  const response = await callback.handler(
    asTestRaw<Parameters<typeof callback.handler>[0]>({
      route: "/v1/sharepoint/oauth/callback" satisfies ApiRoutePath,
      query: { code: "legacy-code", state },
      request: new Request(
        "https://api.example.test/v1/sharepoint/oauth/callback",
      ),
      safeDb: safeDbForOwner({ organizationId: ids.orgB, userId: ids.userA1 }),
      session: { activeOrganizationId: ids.orgB },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async () => {},
    }),
  );
  if (!(response instanceof Response)) {
    return panic("Expected legacy consent redirect");
  }
  expect(
    new URL(response.headers.get("Location") ?? "").searchParams.get("status"),
  ).toBe("connected");
  const stored = await testDb.query.sharepointConnections.findFirst({
    where: {
      organizationId: { eq: ids.orgB },
      userId: { eq: ids.userA1 },
    },
  });
  expect(grantedCapabilities(stored?.scope ?? null)).toEqual(["files.read"]);
});

const expiredCalendarConnection = async ({
  organizationId,
  userId,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) => {
  await testDb
    .update(organizationSettings)
    .set({ microsoft365CalendarReadEnabled: true })
    .where(eq(organizationSettings.organizationId, organizationId));
  const access = await encryptSharepointSecret({
    organizationId,
    userId,
    purpose: "sharepoint_access_token",
    secret: "expired-access",
  });
  const refresh = await encryptSharepointSecret({
    organizationId,
    userId,
    purpose: "sharepoint_refresh_token",
    secret: "refresh-token",
  });
  const id = createSafeId<"sharepointConnection">();
  await testDb.insert(sharepointConnections).values({
    id,
    organizationId,
    userId,
    accessTokenEncrypted: access.ciphertext,
    accessTokenIv: access.iv,
    refreshTokenEncrypted: refresh.ciphertext,
    refreshTokenIv: refresh.iv,
    status: "connected",
    scope: "Calendars.Read",
    expiresAt: new Date(0),
  });
  const row = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: id } },
  });
  return row ?? panic("Expected expired connection fixture");
};

test("fresh consent restores a reconnect-required connection", async () => {
  await testDb
    .delete(sharepointConnections)
    .where(
      and(
        eq(sharepointConnections.organizationId, ids.orgA),
        eq(sharepointConnections.userId, ids.userA1),
      ),
    );
  const previous = await expiredCalendarConnection({
    organizationId: ids.orgA,
    userId: ids.userA1,
  });
  await testDb
    .update(sharepointConnections)
    .set({ status: "reconnect_required" })
    .where(eq(sharepointConnections.id, previous.id));
  const state = `restore-calendar-consent-${createSafeId<"sharepointConnection">()}`;
  await testDb.insert(sharepointOAuthState).values({
    state,
    organizationId: ids.orgA,
    userId: ids.userA1,
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/v1/sharepoint/oauth/callback",
    requestedScope: "User.Read Calendars.Read",
  });
  const callback = createSharepointOAuthCallback({
    deploymentEnabled: () => true,
    getSharepointOAuthConfig: () =>
      Result.ok({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
      }),
    exchangeAuthorizationCode: async () =>
      Result.ok({
        access_token: "restored-calendar-access",
        scope: "User.Read Calendars.Read",
        expires_in: 3600,
      }),
    fetchAccountLabel: async () => Result.ok(null),
  });
  const response = await callback.handler(
    asTestRaw<Parameters<typeof callback.handler>[0]>({
      route: "/v1/sharepoint/oauth/callback" satisfies ApiRoutePath,
      query: { code: "restore-code", state },
      request: new Request(
        "https://api.example.test/v1/sharepoint/oauth/callback",
      ),
      safeDb: safeDbForOwner({ organizationId: ids.orgA, userId: ids.userA1 }),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async () => {},
    }),
  );
  if (!(response instanceof Response)) {
    return panic("Expected reconnect callback redirect");
  }
  expect(
    new URL(response.headers.get("Location") ?? "").searchParams.get("status"),
  ).toBe("connected");
  const stored = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: previous.id } },
  });
  expect(stored?.status).toBe("connected");
  expect(grantedCapabilities(stored?.scope ?? null)).toEqual(["calendar.read"]);
  expect(stored?.accessTokenEncrypted).not.toEqual(
    previous.accessTokenEncrypted,
  );
});

test("a committed newer consent invalidates an unexpired calendar token snapshot", async () => {
  await testDb
    .delete(sharepointConnections)
    .where(
      and(
        eq(sharepointConnections.organizationId, ids.orgA),
        eq(sharepointConnections.userId, ids.userA1),
      ),
    );
  const seeded = await expiredCalendarConnection({
    organizationId: ids.orgA,
    userId: ids.userA1,
  });
  await testDb
    .update(organizationSettings)
    .set({ sharepointConnectionEnabled: true })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  await testDb
    .update(sharepointConnections)
    .set({ expiresAt: new Date(Date.now() + 3_600_000) })
    .where(eq(sharepointConnections.id, seeded.id));
  const snapshot = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: seeded.id } },
  });
  if (!snapshot) {
    return panic("Expected unexpired connection snapshot");
  }
  const state = `file-only-consent-${createSafeId<"sharepointConnection">()}`;
  await testDb.insert(sharepointOAuthState).values({
    state,
    organizationId: ids.orgA,
    userId: ids.userA1,
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/v1/sharepoint/oauth/callback",
    requestedScope: "User.Read Files.Read.All Sites.Read.All",
  });
  const callback = createSharepointOAuthCallback({
    deploymentEnabled: () => true,
    getSharepointOAuthConfig: () =>
      Result.ok({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
      }),
    exchangeAuthorizationCode: async () =>
      Result.ok({
        access_token: "newer-file-only-access",
        scope: "User.Read Files.Read.All Sites.Read.All",
        expires_in: 3600,
      }),
    fetchAccountLabel: async () => Result.ok(null),
  });
  const response = await callback.handler(
    asTestRaw<Parameters<typeof callback.handler>[0]>({
      route: "/v1/sharepoint/oauth/callback" satisfies ApiRoutePath,
      query: { code: "file-only-code", state },
      request: new Request(
        "https://api.example.test/v1/sharepoint/oauth/callback",
      ),
      safeDb: safeDbForOwner({ organizationId: ids.orgA, userId: ids.userA1 }),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async () => {},
    }),
  );
  if (!(response instanceof Response)) {
    return panic("Expected newer consent redirect");
  }
  expect(
    new URL(response.headers.get("Location") ?? "").searchParams.get("status"),
  ).toBe("connected");
  const newer = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: snapshot.id } },
  });
  if (!newer) {
    return panic("Expected newer file-only consent");
  }
  expect(grantedCapabilities(newer.scope)).toEqual(["files.read"]);
  expect(newer.accessTokenEncrypted).not.toEqual(snapshot.accessTokenEncrypted);

  const result = await ensureSharepointAccessToken({
    connection: { ...snapshot, userId: ids.userA1 },
    safeDb: safeDbForOwner({ organizationId: ids.orgA, userId: ids.userA1 }),
    capability: "calendar.read",
    permit: grantThirdPartyOutboundPermit(),
    recordAuditEvent: async () => {},
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toMatchObject({ status: 409 });
  }
  const retained = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: snapshot.id } },
  });
  expect(retained?.scope).toBe(newer.scope);
  expect(retained?.accessTokenEncrypted).toEqual(newer.accessTokenEncrypted);
});

test("a delayed refresh cannot replace newer consent or its ciphertext", async () => {
  const connection = await expiredCalendarConnection({
    organizationId: ids.orgB,
    userId: ids.userB1,
  });
  const newerScope = "Calendars.Read Files.Read.All Sites.Read.All";
  const newerCiphertext = Buffer.from("newer-consent-ciphertext");
  const result = await ensureSharepointAccessToken(
    {
      connection: { ...connection, userId: ids.userB1 },
      safeDb: safeDbForOwner({ organizationId: ids.orgB, userId: ids.userB1 }),
      capability: "calendar.read",
      permit: grantThirdPartyOutboundPermit(),
      recordAuditEvent: async () => {},
    },
    {
      getSharepointOAuthConfig: () =>
        Result.ok({
          clientId: "client",
          clientSecret: "secret",
          tenantId: "tenant",
        }),
      refreshAccessToken: async ({ scope }) => {
        expect(scopeSet(scope ?? null)).toContain("calendars.read");
        await testDb
          .update(sharepointConnections)
          .set({ accessTokenEncrypted: newerCiphertext, scope: newerScope })
          .where(eq(sharepointConnections.id, connection.id));
        return Result.ok({
          access_token: "stale-refreshed-access",
          scope: "Calendars.Read",
          expires_in: 3600,
        });
      },
    },
  );
  expect(Result.isError(result)).toBe(true);
  const stored = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: connection.id } },
  });
  expect(stored?.scope).toBe(newerScope);
  expect(stored?.accessTokenEncrypted).toEqual(newerCiphertext);

  // A failed stale refresh must not mark that newer consent as disconnected.
  const failed = await ensureSharepointAccessToken(
    {
      connection: { ...connection, userId: ids.userB1 },
      safeDb: safeDbForOwner({ organizationId: ids.orgB, userId: ids.userB1 }),
      capability: "calendar.read",
      permit: grantThirdPartyOutboundPermit(),
      recordAuditEvent: async () => {},
    },
    {
      getSharepointOAuthConfig: () =>
        Result.ok({
          clientId: "client",
          clientSecret: "secret",
          tenantId: "tenant",
        }),
      refreshAccessToken: async () =>
        Result.err(
          new HandlerError({
            status: 502,
            code: "internal_error",
            message: "Provider unavailable",
          }),
        ),
    },
  );
  expect(Result.isError(failed)).toBe(true);
  const retained = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: connection.id } },
  });
  expect(retained?.status).toBe("connected");
  expect(retained?.scope).toBe(newerScope);
  expect(retained?.accessTokenEncrypted).toEqual(newerCiphertext);
});

test("calendar policy revoked during refresh refuses the returned token", async () => {
  const connection = await expiredCalendarConnection({
    organizationId: ids.orgA,
    userId: ids.userA2,
  });
  const audit: unknown[] = [];
  const result = await ensureSharepointAccessToken(
    {
      connection: { ...connection, userId: ids.userA2 },
      safeDb: safeDbForOwner({ organizationId: ids.orgA, userId: ids.userA2 }),
      capability: "calendar.read",
      permit: grantThirdPartyOutboundPermit(),
      recordAuditEvent: async (_tx, event) => {
        audit.push(event);
      },
    },
    {
      getSharepointOAuthConfig: () =>
        Result.ok({
          clientId: "client",
          clientSecret: "secret",
          tenantId: "tenant",
        }),
      refreshAccessToken: async () => {
        await testDb
          .update(organizationSettings)
          .set({ microsoft365CalendarReadEnabled: false })
          .where(eq(organizationSettings.organizationId, ids.orgA));
        return Result.ok({
          access_token: "refreshed-after-revocation",
          scope: "Calendars.Read",
          expires_in: 3600,
        });
      },
    },
  );
  expect(Result.isError(result)).toBe(true);
  const stored = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: connection.id } },
  });
  expect(grantedCapabilities(stored?.scope ?? null)).toEqual([]);
  expect(audit).toMatchObject([
    {
      metadata: {
        operation: "sharepoint_refresh_scope_change",
        oldScopes: ["calendars.read"],
        newScopes: [],
        grantedCapabilities: [],
      },
    },
  ]);
});

test("successful refresh retains the original refresh secret and rejects extra provider grants", async () => {
  const connection = await expiredCalendarConnection({
    organizationId: ids.orgA,
    userId: ids.userAdmin,
  });
  const result = await ensureSharepointAccessToken(
    {
      connection: { ...connection, userId: ids.userAdmin },
      safeDb: safeDbForOwner({
        organizationId: ids.orgA,
        userId: ids.userAdmin,
      }),
      capability: "calendar.read",
      permit: grantThirdPartyOutboundPermit(),
      recordAuditEvent: async () => {},
    },
    {
      getSharepointOAuthConfig: () =>
        Result.ok({
          clientId: "client",
          clientSecret: "secret",
          tenantId: "tenant",
        }),
      refreshAccessToken: async ({ scope }) => {
        expect(scopeSet(scope ?? null)).not.toContain("files.read.all");
        return Result.ok({
          access_token: "fresh-calendar-access",
          scope: "User.Read Calendars.Read Files.Read.All",
          expires_in: 3600,
        });
      },
    },
  );
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    return panic("Expected usable refreshed token");
  }
  expect(String(result.value)).toBe("fresh-calendar-access");
  const stored = await testDb.query.sharepointConnections.findFirst({
    where: { id: { eq: connection.id } },
  });
  if (!stored) {
    return panic("Expected refreshed connection");
  }
  expect(grantedCapabilities(stored.scope)).toEqual(["calendar.read"]);
  expect(scopeSet(stored.scope)).not.toContain("files.read.all");
  expect(stored.refreshTokenEncrypted).toEqual(
    connection.refreshTokenEncrypted,
  );
  expect(stored.refreshTokenIv).toEqual(connection.refreshTokenIv);
  expect(
    String(
      (
        await decryptSharepointSecret({
          purpose: "sharepoint_access_token",
          ciphertext: stored.accessTokenEncrypted,
          iv: stored.accessTokenIv,
          organizationId: ids.orgA,
          userId: ids.userAdmin,
        })
      ).unwrap(),
    ),
  ).toBe("fresh-calendar-access");
});
