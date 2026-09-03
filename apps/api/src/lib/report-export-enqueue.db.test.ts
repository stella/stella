/**
 * A `queued` export whose job never reached the queue has nothing left to
 * drive it, and the row cannot tell that apart from an export still waiting
 * its turn. What is asserted here is the part no type can hold: that such an
 * export is handed back exactly once, carrying the format and narrative flag
 * the request was made with, and that a finished export is never resurrected.
 * Driven against a real (PGlite) database with a stubbed queue.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { reportExports } from "@/api/db/schema";
import type { ReportExportFormat, ReportExportStatus } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { reconcileQueuedReportExports } from "@/api/lib/report-export-enqueue";
import type { ViewLayout } from "@/api/lib/views-schema";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();

type StubJobState = "active" | "completed" | "failed" | "waiting";

type AddedJob = { data: unknown; jobId: string; name: string };

const added: AddedJob[] = [];
const priorJobs = new Map<string, StubJobState>();

const queue = {
  add: async (name: string, data: unknown, options: { jobId: string }) => {
    added.push({ data, jobId: options.jobId, name });
    priorJobs.set(options.jobId, "waiting");
  },
  getJob: async (jobId: string) => {
    const state = priorJobs.get(jobId);
    if (state === undefined) {
      return undefined;
    }
    return {
      getState: async () => state,
      remove: async () => {
        priorJobs.delete(jobId);
      },
      retry: async () => {
        priorJobs.set(jobId, "waiting");
      },
    };
  },
};

const LAYOUT: ViewLayout = {
  type: "table",
  version: 1,
  calculations: [],
  columnOrder: [],
  columnPinning: [],
  filters: [],
  hiddenProperties: [],
  sorts: [],
};

const seededExportIds: SafeId<"reportExport">[] = [];

type SeedExportOptions = {
  aiNarrative?: boolean | null;
  createdAt?: Date;
  format?: ReportExportFormat | null;
  requestedBy?: string | null;
  status?: ReportExportStatus;
};

const exportValues = ({
  aiNarrative = true,
  createdAt = new Date(),
  format = "docx",
  requestedBy = ids.userA1,
  status = "queued",
}: SeedExportOptions = {}) => {
  const exportId = createSafeId<"reportExport">();
  seededExportIds.push(exportId);
  return {
    id: exportId,
    workspaceId: ids.wsA1,
    requestedBy,
    templateRef: { type: "builtin", key: "due-diligence" } as const,
    layout: LAYOUT,
    mode: "download" as const,
    format,
    aiNarrative,
    status,
    createdAt,
  };
};

const seedExport = async (
  options: SeedExportOptions = {},
): Promise<SafeId<"reportExport">> => {
  const values = exportValues(options);
  await testDb.insert(reportExports).values(values);
  return values.id;
};

const jobIdFor = (exportId: SafeId<"reportExport">) =>
  createBullMqJobId(ids.wsA1, exportId);

describe("queued report export reconciliation", () => {
  beforeEach(() => {
    added.length = 0;
    priorJobs.clear();
  });

  afterEach(async () => {
    if (seededExportIds.length > 0) {
      await testDb
        .delete(reportExports)
        .where(inArray(reportExports.id, seededExportIds));
    }
    seededExportIds.length = 0;
  });

  afterAll(async () => {
    await releaseRlsFixture();
  });

  test("hands an export no job owns back to the queue exactly once, with the request it was made with", async () => {
    const exportId = await seedExport({ aiNarrative: false, format: "pdf" });

    const first = await reconcileQueuedReportExports({ db: testDb, queue });
    const second = await reconcileQueuedReportExports({ db: testDb, queue });

    expect(first).toEqual({
      handedOff: 1,
      scanned: 1,
      unattributed: 0,
      unrecoverable: 0,
    });
    // The row is still `queued` — only the worker's claim moves it — so the
    // second sweep sees it again and must recognise its own job.
    expect(second).toEqual({
      handedOff: 0,
      scanned: 1,
      unattributed: 0,
      unrecoverable: 0,
    });
    expect(added).toEqual([
      {
        data: {
          exportId,
          workspaceId: ids.wsA1,
          organizationId: ids.orgA,
          userId: ids.userA1,
          format: "pdf",
          aiNarrative: false,
        },
        jobId: jobIdFor(exportId),
        name: "export-report",
      },
    ]);
  });

  test("leaves finished exports alone", async () => {
    await seedExport({ status: "completed" });
    await seedExport({ status: "failed" });
    await seedExport({ status: "running" });

    const result = await reconcileQueuedReportExports({ db: testDb, queue });

    expect(result).toEqual({
      handedOff: 0,
      scanned: 0,
      unattributed: 0,
      unrecoverable: 0,
    });
    expect(added).toEqual([]);
  });

  test("counts an export whose requester is gone instead of dropping it", async () => {
    await seedExport({ requestedBy: null });

    const result = await reconcileQueuedReportExports({ db: testDb, queue });

    expect(result).toEqual({
      handedOff: 0,
      scanned: 1,
      unattributed: 1,
      unrecoverable: 0,
    });
    expect(added).toEqual([]);
  });

  test("fails a queued export whose request was never recorded", async () => {
    // Rows written before the columns existed carry their format and
    // narrative flag on the job alone. Handing one back would mean inventing
    // options and running a different export than the one asked for.
    const exportId = await seedExport({ aiNarrative: null, format: null });

    const result = await reconcileQueuedReportExports({ db: testDb, queue });

    expect(result).toEqual({
      handedOff: 0,
      scanned: 1,
      unattributed: 0,
      unrecoverable: 1,
    });
    expect(added).toEqual([]);
    const [row] = await testDb
      .select({ error: reportExports.error, status: reportExports.status })
      .from(reportExports)
      .where(eq(reportExports.id, exportId));
    // Terminal and legible, so the requester stops polling a row nothing will
    // pick up and knows to run it again.
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("run it again");
  });

  test("pages past a full page of queue-owned exports to reach an orphan", async () => {
    // One page is 100 rows, and an export the queue owns keeps its `queued`
    // row, so a sweep bounded by the first page would never inspect row 101.
    const base = Date.now() - 60 * 60 * 1000;
    const owned = Array.from({ length: 150 }, (_, index) =>
      exportValues({ createdAt: new Date(base + index) }),
    );
    await testDb.insert(reportExports).values(owned);
    for (const { id } of owned) {
      priorJobs.set(jobIdFor(id), "waiting");
    }
    const orphan = await seedExport({ createdAt: new Date(base + 1000) });

    const result = await reconcileQueuedReportExports({ db: testDb, queue });

    expect(result).toEqual({
      handedOff: 1,
      scanned: 151,
      unattributed: 0,
      unrecoverable: 0,
    });
    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(orphan)]);
  });

  test("stops at the per-tick handoff limit on a page of orphans", async () => {
    // A full page of exports that all need handing back. Whether a row hands
    // off is only known once its handler returns, so capacity has to be taken
    // before each handler starts or the whole page would be enqueued at once —
    // a queue storm of metered fills rather than a paced drain.
    const base = Date.now() - 60 * 60 * 1000;
    const orphans = Array.from({ length: 100 }, (_, index) =>
      exportValues({ createdAt: new Date(base + index) }),
    );
    await testDb.insert(reportExports).values(orphans);

    const result = await reconcileQueuedReportExports({ db: testDb, queue });

    expect(result).toEqual({
      handedOff: 50,
      scanned: 50,
      unattributed: 0,
      unrecoverable: 0,
    });
    expect(added).toHaveLength(50);
  });
});
