import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

process.env["S3_ENDPOINT"] ??= "http://localhost:9000";
process.env["S3_BUCKET"] ??= "test";
process.env["S3_REGION"] ??= "us-east-1";

type QueryBuilder = {
  select: () => QueryBuilder;
  from: () => QueryBuilder;
  innerJoin: () => QueryBuilder;
  leftJoin: () => QueryBuilder;
  where: () => QueryBuilder;
  limit: () => Promise<Record<string, unknown>[]>;
};

let nextRows: Record<string, unknown>[] = [];
let scopedRows: Record<string, unknown>[][] = [];
const builder: QueryBuilder = {
  select: () => builder,
  from: () => builder,
  innerJoin: () => builder,
  leftJoin: () => builder,
  where: () => builder,
  limit: async () => nextRows,
};
const scopedBuilder: QueryBuilder = {
  select: () => scopedBuilder,
  from: () => scopedBuilder,
  innerJoin: () => scopedBuilder,
  leftJoin: () => scopedBuilder,
  where: () => scopedBuilder,
  limit: async () => scopedRows.shift() ?? [],
};

void mock.module("@/api/db/root", () => ({ rootDb: builder, rlsDb: {} }));
void mock.module("@/api/lib/root-scoped-db", () => ({
  createRootScopedDb:
    () => async (callback: (tx: QueryBuilder) => Promise<unknown>) =>
      await callback(scopedBuilder),
  createRootSafeDb: () => "SAFE_DB_SENTINEL",
}));

const {
  authorizeFolioCollabRoom,
  collectFolioCollabStoredRoomFiles,
  computeFolioCollabTokenExpiresAt,
  decideFolioCollabSnapshotStore,
  decideFolioCollabRoomAuthorization,
  FOLIO_COLLAB_TOKEN_TTL_MS,
  FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
  loadFolioCollabSnapshot,
} = await import("@/api/lib/folio-collab-rooms");
const { DOCX_MIME_TYPE } = await import("@/api/mime-types");

const roomId = toSafeId<"folioCollabRoom">("fcr_1");
const entityId = toSafeId<"entity">("entity_1");
const propertyId = toSafeId<"property">("property_1");
const organizationId = toSafeId<"organization">("org_1");
const workspaceId = toSafeId<"workspace">("ws_1");
const yjsSnapshotFileId = toSafeId<"userFile">("file_yjs");
const docxCheckpointFileId = toSafeId<"userFile">("file_docx");

type Row = Record<string, unknown>;

const validRow = (overrides: Row = {}): Row => ({
  entityId,
  expiresAt: new Date(Date.now() + FOLIO_COLLAB_TOKEN_TTL_MS),
  fileName: "contract.docx",
  generation: 3,
  organizationId,
  organizationRole: "owner",
  permissions: { canEdit: true },
  propertyId,
  tokenId: toSafeId<"folioCollabRoomToken">("fcrt_1"),
  tokenGeneration: 3,
  userId: "user_1",
  workspaceId,
  workspaceClientId: "client_1",
  workspaceMemberId: null,
  ...overrides,
});

const authorize = async (row: Row | null) => {
  nextRows = row === null ? [] : [row];
  return await authorizeFolioCollabRoom({ roomId, token: "tok" });
};

describe("authorizeFolioCollabRoom", () => {
  test("does not authorize a token outside its room and workspace", async () => {
    expect(await authorize(null)).toEqual({ status: "missing" });
  });

  test("rejects expired tokens", async () => {
    expect(
      await authorize(validRow({ expiresAt: new Date(Date.now() - 1) })),
    ).toEqual({ status: "token-expired" });
  });

  test("rejects users whose workspace access was revoked", async () => {
    expect(await authorize(validRow({ organizationRole: null }))).toEqual({
      status: "workspace-access-revoked",
    });
    expect(
      await authorize(
        validRow({ organizationRole: "member", workspaceMemberId: null }),
      ),
    ).toEqual({ status: "workspace-access-revoked" });
  });

  test("requires personal-matter membership even for organization admins", async () => {
    expect(
      await authorize(
        validRow({ workspaceClientId: null, workspaceMemberId: null }),
      ),
    ).toEqual({ status: "workspace-access-revoked" });

    expect(
      await authorize(
        validRow({ workspaceClientId: null, workspaceMemberId: "wm_1" }),
      ),
    ).toMatchObject({ status: "authorized" });
  });

  test("rejects credentials minted for an abandoned seed generation", async () => {
    expect(await authorize(validRow({ tokenGeneration: 2 }))).toEqual({
      status: "generation-conflict",
    });
  });

  test("downgrades edit permission on the next authorization", async () => {
    const result = await authorize(
      validRow({ organizationRole: "intern", workspaceMemberId: "wm_1" }),
    );

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.value.canEdit).toBe(false);
      expect(result.value.generation).toBe(3);
    }
  });

  test("preserves an explicitly read-only token", () => {
    expect(
      decideFolioCollabRoomAuthorization({
        actualGeneration: 3,
        expiresAt: new Date(Date.now() + FOLIO_COLLAB_TOKEN_TTL_MS),
        now: new Date(),
        organizationRole: "owner",
        tokenCanEdit: false,
        tokenGeneration: 3,
        workspaceClientId: "client_1",
        workspaceMemberId: null,
      }),
    ).toEqual({ status: "authorized", canEdit: false });
  });
});

describe("folio collaboration room token lifetime", () => {
  test("refreshes for one hour even after the former eight-hour wall", () => {
    const roomCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(roomCreatedAt.getTime() + 24 * 60 * 60 * 1000);

    expect(computeFolioCollabTokenExpiresAt(now)).toEqual(
      new Date(now.getTime() + FOLIO_COLLAB_TOKEN_TTL_MS),
    );
  });
});

describe("folio collaboration room snapshot generation", () => {
  test("retries the current pointer when a concurrent store removes the old object", async () => {
    const authorized = await authorize(validRow());
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") {
      return;
    }

    scopedRows = [
      [
        {
          generation: 3,
          yjsSnapshotFileId,
          yjsSnapshotUpdatedAt: new Date(),
        },
      ],
      [
        {
          generation: 3,
          yjsSnapshotFileId: toSafeId<"userFile">("file_yjs_next"),
          yjsSnapshotUpdatedAt: new Date(),
        },
      ],
    ];
    const snapshotObjects: (ArrayBuffer | null)[] = [
      null,
      new TextEncoder().encode("next").buffer,
    ];

    expect(
      await loadFolioCollabSnapshot(
        authorized.value,
        async () => snapshotObjects.shift() ?? null,
      ),
    ).toEqual({
      generation: 3,
      snapshotBase64: "bmV4dA==",
    });
  });

  test("rejects a store from a stale generation", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        expectedGeneration: 3,
        seedClaimedBy: "user_1",
        seedState: "claimed",
        userId: "user_1",
      }),
    ).toEqual({ status: "generation-conflict", actualGeneration: 4 });
  });

  test("only the generation claim owner may write the first snapshot", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        expectedGeneration: 4,
        seedClaimedBy: "user_1",
        seedState: "claimed",
        userId: "user_2",
      }),
    ).toEqual({ status: "seed-owner-conflict" });
  });
});

describe("folio collaboration room stored files", () => {
  test("collects only blobs that were durably written", () => {
    const writtenAt = new Date("2026-01-01T00:00:00.000Z");

    expect(
      collectFolioCollabStoredRoomFiles({
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
      collectFolioCollabStoredRoomFiles({
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
