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
  limit: async () => nextRows,
};

void mock.module("@/api/db/root", () => ({ rootDb: builder, rlsDb: {} }));
void mock.module("@/api/lib/root-scoped-db", () => ({
  createRootScopedDb: () => "SCOPED_DB_SENTINEL",
  createRootSafeDb: () => "SAFE_DB_SENTINEL",
}));

const {
  authorizeFolioCollabSession,
  collectFolioCollabStoredSessionFiles,
  computeFolioCollabTokenExpiresAt,
  computeFolioCollabRefreshTokenExpiresAt,
  FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
  FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS,
  FOLIO_COLLAB_TOKEN_TTL_MS,
  isFolioCollabSessionExpired,
} = await import("@/api/lib/folio-collab-sessions");
const { DOCX_MIME_TYPE } = await import("@/api/mime-types");

const sessionId = toSafeId<"folioCollabSession">("fcs_1");
const orgId = toSafeId<"organization">("org_1");
const wsId = toSafeId<"workspace">("ws_1");
const yjsSnapshotFileId = toSafeId<"userFile">("file_yjs");
const docxCheckpointFileId = toSafeId<"userFile">("file_docx");

type Row = Record<string, unknown>;

const validRow = (overrides: Row = {}): Row => ({
  canEdit: { canEdit: true },
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  fileName: "contract.docx",
  organizationId: orgId,
  organizationRole: "owner",
  sessionCreatedAt: new Date(Date.now() - 30 * 60 * 1000),
  sessionStatus: "open",
  tokenId: toSafeId<"folioCollabSessionToken">("fcst_1"),
  userId: "user_1",
  workspaceId: wsId,
  workspaceMemberId: null,
  yjsSnapshotFileId: null,
  ...overrides,
});

const authorize = async (row: Row | null) => {
  nextRows = row === null ? [] : [row];
  return await authorizeFolioCollabSession({ sessionId, token: "tok" });
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

  test("an otherwise-valid token expires at the absolute session lifetime", async () => {
    const result = await authorize(
      validRow({
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        sessionCreatedAt: new Date(
          Date.now() - FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS,
        ),
      }),
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

describe("folio collab token lifetime", () => {
  test("caps refreshed tokens at the absolute session lifetime", () => {
    const sessionCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(
      sessionCreatedAt.getTime() +
        FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS -
        5 * 60 * 1000,
    );

    expect(computeFolioCollabTokenExpiresAt(sessionCreatedAt, now)).toEqual(
      new Date(
        sessionCreatedAt.getTime() + FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS,
      ),
    );
  });

  test("keeps the normal one-hour token lifetime before the session cap", () => {
    const sessionCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(sessionCreatedAt.getTime() + 30 * 60 * 1000);

    expect(computeFolioCollabTokenExpiresAt(sessionCreatedAt, now)).toEqual(
      new Date(now.getTime() + FOLIO_COLLAB_TOKEN_TTL_MS),
    );
  });

  test("refuses refreshes once the absolute session lifetime has elapsed", () => {
    const sessionCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(
      sessionCreatedAt.getTime() + FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS,
    );

    expect(computeFolioCollabRefreshTokenExpiresAt(sessionCreatedAt, now)).toBe(
      null,
    );
  });

  test("classifies reusable open sessions by the same absolute lifetime", () => {
    const sessionCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const justBeforeCap = new Date(
      sessionCreatedAt.getTime() + FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS - 1,
    );
    const atCap = new Date(
      sessionCreatedAt.getTime() + FOLIO_COLLAB_SESSION_MAX_LIFETIME_MS,
    );

    expect(isFolioCollabSessionExpired(sessionCreatedAt, justBeforeCap)).toBe(
      false,
    );
    expect(isFolioCollabSessionExpired(sessionCreatedAt, atCap)).toBe(true);
  });
});

describe("folio collab stored session files", () => {
  test("collects only blobs that have been written", () => {
    const writtenAt = new Date("2026-01-01T00:00:00.000Z");

    expect(
      collectFolioCollabStoredSessionFiles({
        docxCheckpointFileId,
        docxCheckpointUpdatedAt: null,
        yjsSnapshotFileId,
        yjsSnapshotUpdatedAt: writtenAt,
      }),
    ).toEqual([
      {
        fileId: yjsSnapshotFileId,
        mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
      },
    ]);

    expect(
      collectFolioCollabStoredSessionFiles({
        docxCheckpointFileId,
        docxCheckpointUpdatedAt: writtenAt,
        yjsSnapshotFileId,
        yjsSnapshotUpdatedAt: writtenAt,
      }),
    ).toEqual([
      {
        fileId: yjsSnapshotFileId,
        mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
      },
      { fileId: docxCheckpointFileId, mimeType: DOCX_MIME_TYPE },
    ]);
  });
});
