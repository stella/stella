import { Result, panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  microsoft365Connections,
  microsoft365OAuthState,
  organizationSettings,
} from "@/api/db/schema";
import { grantedCapabilities } from "@/api/handlers/microsoft365/capabilities";
import {
  MICROSOFT365_TOKEN_PURPOSE,
  decryptMicrosoft365Secret,
  encryptMicrosoft365Secret,
} from "@/api/handlers/microsoft365/crypto";
import { ensureMicrosoft365AccessToken } from "@/api/handlers/microsoft365/graph-client";
import { createMicrosoft365OAuthCallback } from "@/api/handlers/microsoft365/oauth-callback";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
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
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

// The Microsoft 365 token tables are covered by a cross-tenant *waiver* in the
// handler matrix (their only reads are per-user+org connection state). This
// focused test still proves the org+user RLS holds at the row level: neither a
// different org nor a same-org non-owner can read, mutate, or delete another
// user's stored delegated tokens.

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;

const connOrgAUserA1 = createSafeId<"microsoft365Connection">();
const connOrgBUserB1 = createSafeId<"microsoft365Connection">();
const stateOrgAUserA1 = `spstate-a-${connOrgAUserA1}`;
const stateOrgBUserB1 = `spstate-b-${connOrgBUserB1}`;

