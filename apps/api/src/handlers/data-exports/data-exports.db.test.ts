/**
 * Organisation data exports against a real (PGlite) database: who may start
 * and run one, what one organisation can see of another's exports, that a
 * run carries every version of every client-matter document and never a
 * personal matter, that only the claimed attempt may write, and that expiry
 * only marks rows (the bucket lifecycle deletes the files).
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import JSZip from "jszip";
import * as v from "valibot";

import { cents } from "@stll/money";
import { sha256Hex } from "@stll/sha256/bun";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  ACTIVE_DATA_EXPORT_PREDICATE,
  contacts,
  DATA_EXPORT_MAX_FAILURES,
  entities,
  entityVersions,
  expenses,
  fields,
  INVOICE_PAYMENT_ORIGIN,
  INVOICE_STATUS,
  invoiceLines,
  invoicePayments,
  invoices,
  organizationDataExports,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { DataExportPlanRecord } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { createSafeDb } from "@/api/db/scoped";
import {
  DATA_EXPORT_RECORD_BYTES_CAP,
  planDataExport,
} from "@/api/handlers/data-exports/build-export";
import type {
  ExportPlan,
  ExportSource,
} from "@/api/handlers/data-exports/build-export";
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
import {
  DATA_EXPORT_START_OUTCOME,
  startDataExport,
} from "@/api/handlers/data-exports/start-export";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  DATA_EXPORT_MATTER_RECORD_NAMES,
  DATA_EXPORT_ORGANIZATION_RECORD_NAMES,
} from "@/api/lib/data-export/archive-plan";
import { DATA_EXPORT_RETENTION_MS } from "@/api/lib/data-export/queue";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  createRootMembershipScopedDb,
  createRootScopedDb,
} from "@/api/lib/root-scoped-db";
import { STREAMING_UPLOAD_MAX_EXPECTED_BYTES } from "@/api/lib/s3/multipart-sink";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  createMaintainDataExportsTask,
  DATA_EXPORT_HANDOFF_PAGE_SIZE,
} from "@/api/lib/scheduler/tasks/data-export-maintenance";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { createLeasedSchedulerJobFixture } from "@/api/tests/helpers/leased-scheduler-job";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

type ExportFixture = Awaited<ReturnType<typeof getRlsFixture>>;
let testDb: ExportFixture["testDb"];
let ids: ExportFixture["ids"];
let database: RlsDatabase<Transaction>;

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
beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  database = asTestRaw<RlsDatabase<Transaction>>(testDb);

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
});

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

const assertCompleteStoredPlan = (plan: DataExportPlanRecord | null) => {
  expect(plan).not.toBeNull();
  if (plan === null) {
    panic("The export plan must be persisted before writing an archive part");
  }
  expect(Object.keys(plan.paths.organization.records).toSorted()).toEqual(
    Object.keys(DATA_EXPORT_ORGANIZATION_RECORD_NAMES).toSorted(),
  );
  for (const paths of Object.values(plan.paths.organization.records)) {
    expect(paths.json.length).toBeGreaterThan(0);
    expect(paths.csv.length).toBeGreaterThan(0);
  }
  for (const path of Object.values(plan.paths.organization.templateFiles)) {
    expect(path.length).toBeGreaterThan(0);
  }
  expect(Object.keys(plan.paths.matters).toSorted()).toEqual(
    plan.parts.flatMap((part) => part.matterIds).toSorted(),
  );
  expect(
    plan.parts.every(
      ({ paths }) => paths.manifest.length > 0 && paths.readme.length > 0,
    ),
  ).toBe(true);
  for (const part of plan.parts) {
    for (const matterId of part.matterIds) {
      const matter = plan.paths.matters[matterId];
      expect(matter).toBeDefined();
      if (matter === undefined) {
        panic(`The stored plan is missing matter paths for ${matterId}`);
      }
      expect(matter.directory.length).toBeGreaterThan(0);
      expect(matter.record.length).toBeGreaterThan(0);
      expect(Object.keys(matter.records).toSorted()).toEqual(
        Object.keys(DATA_EXPORT_MATTER_RECORD_NAMES).toSorted(),
      );
      for (const paths of Object.values(matter.records)) {
        expect(paths.json.length).toBeGreaterThan(0);
        expect(paths.csv.length).toBeGreaterThan(0);
      }
      for (const paths of Object.values(matter.folders)) {
        expect(paths.current.length).toBeGreaterThan(0);
        expect(paths.history.length).toBeGreaterThan(0);
      }
      for (const document of Object.values(matter.documents)) {
        for (const version of Object.values(document.versions)) {
          for (const path of Object.values(version.files)) {
            expect(path.length).toBeGreaterThan(0);
          }
        }
      }
    }
  }
};

const memorySink = (
  readPlanAtOpen?: () => Promise<DataExportPlanRecord | null>,
) => {
  const parts = new Map<string, Uint8Array[]>();
  return {
    parts,
    sink: {
      openPart: (fileName: string) => {
        const chunks: Uint8Array[] = [];
        parts.set(fileName, chunks);
        const planAtOpen = readPlanAtOpen?.();
        let checkedPlan = false;
        return {
          write: async (chunk: Uint8Array) => {
            if (!checkedPlan && planAtOpen !== undefined) {
              checkedPlan = true;
              assertCompleteStoredPlan(await planAtOpen);
            }
            chunks.push(chunk);
          },
          close: async () => {},
        };
      },
    },
  };
};

type RunForOptions = {
  /** Wraps the database-backed source, to act between run steps. */
  wrapSource?: (source: ExportSource) => ExportSource;
  controller?: AbortController;
  recordBytesCap?: number;
  verifyPlanBeforeFirstWrite?: boolean;
};

