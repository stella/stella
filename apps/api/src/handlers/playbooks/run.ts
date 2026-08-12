import { Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import { t } from "elysia";

import { PLAYBOOK_RUN_PROJECTIONS } from "@stll/api-contract";

import { playbookDefinitionVersions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { resolvePlaybookPin } from "@/api/lib/document-review/resolve-playbook-pin";
import type { PinnedPlaybook } from "@/api/lib/document-review/run-contract";
import { enqueueDocumentReviewRuns } from "@/api/lib/document-review/run-queue";
import {
  createPlaybookTableRuns,
  PLAYBOOK_RUN_DOCUMENTS_MAX,
} from "@/api/lib/document-review/table-run-create";
import type { CreatePlaybookTableRunsResult } from "@/api/lib/document-review/table-run-create";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { startWorkflow } from "@/api/lib/workflow-queue";
import {
  materializePlaybookRun,
  resolveScopedGate,
} from "@/api/lib/workflow/materialize-playbook-run";
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
    'workspaceId, playbookId, and the projection: "columns" also ' +
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

const runPlaybook = createSafeHandler(
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

        // Findings are pinned to the version they were measured against, so a
        // table run resolves the same approved snapshot a single-document
        // review does rather than reading the live definition twice.
        const versions = await tx
          .select({
            id: playbookDefinitionVersions.id,
            name: playbookDefinitionVersions.name,
            positions: playbookDefinitionVersions.positions,
          })
          .from(playbookDefinitionVersions)
          .where(
            and(
              eq(
                playbookDefinitionVersions.playbookDefinitionId,
                params.playbookId,
              ),
              eq(playbookDefinitionVersions.organizationId, organizationId),
            ),
          )
          .orderBy(desc(playbookDefinitionVersions.version))
          .limit(1);
        const playbook: PinnedPlaybook = resolvePlaybookPin({
          definition,
          latestApprovedVersion: versions.at(0) ?? null,
        });

        const gateResult = await resolveScopedGate({
          tx,
          workspaceId,
          organizationId,
          scope: definition.scope,
        });
        if (!gateResult.ok) {
          return gateResult;
        }

        const materializedPropertyIds: SafeId<"property">[] = [];
        if (projection === PLAYBOOK_RUN_PROJECTION.COLUMNS) {
          const materialized = await materializePlaybookRun({
            tx,
            workspaceId,
            organizationId,
            playbookId: params.playbookId,
            positions: playbook.definitionSnapshot.positions.items,
            scope: definition.scope,
            recordAuditEvent,
            auditMetadata: { projection },
          });
          if (!materialized.ok) {
            return materialized;
          }
          materializedPropertyIds.push(...materialized.materializedPropertyIds);
        }

        const tableRuns = await createPlaybookTableRuns({
          tx,
          workspaceId,
          organizationId,
          userId: user.id,
          playbook,
          docTypeGate: gateResult.gate,
          projection,
        });

        // A projected run is audited by the materializer; an unprojected one
        // writes no column, so its execution is recorded here.
        if (projection === PLAYBOOK_RUN_PROJECTION.NONE) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.EXECUTE,
            resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
            resourceId: params.playbookId,
            metadata: {
              documentRunCount: tableRuns.runs.length,
              playbookProvenance: playbook.provenance,
              projection,
            },
          });
        }

        return { ok: true, materializedPropertyIds, tableRuns };
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
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await startWorkflow({
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
    }

    return Result.ok({
      runPropertyCount: txResult.materializedPropertyIds.length,
      documentRunCount: tableRuns.runs.length,
      documentsWithoutRun:
        tableRuns.skippedActiveCount + tableRuns.uncoveredCount,
    });
  },
);

export default runPlaybook;
