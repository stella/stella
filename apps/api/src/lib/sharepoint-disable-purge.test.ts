import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  organizationSettings,
  sharepointConnections,
  sharepointOAuthState,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import disconnectSharepoint from "@/api/handlers/sharepoint/disconnect";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { purgeSharepointForOrg } from "@/api/lib/sharepoint-disable-purge";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

const enc = () => Buffer.from("ciphertext");
const iv = () => Buffer.alloc(12);

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  // orgA opts in; two members hold connections so the purge must cross users.
  // orgB stays disabled (schema default) — the disconnect test runs against it.
  await testDb
    .update(organizationSettings)
    .set({ sharepointConnectionEnabled: true })
    .where(eq(organizationSettings.organizationId, ids.orgA));

  await testDb.insert(sharepointConnections).values([
    {
      id: createSafeId<"sharepointConnection">(),
      organizationId: ids.orgA,
      userId: ids.userA1,
      accessTokenEncrypted: enc(),
      accessTokenIv: iv(),
      refreshTokenEncrypted: enc(),
      refreshTokenIv: iv(),
      status: "connected",
    },
    {
      id: createSafeId<"sharepointConnection">(),
      organizationId: ids.orgA,
      userId: ids.userA2,
      accessTokenEncrypted: enc(),
      accessTokenIv: iv(),
      status: "connected",
    },
    {
      id: createSafeId<"sharepointConnection">(),
      organizationId: ids.orgB,
      userId: ids.userB1,
      accessTokenEncrypted: enc(),
      accessTokenIv: iv(),
      status: "connected",
    },
  ]);

  await testDb.insert(sharepointOAuthState).values({
    state: `spstate-${ids.orgA}`,
    organizationId: ids.orgA,
    userId: ids.userA1,
    codeVerifier: "verifier",
    redirectUri: "https://api.example.test/v1/sharepoint/oauth/callback",
  });
});

afterAll(async () => {
  await releaseTestDb();
});

describe("disabling the org toggle revokes stored tokens", () => {
  test("purges every member's connection and pending state, sets the toggle false, and audits", async () => {
    const events: AuditEvent[] = [];
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      for (const one of Array.isArray(event) ? event : [event]) {
        events.push(one);
      }
    };

    const result = await testDb.transaction(
      async (tx) =>
        await purgeSharepointForOrg(asTestRaw<Transaction>(tx), {
          organizationId: ids.orgA,
          recordAuditEvent,
        }),
    );

    // Both orgA members' connections plus the pending state are revoked.
    expect(result.purgedConnections).toBe(2);
    expect(result.purgedPendingStates).toBe(1);

    const remaining = await testDb
      .select({ id: sharepointConnections.id })
      .from(sharepointConnections)
      .where(eq(sharepointConnections.organizationId, ids.orgA));
    expect(remaining).toHaveLength(0);

    const pending = await testDb
      .select({ state: sharepointOAuthState.state })
      .from(sharepointOAuthState)
      .where(eq(sharepointOAuthState.organizationId, ids.orgA));
    expect(pending).toHaveLength(0);

    const settings = await testDb
      .select({ enabled: organizationSettings.sharepointConnectionEnabled })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(settings[0]?.enabled).toBe(false);

    // Another org's connection is untouched.
    const orgBConnections = await testDb
      .select({ id: sharepointConnections.id })
      .from(sharepointConnections)
      .where(eq(sharepointConnections.organizationId, ids.orgB));
    expect(orgBConnections).toHaveLength(1);

    // A toggle-change audit plus a disconnect/purge audit.
    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe("update");
    expect(events[1]?.action).toBe("delete");
    expect(events[1]?.metadata?.["operation"]).toBe(
      "sharepoint_oauth_disconnect",
    );
    expect(events[1]?.metadata?.["purgedConnections"]).toBe(2);
  });
});

describe("disconnect is never gated on org enablement", () => {
  test("a user can revoke their own connection while the feature is disabled", async () => {
    // orgB never enabled the feature, yet its member must still be able to
    // remove their own stored tokens.
    const auditActions: string[] = [];
    const recordAuditEvent: AuditRecorder = async (_tx, event) => {
      for (const one of Array.isArray(event) ? event : [event]) {
        auditActions.push(one.action);
      }
    };

    const safeDb = createSafeDb(testDb, [], ids.orgB, ids.userB1);

    const result = await disconnectSharepoint.handler(
      asTestRaw({
        safeDb,
        session: { activeOrganizationId: ids.orgB },
        user: { id: ids.userB1 },
        memberRole: { role: "owner" },
        recordAuditEvent,
        request: new Request(
          "https://api.example.test/v1/sharepoint/connection",
        ),
        route: "/v1/sharepoint/connection",
      }),
    );

    expect(result).toEqual({ disconnected: true });
    expect(auditActions).toEqual(["delete"]);

    const remaining = await testDb
      .select({ id: sharepointConnections.id })
      .from(sharepointConnections)
      .where(eq(sharepointConnections.organizationId, ids.orgB));
    expect(remaining).toHaveLength(0);
  });
});