const runFor = async (
  userId: SafeId<"user">,
  exportId: SafeId<"dataExport">,
  {
    wrapSource = (source) => source,
    controller = new AbortController(),
    recordBytesCap = DATA_EXPORT_RECORD_BYTES_CAP,
    verifyPlanBeforeFirstWrite = false,
  }: RunForOptions = {},
) => {
  const db = createRootMembershipScopedDb(
    { organizationId: ids.orgA, userId },
    database,
  );
  const signal = controller.signal;
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
  const memory = memorySink(
    verifyPlanBeforeFirstWrite
      ? async () => {
          const [row] = await testDb
            .select({ plan: organizationDataExports.plan })
            .from(organizationDataExports)
            .where(eq(organizationDataExports.id, exportId));
          return row?.plan ?? null;
        }
      : undefined,
  );
  let manifest: Uint8Array | null = null;
  const storageAttempts: number[] = [];
  const now = new Date("2026-10-14T10:00:00.000Z");
  const outcome = await runDataExport(
    { exportId, organizationId: ids.orgA, userId },
    {
      db,
      source: wrapSource({
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
      }),
      storage: (attempt) => {
        storageAttempts.push(attempt);
        return {
          sink: memory.sink,
          writeManifest: async (bytes) => {
            manifest = bytes;
          },
        };
      },
      pace,
      signal,
      partTargetBytes: 2 * 1024 ** 3,
      recordBytesCap,
      now: () => now,
    },
  );
  return { outcome, memory, manifest, now, storageAttempts };
};

const planFor = async (userId: SafeId<"user">): Promise<ExportPlan> => {
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
  return (
    await planDataExport({
      source,
      partTargetBytes: Number.MAX_SAFE_INTEGER,
      recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
      scope: { versions: "all" },
      pace,
    })
  ).unwrap();
};

