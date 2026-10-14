/**
 * Organisation data exports against a real (PGlite) database: who may run
 * one, what one organisation can see of another's exports, that a run
 * carries every version of every document the requester's organisation
 * holds, and that expiry removes files before it marks a row expired.
 */

import { Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import JSZip from "jszip";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import {
  DATA_EXPORT_MAX_ATTEMPTS,
  entities,
  entityVersions,
  fields,
  organizationDataExports,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { createSafeDb } from "@/api/db/scoped";
import createDataExport from "@/api/handlers/data-exports/create";
import {
  DATA_EXPORT_FAILURE_MESSAGE,
  DATA_EXPORT_RUN_OUTCOME,
  runDataExport,
} from "@/api/handlers/data-exports/data-export-worker";
import downloadDataExport from "@/api/handlers/data-exports/download";
import { createExportSource } from "@/api/handlers/data-exports/export-source";
import readDataExport from "@/api/handlers/data-exports/get";
import listDataExports from "@/api/handlers/data-exports/list";
import { partManifestSchema } from "@/api/handlers/data-exports/manifest-schema";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { DATA_EXPORT_RETENTION_MS } from "@/api/lib/data-export-queue";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createRootMembershipScopedDb } from "@/api/lib/root-scoped-db";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { createMaintainDataExportsTask } from "@/api/lib/scheduler/tasks/data-export-maintenance";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();
const database = asTestRaw<RlsDatabase<Transaction>>(testDb);

const createdExportIds: SafeId<"dataExport">[] = [];

type InvokableHandler = (context: unknown) => Promise<unknown>;
// The handlers are invoked with hand-built contexts; their inferred context
// types are what the route layer supplies, not what a test assembles.
const invoke = async (
  endpoint: { handler: unknown },
  context: Record<string, unknown>,
): Promise<unknown> =>
  await asTestRaw<InvokableHandler>(endpoint.handler)(context);
const documentId = toSafeId<"entity">(Bun.randomUUIDv7());
const versionIds = [1, 2, 3].map(() =>
  toSafeId<"entityVersion">(Bun.randomUUIDv7()),
);
const fieldIds = versionIds.map(() => toSafeId<"field">(Bun.randomUUIDv7()));
const fileIds = versionIds.map(() => Bun.randomUUIDv7());
const fileBytes = versionIds.map((_, index) =>
  new TextEncoder().encode(`contract draft ${index + 1}`),
);

// A three-version document in matter A1, plus a tombstoned fourth version
// the export must leave out.
const tombstonedVersionId = toSafeId<"entityVersion">(Bun.randomUUIDv7());
await testDb.insert(entities).values({
  id: documentId,
  workspaceId: ids.wsA1,
  kind: "document",
  name: "Kupní smlouva.pdf",
});
await testDb.insert(entityVersions).values([
  ...versionIds.map((id, index) => ({
    id,
    workspaceId: ids.wsA1,
    entityId: documentId,
    versionNumber: index + 1,
    createdBy: ids.userA1,
  })),
  {
    id: tombstonedVersionId,
    workspaceId: ids.wsA1,
    entityId: documentId,
    versionNumber: 4,
    deletedAt: new Date(),
  },
]);
await testDb.insert(fields).values(
  versionIds.map((versionId, index) => ({
    id: fieldIds[index] ?? toSafeId<"field">(Bun.randomUUIDv7()),
    workspaceId: ids.wsA1,
    propertyId: ids.filePropertyA1,
    entityVersionId: versionId,
    content: {
      version: 1 as const,
      type: "file" as const,
      id: fileIds[index] ?? "",
      fileName: "Kupní smlouva.pdf",
      mimeType: "application/pdf",
      sizeBytes: fileBytes[index]?.byteLength ?? 0,
      encrypted: false,
      sha256Hex: sha256Hex(fileBytes[index] ?? new Uint8Array()),
      pdfFileId: null,
    },
  })),
);
await testDb
  .update(entities)
  .set({ currentVersionId: versionIds[2] })
  .where(eq(entities.id, documentId));

afterAll(async () => {
  if (createdExportIds.length > 0) {
    await testDb
      .delete(organizationDataExports)
      .where(inArray(organizationDataExports.id, createdExportIds));
  }
  await testDb.delete(fields).where(inArray(fields.id, fieldIds));
  await testDb
    .update(entities)
    .set({ currentVersionId: null })
    .where(eq(entities.id, documentId));
  await testDb
    .delete(entityVersions)
    .where(eq(entityVersions.entityId, documentId));
  await testDb.delete(entities).where(eq(entities.id, documentId));
  await releaseRlsFixture();
});

const insertExport = async (
  values: Partial<typeof organizationDataExports.$inferInsert> & {
    organizationId: SafeId<"organization">;
  },
) => {
  const id = toSafeId<"dataExport">(Bun.randomUUIDv7());
  createdExportIds.push(id);
  await testDb.insert(organizationDataExports).values({
    id,
    versionScope: "all",
    ...values,
  });
  return id;
};

const memorySink = () => {
  const parts = new Map<string, Uint8Array[]>();
  return {
    parts,
    sink: {
      openPart: (fileName: string) => {
        const chunks: Uint8Array[] = [];
        parts.set(fileName, chunks);
        return {
          write: async (chunk: Uint8Array) => {
            chunks.push(chunk);
          },
          close: async () => {},
        };
      },
    },
  };
};

const runFor = async (
  userId: SafeId<"user">,
  exportId: SafeId<"dataExport">,
) => {
  const db = createRootMembershipScopedDb(
    { organizationId: ids.orgA, userId },
    database,
  );
  const signal = new AbortController().signal;
  const pace = async () => {};
  const source = createExportSource({
    db,
    organizationId: ids.orgA,
    signal,
    pace,
  });
  const bytesByFileId = new Map(
    fileIds.map((fileId, index) => [fileId, fileBytes[index]]),
  );
  const memory = memorySink();
  let manifest: Uint8Array | null = null;
  let removed = 0;
  const now = new Date("2026-10-14T10:00:00.000Z");
  const outcome = await runDataExport(
    { exportId, organizationId: ids.orgA, userId },
    {
      db,
      source: {
        ...source,
        readFile: async (ref) => {
          const data =
            ref.type === "document" ? bytesByFileId.get(ref.fileId) : undefined;
          return data === undefined
            ? { type: "missing" }
            : {
                type: "found",
                sizeBytes: data.byteLength,
                chunks: (async function* () {
                  yield data;
                })(),
              };
        },
      },
      sink: memory.sink,
      writeManifest: async (bytes) => {
        manifest = bytes;
      },
      removeObjects: async () => {
        removed += 1;
      },
      pace,
      signal,
      partTargetBytes: 2 * 1024 ** 3,
      now: () => now,
    },
  );
  return { outcome, memory, manifest, removed, now };
};

describe("data export permissions", () => {
  const handlers = [
    ["create", createDataExport, { body: { versions: "all" } }],
    ["list", listDataExports, { query: {} }],
    ["get", readDataExport, { params: { exportId: Bun.randomUUIDv7() } }],
    [
      "download",
      downloadDataExport,
      {
        params: { exportId: Bun.randomUUIDv7() },
        body: { file: { type: "manifest" } },
      },
    ],
  ] as const;

  for (const role of ["member", "intern", "external"] as const) {
    for (const [name, endpoint, input] of handlers) {
      test(`a ${role} cannot ${name} organisation data exports`, async () => {
        const context = createTestHandlerContext({
          audit: NO_AUDIT,
          safeDb: NO_DB,
          scopedDb: NO_DB,
          memberRole: sessionMemberRole(role),
        });
        const response = await invoke(endpoint, { ...context, ...input });
        expect(response).toMatchObject({ code: 403 });
      });
    }
  }

  test("an owner cannot see or download another organisation's export", async () => {
    const foreignExport = await insertExport({
      organizationId: ids.orgB,
      requestedBy: ids.userB1,
      status: "ready",
      expiresAt: new Date(Date.now() + DATA_EXPORT_RETENTION_MS),
      parts: [
        {
          index: 1,
          fileName: "part.zip",
          sizeBytes: 1,
          sha256: "0".repeat(64),
          matterCount: 1,
          fileCount: 1,
        },
      ],
    });
    const safeDb = createSafeDb(database, [], ids.orgA, ids.userAdmin);
    const context = createTestHandlerContext({
      audit: async () => {},
      safeDb,
      scopedDb: NO_DB,
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
    });
    const read = await invoke(readDataExport, {
      ...context,
      params: { exportId: foreignExport },
    });
    expect(read).toMatchObject({ code: 404 });
    const download = await invoke(downloadDataExport, {
      ...context,
      params: { exportId: foreignExport },
      body: { file: { type: "part", index: 1 } },
    });
    expect(download).toMatchObject({ code: 404 });
    const list = await invoke(listDataExports, { ...context, query: {} });
    expect(JSON.stringify(list)).not.toContain(foreignExport);
  });
});

describe("data export run", () => {
  test("carries every live version of every document the organisation holds, and nothing of another organisation", async () => {
    const exportId = await insertExport({
      organizationId: ids.orgA,
      requestedBy: ids.userAdmin,
    });
    const { outcome, memory, manifest, removed, now } = await runFor(
      ids.userAdmin,
      exportId,
    );
    expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.READY);
    expect(removed).toBe(0);
    expect(manifest).not.toBeNull();

    const [partChunks] = [...memory.parts.values()];
    const zip = await JSZip.loadAsync(Buffer.concat(partChunks ?? []));
    const partManifest = v.parse(
      partManifestSchema,
      JSON.parse((await zip.file("manifest.json")?.async("string")) ?? ""),
    );
    const matterIds = partManifest.matters.map((m) => m.id);
    expect(matterIds).toContain(ids.wsA1);
    expect(matterIds).toContain(ids.wsA2);
    expect(matterIds).not.toContain(ids.wsB1);
    const document = partManifest.matters
      .flatMap((m) => m.documents)
      .find((d) => d.id === documentId);
    expect(document?.versions.map((ver) => ver.id)).toEqual(
      versionIds.map(String),
    );
    for (const [index, version] of (document?.versions ?? []).entries()) {
      const file = version.files.at(0);
      expect(file?.sha256).toBe(
        sha256Hex(fileBytes[index] ?? new Uint8Array()),
      );
      const stored = await zip.file(file?.path ?? "")?.async("uint8array");
      expect(stored).toEqual(fileBytes[index]);
    }

    const [row] = await testDb
      .select()
      .from(organizationDataExports)
      .where(eq(organizationDataExports.id, exportId));
    expect(row?.status).toBe("ready");
    expect(row?.parts).toHaveLength(1);
    expect(row?.plan?.parts.map((part) => part.index)).toEqual([1]);
    expect(row?.attempts).toBe(1);
    expect(row?.expiresAt?.getTime()).toBe(
      now.getTime() + DATA_EXPORT_RETENTION_MS,
    );
  });

  test("refuses to run once the requester is no longer an owner or admin", async () => {
    const exportId = await insertExport({
      organizationId: ids.orgA,
      requestedBy: ids.userA1,
    });
    const { outcome, memory } = await runFor(ids.userA1, exportId);
    expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.FAILED);
    expect(memory.parts.size).toBe(0);
    const [row] = await testDb
      .select()
      .from(organizationDataExports)
      .where(eq(organizationDataExports.id, exportId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(DATA_EXPORT_FAILURE_MESSAGE.notAuthorized);
  });
});

describe("data export maintenance", () => {
  test("deletes expired files before marking the export expired, and keeps it ready when deletion fails", async () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    const expired = await insertExport({
      organizationId: ids.orgA,
      status: "ready",
      expiresAt: new Date(now.getTime() - 1000),
    });
    const stuck = await insertExport({
      organizationId: ids.orgB,
      status: "ready",
      expiresAt: new Date(now.getTime() - 1000),
    });
    const live = await insertExport({
      organizationId: ids.orgB,
      status: "ready",
      expiresAt: new Date(now.getTime() + 1000),
    });
    const deletedPrefixes: string[] = [];
    const task = createMaintainDataExportsTask({
      deleteObjects: async (prefix) => {
        if (prefix.includes(stuck)) {
          throw new Error("storage unavailable");
        }
        deletedPrefixes.push(prefix);
      },
      enqueue: async () => "requeued",
    });
    const result = await task(
      asTestRaw<SchedulerTaskContext>({
        db: testDb,
        dueAt: DueSlot.of({ nextRunAt: now }),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        signal: new AbortController().signal,
      }),
    );
    // The failed deletion is reported, not swallowed.
    expect(result !== undefined && Result.isError(result)).toBe(true);
    expect(deletedPrefixes).toEqual([
      `exports/${ids.orgA}/data-exports/${expired}/`,
    ]);
    const rows = await testDb
      .select({
        id: organizationDataExports.id,
        status: organizationDataExports.status,
      })
      .from(organizationDataExports)
      .where(inArray(organizationDataExports.id, [expired, stuck, live]));
    const statusById = new Map(rows.map((row) => [row.id, row.status]));
    expect(statusById.get(expired)).toBe("expired");
    expect(statusById.get(stuck)).toBe("ready");
    expect(statusById.get(live)).toBe("ready");
  });

  test("resumes runs whose worker stopped and fails those out of attempts", async () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    const stale = await insertExport({
      organizationId: ids.orgA,
      status: "running",
      requestedBy: ids.userAdmin,
      attempts: 1,
      createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      heartbeatAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    const exhausted = await insertExport({
      organizationId: ids.orgB,
      status: "running",
      requestedBy: ids.userB1,
      attempts: DATA_EXPORT_MAX_ATTEMPTS,
      heartbeatAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    const enqueued: string[] = [];
    const task = createMaintainDataExportsTask({
      deleteObjects: async () => {},
      enqueue: async ({ exportId, attempts }) => {
        enqueued.push(`${exportId}:${attempts}`);
        return "requeued";
      },
    });
    await task(
      asTestRaw<SchedulerTaskContext>({
        db: testDb,
        dueAt: DueSlot.of({ nextRunAt: now }),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        signal: new AbortController().signal,
      }),
    );
    // The resumed run is queued again and handed to the queue in the same
    // sweep as its next attempt (the job id carries the attempt count). The
    // partial unique index allows one active export per organisation, so
    // this one row also stands for a queued export whose handoff was lost.
    expect(enqueued).toContain(`${stale}:1`);
    const rows = await testDb
      .select({
        id: organizationDataExports.id,
        status: organizationDataExports.status,
      })
      .from(organizationDataExports)
      .where(inArray(organizationDataExports.id, [stale, exhausted]));
    const statusById = new Map(rows.map((row) => [row.id, row.status]));
    expect(statusById.get(stale)).toBe("queued");
    expect(statusById.get(exhausted)).toBe("failed");
  });
});
