import { panic, Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import { aiMemories } from "@/api/db/schema";
import { canManageMemory } from "@/api/handlers/memories/authorization";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { AI_MEMORY_FEATURE_ID } from "@/api/lib/feature-access/registry";

const config = {
  featureAccess: { type: "required", featureId: AI_MEMORY_FEATURE_ID },
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  permissions: { chat: ["update"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  params: v.object({ memoryId: resourceIdSchema("aiMemory") }),
} satisfies HandlerConfig;

const deleteMemory = createSafeRootHandler(
  config,
  async function* ({
    getAccessibleWorkspaces,
    memberRole,
    params,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const accessibleWorkspaces = yield* Result.await(
      Result.tryPromise(async () => await getAccessibleWorkspaces()),
    );

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({
            scope: aiMemories.scope,
            userId: aiMemories.userId,
            workspaceId: aiMemories.workspaceId,
          })
          .from(aiMemories)
          .where(
            and(
              eq(aiMemories.id, params.memoryId),
              eq(aiMemories.organizationId, session.activeOrganizationId),
            ),
          )
          .limit(1);
        const memory = rows.at(0);
        if (!memory) {
          return { type: "not_found" } as const;
        }
        if (
          !canManageMemory({
            accessibleWorkspaces,
            currentUserId: user.id,
            memberRole,
            memory,
          })
        ) {
          return { type: "forbidden" } as const;
        }

        // Recheck every ownership field in the mutation so authorization and
        // deletion agree even if the row changes after the read.
        const deleted = await tx
          .delete(aiMemories)
          .where(
            and(
              eq(aiMemories.id, params.memoryId),
              eq(aiMemories.organizationId, session.activeOrganizationId),
              eq(aiMemories.scope, memory.scope),
              memory.userId === null
                ? isNull(aiMemories.userId)
                : eq(aiMemories.userId, memory.userId),
              memory.workspaceId === null
                ? isNull(aiMemories.workspaceId)
                : eq(aiMemories.workspaceId, memory.workspaceId),
            ),
          )
          .returning({
            id: aiMemories.id,
            workspaceId: aiMemories.workspaceId,
          });
        const erased = deleted.at(0);
        if (!erased) {
          return { type: "not_found" } as const;
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
          resourceId: erased.id,
          workspaceId: erased.workspaceId,
          changes: { deleted: { old: null, new: null } },
        });
        return { type: "deleted", id: erased.id } as const;
      }),
    );

    switch (outcome.type) {
      case "deleted":
        return Result.ok({ id: outcome.id });
      case "not_found":
        return Result.err(
          new HandlerError({ status: 404, message: "Memory not found" }),
        );
      case "forbidden":
        return Result.err(
          new HandlerError({ status: 403, message: "Forbidden" }),
        );
      default: {
        outcome satisfies never;
        return panic("Unhandled memory deletion outcome");
      }
    }
  },
);

declareAggregateMutation(deleteMemory, {
  type: "independent",
  reason:
    "Deletes one memory row in one transaction and re-checks its ownership fields in the delete itself; no aggregate state spans memories.",
});

export default deleteMemory;
