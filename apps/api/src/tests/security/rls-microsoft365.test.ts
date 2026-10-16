import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  microsoft365Connections,
  microsoft365OAuthState,
  organizationSettings,
} from "@/api/db/schema";
import { grantedCapabilities } from "@/api/handlers/microsoft365/capabilities";
import { encryptMicrosoft365Secret } from "@/api/handlers/microsoft365/crypto";
import { ensureMicrosoft365AccessToken } from "@/api/handlers/microsoft365/graph-client";
import { createMicrosoft365OAuthCallback } from "@/api/handlers/microsoft365/oauth-callback";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
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

const enc = () => Buffer.from("ciphertext");
const iv = () => Buffer.alloc(12);

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  scopedQuery = createScopedQuery(testDb);

  await testDb.insert(microsoft365Connections).values([
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

  await testDb.insert(microsoft365OAuthState).values([
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
  await testDb.insert(microsoft365OAuthState).values({
    state,
    organizationId: ids.orgA,
    userId: ids.userA1,
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/v1/microsoft365/oauth/callback",
  });
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
  const response = await callback.handler(
    asTestRaw({
      query: { code: "consent-code", state },
      request: new Request(
        "https://api.example.test/v1/microsoft365/oauth/callback",
      ),
      safeDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      recordAuditEvent: async () => {},
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
    purpose: "microsoft365_access_token",
    secret: "expired-access",
  });
  const refresh = await encryptMicrosoft365Secret({
    organizationId: ids.orgA,
    userId: ids.userA1,
    purpose: "microsoft365_refresh_token",
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
