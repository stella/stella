import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { aiMemories } from "@/api/db/schema";
import { canManageMemory } from "@/api/handlers/memories/authorization";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["update"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  params: t.Object({ memoryId: tSafeId("aiMemory") }),
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
          .limit(1)
          .for("update");
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

        const deleted = await tx
          .delete(aiMemories)
          .where(
            and(
              eq(aiMemories.id, params.memoryId),
              eq(aiMemories.organizationId, session.activeOrganizationId),
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
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  },
);

export default deleteMemory;
