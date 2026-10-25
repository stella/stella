import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SQL, Subquery } from "drizzle-orm";
import type { PgTable, SelectedFields } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { Doc, encodeStateAsUpdate, XmlElement, XmlText } from "yjs";

import { FOLIO_YJS_ATTR_SCHEMA_VERSION } from "@stll/folio-core/server";
import { sha256Hex } from "@stll/sha256/node";

import { folioCollabRooms, workspaces } from "@/api/db/schema";
import { createMockDatabase } from "@/api/db/sql-client";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { toSafeId } from "@/api/lib/branded-types";
import { createFileKey } from "@/api/lib/file-key";
import { aggregateExecutionRows } from "@/api/tests/fixtures/aggregate-lock-order";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type Row = Record<string, unknown>;
type QueuedRows = Row[] | (() => Row[]);

type QueryBuilder = {
  for: () => QueryBuilder;
  from: (table?: PgTable) => QueryBuilder;
  as: (alias: string) => Subquery;
  toSQL: () => { sql: string };
  innerJoin: (table?: PgTable, predicate?: SQL) => QueryBuilder;
  leftJoin: () => QueryBuilder;
  where: (predicate?: SQL) => QueryBuilder;
  limit: () => QueryBuilder;
  returning: () => QueryBuilder;
  set: () => QueryBuilder;
  values: (rows: Row | Row[]) => QueryBuilder;
};

type QueryApi = {
  delete: () => QueryBuilder;
  execute: (query: SQL) => Promise<Row[]>;
  insert: () => QueryBuilder;
  select: (selectedFields?: SelectedFields) => QueryBuilder;
  update: () => QueryBuilder;
};

const resolveQueuedRows = (queued: QueuedRows | undefined): Row[] =>
  typeof queued === "function" ? queued() : (queued ?? []);

let nextRows: Row[] = [];
let scopedRows: QueuedRows[] = [];
let scopedLockRows: QueuedRows[] = [];
let scopedPendingLockReads = 0;
let scopedInsertedRows: Row[] = [];
let scopedDeleteCalls = 0;
let scopedFailure: Error | null = null;
let scopedFailureAfterCalls = 0;
let scopedCalls = 0;

const createQueryBuilder = ({
  captureValues = false,
  onLock,
  resolveRows,
  selectedFields = {},
}: {
  selectedFields?: SelectedFields;
  captureValues?: boolean;
  onLock?: () => void;
  resolveRows: (lockRead: boolean) => Row[];
}): QueryBuilder => {
  let lockRead = false;
  let selectedTable: PgTable | undefined;
  const metadataFor = (table: PgTable) =>
    createMockDatabase().select(selectedFields).from(table).$dynamic();
  let metadata = metadataFor(folioCollabRooms);
  const query = Promise.resolve().then(() => {
    const rows = resolveRows(lockRead);
    if (!lockRead) {
      return rows;
    }
    if (selectedTable === folioCollabRooms) {
      return rows.map((row) => ({ id: roomId, workspaceId, ...row }));
    }
    if (selectedTable === workspaces) {
      return rows.map((row) => ({ id: workspaceId, organizationId, ...row }));
    }
    return rows;
  });
  const builder: QueryBuilder = Object.assign(query, {
    for: () => {
      lockRead = true;
      onLock?.();
      return builder;
    },
    from: (table?: PgTable) => {
      if (table) {
        selectedTable = table;
        metadata = metadataFor(table);
      }
      return builder;
    },
    as: (alias: string) => metadata.as(alias),
    toSQL: () => metadata.toSQL(),
    innerJoin: (table?: PgTable, predicate?: SQL) => {
      if (table) {
        metadata = metadata.innerJoin(table, predicate);
      }
      return builder;
    },
    leftJoin: () => builder,
    limit: () => builder,
    returning: () => builder,
    set: () => builder,
    values: (rows: Row | Row[]) => {
      if (captureValues) {
        scopedInsertedRows.push(...(Array.isArray(rows) ? rows : [rows]));
      }
      return builder;
    },
    where: (predicate?: SQL) => {
      if (predicate) {
        metadata = metadata.where(predicate);
      }
      return builder;
    },
  });
  return builder;
};

const createScopedQueryBuilder = ({
  captureValues = false,
  readsRows = true,
  selectedFields = {},
}: {
  captureValues?: boolean;
  readsRows?: boolean;
  selectedFields?: SelectedFields;
} = {}): QueryBuilder =>
  createQueryBuilder({
    captureValues,
    selectedFields,
    onLock: () => {
      scopedPendingLockReads += 1;
    },
    resolveRows: (lockRead) => {
      if (!readsRows) {
        return [];
      }
      if (lockRead) {
        scopedPendingLockReads -= 1;
        return resolveQueuedRows(scopedLockRows.shift());
      }
      return resolveQueuedRows(scopedRows.shift());
    },
  });

