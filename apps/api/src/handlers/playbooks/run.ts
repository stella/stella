import { Result } from "better-result";
import { t } from "elysia";

import { PLAYBOOK_RUN_PROJECTIONS } from "@stll/api-contract";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { loadLatestApprovedVersion } from "@/api/lib/document-review/approved-playbook-versions";
import { openPlaybookRun } from "@/api/lib/document-review/open-playbook-run";
import {
  PLAYBOOK_RUN_START_OUTCOME,
  playbookRunStartOutcome,
} from "@/api/lib/document-review/playbook-run-start";
import { enqueueDocumentReviewRuns } from "@/api/lib/document-review/run-queue";
import { PLAYBOOK_RUN_DOCUMENTS_MAX } from "@/api/lib/document-review/table-run-create";
import type { CreatePlaybookTableRunsResult } from "@/api/lib/document-review/table-run-create";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { startWorkflow } from "@/api/lib/workflow-queue";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";

const runPlaybookBodySchema = t.Object({
  projection: t.UnionEnum(PLAYBOOK_RUN_PROJECTIONS, {
    description:
      'Where the run shows up. "columns" materializes the playbook\'s ' +
      "extraction and verdict columns onto the matter's table, which costs " +
      'two columns per graded position. "none" materializes no columns; the ' +
      "same review runs per document and its findings are read through the " +
      "review surface.",
  }),
});

const config = {
  description:
    "Run a review playbook over a matter's documents. Every DOCX document is " +
    "reviewed against the playbook's latest approved version, and each " +
    "document's findings are recorded against its own pinned version. Pass " +
    'matterId, playbookId, and the projection: "columns" also ' +
    "materializes the playbook's extraction and verdict columns onto the " +
    'table, "none" materializes none. Findings populate asynchronously.',
  permissions: { playbook: ["apply"] },
  access: "write",
  mcp: { type: "tool", name: "run_playbook" },
  params: workspaceParams({
    playbookId: tSafeId("playbookDefinition", {
      description: "Playbook id to run",
    }),
  }),
  body: runPlaybookBodySchema,
} satisfies HandlerConfig;

type RunFailure = { ok: false; status: 400 | 404; message: string };

type RunSuccess = {
  ok: true;
  materializedPropertyIds: SafeId<"property">[];
  tableRuns: CreatePlaybookTableRunsResult;
};

type RunDependencies = {
  loadLatestApprovedVersion: typeof loadLatestApprovedVersion;
  openPlaybookRun: typeof openPlaybookRun;
  startWorkflow: typeof startWorkflow;
};

const DEFAULT_RUN_DEPENDENCIES: RunDependencies = {
  loadLatestApprovedVersion,
  openPlaybookRun,
  startWorkflow,
};

export const createRunPlaybook = (
  dependencies: RunDependencies = DEFAULT_RUN_DEPENDENCIES,
) =>
  createSafeHandler(
    config,
    async function* ({
      body,
      safeDb,
      scopedDb,
      workspaceId,
      params,
      session,
      user,
      recordAuditEvent,
    }) {
      const organizationId = session.activeOrganizationId;
      const { projection } = body;

      const txResult = yield* Result.await(
        safeDb(async (tx): Promise<RunFailure | RunSuccess> => {
          const definition = await tx.query.playbookDefinitions.findFirst({
            where: {
              id: { eq: params.playbookId },
              organizationId: { eq: organizationId },
            },
            columns: { id: true, name: true, positions: true, scope: true },
          });
          if (!definition) {
            return { ok: false, status: 404, message: "Playbook not found" };
          }

          const opened = await dependencies.openPlaybookRun({
            tx,
            workspaceId,
            organizationId,
            userId: user.id,
            definition,
            latestApprovedVersion: await dependencies.loadLatestApprovedVersion(
              {
                tx,
                organizationId,
                playbookDefinitionId: params.playbookId,
              },
            ),
            projection,
            recordAuditEvent,
          });
          if (!opened.ok) {
            return opened;
          }

          return {
            ok: true,
            materializedPropertyIds: opened.materializedPropertyIds,
            tableRuns: opened.tableRuns,
          };
        }),
      );

      if (!txResult.ok) {
        return Result.err(
          new HandlerError({
            status: txResult.status,
            message: txResult.message,
          }),
        );
      }

      const { tableRuns } = txResult;
      // Without columns the runs are the only record of the review, so covering
      // part of the matter is a refusal, not a partial success.
      if (
        projection === PLAYBOOK_RUN_PROJECTION.NONE &&
        tableRuns.uncoveredCount > 0
      ) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: `This matter holds more documents than one playbook run can review (${PLAYBOOK_RUN_DOCUMENTS_MAX}). Review them in smaller matters.`,
          }),
        );
      }

      if (projection === PLAYBOOK_RUN_PROJECTION.NONE) {
        yield* Result.await(
          Result.tryPromise({
            try: async () =>
              await enqueueDocumentReviewRuns(
                tableRuns.runs.map((run) => ({
                  runId: run.runId,
                  workspaceId,
                  organizationId,
                  userId: user.id,
                })),
              ),
            // A run whose job never arrived stays `queued` and is reconciled to
            // `failed` by the review queue's janitor, so a partial enqueue never
            // leaves a document blocked forever.
            catch: (cause) =>
              new HandlerError({
                status: 500,
                message: "Failed to start the review.",
                cause,
              }),
          }),
        );
        return Result.ok({
          runPropertyCount: 0,
          documentRunCount: tableRuns.runs.length,
          documentsWithoutRun: tableRuns.skippedActiveCount,
        });
      }

      if (txResult.materializedPropertyIds.length > 0) {
        const started = yield* Result.await(
          Result.tryPromise({
            try: async () =>
              await dependencies.startWorkflow({
                workspaceId,
                organizationId,
                userId: user.id,
                scopedDb,
                propertyIds: txResult.materializedPropertyIds,
              }),
            catch: (cause) =>
              new HandlerError({
                status: 500,
                message: "Internal server error",
                cause,
              }),
          }),
        );
        // Answering 200 on a start that never happened would leave a run
        // nothing drives. Nothing is unwound: the columns are upserted by
        // playbook source id and left stale, and the runs this request opened
        // stay claimed, so a retry maps back to both.
        if (
          playbookRunStartOutcome(started.status) ===
          PLAYBOOK_RUN_START_OUTCOME.NOT_STARTED
        ) {
          return Result.err(
            new HandlerError({
              status: 500,
              message: "Failed to start the review.",
            }),
          );
        }
      }

      return Result.ok({
        runPropertyCount: txResult.materializedPropertyIds.length,
        documentRunCount: tableRuns.runs.length,
        documentsWithoutRun:
          tableRuns.skippedActiveCount + tableRuns.uncoveredCount,
      });
    },
  );

const runPlaybook = createRunPlaybook();

export default runPlaybook;
