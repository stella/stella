import { Result } from "better-result";

import { materializePlaybookRun } from "@/api/handlers/playbooks/materialize-run";
import { resolveApplicablePlaybooks } from "@/api/handlers/playbooks/route-playbooks";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { startWorkflow } from "@/api/lib/workflow-queue";

const config = {
  permissions: { playbook: ["apply"] },
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
// Each playbook stays gated to its own subset via `materializePlaybookRun`; a
// per-playbook failure (e.g. the properties cap) skips that one and the batch
// continues.
const autoRunPlaybooks = createSafeHandler(
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
          columns: { id: true, positions: true, scope: true },
          limit: LIMITS.playbookDefinitionsCount,
        });

        const applicable = await resolveApplicablePlaybooks({
          tx,
          workspaceId,
          organizationId,
          playbooks,
        });

        const materializedPropertyIds: SafeId<"property">[] = [];
        let playbooksRun = 0;

        for (const playbook of applicable) {
          // oxlint-disable-next-line no-await-in-loop -- one shared transaction: each run reads the cumulative property count to enforce the per-workspace cap, and a single tx cannot run writes in parallel
          const result = await materializePlaybookRun({
            tx,
            workspaceId,
            organizationId,
            playbookId: playbook.id,
            positions: playbook.positions.items,
            scope: playbook.scope,
            recordAuditEvent,
          });
          // Skip a playbook that hit a per-run limit; the rest of the batch
          // still materializes rather than failing the whole auto-run.
          if (!result.ok || result.materializedPropertyIds.length === 0) {
            continue;
          }
          materializedPropertyIds.push(...result.materializedPropertyIds);
          playbooksRun += 1;
        }

        return { playbooksRun, materializedPropertyIds };
      }),
    );

    if (txResult.materializedPropertyIds.length === 0) {
      return Result.ok({ playbooksRun: 0, runPropertyCount: 0 });
    }

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

    return Result.ok({
      playbooksRun: txResult.playbooksRun,
      runPropertyCount: txResult.materializedPropertyIds.length,
    });
  },
);

export default autoRunPlaybooks;