const scopedTransaction: QueryApi = {
  delete: () => {
    scopedDeleteCalls += 1;
    return createScopedQueryBuilder();
  },
  execute: async (query) => {
    const { sql } = new PgDialect().sqlToQuery(query);
    // Owner-registered advisory locks report the physical key they took.
    if (sql.includes("AS key1")) {
      return aggregateExecutionRows(query);
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return [{}];
    }
    if (/FOR (?:NO KEY UPDATE|UPDATE|SHARE)/u.test(sql)) {
      return [{ id: workspaceId, organizationId }];
    }
    const rows = resolveQueuedRows(scopedRows.shift());
    if (sql.includes("AS count FROM changed")) {
      return [{ count: rows.length }];
    }
    return rows;
  },
  insert: () =>
    createScopedQueryBuilder({ captureValues: true, readsRows: false }),
  select: (selectedFields = {}) => createScopedQueryBuilder({ selectedFields }),
  update: () => createScopedQueryBuilder(),
};

const createScopedDbTestDouble =
  () => async (callback: (tx: QueryApi) => Promise<unknown>) => {
    scopedCalls += 1;
    if (scopedFailure !== null && scopedCalls > scopedFailureAfterCalls) {
      throw new Error(scopedFailure.message, { cause: scopedFailure });
    }
    // Each scoped call is its own transaction, with its own lock history.
    return await callback({ ...scopedTransaction });
  };
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

const createScopedDb = asTestRaw<
  NonNullable<Parameters<typeof authorizeFolioCollabRoom>[0]["createScopedDb"]>
>(createScopedDbTestDouble);
const database = asTestRaw<
  NonNullable<Parameters<typeof authorizeFolioCollabRoom>[0]["db"]>
>({
  select: () =>
    createQueryBuilder({ resolveRows: () => resolveQueuedRows(nextRows) }),
});

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
  scopedRows = [];
  scopedLockRows = [];
  scopedPendingLockReads = 0;
  scopedInsertedRows = [];
  scopedDeleteCalls = 0;
});

const snapshotKey = (fileId: string) =>
  createFileKey({
    fileId,
    mimeType: FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    organizationId,
    workspaceId,
  });

const currentFolioSnapshot = () => {
  const doc = new Doc();
  doc
    .getMap("folio:document-metadata")
    .set("attrSchemaVersion", FOLIO_YJS_ATTR_SCHEMA_VERSION);
  const update = encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

const refusedFolioSnapshot = () => {
  const doc = new Doc();
  doc.getMap("folio:document-metadata").set("attrSchemaVersion", 11);
  const paragraph = new XmlElement("paragraph");
  const text = new XmlText();
  text.insert(0, "1", { footnoteRef: { id: 1 } });
  paragraph.insert(0, [text]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
  const update = encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
};

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
  userName: "Authorized user",
  workspaceId,
  reachesMatter: true,
  workspaceStatus: "active",
  ...overrides,
});

