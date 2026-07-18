import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  flowDefinitionInputSchema,
  type FlowDefinitionInput,
  type FlowTrigger,
} from "@/api/lib/flows/flow-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

/**
 * Authoritative gate for a flow-definition write: parse the (TypeBox-validated)
 * body through the shared valibot schema for normalization + the deep
 * invariants, then verify any trigger-referenced workspace belongs to the
 * caller's organization. The workspace check runs through the org-scoped
 * `safeDb`, so its RLS also confirms the caller can access that workspace — you
 * cannot schedule / target a flow onto a workspace you have no access to.
 */
export const parseAndValidateFlowDefinition = async ({
  safeDb,
  organizationId,
  body,
}: {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  body: unknown;
}): Promise<Result<FlowDefinitionInput, HandlerError | SafeDbError>> =>
  await Result.gen(async function* () {
    const parsed = v.safeParse(flowDefinitionInputSchema, body);
    if (!parsed.success) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: `Invalid flow definition: ${parsed.issues
            .map((issue) => issue.message)
            .join("; ")
            .slice(0, 500)}`,
        }),
      );
    }
    const input = parsed.output;

    const triggerWorkspaceIds = collectTriggerWorkspaceIds(input.trigger);
    if (triggerWorkspaceIds.length > 0) {
      const owned = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.organizationId, organizationId),
                inArray(workspaces.id, triggerWorkspaceIds),
              ),
            ),
        ),
      );
      const ownedIds = new Set(owned.map((row) => row.id));
      const missing = triggerWorkspaceIds.filter((id) => !ownedIds.has(id));
      if (missing.length > 0) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "The trigger references a workspace outside this organization or one you cannot access.",
          }),
        );
      }
    }

    return Result.ok(input);
  });

const collectTriggerWorkspaceIds = (
  trigger: FlowTrigger,
): SafeId<"workspace">[] => {
  if (trigger.type === "schedule") {
    return [brandPersistedWorkspaceId(trigger.workspaceId)];
  }
  if (trigger.type === "file-upload" && trigger.workspaceIds) {
    return trigger.workspaceIds.map(brandPersistedWorkspaceId);
  }
  return [];
};
