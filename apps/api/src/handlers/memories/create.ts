import { Result } from "better-result";
import { t } from "elysia";

import { aiMemories } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeMemoryContent } from "@/api/lib/memory/memory-content-safety";

// Matter-specific kinds may only live at workspace scope, so a fact
// about one matter can never be saved as user (cross-matter) memory.
const MATTER_KINDS: ReadonlySet<string> = new Set([
  "fact",
  "decision",
  "relationship",
]);

const config = {
  // Memory is part of the AI assistant; gate on the chat capability.
  // Firm-scoped writes go through the separate, permission-gated route.
  permissions: { chat: ["create"] },
  body: t.Object({
    scope: t.UnionEnum(["user", "workspace"]),
    kind: t.UnionEnum([
      "preference",
      "instruction",
      "fact",
      "decision",
      "relationship",
    ]),
    content: t.String({ minLength: 1, maxLength: 4000 }),
    workspaceId: t.Optional(tSafeId("workspace")),
    pinned: t.Optional(t.Boolean()),
    language: t.Optional(t.String({ maxLength: 10 })),
  }),
} satisfies HandlerConfig;

const createMemory = createSafeRootHandler(
  config,
  async function* ({
    activeWorkspaceIds,
    body,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const isWorkspaceScope = body.scope === "workspace";

    if (isWorkspaceScope && !body.workspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "workspaceId is required for workspace-scoped memory",
        }),
      );
    }
    if (!isWorkspaceScope && body.workspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "workspaceId is only valid for workspace-scoped memory",
        }),
      );
    }
    if (!isWorkspaceScope && MATTER_KINDS.has(body.kind)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Kind "${body.kind}" is only allowed on workspace-scoped memory`,
        }),
      );
    }

    const workspaceId =
      isWorkspaceScope && body.workspaceId ? body.workspaceId : null;

    // Ownership comes from the server context; the body-supplied
    // workspaceId is validated against the session's own workspaces.
    if (workspaceId && !activeWorkspaceIds.includes(workspaceId)) {
      return Result.err(
        new HandlerError({ status: 404, message: "Workspace not found" }),
      );
    }

    // Stored memory is replayed into future system prompts, so refuse
    // content carrying model-control sequences at the boundary.
    const sanitized = sanitizeMemoryContent(body.content);
    if (Result.isError(sanitized)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Memory content contains disallowed sequences",
        }),
      );
    }

    const created = yield* Result.await(
      safeDb(async (tx) => {
        const [row] = await tx
          .insert(aiMemories)
          .values({
            organizationId: session.activeOrganizationId,
            scope: body.scope,
            userId: body.scope === "user" ? user.id : null,
            workspaceId,
            kind: body.kind,
            content: sanitized.value,
            language: body.language ?? null,
            source: "user",
            pinned: body.pinned ?? false,
            createdBy: user.id,
          })
          .returning({ id: aiMemories.id });

        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
            resourceId: row.id,
            workspaceId,
            changes: {
              created: {
                old: null,
                new: { scope: body.scope, kind: body.kind },
              },
            },
          });
        }

        return row;
      }),
    );

    if (!created) {
      return Result.err(
        new HandlerError({ status: 500, message: "Failed to create memory" }),
      );
    }

    return Result.ok({ id: created.id });
  },
);

export default createMemory;
