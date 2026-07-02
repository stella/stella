import { Result } from "better-result";

import { materializePlaybookRun } from "@/api/handlers/playbooks/materialize-run";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { startWorkflow } from "@/api/lib/workflow-queue";

const config = {
  permissions: { playbook: ["apply"] },
  mcp: { type: "pending" },
  params: workspaceParams({ playbookId: tSafeId("playbookDefinition") }),
} satisfies HandlerConfig;

const runPlaybook = createSafeHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    workspaceId,
    params,
    session,
    user,
    recordAuditEvent,
  }) {
    const organizationId = session.activeOrganizationId;

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const playbook = await tx.query.playbookDefinitions.findFirst({
          where: {
            id: { eq: params.playbookId },
            organizationId: { eq: organizationId },
          },
          columns: { positions: true, scope: true },
        });
        if (!playbook) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Playbook not found",
          };
        }

        return await materializePlaybookRun({
          tx,
          workspaceId,
          organizationId,
          playbookId: params.playbookId,
          positions: playbook.positions.items,
          scope: playbook.scope,
          recordAuditEvent,
        });
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

    if (txResult.materializedPropertyIds.length === 0) {
      return Result.ok({ runPropertyCount: 0 });
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
      runPropertyCount: txResult.materializedPropertyIds.length,
    });
  },
);

export default runPlaybook;
