import { panic } from "better-result";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { OpenPlaybookRunResult } from "@/api/lib/document-review/open-playbook-run";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";
import { mapHandlerResult } from "@/api/mcp/capability-tools";
import {
  NO_AUDIT,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const loadLatestApprovedVersionMock = mock();
const openPlaybookRunMock = mock();
const startWorkflowMock = mock();

const { createRunPlaybook } = await import("./run");
const runPlaybook = createRunPlaybook({
  loadLatestApprovedVersion: loadLatestApprovedVersionMock,
  openPlaybookRun: openPlaybookRunMock,
  startWorkflow: startWorkflowMock,
});

type RunPlaybookCtx = Parameters<typeof runPlaybook.handler>[0];

const playbookId = toSafeId<"playbookDefinition">("pb_run");
const propertyId = toSafeId<"property">("property_run");

/** One run opened over one document, with the columns to extract for it. */
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
        runId: toSafeId<"documentReviewRun">("dr_run"),
        entityId: toSafeId<"entity">("entity_run"),
      },
    ],
    skippedActiveCount: 0,
    uncoveredCount: 0,
    expectedFindingCount: 1,
  },
} satisfies OpenPlaybookRunResult;

const runColumnsProjection = async () => {
  const { scopedDb, safeDb } = createScopedDbMock({
    query: {
      playbookDefinitions: {
        findFirst: async () => ({
          id: playbookId,
          name: "Vendor agreement review",
          positions: { version: 3, items: [] },
          scope: null,
        }),
      },
    },
  });
  return await runPlaybook.handler(
    createTestHandlerContext<RunPlaybookCtx>({
      audit: NO_AUDIT,
      body: { projection: PLAYBOOK_RUN_PROJECTION.COLUMNS },
      params: { playbookId },
      safeDb,
      scopedDb,
    }),
  );
};

const successPayload = {
  runPropertyCount: 1,
  documentRunCount: 1,
  documentsWithoutRun: 0,
};

describe("run playbook handler", () => {
  beforeEach(() => {
    loadLatestApprovedVersionMock.mockReset();
    loadLatestApprovedVersionMock.mockResolvedValue(null);
    openPlaybookRunMock.mockReset();
    openPlaybookRunMock.mockResolvedValue(opened);
    startWorkflowMock.mockReset();
  });

  afterAll(() => {
    mock.restore();
  });

  const refusals = {
    file_property_type_immutable: {
      ok: false,
      status: 422,
      code: "file_property_type_immutable",
      retryable: false,
      message: "File property types cannot be changed.",
      hint: "Keep the existing ASK content.type or add a new playbook position.",
    },
    playbook_scope_unresolved: {
      ok: false,
      status: 400,
      code: "playbook_scope_unresolved",
      retryable: false,
      message: "The document-type scope cannot be resolved.",
      hint: "Configure a matching Document Type classifier before running it.",
    },
    properties_limit_reached: {
      ok: false,
      status: 400,
      code: "properties_limit_reached",
      message: "The matter has reached its property limit.",
    },
  } as const satisfies Record<
    Extract<OpenPlaybookRunResult, { ok: false }>["code"],
    Extract<OpenPlaybookRunResult, { ok: false }>
  >;

  test.each(Object.values(refusals))(
    "preserves $code over REST and capability MCP without starting extraction",
    async (refusal) => {
      openPlaybookRunMock.mockResolvedValue(refusal);
      const result = await runColumnsProjection();
      if (!("code" in result)) {
        panic("Expected the playbook refusal status");
      }
      const { ok: _ok, status, ...details } = refusal;
      expect(result.code).toBe(status);
      expect(result.response).toEqual(details);
      const mcp = mapHandlerResult({
        id: "playbooks.run",
        result,
        access: "write",
      });
      expect(mcp).toMatchObject({
        status: "error",
        error: {
          type: "structured",
          ...details,
          code: "validation_error",
          issues: [{ path: "", code: refusal.code, message: refusal.message }],
        },
      });
      expect(startWorkflowMock).not.toHaveBeenCalled();
    },
  );

  test("a failed enqueue is answered as a failure, not as an opened run", async () => {
    // The queue reports it in band rather than throwing, so nothing above
    // catches it.
    startWorkflowMock.mockResolvedValue({ status: "failed" });

    const result = await runColumnsProjection();

    if (!("code" in result)) {
      throw new Error("Expected the failed start to return a status");
    }
    expect(result.code).toBe(500);
    expect(result.response).toMatchObject({
      message: "Failed to start the review.",
    });
  });

  test("a deferred enqueue still reports the run it opened", async () => {
    // A concurrent run holds the workspace. The columns this run materialized
    // are stale ai-model columns that the in-flight run's catch-up still
    // grades, so the review did start.
    startWorkflowMock.mockResolvedValue({ status: "already-running" });

    expect(await runColumnsProjection()).toEqual(successPayload);
  });

  test("a retry after a failed enqueue re-queues the same columns", async () => {
    startWorkflowMock.mockResolvedValueOnce({ status: "failed" });
    startWorkflowMock.mockResolvedValueOnce({ status: "started" });

    const failed = await runColumnsProjection();
    if (!("code" in failed)) {
      throw new Error("Expected the failed start to return a status");
    }
    expect(failed.code).toBe(500);

    // Nothing is unwound on the failure path: the columns stay materialized
    // (`materializePlaybookRun` upserts by playbook source id) and the run rows
    // this request opened stay claimed, so the retry drives the same property
    // set rather than a second one.
    expect(await runColumnsProjection()).toEqual(successPayload);
    expect(startWorkflowMock).toHaveBeenCalledTimes(2);
    for (const call of startWorkflowMock.mock.calls) {
      expect(call.at(0)).toMatchObject({ propertyIds: [propertyId] });
    }
  });
});