const withFirstPartEstimate = (
  plan: ExportPlan,
  estimatedBytes: number,
): ExportPlan => {
  const firstPart = plan.parts.at(0);
  if (firstPart === undefined) {
    panic("The RLS fixture must produce at least one export part");
  }
  return {
    ...plan,
    parts: [{ ...firstPart, estimatedBytes }, ...plan.parts.slice(1)],
    bytesTotal: plan.bytesTotal + estimatedBytes - firstPart.estimatedBytes,
  };
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
          attempt: 1,
          fileName: "part.zip",
          sizeBytes: 1,
          sha256: "0".repeat(64),
          matterIds: [],
          fileCount: 1,
          totals: {
            matters: 0,
            documents: 0,
            versions: 0,
            files: 0,
            fileBytes: 0,
          },
          problems: [],
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
    const { outcome, memory, manifest, now, storageAttempts } = await runFor(
      ids.userAdmin,
      exportId,
      { verifyPlanBeforeFirstWrite: true },
    );
    expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.READY);
    expect(manifest).not.toBeNull();

    const [row] = await testDb
      .select()
      .from(organizationDataExports)
      .where(eq(organizationDataExports.id, exportId));
    assertCompleteStoredPlan(row?.plan ?? null);
    const partManifestPath = row?.plan?.parts.at(0)?.paths.manifest;
    if (partManifestPath === undefined) {
      panic("The completed export must store its part manifest path");
    }

    const [partChunks] = [...memory.parts.values()];
    const zip = await JSZip.loadAsync(Buffer.concat(partChunks ?? []));
    const partManifest = v.parse(
      partManifestSchema,
      JSON.parse((await zip.file(partManifestPath)?.async("string")) ?? ""),
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

    expect(row?.status).toBe("ready");
    expect(row?.parts).toHaveLength(1);
    expect(row?.plan?.parts.map((part) => part.index)).toEqual([1]);
    expect(row?.attempt).toBe(1);
    // Every stored file is addressed by the attempt that wrote it, so a
    // superseded attempt's late upload cannot replace a published object.
    expect(storageAttempts).toEqual([1]);
    expect(row?.parts.map((part) => part.attempt)).toEqual([1]);
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
  test("expires ready exports in bounded batches and continues the remainder", async () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    const exportIds: SafeId<"dataExport">[] = [];
    for (let index = 0; index < 9; index += 1) {
      exportIds.push(
        await insertExport({
          organizationId: ids.orgA,
          status: "ready",
          expiresAt: new Date(now.getTime() - 9000 + index * 1000),
        }),
      );
    }

    const continuations: Date[] = [];
    const task = createMaintainDataExportsTask({
      handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
      enqueue: async () => "requeued",
    });
    const runMaintenance = async (nextRunAt: Date) =>
      await task(
        asTestRaw<SchedulerTaskContext>({
          runId: createSafeId<"schedulerJobRun">(),
          db: testDb,
          dueAt: DueSlot.of({ nextRunAt }),
          job: createLeasedSchedulerJobFixture({
            id: "data-export-maintenance-test",
            task: "dataExports.maintain",
            nextRunAt,
          }),
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          scheduleContinuation: (continuationAt: Date) =>
            continuations.push(continuationAt),
          signal: new AbortController().signal,
        }),
      );

    const readStatuses = async () =>
      new Map(
        (
          await testDb
            .select({
              id: organizationDataExports.id,
              status: organizationDataExports.status,
            })
            .from(organizationDataExports)
            .where(inArray(organizationDataExports.id, exportIds))
        ).map((row) => [row.id, row.status]),
      );

    let nextRunAt: Date | null = now;
    while (nextRunAt !== null) {
      const previousContinuationCount = continuations.length;
      const result = await runMaintenance(nextRunAt);
      expect(result !== undefined && Result.isOk(result)).toBe(true);
      nextRunAt =
        continuations.length > previousContinuationCount
          ? (continuations.at(-1) ?? null)
          : null;
    }
    expect(continuations.length).toBeGreaterThan(0);

    const finalStatuses = await readStatuses();
    for (const exportId of exportIds) {
      expect(finalStatuses.get(exportId)).toBe("expired");
    }
  });

  test("marks exports expired without deleting objects, and refuses their downloads", async () => {
    // Export objects are deleted by the bucket lifecycle, never by the app:
    // the maintenance task only stops offering them.
    const now = new Date("2026-10-14T12:00:00.000Z");
    const part = {
      index: 1,
      attempt: 1,
      fileName: "part.zip",
      sizeBytes: 1,
      sha256: "0".repeat(64),
      matterIds: [],
      fileCount: 0,
      totals: { matters: 0, documents: 0, versions: 0, files: 0, fileBytes: 0 },
      problems: [],
    };
    const expired = await insertExport({
      organizationId: ids.orgA,
      status: "ready",
      expiresAt: new Date(now.getTime() - 1000),
      parts: [part],
    });
    const live = await insertExport({
      organizationId: ids.orgB,
      status: "ready",
      expiresAt: new Date(now.getTime() + 1000),
    });
    const task = createMaintainDataExportsTask({
      handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
      enqueue: async () => "requeued",
    });
    const result = await task(
      asTestRaw<SchedulerTaskContext>({
        runId: createSafeId<"schedulerJobRun">(),
        db: testDb,
        dueAt: DueSlot.of({ nextRunAt: now }),
        job: createLeasedSchedulerJobFixture({
          id: "data-export-maintenance-test",
          task: "dataExports.maintain",
          nextRunAt: now,
        }),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        scheduleContinuation: () => {},
        signal: new AbortController().signal,
      }),
    );
    expect(result !== undefined && Result.isOk(result)).toBe(true);
    const rows = await testDb
      .select({
        id: organizationDataExports.id,
        status: organizationDataExports.status,
      })
      .from(organizationDataExports)
      .where(inArray(organizationDataExports.id, [expired, live]));
    const statusById = new Map(rows.map((row) => [row.id, row.status]));
    expect(statusById.get(expired)).toBe("expired");
    expect(statusById.get(live)).toBe("ready");

    const context = createTestHandlerContext({
      audit: async () => {},
      safeDb: createSafeDb(database, [], ids.orgA, ids.userAdmin),
      scopedDb: NO_DB,
      memberRole: sessionMemberRole("owner"),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
    });
    const download = await invoke(downloadDataExport, {
      ...context,
      params: { exportId: expired },
      body: { file: { type: "part", index: 1 } },
    });
    expect(download).toMatchObject({ code: 409 });
  });

  test("hands every settled queued export to the queue in one run, past a full page", async () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    const settledAt = new Date(now.getTime() - 60 * 60 * 1000);
    // One active export per organisation: one queued row in each.
    const first = await insertExport({
      organizationId: ids.orgA,
      requestedBy: ids.userAdmin,
      createdAt: settledAt,
    });
    const second = await insertExport({
      organizationId: ids.orgB,
      requestedBy: ids.userB1,
      createdAt: new Date(settledAt.getTime() + 1000),
    });
    const enqueued: string[] = [];
    // A one-row page: the first row stays queued after its handoff, and the
    // second must still be reached.
    const task = createMaintainDataExportsTask({
      handoffPageSize: 1,
      enqueue: async ({ exportId }) => {
        enqueued.push(exportId);
        return "requeued";
      },
    });
    try {
      await task(
        asTestRaw<SchedulerTaskContext>({
          runId: createSafeId<"schedulerJobRun">(),
          db: testDb,
          dueAt: DueSlot.of({ nextRunAt: now }),
          job: createLeasedSchedulerJobFixture({
            id: "data-export-maintenance-test",
            task: "dataExports.maintain",
            nextRunAt: now,
          }),
          logger: { info: () => {}, warn: () => {}, error: () => {} },
          scheduleContinuation: () => {},
          signal: new AbortController().signal,
        }),
      );
      expect(enqueued).toContain(first);
      expect(enqueued).toContain(second);
    } finally {
      await testDb
        .update(organizationDataExports)
        .set({ status: "failed" })
        .where(inArray(organizationDataExports.id, [first, second]));
    }
  });

  test("resumes runs whose worker stopped and fails those out of attempts", async () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    const stale = await insertExport({
      organizationId: ids.orgA,
      status: "running",
      requestedBy: ids.userAdmin,
      attempt: 1,
      failures: 0,
      createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      heartbeatAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    const exhausted = await insertExport({
      organizationId: ids.orgB,
      status: "running",
      requestedBy: ids.userB1,
      attempt: DATA_EXPORT_MAX_FAILURES,
      failures: DATA_EXPORT_MAX_FAILURES - 1,
      heartbeatAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    const enqueued: string[] = [];
    const task = createMaintainDataExportsTask({
      handoffPageSize: DATA_EXPORT_HANDOFF_PAGE_SIZE,
      enqueue: async ({ exportId, attempt }) => {
        enqueued.push(`${exportId}:${attempt}`);
        return "requeued";
      },
    });
    await task(
      asTestRaw<SchedulerTaskContext>({
        runId: createSafeId<"schedulerJobRun">(),
        db: testDb,
        dueAt: DueSlot.of({ nextRunAt: now }),
        job: createLeasedSchedulerJobFixture({
          id: "data-export-maintenance-test",
          task: "dataExports.maintain",
          nextRunAt: now,
        }),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        scheduleContinuation: () => {},
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
    // Free organisation A's single export slot for the tests that follow.
    await testDb
      .update(organizationDataExports)
      .set({ status: "failed" })
      .where(eq(organizationDataExports.id, stale));
  });
});

const setRole = async (memberId: string, role: "member" | "admin") => {
  await testDb.update(member).set({ role }).where(eq(member.id, memberId));
};

const statusOf = async (exportId: SafeId<"dataExport">) =>
  (
    await testDb
      .select({
        status: organizationDataExports.status,
        error: organizationDataExports.error,
        attempt: organizationDataExports.attempt,
        failures: organizationDataExports.failures,
      })
      .from(organizationDataExports)
      .where(eq(organizationDataExports.id, exportId))
  ).at(0);

describe("personal matters", () => {
  test("are never exported, whoever runs the export", async () => {
    // A personal matter (no client) of member A1, who is promoted to admin
    // for this test, so both admins of the organisation run an export.
    const personalId = toSafeId<"workspace">(Bun.randomUUIDv7());
    await testDb.insert(workspaces).values({
      id: personalId,
      organizationId: ids.orgA,
      clientId: null,
      name: "Personal notes",
      reference: `P-${personalId.slice(0, 8)}`,
      status: "active",
    });
    await testDb.insert(workspaceMembers).values({
      id: toSafeId<"workspaceMember">(Bun.randomUUIDv7()),
      workspaceId: personalId,
      userId: ids.userA1,
    });
    await setRole(ids.memberA1org, "admin");
    try {
      for (const userId of [ids.userA1, ids.userAdmin]) {
        const exportId = await insertExport({
          organizationId: ids.orgA,
          requestedBy: userId,
        });
        // db-await-in-loop: two sequential export runs; each needs the organisation's single export slot
        const { outcome, memory } = await runFor(userId, exportId);
        expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.READY);
        const [row] = await testDb
          .select({ plan: organizationDataExports.plan })
          .from(organizationDataExports)
          .where(eq(organizationDataExports.id, exportId));
        const partManifestPath = row?.plan?.parts.at(0)?.paths.manifest;
        if (partManifestPath === undefined) {
          panic("The completed export must store its part manifest path");
        }
        const [partChunks] = [...memory.parts.values()];
        const zip = await JSZip.loadAsync(Buffer.concat(partChunks ?? []));
        const manifest = v.parse(
          partManifestSchema,
          JSON.parse((await zip.file(partManifestPath)?.async("string")) ?? ""),
        );
        const matterIds = manifest.matters.map((matter) => matter.id);
        expect(matterIds).toContain(ids.wsA1);
        expect(matterIds).not.toContain(personalId);
        expect(Object.keys(zip.files).join("\n")).not.toContain(
          "Personal notes",
        );
      }
    } finally {
      await setRole(ids.memberA1org, "member");
      await testDb.delete(workspaces).where(eq(workspaces.id, personalId));
    }
  });
});

describe("starting an export", () => {
  let scopedDb: ReturnType<typeof createRootScopedDb>;
  beforeAll(() => {
    scopedDb = createRootScopedDb(
      { organizationId: ids.orgB, userId: ids.userB1, workspaceIds: [] },
      database,
    );
  });
  const start = async () =>
    await scopedDb(
      async (tx) =>
        await startDataExport({
          tx,
          organizationId: ids.orgB,
          userId: ids.userB1,
          versions: "all",
          recordAuditEvent: async () => {},
        }),
    );
  const finishActive = async () => {
    await testDb
      .update(organizationDataExports)
      .set({ status: "failed" })
      .where(
        and(
          eq(organizationDataExports.organizationId, ids.orgB),
          ACTIVE_DATA_EXPORT_PREDICATE,
        ),
      );
  };

  test("starts one export and returns it while it is active", async () => {
    await finishActive();
    const first = await start();
    expect(first.outcome).toBe(DATA_EXPORT_START_OUTCOME.STARTED);
    const second = await start();
    expect(second.outcome).toBe(DATA_EXPORT_START_OUTCOME.ALREADY_ACTIVE);
    expect(second.row?.id).toBe(first.row?.id);
    if (first.row !== null) {
      createdExportIds.push(first.row.id);
    }
    await finishActive();
  });

  test("lets only one of two concurrent requests start an export", async () => {
    await finishActive();
    const results = await Promise.all([start(), start()]);
    const started = results.filter(
      (result) => result.outcome === DATA_EXPORT_START_OUTCOME.STARTED,
    );
    expect(started).toHaveLength(1);
    expect(new Set(results.map((result) => result.row?.id)).size).toBe(1);
    for (const result of started) {
      createdExportIds.push(result.row.id);
    }
    await finishActive();
  });

  test("keeps matching the partial index under a generic plan", async () => {
    await finishActive();
    // The insert exactly as the start path builds it, prepared once and
    // executed more times than Postgres takes to switch to a generic plan.
    const query = testDb
      .insert(organizationDataExports)
      .values({
        organizationId: ids.orgB,
        requestedBy: ids.userB1,
        versionScope: "all",
      })
      .onConflictDoNothing({
        target: organizationDataExports.organizationId,
        where: ACTIVE_DATA_EXPORT_PREDICATE,
      })
      .returning({ id: organizationDataExports.id })
      .toSQL();
    const literal = (value: unknown) =>
      `'${String(value).replaceAll("'", "''")}'`;
    await testDb.execute(sql.raw("SET plan_cache_mode = force_generic_plan"));
    await testDb.execute(sql.raw(`PREPARE start_data_export AS ${query.sql}`));
    try {
      for (let execution = 0; execution < 7; execution++) {
        // A fresh id per execution; the first starts an export, the rest
        // meet the active one and do nothing.
        const params = query.params.map((param, index) =>
          index === 0 ? literal(Bun.randomUUIDv7()) : literal(param),
        );
        // db-await-in-loop: the test is repeated execution of one prepared statement
        await testDb.execute(
          sql.raw(`EXECUTE start_data_export(${params.join(", ")})`),
        );
      }
    } finally {
      await testDb.execute(sql.raw("DEALLOCATE start_data_export"));
      await testDb.execute(sql.raw("RESET plan_cache_mode"));
    }
    const active = await testDb
      .select({ id: organizationDataExports.id })
      .from(organizationDataExports)
      .where(
        and(
          eq(organizationDataExports.organizationId, ids.orgB),
          ACTIVE_DATA_EXPORT_PREDICATE,
        ),
      );
    expect(active).toHaveLength(1);
    createdExportIds.push(...active.map((row) => row.id));
    await finishActive();
  });
});

describe("run ownership", () => {
  test("exports a client invoice with its matter line and payments exactly once", async () => {
    const invoiceId = createSafeId<"invoice">();
    const lineId = createSafeId<"invoiceLine">();
    const paymentId = createSafeId<"invoicePayment">();
    const expenseId = createSafeId<"expense">();
    const unbilledExpenseId = createSafeId<"expense">();
    const matterInvoiceId = createSafeId<"invoice">();
    const matterPaymentId = createSafeId<"invoicePayment">();
    const source = createExportSource({
      db: createRootMembershipScopedDb(
        { organizationId: ids.orgA, userId: ids.userAdmin },
        database,
      ),
      organizationId: ids.orgA,
      signal: new AbortController().signal,
      pace: async () => {},
    });
    const baselineBytes = await source.measureRecords([ids.wsA1]);
    await testDb.insert(invoices).values({
      id: invoiceId,
      organizationId: ids.orgA,
      clientId: ids.contactA,
      workspaceId: null,
      invoiceNumber: `INV-EXPORT-${invoiceId}`,
      invoiceDate: "2026-10-01",
      currency: "EUR",
      status: INVOICE_STATUS.SENT,
      totalAmount: cents(121),
    });
    await testDb.insert(invoiceLines).values({
      id: lineId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceId,
      position: 0,
      description: "Legal services",
      quantity: "1.0000",
      unit: "h",
      unitPrice: cents(100),
      vatRateBps: 2100,
      vatTreatment: "domestic_vat",
      netAmount: cents(100),
      vatAmount: cents(21),
      grossAmount: cents(121),
      source: "manual",
    });
    await testDb.insert(invoicePayments).values({
      id: paymentId,
      organizationId: ids.orgA,
      invoiceId,
      amount: cents(121),
      paidOn: "2026-10-02",
      method: "bank_transfer",
      origin: INVOICE_PAYMENT_ORIGIN.RECORDED,
      recordedBy: ids.userAdmin,
    });
    await testDb.insert(expenses).values([
      {
        id: expenseId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        matterId: documentId,
        dateIncurred: "2026-09-30",
        amount: cents(121),
        currency: "EUR",
        category: "filing_fee",
        description: "Client invoice expense",
        invoiceId,
      },
      {
        id: unbilledExpenseId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        userId: ids.userA1,
        matterId: documentId,
        dateIncurred: "2026-09-29",
        amount: cents(75),
        currency: "EUR",
        category: "filing_fee",
        description: "Unbilled matter expense",
        invoiceId: null,
      },
    ]);
    await testDb.insert(invoices).values({
      id: matterInvoiceId,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      invoiceNumber: `INV-MATTER-${matterInvoiceId}`,
      invoiceDate: "2026-10-01",
      currency: "EUR",
      status: INVOICE_STATUS.SENT,
      totalAmount: cents(200),
    });
    await testDb.insert(invoicePayments).values({
      id: matterPaymentId,
      organizationId: ids.orgA,
      invoiceId: matterInvoiceId,
      amount: cents(200),
      paidOn: "2026-10-02",
      method: "bank_transfer",
      origin: INVOICE_PAYMENT_ORIGIN.RECORDED,
      recordedBy: ids.userAdmin,
    });

    try {
      const organizationRecords = v.parse(
        v.object({
          invoices: v.object({
            rows: v.array(
              v.object({
                id: v.string(),
                workspaceId: v.nullable(v.string()),
                lines: v.array(
                  v.object({
                    id: v.string(),
                    workspaceId: v.string(),
                  }),
                ),
                payments: v.array(v.object({ id: v.string() })),
              }),
            ),
          }),
        }),
        await source.loadOrganizationRecords(),
      );
      const organizationInvoiceRows = organizationRecords.invoices.rows.filter(
        (row) => row.id === invoiceId,
      );
      expect(organizationInvoiceRows).toHaveLength(1);
      expect(organizationInvoiceRows[0]).toMatchObject({
        workspaceId: null,
        lines: [{ id: lineId, workspaceId: ids.wsA1 }],
        payments: [{ id: paymentId }],
      });
      expect(organizationInvoiceRows[0]).not.toHaveProperty("expenses");
      const measured = await source.measureRecords([]);
      expect(measured.organizationBytes).toBeGreaterThan(
        baselineBytes.organizationBytes,
      );
      expect(measured.matterBytes.size).toBe(0);
      const measuredMatter = await source.measureRecords([ids.wsA1]);
      const baselineMatterBytes = baselineBytes.matterBytes.get(ids.wsA1);
      const measuredMatterBytes = measuredMatter.matterBytes.get(ids.wsA1);
      expect(baselineMatterBytes).toBeDefined();
      expect(measuredMatterBytes).toBeDefined();
      if (
        baselineMatterBytes === undefined ||
        measuredMatterBytes === undefined
      ) {
        throw new Error("Matter measurement omitted a requested workspace");
      }
      expect(measuredMatterBytes).toBeGreaterThan(baselineMatterBytes);

      const matters = await Promise.all(
        [ids.wsA1, ids.wsA2].map(
          async (workspaceId) => await source.loadMatter(workspaceId, "all"),
        ),
      );
      const matterExpenses = matters.flatMap((matter) =>
        matter === null
          ? []
          : v.parse(
              v.object({
                expenses: v.object({
                  rows: v.array(v.object({ id: v.string() })),
                }),
              }),
              matter,
            ).expenses.rows,
      );
      expect(matterExpenses.filter((row) => row.id === expenseId)).toHaveLength(
        1,
      );
      expect(
        matterExpenses.filter((row) => row.id === unbilledExpenseId),
      ).toHaveLength(1);
      const matterInvoiceRows = matters.flatMap((matter) =>
        matter === null ? [] : matter.invoices.rows,
      );
      expect(
        matterInvoiceRows.filter((row) => row["id"] === invoiceId),
      ).toHaveLength(0);
      expect(
        matterInvoiceRows.filter((row) => row["id"] === matterInvoiceId),
      ).toHaveLength(1);
      expect(
        matterInvoiceRows.find((row) => row["id"] === matterInvoiceId),
      ).toMatchObject({ payments: [{ id: matterPaymentId }] });
    } finally {
      await testDb
        .delete(expenses)
        .where(inArray(expenses.id, [expenseId, unbilledExpenseId]));
      await testDb
        .delete(invoices)
        .where(inArray(invoices.id, [invoiceId, matterInvoiceId]));
    }
  });

  test("measures records by their expanded size, not their compressed storage", async () => {
    // Repetitive text compresses to a sliver of its size on disk; the export
    // still loads and serialises all of it.
    const notes = "Kancelář ".repeat(512 * 1024);
    const [contact] = await testDb
      .insert(contacts)
      .values({
        organizationId: ids.orgA,
        type: "person",
        displayName: "Measured contact",
        notes,
      })
      .returning({ id: contacts.id });
    try {
      const source = createExportSource({
        db: createRootMembershipScopedDb(
          { organizationId: ids.orgA, userId: ids.userAdmin },
          database,
        ),
        organizationId: ids.orgA,
        signal: new AbortController().signal,
        pace: async () => {},
      });
      const measured = await source.measureRecords([]);
      expect(measured.organizationBytes).toBeGreaterThanOrEqual(
        new TextEncoder().encode(notes).byteLength,
      );
    } finally {
      if (contact !== undefined) {
        await testDb.delete(contacts).where(eq(contacts.id, contact.id));
      }
    }
  });

  test("an oversized indivisible part fails before opening an upload", async () => {
    const estimatedBytes = STREAMING_UPLOAD_MAX_EXPECTED_BYTES + 1;
    const planned = await planFor(ids.userAdmin);
    const exportId = await insertExport({
      organizationId: ids.orgA,
      requestedBy: ids.userAdmin,
      plan: withFirstPartEstimate(planned, estimatedBytes),
    });
    const { outcome, memory, manifest } = await runFor(ids.userAdmin, exportId);
    expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.FAILED);
    expect(memory.parts.size).toBe(0);
    expect(manifest).toBeNull();
    const [row] = await testDb
      .select({
        status: organizationDataExports.status,
        error: organizationDataExports.error,
      })
      .from(organizationDataExports)
      .where(eq(organizationDataExports.id, exportId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(DATA_EXPORT_FAILURE_MESSAGE.partTooLarge);
  });

  test("a resumed attempt measures its records again before loading them", async () => {
    // The stored plan came from an earlier attempt; the records have grown
    // past the cap since, so the resumed attempt refuses to load them.
    const plan = await planFor(ids.userAdmin);
    const exportId = await insertExport({
      organizationId: ids.orgA,
      requestedBy: ids.userAdmin,
      plan,
    });
    const { outcome, memory } = await runFor(ids.userAdmin, exportId, {
      recordBytesCap: 1,
    });
    expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.FAILED);
    expect(memory.parts.size).toBe(0);
    const [row] = await testDb
      .select({
        status: organizationDataExports.status,
        error: organizationDataExports.error,
      })
      .from(organizationDataExports)
      .where(eq(organizationDataExports.id, exportId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(DATA_EXPORT_FAILURE_MESSAGE.recordsTooLarge);
  });

  test("a run superseded by a newer attempt cannot finish the export", async () => {
    const exportId = await insertExport({
      organizationId: ids.orgA,
      requestedBy: ids.userAdmin,
    });
    const { outcome, memory } = await runFor(ids.userAdmin, exportId, {
      // While this attempt plans, the sweep hands the export to a newer
      // attempt, which claims it.
      wrapSource: (source) => ({
        ...source,
        listMatters: async (scope) => {
          await testDb
            .update(organizationDataExports)
            .set({ attempt: sql`${organizationDataExports.attempt} + 1` })
            .where(eq(organizationDataExports.id, exportId));
          return await source.listMatters(scope);
        },
      }),
    });
    expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.SKIPPED);
    // The plan write is the first fenced write: the stale attempt stops
    // there, before it uploads anything.
    expect(memory.parts.size).toBe(0);
    const row = await statusOf(exportId);
    expect(row?.status).toBe("running");
    expect(row?.attempt).toBe(2);
    await testDb
      .update(organizationDataExports)
      .set({ status: "failed" })
      .where(eq(organizationDataExports.id, exportId));
  });

  test("objects a superseded attempt uploads are never published", async () => {
    const exportId = await insertExport({
      organizationId: ids.orgA,
      requestedBy: ids.userAdmin,
    });
    const plannedMatters = new Set<string>();
    const { outcome, memory, storageAttempts } = await runFor(
      ids.userAdmin,
      exportId,
      {
        // The takeover lands while the part is being packed: the stale
        // attempt has opened its upload and stops at its next fenced write.
        wrapSource: (source) => ({
          ...source,
          loadMatter: async (matterId, scope) => {
            if (plannedMatters.has(matterId)) {
              await testDb
                .update(organizationDataExports)
                .set({ attempt: 2 })
                .where(eq(organizationDataExports.id, exportId));
            } else {
              plannedMatters.add(matterId);
            }
            return await source.loadMatter(matterId, scope);
          },
        }),
      },
    );
    expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.SKIPPED);
    expect(memory.parts.size).toBe(1);
    // Whatever the stale attempt uploads lives under attempt 1's keys; the
    // export, now owned by attempt 2, references none of them.
    expect(storageAttempts).toEqual([1]);
    const [row] = await testDb
      .select({
        attempt: organizationDataExports.attempt,
        parts: organizationDataExports.parts,
      })
      .from(organizationDataExports)
      .where(eq(organizationDataExports.id, exportId));
    expect(row?.attempt).toBe(2);
    expect(row?.parts).toEqual([]);
    await testDb
      .update(organizationDataExports)
      .set({ status: "failed" })
      .where(eq(organizationDataExports.id, exportId));
  });

  test("a graceful stop hands the run back without using up its failure budget", async () => {
    const exportId = await insertExport({
      organizationId: ids.orgA,
      requestedBy: ids.userAdmin,
    });
    const controller = new AbortController();
    const { outcome } = await runFor(ids.userAdmin, exportId, {
      controller,
      wrapSource: (source) => ({
        ...source,
        listMatters: async (scope) => {
          controller.abort();
          return await source.listMatters(scope);
        },
      }),
    });
    expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.RESUMABLE);
    const row = await statusOf(exportId);
    expect(row?.status).toBe("queued");
    expect(row?.failures).toBe(0);
    await testDb
      .update(organizationDataExports)
      .set({ status: "failed" })
      .where(eq(organizationDataExports.id, exportId));
  });
});