const withTokenOwner = async <T>(
  run: (tx: TestDatabaseTransaction) => Promise<T>,
) =>
  await testDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE microsoft365_test_owner`);
    return await run(tx);
  });

const enc = () => Buffer.from("ciphertext");
const iv = () => Buffer.alloc(12);

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  scopedQuery = createScopedQuery(testDb);

  await testDb.execute(
    sql`CREATE ROLE microsoft365_test_owner NOLOGIN NOSUPERUSER NOBYPASSRLS`,
  );
  await testDb.execute(
    sql`ALTER TABLE sharepoint_connections OWNER TO microsoft365_test_owner`,
  );
  await testDb.execute(
    sql`ALTER TABLE sharepoint_oauth_state OWNER TO microsoft365_test_owner`,
  );
  await testDb.execute(
    sql`ALTER TABLE sharepoint_connections FORCE ROW LEVEL SECURITY`,
  );
  await testDb.execute(
    sql`ALTER TABLE sharepoint_oauth_state FORCE ROW LEVEL SECURITY`,
  );
  await testDb.transaction(async (owner) => {
    await owner.execute(sql`SET LOCAL ROLE microsoft365_test_owner`);
    await owner.insert(microsoft365Connections).values([
      {
        id: connOrgAUserA1,
        organizationId: ids.orgA,
        userId: ids.userA1,
        accessTokenEncrypted: enc(),
        accessTokenIv: iv(),
        status: "connected",
      },
      {
        id: connOrgBUserB1,
        organizationId: ids.orgB,
        userId: ids.userB1,
        accessTokenEncrypted: enc(),
        accessTokenIv: iv(),
        status: "connected",
      },
    ]);

    await owner.insert(microsoft365OAuthState).values([
      {
        state: stateOrgAUserA1,
        organizationId: ids.orgA,
        userId: ids.userA1,
        codeVerifier: "verifier",
        redirectUri: "https://api.example.test/v1/microsoft365/oauth/callback",
      },
      {
        state: stateOrgBUserB1,
        organizationId: ids.orgB,
        userId: ids.userB1,
        codeVerifier: "verifier",
        redirectUri: "https://api.example.test/v1/microsoft365/oauth/callback",
      },
    ]);
  });
});

afterAll(async () => {
  await testDb
    .delete(microsoft365Connections)
    .where(eq(microsoft365Connections.id, connOrgAUserA1));
  await testDb
    .delete(microsoft365Connections)
    .where(eq(microsoft365Connections.id, connOrgBUserB1));
  await releaseTestDb();
});

const noWorkspaces: SafeId<"workspace">[] = [];

describe("microsoft365_connections RLS", () => {
  test("owner sees only their own connection", async () => {
    const rows = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .select({ id: microsoft365Connections.id })
          .from(microsoft365Connections),
      ids.userA1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(connOrgAUserA1);
  });

  test("a different org cannot read another org's connection", async () => {
    const rows = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .select({ id: microsoft365Connections.id })
          .from(microsoft365Connections)
          .where(eq(microsoft365Connections.id, connOrgBUserB1)),
      ids.userA1,
    );
    expect(rows).toHaveLength(0);
  });

  test("a same-org non-owner cannot read the owner's connection", async () => {
    const rows = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .select({ id: microsoft365Connections.id })
          .from(microsoft365Connections),
      ids.userA2,
    );
    expect(rows).toHaveLength(0);
  });

  test("a different org cannot delete another org's connection", async () => {
    const deleted = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .delete(microsoft365Connections)
          .where(eq(microsoft365Connections.id, connOrgBUserB1))
          .returning({ id: microsoft365Connections.id }),
      ids.userA1,
    );
    expect(deleted).toHaveLength(0);

    const survivor = await testDb
      .select({ id: microsoft365Connections.id })
      .from(microsoft365Connections)
      .where(eq(microsoft365Connections.id, connOrgBUserB1));
    expect(survivor).toHaveLength(1);
  });

  test("a same-org non-owner cannot update the owner's connection", async () => {
    const updated = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .update(microsoft365Connections)
          .set({ status: "reconnect_required" })
          .where(eq(microsoft365Connections.id, connOrgAUserA1))
          .returning({ id: microsoft365Connections.id }),
      ids.userA2,
    );
    expect(updated).toHaveLength(0);

    const unchanged = await testDb
      .select({ status: microsoft365Connections.status })
      .from(microsoft365Connections)
      .where(eq(microsoft365Connections.id, connOrgAUserA1));
    expect(unchanged[0]?.status).toBe("connected");
  });
});

describe("microsoft365_oauth_state RLS", () => {
  test("owner sees only their own pending state", async () => {
    const rows = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .select({ state: microsoft365OAuthState.state })
          .from(microsoft365OAuthState),
      ids.userA1,
    );
    expect(rows.map((r) => r.state)).toEqual([stateOrgAUserA1]);
  });

  test("a same-org non-owner cannot delete the owner's pending state", async () => {
    const deleted = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .delete(microsoft365OAuthState)
          .where(eq(microsoft365OAuthState.state, stateOrgAUserA1))
          .returning({ state: microsoft365OAuthState.state }),
      ids.userA2,
    );
    expect(deleted).toHaveLength(0);

    const survivor = await testDb
      .select({ state: microsoft365OAuthState.state })
      .from(microsoft365OAuthState)
      .where(eq(microsoft365OAuthState.state, stateOrgAUserA1));
    expect(survivor).toHaveLength(1);
  });
});

test("callback persists the scope returned by consent and consumes the bound state", async () => {
  const state = `calendar-consent-${createSafeId<"microsoft365Connection">()}`;
  await testDb
    .update(organizationSettings)
    .set({
      microsoft365ConnectionEnabled: true,
      microsoft365CalendarReadEnabled: true,
    })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  await withTokenOwner(
    async (owner) =>
      await owner.insert(microsoft365OAuthState).values({
        state,
        organizationId: ids.orgA,
        userId: ids.userA1,
        codeVerifier: "verifier",
        redirectUri: "https://api.example.test/v1/microsoft365/oauth/callback",
        requestedScope: "User.Read Calendars.Read",
      }),
  );
  const callback = createMicrosoft365OAuthCallback({
    assertMicrosoft365ConnectionEnabled: async () => Result.ok(undefined),
    getMicrosoft365OAuthConfig: () =>
      Result.ok({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
      }),
    exchangeAuthorizationCode: async () =>
      Result.ok({
        access_token: "calendar-access",
        refresh_token: "calendar-refresh",
        scope: "User.Read Calendars.Read",
        expires_in: 3600,
      }),
    fetchAccountLabel: async () => Result.ok("calendar@example.test"),
  });
  const safeDb: SafeDb = async (run) =>
    Result.ok(
      await scopedQuery(
        noWorkspaces,
        ids.orgA,
        async (tx) => await run(asTestRaw(tx)),
        ids.userA1,
      ),
    );
  const audit: unknown[] = [];
  const response = await callback.handler(
    asTestRaw({
      query: { code: "consent-code", state },
      request: new Request(
        "https://api.example.test/v1/microsoft365/oauth/callback",
      ),
      safeDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async (_tx: unknown, event: unknown) => {
        audit.push(event);
      },
    }),
  );
  expect(response).toBeInstanceOf(Response);
  if (response instanceof Response) {
    expect(response.headers.get("Location")).toContain(
      "microsoft365Status=connected",
    );
  }
  const row = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  expect(row?.scope).toBe("User.Read Calendars.Read");
  expect(audit).toMatchObject([
    {
      metadata: {
        operation: "microsoft365_oauth_connect",
        grantedScopes: ["calendars.read", "user.read"],
        grantedCapabilities: ["calendar.read"],
      },
    },
  ]);
  expect(grantedCapabilities(row?.scope ?? null)).toEqual(["calendar.read"]);
  const pending = await testDb
    .select()
    .from(microsoft365OAuthState)
    .where(eq(microsoft365OAuthState.state, state));
  expect(pending).toHaveLength(0);
});

test("a token refresh preserves a newer consent grant", async () => {
  const access = await encryptMicrosoft365Secret({
    organizationId: ids.orgA,
    userId: ids.userA1,
    purpose: MICROSOFT365_TOKEN_PURPOSE.access,
    secret: "expired-access",
  });
  const refresh = await encryptMicrosoft365Secret({
    organizationId: ids.orgA,
    userId: ids.userA1,
    purpose: MICROSOFT365_TOKEN_PURPOSE.refresh,
    secret: "refresh",
  });
  await testDb
    .update(microsoft365Connections)
    .set({
      accessTokenEncrypted: access.ciphertext,
      accessTokenIv: access.iv,
      refreshTokenEncrypted: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      status: "connected",
      scope: "Calendars.Read",
      expiresAt: new Date(0),
    })
    .where(eq(microsoft365Connections.id, connOrgAUserA1));
  const connection = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  if (!connection) {
    throw new Error("Expected connection fixture");
  }
  const safeDb: SafeDb = async (run) =>
    Result.ok(
      await scopedQuery(
        noWorkspaces,
        ids.orgA,
        async (tx) => await run(asTestRaw(tx)),
        ids.userA1,
      ),
    );
  const upgraded = "Calendars.Read Files.Read.All Sites.Read.All";
  const result = await ensureMicrosoft365AccessToken(
    {
      connection: { ...connection, userId: ids.userA1 },
      safeDb,
      capability: "calendar.read",
      recordAuditEvent: async () => {},
    },
    {
      getMicrosoft365OAuthConfig: () =>
        Result.ok({
          clientId: "client",
          clientSecret: "secret",
          tenantId: "tenant",
        }),
      refreshAccessToken: async () => {
        await testDb
          .update(microsoft365Connections)
          .set({
            accessTokenEncrypted: Buffer.from("newer-consent"),
            scope: upgraded,
          })
          .where(eq(microsoft365Connections.id, connOrgAUserA1));
        return Result.ok({
          access_token: "refreshed-access",
          scope: "Calendars.Read",
          expires_in: 3600,
        });
      },
    },
  );
  expect(Result.isError(result)).toBe(true);
  const current = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  expect(current?.scope).toBe(upgraded);
  expect(current?.accessTokenEncrypted).toEqual(Buffer.from("newer-consent"));
});

test("an existing delegated connection refreshes its original ciphertext and retains granted scopes", async () => {
  const access = await encryptContent(
    ids.orgA,
    JSON.stringify({
      purpose: "sharepoint_access_token",
      secret: "legacy-access",
      userId: ids.userA1,
    }),
  );
  const refresh = await encryptContent(
    ids.orgA,
    JSON.stringify({
      purpose: "sharepoint_refresh_token",
      secret: "legacy-refresh",
      userId: ids.userA1,
    }),
  );
  const scope = "User.Read Files.Read.All Sites.Read.All";
  await testDb
    .update(microsoft365Connections)
    .set({
      accessTokenEncrypted: access.ciphertext,
      accessTokenIv: access.iv,
      refreshTokenEncrypted: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      status: "connected",
      scope,
      expiresAt: new Date(0),
    })
    .where(eq(microsoft365Connections.id, connOrgAUserA1));
  const connection = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  if (!connection) {
    panic("Expected existing delegated connection fixture");
  }
  const safeDb: SafeDb = async (run) =>
    Result.ok(
      await scopedQuery(
        noWorkspaces,
        ids.orgA,
        async (tx) => await run(asTestRaw(tx)),
        ids.userA1,
      ),
    );
  const renewed = await ensureMicrosoft365AccessToken(
    {
      connection: { ...connection, userId: ids.userA1 },
      safeDb,
      capability: "files.read",
      recordAuditEvent: async () => {},
    },
    {
      getMicrosoft365OAuthConfig: () =>
        Result.ok({
          clientId: "client",
          clientSecret: "secret",
          tenantId: "tenant",
        }),
      refreshAccessToken: async ({ refreshToken }) => {
        expect(String(refreshToken)).toBe("legacy-refresh");
        return Result.ok({
          access_token: "renewed-access",
          refresh_token: "renewed-refresh",
          expires_in: 3600,
        });
      },
    },
  );
  expect(String(renewed.unwrap())).toBe("renewed-access");
  const current = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  if (!current?.refreshTokenEncrypted || !current.refreshTokenIv) {
    panic("Expected refreshed delegated credentials");
  }
  expect(current.scope).toBe(scope);
  expect(grantedCapabilities(current.scope)).toEqual(["files.read"]);
  const storedRefresh = await decryptMicrosoft365Secret({
    ciphertext: current.refreshTokenEncrypted,
    iv: current.refreshTokenIv,
    organizationId: ids.orgA,
    userId: ids.userA1,
    purpose: MICROSOFT365_TOKEN_PURPOSE.refresh,
  });
  expect(String(storedRefresh.unwrap())).toBe("renewed-refresh");
});

test("a non-bypass table owner removes delegated credentials while another organization cannot", async () => {
  const id = createSafeId<"microsoft365Connection">();
  const state = `owner-cleanup-${id}`;
  await testDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE microsoft365_test_owner`);
    const roles = await tx.execute(
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(roles.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await tx.insert(microsoft365Connections).values({
      id,
      organizationId: ids.orgB,
      userId: ids.userA2,
      accessTokenEncrypted: enc(),
      accessTokenIv: iv(),
      status: "connected",
    });
    await tx.insert(microsoft365OAuthState).values({
      state,
      organizationId: ids.orgB,
      userId: ids.userA2,
      codeVerifier: "verifier",
      redirectUri: "https://api.example.test/callback",
    });
    await tx.execute(sql`SET LOCAL ROLE stella`);
    await tx.execute(
      sql`SELECT set_config('app.organization_id', ${ids.orgA}, true), set_config('app.user_id', ${ids.userA1}, true)`,
    );
    expect(
      await tx
        .delete(microsoft365Connections)
        .where(eq(microsoft365Connections.id, id))
        .returning({ id: microsoft365Connections.id }),
    ).toEqual([]);
    expect(
      await tx
        .delete(microsoft365OAuthState)
        .where(eq(microsoft365OAuthState.state, state))
        .returning({ state: microsoft365OAuthState.state }),
    ).toEqual([]);
    await tx.execute(sql`SET LOCAL ROLE microsoft365_test_owner`);
    expect(
      await tx
        .delete(microsoft365Connections)
        .where(eq(microsoft365Connections.id, id))
        .returning({ id: microsoft365Connections.id }),
    ).toEqual([{ id }]);
    expect(
      await tx
        .delete(microsoft365OAuthState)
        .where(eq(microsoft365OAuthState.state, state))
        .returning({ state: microsoft365OAuthState.state }),
    ).toEqual([{ state }]);
    expect(
      await tx
        .select()
        .from(microsoft365Connections)
        .where(eq(microsoft365Connections.id, id)),
    ).toEqual([]);
    expect(
      await tx
        .select()
        .from(microsoft365OAuthState)
        .where(eq(microsoft365OAuthState.state, state)),
    ).toEqual([]);
  });
});

