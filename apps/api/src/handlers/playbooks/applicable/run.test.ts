import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { FILE_PROPERTY_TYPE_IMMUTABLE_CODE } from "@stll/api-contract/property-policy";

import { toSafeId } from "@/api/lib/branded-types";
import type { OpenPlaybookRunResult } from "@/api/lib/document-review/open-playbook-run";
import { PLAYBOOK_RUN_FAILURE_CODE } from "@/api/lib/document-review/playbook-run-refusal";
import { mapHandlerResult } from "@/api/mcp/capability-tools";
import {
  NO_AUDIT,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const loadLatestApprovedVersionsMock = mock();
const openPlaybookRunMock = mock();
const resolveApplicablePlaybooksMock = mock();
const startWorkflowMock = mock();

const { createAutoRunPlaybooks } = await import("./run");
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
    createTestHandlerContext<AutoRunCtx>({
      audit: NO_AUDIT,
      safeDb,
      scopedDb,
    }),
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
      refusals: [],
    });
  });

  test("policy refusals retain per-playbook details through REST and MCP", async () => {
    const refusal = {
      ok: false,
      status: 422,
      code: FILE_PROPERTY_TYPE_IMMUTABLE_CODE,
      retryable: false,
      message: "File property types cannot be changed.",
      hint: "Keep the existing ASK content.type, or add a new playbook position.",
    } as const satisfies OpenPlaybookRunResult;
    openPlaybookRunMock.mockResolvedValue(refusal);
    const result = await runAutoRun();
    const expected = {
      playbooksRun: 0,
      runPropertyCount: 0,
      documentRunCount: 0,
      refusals: [
        {
          ...refusal,
          playbookId,
          playbookName: "Vendor agreement review",
        },
      ],
    };
    expect(result).toEqual(expected);
    expect(
      mapHandlerResult({
        id: "playbooks.applicable.run",
        result,
        access: "write",
      }),
    ).toMatchObject({
      egress: "structured",
      payload: expected,
    });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  test("property limits skip only that playbook while successful runs continue", async () => {
    const limit = {
      ok: false,
      status: 400,
      code: PLAYBOOK_RUN_FAILURE_CODE.PROPERTIES_LIMIT,
      message: "Properties limit reached",
    } as const satisfies OpenPlaybookRunResult;
    const secondId = toSafeId<"playbookDefinition">("pb_second");
    resolveApplicablePlaybooksMock.mockResolvedValue([
      {
        id: playbookId,
        name: "Limited",
        positions: { version: 3, items: [] },
        scope: null,
      },
      {
        id: secondId,
        name: "Available",
        positions: { version: 3, items: [] },
        scope: null,
      },
    ]);
    openPlaybookRunMock
      .mockResolvedValueOnce(limit)
      .mockResolvedValueOnce(opened);
    startWorkflowMock.mockResolvedValue({ status: "skipped" });
    expect(await runAutoRun()).toEqual({
      playbooksRun: 1,
      runPropertyCount: 1,
      documentRunCount: 1,
      refusals: [],
    });
    expect(openPlaybookRunMock).toHaveBeenCalledTimes(2);
    expect(startWorkflowMock.mock.calls.at(0)?.[0]).toMatchObject({
      propertyIds: [propertyId],
    });
  });

  test("all-limited batches remain skipped without policy refusals", async () => {
    openPlaybookRunMock.mockResolvedValue({
      ok: false,
      status: 400,
      code: PLAYBOOK_RUN_FAILURE_CODE.PROPERTIES_LIMIT,
      message: "Properties limit reached",
    } as const satisfies OpenPlaybookRunResult);
    expect(await runAutoRun()).toEqual({
      playbooksRun: 0,
      runPropertyCount: 0,
      documentRunCount: 0,
      refusals: [],
    });
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  test("configuration refusals survive alongside successfully started playbooks", async () => {
    const refusal = {
      ok: false,
      status: 400,
      code: PLAYBOOK_RUN_FAILURE_CODE.SCOPE_UNRESOLVED,
      message: "Document Type classifier unavailable",
      hint: "Configure the matching Document Type classifier.",
      retryable: false,
    } as const satisfies OpenPlaybookRunResult;
    resolveApplicablePlaybooksMock.mockResolvedValue([
      {
        id: playbookId,
        name: "Refused",
        positions: { version: 3, items: [] },
        scope: null,
      },
      {
        id: toSafeId<"playbookDefinition">("pb_second"),
        name: "Available",
        positions: { version: 3, items: [] },
        scope: null,
      },
    ]);
    openPlaybookRunMock
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(opened);
    startWorkflowMock.mockResolvedValue({ status: "started" });
    const expected = {
      playbooksRun: 1,
      runPropertyCount: 1,
      documentRunCount: 1,
      refusals: [{ playbookId, playbookName: "Refused", ...refusal }],
    };
    const result = await runAutoRun();
    expect(result).toEqual(expected);
    expect(
      mapHandlerResult({
        id: "playbooks.applicable.run",
        result,
        access: "write",
      }),
    ).toMatchObject({ egress: "structured", payload: expected });
    expect(startWorkflowMock).toHaveBeenCalledTimes(1);
  });
});
