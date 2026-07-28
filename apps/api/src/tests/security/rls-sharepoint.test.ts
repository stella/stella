import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { sharepointConnections, sharepointOAuthState } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
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

// The SharePoint token tables are covered by a cross-tenant *waiver* in the
// handler matrix (their only reads are per-user+org connection state). This
// focused test still proves the org+user RLS holds at the row level: neither a
// different org nor a same-org non-owner can read, mutate, or delete another
// user's stored delegated tokens.

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: ReturnType<typeof createScopedQuery>;

const connOrgAUserA1 = createSafeId<"sharepointConnection">();
const connOrgBUserB1 = createSafeId<"sharepointConnection">();
const stateOrgAUserA1 = `spstate-a-${connOrgAUserA1}`;
const stateOrgBUserB1 = `spstate-b-${connOrgBUserB1}`;

const enc = () => Buffer.from("ciphertext");
const iv = () => Buffer.alloc(12);

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  scopedQuery = createScopedQuery(testDb);

  await testDb.insert(sharepointConnections).values([
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

  await testDb.insert(sharepointOAuthState).values([
    {
      state: stateOrgAUserA1,
      organizationId: ids.orgA,
      userId: ids.userA1,
      codeVerifier: "verifier",
      redirectUri: "https://api.example.test/v1/sharepoint/oauth/callback",
    },
    {
      state: stateOrgBUserB1,
      organizationId: ids.orgB,
      userId: ids.userB1,
      codeVerifier: "verifier",
      redirectUri: "https://api.example.test/v1/sharepoint/oauth/callback",
    },
  ]);
});

afterAll(async () => {
  await testDb
    .delete(sharepointConnections)
    .where(eq(sharepointConnections.id, connOrgAUserA1));
  await testDb
    .delete(sharepointConnections)
    .where(eq(sharepointConnections.id, connOrgBUserB1));
  await releaseTestDb();
});

const noWorkspaces: SafeId<"workspace">[] = [];

describe("sharepoint_connections RLS", () => {
  test("owner sees only their own connection", async () => {
    const rows = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx.select({ id: sharepointConnections.id }).from(sharepointConnections),
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
          .select({ id: sharepointConnections.id })
          .from(sharepointConnections)
          .where(eq(sharepointConnections.id, connOrgBUserB1)),
      ids.userA1,
    );
    expect(rows).toHaveLength(0);
  });

  test("a same-org non-owner cannot read the owner's connection", async () => {
    const rows = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx.select({ id: sharepointConnections.id }).from(sharepointConnections),
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
          .delete(sharepointConnections)
          .where(eq(sharepointConnections.id, connOrgBUserB1))
          .returning({ id: sharepointConnections.id }),
      ids.userA1,
    );
    expect(deleted).toHaveLength(0);

    const survivor = await testDb
      .select({ id: sharepointConnections.id })
      .from(sharepointConnections)
      .where(eq(sharepointConnections.id, connOrgBUserB1));
    expect(survivor).toHaveLength(1);
  });

  test("a same-org non-owner cannot update the owner's connection", async () => {
    const updated = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .update(sharepointConnections)
          .set({ status: "reconnect_required" })
          .where(eq(sharepointConnections.id, connOrgAUserA1))
          .returning({ id: sharepointConnections.id }),
      ids.userA2,
    );
    expect(updated).toHaveLength(0);

    const unchanged = await testDb
      .select({ status: sharepointConnections.status })
      .from(sharepointConnections)
      .where(eq(sharepointConnections.id, connOrgAUserA1));
    expect(unchanged[0]?.status).toBe("connected");
  });
});

describe("sharepoint_oauth_state RLS", () => {
  test("owner sees only their own pending state", async () => {
    const rows = await scopedQuery(
      noWorkspaces,
      ids.orgA,
      (tx) =>
        tx
          .select({ state: sharepointOAuthState.state })
          .from(sharepointOAuthState),
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
          .delete(sharepointOAuthState)
          .where(eq(sharepointOAuthState.state, stateOrgAUserA1))
          .returning({ state: sharepointOAuthState.state }),
      ids.userA2,
    );
    expect(deleted).toHaveLength(0);

    const survivor = await testDb
      .select({ state: sharepointOAuthState.state })
      .from(sharepointOAuthState)
      .where(eq(sharepointOAuthState.state, stateOrgAUserA1));
    expect(survivor).toHaveLength(1);
  });
});