const runConsent = async ({
  requestedScope,
  returnedScope,
  filesEnabled,
}: {
  requestedScope: string;
  returnedScope: string;
  filesEnabled: boolean;
}) => {
  const state = `consent-${createSafeId<"microsoft365Connection">()}`;
  await testDb
    .update(organizationSettings)
    .set({
      microsoft365ConnectionEnabled: true,
      microsoft365CalendarReadEnabled: true,
      microsoft365FilesReadEnabled: filesEnabled,
    })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  await withTokenOwner(
    async (owner) =>
      await owner.insert(microsoft365OAuthState).values({
        state,
        organizationId: ids.orgA,
        userId: ids.userA1,
        codeVerifier: "verifier",
        redirectUri: "https://api.example.test/callback",
        requestedScope,
      }),
  );
  const callback = createMicrosoft365OAuthCallback({
    assertMicrosoft365ConnectionEnabled: async () => Result.ok(undefined),
    getMicrosoft365OAuthConfig: () =>
      Result.ok({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
      }),
    exchangeAuthorizationCode: async () =>
      Result.ok({
        access_token: "access",
        refresh_token: "refresh",
        scope: returnedScope,
        expires_in: 3600,
      }),
    fetchAccountLabel: async () => Result.ok("calendar@example.test"),
  });
  const safeDb: SafeDb = async (run) =>
    Result.ok(
      await scopedQuery(
        noWorkspaces,
        ids.orgA,
        async (tx) => await run(asTestRaw(tx)),
        ids.userA1,
      ),
    );
  return await callback.handler(
    asTestRaw({
      query: { code: "code", state },
      request: new Request("https://api.example.test/callback"),
      safeDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent: async () => {},
    }),
  );
};

