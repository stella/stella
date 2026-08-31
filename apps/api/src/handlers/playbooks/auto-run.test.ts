import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { OpenPlaybookRunResult } from "@/api/lib/document-review/open-playbook-run";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const loadLatestApprovedVersionsMock = mock();
const openPlaybookRunMock = mock();
const resolveApplicablePlaybooksMock = mock();
const startWorkflowMock = mock();

const { createAutoRunPlaybooks } = await import("./auto-run");
const autoRunPlaybooks = createAutoRunPlaybooks({
  loadLatestApprovedVersions: loadLatestApprovedVersionsMock,
  openPlaybookRun: openPlaybookRunMock,
  resolveApplicablePlaybooks: resolveApplicablePlaybooksMock,
  startWorkflow: startWorkflowMock,
});

type AutoRunCtx = Parameters<typeof autoRunPlaybooks.handler>[0];

const playbookId = toSafeId<"playbookDefinition">("pb_auto_run");
const propertyId = toSafeId<"property">("property_auto_run");

const opened = {
  ok: true,
  playbook: {
    definitionId: playbookId,
    versionId: null,
    provenance: "draft",
    definitionSnapshot: {
      name: "Vendor agreement review",
      positions: { version: 3, items: [] },
    },
  },
  materializedPropertyIds: [propertyId],
  tableRuns: {
    runs: [
      {
        runId: toSafeId<"documentReviewRun">("dr_auto_run"),
        entityId: toSafeId<"entity">("entity_auto_run"),
      },
    ],
    skippedActiveCount: 0,
    uncoveredCount: 0,
    expectedFindingCount: 1,
  },
} satisfies OpenPlaybookRunResult;

const runAutoRun = async () => {
  const { scopedDb, safeDb } = createScopedDbMock({
    query: { playbookDefinitions: { findMany: async () => [] } },
  });
  return await autoRunPlaybooks.handler(
    createTestHandlerContext<AutoRunCtx>({ safeDb, scopedDb }),
  );
};

describe("auto-run playbooks handler", () => {
  beforeEach(() => {
    loadLatestApprovedVersionsMock.mockReset();
    loadLatestApprovedVersionsMock.mockResolvedValue(new Map());
    openPlaybookRunMock.mockReset();
    openPlaybookRunMock.mockResolvedValue(opened);
    resolveApplicablePlaybooksMock.mockReset();
    resolveApplicablePlaybooksMock.mockResolvedValue([
      {
        id: playbookId,
        name: "Vendor agreement review",
        positions: { version: 3, items: [] },
        scope: null,
      },
    ]);
    startWorkflowMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  test("a failed enqueue is answered as a failure, not as a batch of opened runs", async () => {
    // The queue reports it in band rather than throwing, so nothing above
    // catches it.
    startWorkflowMock.mockResolvedValue({ status: "failed" });

    const result = await runAutoRun();

    if (!("code" in result)) {
      throw new Error("Expected the failed start to return a status");
    }
    expect(result.code).toBe(500);
    expect(result.response).toMatchObject({
      message: "Failed to start the review.",
    });
    // The batch's columns stay materialized and its runs stay open, so the
    // retry the user is now told to make maps back to the same ones.
    expect(startWorkflowMock.mock.calls.at(0)?.[0]).toMatchObject({
      propertyIds: [propertyId],
    });
  });

  test("a deferred enqueue still reports the runs it opened", async () => {
    // Nothing was queued because the plan had no work left; the columns are
    // materialized and a later run grades them.
    startWorkflowMock.mockResolvedValue({ status: "skipped" });

    expect(await runAutoRun()).toEqual({
      playbooksRun: 1,
      runPropertyCount: 1,
      documentRunCount: 1,
    });
  });
});