const authorize = async (row: Row | null) => {
  nextRows = row === null ? [] : [row];
  return await authorizeFolioCollabRoom({
    createScopedDb,
    db: database,
    readSessionAuthority: async () => null,
    roomId,
    token: "tok",
  });
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
    expect(await authorize(validRow({ reachesMatter: false }))).toEqual({
      status: "workspace-access-revoked",
    });
  });

  test("rejects credentials minted for an abandoned seed generation", async () => {
    expect(await authorize(validRow({ tokenGeneration: 2 }))).toEqual({
      status: "generation-conflict",
    });
  });

  test("downgrades edit permission on the next authorization", async () => {
    const result = await authorize(validRow({ organizationRole: "intern" }));

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
        reachesMatter: true,
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
  test("corrupt persisted snapshots return a handler failure without resetting the room", async () => {
    const authorized = await authorize(validRow());
    if (authorized.status !== "authorized") {
      throw new Error("Expected an authorized snapshot target");
    }
    scopedRows = [
      [
        {
          generation: 3,
          yjsSnapshotFileId,
          yjsSnapshotRevision: 4,
          yjsSnapshotUpdatedAt: new Date(),
        },
      ],
    ];

    const loaded = await loadFolioCollabSnapshot(
      authorized.value,
      async () => new ArrayBuffer(0),
    );
    expect(Result.isError(loaded)).toBe(true);
    if (!Result.isError(loaded)) {
      throw new TypeError("Expected corrupt snapshot failure");
    }
    expect(loaded.error).toMatchObject({
      _tag: "HandlerError",
      status: 500,
      cause: { code: "invalid_update" },
    });
    expect(scopedCalls).toBe(1);
    expect(scopedInsertedRows).toEqual([]);
  });

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
          yjsSnapshotRevision: 4,
          yjsSnapshotUpdatedAt: new Date(),
        },
      ],
      [
        {
          generation: 3,
          yjsSnapshotFileId: nextSnapshotFileId,
          yjsSnapshotRevision: 5,
          yjsSnapshotUpdatedAt: new Date(),
        },
      ],
    ];
    // Only the replacement object exists: the concurrent store published a
    // new pointer and removed the object the first pointer named.
    const snapshot = currentFolioSnapshot();
    fake.put(
      envBase.S3_BUCKET,
      snapshotKey(nextSnapshotFileId),
      snapshot,
      FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    );

    const loaded = (await loadFolioCollabSnapshot(authorized.value)).unwrap()
      ?.snapshot;
    expect(loaded).toEqual({
      generation: 3,
      loadOutcome: "loaded",
      snapshotBase64: Buffer.from(snapshot).toString("base64"),
      snapshotRevision: 5,
    });
    // The store confirming the first key is gone is what sends the read back
    // to the pointer; the second read must ask for the replacement key.
    expect(fake.requests.map(({ method, key }) => `${method} ${key}`)).toEqual([
      `GET ${snapshotKey(yjsSnapshotFileId)}`,
      `GET ${snapshotKey(nextSnapshotFileId)}`,
    ]);
  });

  test("returns the hash of persisted bytes before snapshot normalization", async () => {
    const authorized = await authorize(validRow());
    if (authorized.status !== "authorized") {
      throw new Error("Expected an authorized snapshot target");
    }
    const snapshot = new Uint8Array(
      await Bun.file(
        new URL(
          "files/fixtures/folio-core-0.58.5/migratable.yjs",
          import.meta.url,
        ),
      ).arrayBuffer(),
    );
    scopedRows = [
      [
        {
          generation: 3,
          yjsSnapshotFileId,
          yjsSnapshotRevision: 4,
          yjsSnapshotUpdatedAt: new Date(),
        },
      ],
    ];
    fake.put(
      envBase.S3_BUCKET,
      snapshotKey(yjsSnapshotFileId),
      snapshot,
      FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    );
    const loaded = (await loadFolioCollabSnapshot(authorized.value)).unwrap();
    expect(loaded?.rawSnapshotSha256Hex).toBe(sha256Hex(snapshot));
    expect(loaded?.snapshot.loadOutcome).toBe("loaded");
    const normalized = loaded?.snapshot.snapshotBase64;
    if (normalized === null || normalized === undefined) {
      throw new Error("Expected normalized persisted snapshot bytes");
    }
    expect(sha256Hex(Buffer.from(normalized, "base64"))).not.toBe(
      sha256Hex(snapshot),
    );
  });

  test.each(["loaded", "rematerialize-from-docx", "conflict"] as const)(
    "recovery handles a concurrent replacement: %s",
    async (replacementOutcome) => {
      const authorized = await authorize(validRow());
      expect(authorized.status).toBe("authorized");
      if (authorized.status !== "authorized") {
        throw new Error("Expected an authorized snapshot target");
      }
      const nextFileId = toSafeId<"userFile">("file_yjs_replacement");
      const pointer = {
        baseVersionId: toSafeId<"entityVersion">("ev_saved"),
        savedVersionCreatedAt: new Date(0),
        savedSnapshotCut: null,
        sourceVersionId: toSafeId<"entityVersion">("ev_saved"),
        docxCheckpointFileId,
        docxCheckpointUpdatedAt: null,
        seededAt: new Date(0),
        generation: 3,
        yjsSnapshotFileId,
        yjsSnapshotRevision: 4,
        yjsSnapshotUpdatedAt: new Date(),
      };
      const replacement =
        replacementOutcome === "loaded"
          ? currentFolioSnapshot()
          : refusedFolioSnapshot();
      scopedRows = [
        [pointer],
        [], // The first recovery CAS loses to the replacement writer.
        [{ ...pointer, yjsSnapshotFileId: nextFileId, yjsSnapshotRevision: 5 }],
      ];
      switch (replacementOutcome) {
        case "rematerialize-from-docx":
          scopedRows.push([{ generation: 4 }]);
          break;
        case "conflict":
          scopedRows.push([]);
          break;
        case "loaded":
          break;
      }
      fake.put(
        envBase.S3_BUCKET,
        snapshotKey(yjsSnapshotFileId),
        refusedFolioSnapshot(),
        FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
      );
      fake.put(
        envBase.S3_BUCKET,
        snapshotKey(nextFileId),
        replacement,
        FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
      );

      if (replacementOutcome === "conflict") {
        const result = await loadFolioCollabSnapshot(authorized.value);
        expect(Result.isError(result) && result.error).toMatchObject({
          status: 503,
          code: "folio_collab_snapshot_recovery_conflict",
        });
      } else {
        expect(
          (await loadFolioCollabSnapshot(authorized.value)).unwrap()?.snapshot,
        ).toEqual(
          replacementOutcome === "loaded"
            ? {
                generation: 3,
                loadOutcome: "loaded",
                snapshotBase64: Buffer.from(replacement).toString("base64"),
                snapshotRevision: 5,
              }
            : {
                generation: 4,
                resetGeneration: 3,
                loadOutcome: "rematerialize-from-docx",
                snapshotBase64: null,
                snapshotRevision: 0,
              },
        );
      }
      expect(scopedRows).toEqual([]);
      expect(
        scopedInsertedRows.filter((row) => row["resourceId"] === roomId),
      ).toHaveLength(replacementOutcome === "rematerialize-from-docx" ? 1 : 0);
      expect(
        scopedInsertedRows.flatMap((row) =>
          typeof row["objectKey"] === "string" ? [row["objectKey"]] : [],
        ),
      ).toEqual(
        replacementOutcome === "rematerialize-from-docx"
          ? [snapshotKey(nextFileId)]
          : [],
      );
      expect(
        fake.requests.map(({ method, key }) => `${method} ${key}`),
      ).toEqual([
        `GET ${snapshotKey(yjsSnapshotFileId)}`,
        `GET ${snapshotKey(nextFileId)}`,
      ]);
    },
  );

  test("a refused snapshot resets its own generation and retires only its object", async () => {
    const authorized = await authorize(validRow());
    if (authorized.status !== "authorized") {
      throw new Error("Expected an authorized snapshot target");
    }
    scopedRows = [
      [
        {
          baseVersionId: toSafeId<"entityVersion">("ev_saved"),
          savedVersionCreatedAt: new Date(0),
          savedSnapshotCut: null,
          sourceVersionId: toSafeId<"entityVersion">("ev_saved"),
          docxCheckpointFileId,
          docxCheckpointUpdatedAt: null,
          seededAt: new Date(0),
          generation: 3,
          yjsSnapshotFileId,
          yjsSnapshotRevision: 4,
          yjsSnapshotUpdatedAt: new Date(),
        },
      ],
      [{ generation: 4 }],
    ];
    fake.put(
      envBase.S3_BUCKET,
      snapshotKey(yjsSnapshotFileId),
      refusedFolioSnapshot(),
      FOLIO_COLLAB_YJS_UPDATE_MIME_TYPE,
    );

    expect(
      (await loadFolioCollabSnapshot(authorized.value)).unwrap()?.snapshot,
    ).toEqual({
      generation: 4,
      resetGeneration: 3,
      loadOutcome: "rematerialize-from-docx",
      snapshotBase64: null,
      snapshotRevision: 0,
    });
    expect(
      scopedInsertedRows.find((row) => row["resourceId"] === roomId),
    ).toMatchObject({
      changes: { generation: { old: 3, new: 4 } },
      performerType: "service",
      triggerType: "system",
    });
    expect(scopedRows).toEqual([]);
    expect(
      scopedInsertedRows.flatMap((row) =>
        typeof row["objectKey"] === "string" ? [row["objectKey"]] : [],
      ),
    ).toEqual([snapshotKey(yjsSnapshotFileId)]);
  });

  test("rejects a store from a stale generation", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        actualSnapshotRevision: 2,
        authority: { type: "participant", userId: firstUserId },
        expectedGeneration: 3,
        expectedSnapshotRevision: 2,
        seedClaimedBy: "user_1",
        seedState: "claimed",
      }),
    ).toEqual({ status: "generation-conflict", actualGeneration: 4 });
  });

  test("rejects a store from a stale snapshot revision", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        actualSnapshotRevision: 3,
        authority: { type: "collab-service" },
        expectedGeneration: 4,
        expectedSnapshotRevision: 2,
        seedClaimedBy: "user_1",
        seedState: "seeded",
      }),
    ).toEqual({
      status: "snapshot-revision-conflict",
      actualSnapshotRevision: 3,
    });
  });

  test("only the generation claim owner may write the first snapshot", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        actualSnapshotRevision: 0,
        authority: { type: "participant", userId: secondUserId },
        expectedGeneration: 4,
        expectedSnapshotRevision: 0,
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
    scopedLockRows = [[{ status: "active" }]];

    const result = await storeFolioCollabSnapshot({
      authority: { type: "participant", userId: firstUserId },
      expectedGeneration: 3,
      expectedSnapshotRevision: 0,
      snapshotBytes: new TextEncoder().encode("snapshot"),
      value: authorized.value,
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.cause).toMatchObject({
        message: "snapshot transaction failed",
      });
    }

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
    ).toEqual(written.map(({ key }) => key));
    // The room pointer never published, so the store must hold nothing.
    expect([...fake.objects.keys()]).toEqual([]);
  });

  test("returns a file-write failure after keeping its cleanup intent recoverable", async () => {
    scopedLockRows = [[{ status: "active" }]];
    const authorized = await authorize(validRow());
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") {
      return;
    }
    const priorFlag = env.FEATURE_FILE_USAGE_LIMITS;
    const priorWorkerFlag =
      envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
    env.FEATURE_FILE_USAGE_LIMITS = true;
    envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = false;
    fake.failNext({ method: "PUT", code: "AccessDenied", status: 403 });
    try {
      const result = await storeFolioCollabSnapshot({
        authority: { type: "participant", userId: firstUserId },
        expectedGeneration: 3,
        expectedSnapshotRevision: 0,
        snapshotBytes: new TextEncoder().encode("snapshot"),
        value: authorized.value,
      });
      expect(result).toMatchObject({
        status: "error",
        error: { reason: "storage_unavailable" },
      });
      expect(
        fake.requests.filter(({ method }) => method === "DELETE"),
      ).toHaveLength(1);
      expect(scopedInsertedRows).toHaveLength(1);
      expect(scopedDeleteCalls).toBe(0);
      expect([...fake.objects.keys()]).toEqual([]);
    } finally {
      env.FEATURE_FILE_USAGE_LIMITS = priorFlag;
      envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = priorWorkerFlag;
    }
  });

  test("accepts a generation-fenced store from the collaboration service", () => {
    expect(
      decideFolioCollabSnapshotStore({
        actualGeneration: 4,
        actualSnapshotRevision: 0,
        authority: { type: "collab-service" },
        expectedGeneration: 4,
        expectedSnapshotRevision: 0,
        seedClaimedBy: "user_1",
        seedState: "claimed",
      }),
    ).toEqual({ status: "accepted" });
  });
});

