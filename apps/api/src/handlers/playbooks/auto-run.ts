import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { loadLatestApprovedVersions } from "@/api/lib/document-review/approved-playbook-versions";
import { openPlaybookRun } from "@/api/lib/document-review/open-playbook-run";
import {
  PLAYBOOK_RUN_START_OUTCOME,
  playbookRunStartOutcome,
} from "@/api/lib/document-review/playbook-run-start";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { startWorkflow } from "@/api/lib/workflow-queue";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";
import { resolveApplicablePlaybooks } from "@/api/lib/workflow/route-playbooks";

const config = {
  description:
    "Run every applicable playbook over a matter in one pass and materialize " +
    "their columns onto its table: a playbook with no document-type scope " +
    "always applies, one scoped to a document type only when that type is " +
    "present among the matter's classified documents. Each playbook pins its " +
    "own latest approved version and opens its own per-document runs; a " +
    "playbook that hits a limit is skipped while the rest continue. Returns " +
    "how many playbooks ran, how many columns were materialized, and how " +
    "many document runs opened. Use playbooks.run for a single playbook.",
  permissions: { playbook: ["apply"] },
  access: "write",
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  params: workspaceParams({}),
} satisfies HandlerConfig;

// Auto-run materializes every APPLICABLE org playbook over the current files
// table in one pass, so the user runs the whole matter's review with one click
// instead of picking each document type's playbook by hand. Applicability:
//  - a playbook with no document-type scope is workspace-wide (always applies);
//  - a doc-type-scoped playbook applies only when its type's LABEL is present
//    among the workspace's "Document Type" classifier values, so we never
//    materialize empty columns for types absent from the matter.
// The table is the point here, so every playbook runs projected onto it. Each
// stays gated to its own subset via `openPlaybookRun`, which pins the same
// approved snapshot a single run pins and opens the same durable per-document
// runs; a per-playbook failure (e.g. the properties cap) skips that one and the
// batch continues.
type AutoRunDependencies = {
  loadLatestApprovedVersions: typeof loadLatestApprovedVersions;
  openPlaybookRun: typeof openPlaybookRun;
  resolveApplicablePlaybooks: typeof resolveApplicablePlaybooks;
  startWorkflow: typeof startWorkflow;
};

const DEFAULT_AUTO_RUN_DEPENDENCIES: AutoRunDependencies = {
  loadLatestApprovedVersions,
  openPlaybookRun,
  resolveApplicablePlaybooks,
  startWorkflow,
};

export const createAutoRunPlaybooks = (
  dependencies: AutoRunDependencies = DEFAULT_AUTO_RUN_DEPENDENCIES,
) =>
  createSafeHandler(
    config,
    async function* ({
      safeDb,
      scopedDb,
      workspaceId,
      session,
      user,
      recordAuditEvent,
    }) {
      const organizationId = session.activeOrganizationId;

      const txResult = yield* Result.await(
        safeDb(async (tx) => {
          const playbooks = await tx.query.playbookDefinitions.findMany({
            where: { organizationId: { eq: organizationId } },
            columns: {
              id: true,
              name: true,
              positions: true,
              scope: true,
            },
            limit: LIMITS.playbookDefinitionsCount,
          });

          const applicable = await dependencies.resolveApplicablePlaybooks({
            tx,
            workspaceId,
            organizationId,
            playbooks,
          });

          // One read for the whole batch: a pin per playbook resolved separately
          // would grow the round-trips with the org's library.
          const approvedVersions =
            await dependencies.loadLatestApprovedVersions({
              tx,
              organizationId,
              playbookDefinitionIds: applicable.map((playbook) => playbook.id),
            });

          const materializedPropertyIds: SafeId<"property">[] = [];
          let playbooksRun = 0;
          let documentRunCount = 0;

          for (const definition of applicable) {
            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- each playbook's materialization consumes the shared property cap the next one checks
            const opened = await dependencies.openPlaybookRun({
              tx,
              workspaceId,
              organizationId,
              userId: user.id,
              definition,
              latestApprovedVersion:
                approvedVersions.get(definition.id) ?? null,
              projection: PLAYBOOK_RUN_PROJECTION.COLUMNS,
              recordAuditEvent,
            });
            // Skip a playbook that hit a per-run limit; the rest of the batch
            // still materializes rather than failing the whole auto-run.
            if (!opened.ok || opened.materializedPropertyIds.length === 0) {
              continue;
            }
            materializedPropertyIds.push(...opened.materializedPropertyIds);
            documentRunCount += opened.tableRuns.runs.length;
            playbooksRun += 1;
          }

          return { playbooksRun, materializedPropertyIds, documentRunCount };
        }),
      );

      if (txResult.materializedPropertyIds.length === 0) {
        return Result.ok({
          playbooksRun: 0,
          runPropertyCount: 0,
          documentRunCount: 0,
        });
      }

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
      // Answering 200 on a start that never happened would leave the whole
      // batch's columns with nothing to grade them. Nothing is unwound: the
      // columns are upserted by playbook source id and left stale, so a retry
      // maps back to the same ones instead of materializing a second set.
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

      return Result.ok({
        playbooksRun: txResult.playbooksRun,
        runPropertyCount: txResult.materializedPropertyIds.length,
        documentRunCount: txResult.documentRunCount,
      });
    },
  );

const autoRunPlaybooks = createAutoRunPlaybooks();

export default autoRunPlaybooks;
