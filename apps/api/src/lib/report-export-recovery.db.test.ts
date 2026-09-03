/**
 * The janitor's `running` branch cannot decide on age alone. The worker sets
 * `running` once and never heartbeats, so a large export that legitimately
 * takes hours looks exactly like one whose worker died half an hour ago. What
 * is asserted here is that the queue, not the clock, settles it: a row whose
 * job is still active survives its cutoff, and only a row the queue has no job
 * for is failed. Driven against a real (PGlite) database with a stubbed queue.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { rootDb } from "@/api/db/root";
import { reportExports } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import { recoverStuckReportExports } from "@/api/lib/report-export-recovery";
import type { StuckExportJobQueue } from "@/api/lib/report-export-recovery";
import type { ViewLayout } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();

const HOUR_IN_MS = 60 * 60 * 1000;

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

/** A job the queue reports in the given state; `null` means the queue has no
 *  record of it at all. */
const queueHolding = (
  jobs: ReadonlyMap<string, string | null>,
): StuckExportJobQueue => ({
  getJob: async (jobId: string) => {
    const state = jobs.get(jobId);
    if (state === undefined || state === null) {
      return undefined;
    }
    return { getState: async () => state };
  },
});

/** `updated_at` is `$onUpdate`-managed, so the age has to be written in a
 *  second statement that sets it explicitly. */
const seedRunningExport = async (
  updatedAt: Date,
): Promise<SafeId<"reportExport">> => {
  const exportId = createSafeId<"reportExport">();
  await testDb.insert(reportExports).values({
    id: exportId,
    workspaceId: ids.wsA1,
    requestedBy: ids.userA1,
    templateRef: { type: "builtin", key: "due-diligence" },
    layout: LAYOUT,
    mode: "download",
    format: "docx",
    aiNarrative: true,
    status: "running",
  });
  await testDb
    .update(reportExports)
    .set({ updatedAt })
    .where(eq(reportExports.id, exportId));
  return exportId;
};

const statusOf = async (exportId: SafeId<"reportExport">) => {
  const [row] = await testDb
    .select({ error: reportExports.error, status: reportExports.status })
    .from(reportExports)
    .where(eq(reportExports.id, exportId));
  return row;
};

const recover = async (queue: StuckExportJobQueue) =>
  await recoverStuckReportExports({
    db: asTestRaw<typeof rootDb>(testDb),
    queue,
  });

describe("stuck report export recovery", () => {
  beforeEach(async () => {
    await testDb.delete(reportExports);
  });

  afterAll(async () => {
    await releaseRlsFixture();
  });

  test("leaves a long-running export alone while its job is active", async () => {
    const exportId = await seedRunningExport(new Date(Date.now() - HOUR_IN_MS));

    const recovered = await recover(
      queueHolding(
        new Map([[createBullMqJobId(ids.wsA1, exportId), "active"]]),
      ),
    );

    expect(recovered).toBe(0);
    // A 500-row export draws a metered draft per contract; the row's age says
    // when the fill started, not that it stopped.
    expect((await statusOf(exportId))?.status).toBe("running");
  });

  test("fails an export past its cutoff that the queue has no job for", async () => {
    const exportId = await seedRunningExport(new Date(Date.now() - HOUR_IN_MS));

    const recovered = await recover(queueHolding(new Map()));

    expect(recovered).toBe(1);
    const row = await statusOf(exportId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("Please try again");
  });

  test("fails an export whose job the queue has already finished", async () => {
    const exportId = await seedRunningExport(new Date(Date.now() - HOUR_IN_MS));

    const recovered = await recover(
      queueHolding(
        new Map([[createBullMqJobId(ids.wsA1, exportId), "completed"]]),
      ),
    );

    expect(recovered).toBe(1);
    expect((await statusOf(exportId))?.status).toBe("failed");
  });

  test("leaves an export inside its cutoff alone whatever the queue says", async () => {
    const exportId = await seedRunningExport(new Date());

    const recovered = await recover(queueHolding(new Map()));

    expect(recovered).toBe(0);
    expect((await statusOf(exportId))?.status).toBe("running");
  });
});