test("consent reports a requested capability that was not granted and preserves the existing connection", async () => {
  const before = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  const response = await runConsent({
    requestedScope: "User.Read Calendars.Read",
    returnedScope: "User.Read",
    filesEnabled: true,
  });
  expect(response).toBeInstanceOf(Response);
  if (!(response instanceof Response)) {
    panic("Expected consent redirect");
  }
  expect(
    new URL(response.headers.get("Location") ?? "").searchParams.get(
      "microsoft365Reason",
    ),
  ).toBe("capability-not-granted");
  const after = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  expect(after).toEqual(before);
});

test("consent stores only requested scopes within the current organization policy", async () => {
  const response = await runConsent({
    requestedScope: "User.Read Calendars.Read Files.Read.All Sites.Read.All",
    returnedScope:
      "User.Read Calendars.Read Files.Read.All Sites.Read.All Mail.Read",
    filesEnabled: false,
  });
  // The disabled requested file capability is reported, rather than claiming success.
  if (!(response instanceof Response)) {
    panic("Expected consent redirect");
  }
  expect(
    new URL(response.headers.get("Location") ?? "").searchParams.get(
      "microsoft365Reason",
    ),
  ).toBe("capability-not-granted");
  const connected = await runConsent({
    requestedScope: "User.Read Calendars.Read",
    returnedScope:
      "User.Read Calendars.Read Files.Read.All Sites.Read.All Mail.Read",
    filesEnabled: false,
  });
  if (!(connected instanceof Response)) {
    panic("Expected consent redirect");
  }
  expect(
    new URL(connected.headers.get("Location") ?? "").searchParams.get(
      "microsoft365Status",
    ),
  ).toBe("connected");
  const row = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  expect(row?.scope).toBe("User.Read Calendars.Read");
});

