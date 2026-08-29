import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";

type QueryBuilder = {
  insert: () => QueryBuilder;
  select: () => QueryBuilder;
  from: () => QueryBuilder;
  innerJoin: () => QueryBuilder;
  leftJoin: () => QueryBuilder;
  where: () => QueryBuilder;
  limit: () => Promise<Record<string, unknown>[]>;
  values: () => Promise<Record<string, unknown>[]>;
};

let nextRows: Record<string, unknown>[] = [];
let scopedRows: Record<string, unknown>[][] = [];
let scopedFailure: Error | null = null;
let scopedFailureAfterCalls = 0;
let scopedCalls = 0;
const builder: QueryBuilder = {
  insert: () => builder,
  select: () => builder,
  from: () => builder,
  innerJoin: () => builder,
  leftJoin: () => builder,
  where: () => builder,
  limit: async () => nextRows,
  values: async () => [],
};
const scopedBuilder: QueryBuilder = {
  insert: () => scopedBuilder,
  select: () => scopedBuilder,
  from: () => scopedBuilder,
  innerJoin: () => scopedBuilder,
  leftJoin: () => scopedBuilder,
  where: () => scopedBuilder,
  limit: async () => scopedRows.shift() ?? [],
  values: async () => [],
};

void mock.module("@/api/db/root", () => ({ rootDb: builder, rlsDb: {} }));
void mock.module("@/api/lib/root-scoped-db", () => ({
  createRootScopedDb:
    () => async (callback: (tx: QueryBuilder) => Promise<unknown>) => {
      scopedCalls += 1;
      if (scopedFailure !== null && scopedCalls > scopedFailureAfterCalls) {
        throw new Error(scopedFailure.message, { cause: scopedFailure });
      }
      return await callback(scopedBuilder);
    },
  createRootSafeDb: () => "SAFE_DB_SENTINEL",
}));
// Object storage is the real `lib/s3`, pointed at an in-process store: the
// keys, content types and deletes below are the ones the module actually put
// on the wire, not a stub's record of the arguments it was handed.
let fake: FakeS3;

const {
  authorizeFolioCollabRoom,
  collectFolioCollabStoredRoomFiles,
  computeFolioCollabTokenExpiresAt,
  decideFolioCollabSnapshotStore,
  decideFolioCollabRoomAuthorization,
  FOLIO_COLLAB_TOKEN_TTL_MS,
  FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
  loadFolioCollabSnapshot,
  storeFolioCollabSnapshot,
} = await import("@/api/lib/folio-collab-rooms");
const { DOCX_MIME_TYPE } = await import("@/api/mime-types");

const roomId = toSafeId<"folioCollabRoom">("fcr_1");
const entityId = toSafeId<"entity">("entity_1");
const propertyId = toSafeId<"property">("property_1");
const organizationId = toSafeId<"organization">("org_1");
const workspaceId = toSafeId<"workspace">("ws_1");
const firstUserId = toSafeId<"user">("user_1");
const secondUserId = toSafeId<"user">("user_2");
const yjsSnapshotFileId = toSafeId<"userFile">("file_yjs");
const docxCheckpointFileId = toSafeId<"userFile">("file_docx");

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
  scopedFailure = null;
  scopedFailureAfterCalls = 0;
  scopedCalls = 0;
});

const snapshotKey = (fileId: string) =>
  createFileKey({
    fileId,
    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    organizationId,
    workspaceId,
  });

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
  workspaceStatus: "active",
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
        workspaceStatus: "active",
      }),
    ).toEqual({ status: "authorized", canEdit: false });
  });

  test("rejects collaboration in an archived workspace", async () => {
    expect(await authorize(validRow({ workspaceStatus: "archived" }))).toEqual({
      status: "workspace-access-revoked",
    });
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

    const nextSnapshotFileId = toSafeId<"userFile">("file_yjs_next");
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
          yjsSnapshotFileId: nextSnapshotFileId,
          yjsSnapshotUpdatedAt: new Date(),
        },
      ],
    ];
    // Only the replacement object exists: the concurrent store published a
    // new pointer and removed the object the first pointer named.
    fake.put(
      envBase.S3_BUCKET,
      snapshotKey(nextSnapshotFileId),
      "next",
      FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    );

    expect(await loadFolioCollabSnapshot(authorized.value)).toEqual({
      generation: 3,
      snapshotBase64: "bmV4dA==",
    });
    // The store confirming the first key is gone is what sends the read back
    // to the pointer; the second read must ask for the replacement key.
    expect(fake.requests.map(({ method, key }) => `${method} ${key}`)).toEqual([
      `GET ${snapshotKey(yjsSnapshotFileId)}`,
      `GET ${snapshotKey(nextSnapshotFileId)}`,
    ]);
  });

  test("rejects a store from a stale generation", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        authority: { type: "participant", userId: firstUserId },
        expectedGeneration: 3,
        seedClaimedBy: "user_1",
        seedState: "claimed",
      }),
    ).toEqual({ status: "generation-conflict", actualGeneration: 4 });
  });

  test("only the generation claim owner may write the first snapshot", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        authority: { type: "participant", userId: secondUserId },
        expectedGeneration: 4,
        seedClaimedBy: "user_1",
        seedState: "claimed",
      }),
    ).toEqual({ status: "seed-owner-conflict" });
  });

  test("deletes a newly written snapshot when its database transaction fails", async () => {
    const authorized = await authorize(validRow());
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") {
      return;
    }

    scopedFailure = new Error("snapshot transaction failed");
    scopedFailureAfterCalls = 1;

    await expect(
      storeFolioCollabSnapshot({
        authority: { type: "participant", userId: firstUserId },
        expectedGeneration: 3,
        snapshotBytes: new TextEncoder().encode("snapshot"),
        value: authorized.value,
      }),
    ).rejects.toThrow("snapshot transaction failed");

    const written = fake.requests.filter(({ method }) => method === "PUT");
    const writtenKey = written.at(0)?.key;
    expect(written).toHaveLength(1);
    // Tenant-scoped key under the snapshot's own media type: a key without
    // the organization and workspace prefix would place one tenant's
    // snapshot inside another's.
    expect(writtenKey).toMatch(/^org_1\/ws_1\/[^/]+\.bin$/u);
    expect(written.at(0)?.contentType).toBe(FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE);
    expect(
      fake.requests
        .filter(({ method }) => method === "DELETE")
        .map(({ key }) => key),
    ).toEqual([writtenKey]);
    // The room pointer never published, so the store must hold nothing.
    expect([...fake.objects.keys()]).toEqual([]);
  });

  test("accepts a generation-fenced store from the collaboration service", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        authority: { type: "collab-service" },
        expectedGeneration: 4,
        seedClaimedBy: "user_1",
        seedState: "claimed",
      }),
    ).toEqual({ status: "accepted" });
  });
});

describe("folio collaboration room stored files", () => {
  test("reserves cleanup before a snapshot write and retires it after publication", async () => {
    const source = await Bun.file(
      new URL("folio-collab-rooms.ts", import.meta.url),
    ).text();
    const reserve = source.indexOf(".insert(bufferObjectCleanupIntents)");
    const write = source.indexOf("await writeS3ObjectWithRetry");
    const publish = source.indexOf(".update(folioCollabRooms)", write);
    const retire = source.indexOf(".delete(bufferObjectCleanupIntents)");

    expect(reserve).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(reserve);
    expect(publish).toBeGreaterThan(write);
    expect(retire).toBeGreaterThan(publish);
  });

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