describe("folio collaboration room stored files", () => {
  test("locks cleanup ownership and retires it when a snapshot publishes", async () => {
    const authorized = await authorize(validRow());
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") {
      return;
    }

    let intentLockRead = false;
    scopedLockRows = [
      [{ status: "active" }],
      [{ status: "active" }],
      [
        {
          generation: 3,
          seedClaimedBy: firstUserId,
          seedState: "claimed",
          yjsSnapshotFileId,
          yjsSnapshotRevision: 0,
          yjsSnapshotUpdatedAt: null,
        },
      ],
      () => {
        intentLockRead = true;
        const intentId = scopedInsertedRows.at(0)?.["id"];
        return typeof intentId === "string"
          ? [{ id: intentId, status: "writing" }]
          : [];
      },
    ];
    scopedRows = [
      [{ snapshotRevision: 1 }],
      () => {
        const intentId = scopedInsertedRows.at(0)?.["id"];
        return typeof intentId === "string" ? [{ id: intentId }] : [];
      },
    ];
    const snapshotBytes = new TextEncoder().encode("snapshot");

    const result = await storeFolioCollabSnapshot({
      authority: { type: "participant", userId: firstUserId },
      expectedGeneration: 3,
      expectedSnapshotRevision: 0,
      snapshotBytes,
      value: authorized.value,
    });

    expect(result).toMatchObject({
      status: "ok",
      value: {
        snapshotRevision: 1,
        sizeBytes: snapshotBytes.byteLength,
        status: "stored",
      },
    });
    expect(intentLockRead).toBe(true);
    expect(scopedLockRows).toEqual([]);
    expect(scopedPendingLockReads).toBe(0);
    expect(scopedDeleteCalls).toBe(1);
    expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(
      1,
    );
    expect([...fake.objects.keys()]).toHaveLength(1);
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