test("a refreshed scope set change is audited with the credential update", async () => {
  await withTokenOwner(
    async (owner) =>
      await owner
        .update(microsoft365Connections)
        .set({
          scope: "User.Read Files.Read.All Sites.Read.All",
          expiresAt: new Date(0),
        })
        .where(eq(microsoft365Connections.id, connOrgAUserA1)),
  );
  const connection = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  if (!connection) {
    panic("Expected refresh connection");
  }
  const safeDb: SafeDb = async (run) =>
    Result.ok(
      await scopedQuery(
        noWorkspaces,
        ids.orgA,
        async (tx) => await run(asTestRaw(tx)),
        ids.userA1,
      ),
    );
  const audit: unknown[] = [];
  const refreshed = await ensureMicrosoft365AccessToken(
    {
      connection: { ...connection, userId: ids.userA1 },
      safeDb,
      capability: "files.read",
      recordAuditEvent: async (_tx, event) => {
        audit.push(event);
      },
    },
    {
      getMicrosoft365OAuthConfig: () =>
        Result.ok({
          clientId: "client",
          clientSecret: "secret",
          tenantId: "tenant",
        }),
      refreshAccessToken: async () =>
        Result.ok({
          access_token: "reduced-access",
          scope: "User.Read Files.Read.All",
          expires_in: 3600,
        }),
    },
  );
  expect(Result.isError(refreshed)).toBe(true);
  expect(audit).toMatchObject([
    {
      metadata: {
        operation: "microsoft365_refresh_scope_change",
        oldScopes: ["files.read.all", "sites.read.all", "user.read"],
        newScopes: ["files.read.all", "user.read"],
        grantedCapabilities: [],
      },
    },
  ]);
  const current = await testDb.query.microsoft365Connections.findFirst({
    where: { id: { eq: connOrgAUserA1 } },
  });
  expect(current?.scope).toBe("User.Read Files.Read.All");
});
