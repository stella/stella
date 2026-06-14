import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

process.env["S3_ENDPOINT"] ??= "http://localhost:9000";
process.env["S3_BUCKET"] ??= "test";
process.env["S3_REGION"] ??= "us-east-1";

// The collab auth query joins five tables; a chainable builder lets each
// test set the single row the join would return.
type QueryBuilder = {
  select: () => QueryBuilder;
  from: () => QueryBuilder;
  innerJoin: () => QueryBuilder;
  leftJoin: () => QueryBuilder;
  where: () => QueryBuilder;
  limit: () => Promise<Record<string, unknown>[]>;
};

let nextRows: Record<string, unknown>[] = [];
const builder: QueryBuilder = {
  select: () => builder,
  from: () => builder,
  innerJoin: () => builder,
  leftJoin: () => builder,
  where: () => builder,
  limit: () => Promise.resolve(nextRows),
};

mock.module("@/api/db/root", () => ({ rootDb: builder, rlsDb: {} }));
mock.module("@/api/lib/root-scoped-db", () => ({
  createRootScopedDb: () => "SCOPED_DB_SENTINEL",
  createRootSafeDb: () => "SAFE_DB_SENTINEL",
}));

const { authorizeFolioCollabSession } =
  await import("@/api/lib/folio-collab-sessions");

const sessionId = toSafeId<"folioCollabSession">("fcs_1");
const orgId = toSafeId<"organization">("org_1");
const wsId = toSafeId<"workspace">("ws_1");

type Row = Record<string, unknown>;

const validRow = (overrides: Row = {}): Row => ({
  canEdit: { canEdit: true },
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  fileName: "contract.docx",
  organizationId: orgId,
  organizationRole: "owner",
  sessionStatus: "open",
  userId: "user_1",
  workspaceId: wsId,
  workspaceMemberId: null,
  yjsSnapshotFileId: null,
  ...overrides,
});

const authorize = (row: Row | null) => {
  nextRows = row === null ? [] : [row];
  return authorizeFolioCollabSession({ sessionId, token: "tok" });
};

describe("authorizeFolioCollabSession (the collab trust boundary)", () => {
  test("no matching token row is 'missing'", async () => {
    expect(await authorize(null)).toEqual({ status: "missing" });
  });

  test("a non-open session is 'missing' even with a valid token and role", async () => {
    expect(await authorize(validRow({ sessionStatus: "closed" }))).toEqual({
      status: "missing",
    });
  });

  test("an expired token is 'token-expired'", async () => {
    const result = await authorize(
      validRow({ expiresAt: new Date(Date.now() - 1000) }),
    );
    expect(result).toEqual({ status: "token-expired" });
  });

  test("a removed org member (null role) is 'permission-revoked'", async () => {
    expect(await authorize(validRow({ organizationRole: null }))).toEqual({
      status: "permission-revoked",
    });
  });

  test("a non-admin member without a workspace membership is revoked", async () => {
    // member has entity:update, so this isolates the canUseWorkspace branch:
    // a non-owner/admin needs a workspace membership row.
    expect(
      await authorize(
        validRow({ organizationRole: "member", workspaceMemberId: null }),
      ),
    ).toEqual({ status: "permission-revoked" });
  });

  test("an owner is authorized without a workspace membership row", async () => {
    // owner/admin satisfy canUseWorkspace via the OR branch.
    const result = await authorize(
      validRow({ organizationRole: "owner", workspaceMemberId: null }),
    );
    expect(result.status).toBe("authorized");
  });

  test("a role lacking entity:update is revoked (intern)", async () => {
    expect(
      await authorize(
        validRow({ organizationRole: "intern", workspaceMemberId: "wm_1" }),
      ),
    ).toEqual({ status: "permission-revoked" });
  });

  test("a read-only token authorizes but preserves canEdit=false", async () => {
    const result = await authorize(validRow({ canEdit: { canEdit: false } }));
    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.value.canEdit).toBe(false);
    }
  });

  test("the authorized session binds to the row's tenant, not the caller", async () => {
    const result = await authorize(validRow());
    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.value.organizationId).toBe(orgId);
      expect(result.value.workspaceId).toBe(wsId);
    }
  });
});
