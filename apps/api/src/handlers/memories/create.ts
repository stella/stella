import { Result } from "better-result";
import { t } from "elysia";

import { aiMemories } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
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

// Ownership provenance for the row: `workspaceId` is non-null only when
// the caller-supplied id matched one of the session's own accessible
// workspaces, so the raw request value can never reach the DB write or
// audit event unvalidated.
type MemoryWorkspaceScope =
  | { scope: "workspace"; workspaceId: SafeId<"workspace"> }
  | { scope: "user"; workspaceId: null };

// Mirrors the `validateWorkspaceAccess` macro for a root handler that
// takes the workspace from the body: the returned SafeId is the element
// found in the server-held `accessibleWorkspaceIds`, never the raw input.
// Keeps the schema's cross-field rules (workspace scope requires a
// workspace; user scope forbids one) as the single gate.
const resolveMemoryWorkspaceScope = ({
  scope,
  requestedWorkspaceId,
  accessibleWorkspaceIds,
}: {
  scope: "user" | "workspace";
  requestedWorkspaceId: SafeId<"workspace"> | undefined;
  accessibleWorkspaceIds: SafeId<"workspace">[];
}): Result<MemoryWorkspaceScope, HandlerError<400 | 404>> => {
  if (scope === "user") {
    if (requestedWorkspaceId) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "workspaceId is only valid for workspace-scoped memory",
        }),
      );
    }
    return Result.ok({ scope: "user", workspaceId: null });
  }

  if (!requestedWorkspaceId) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "workspaceId is required for workspace-scoped memory",
      }),
    );
  }

  const matchedWorkspaceId = accessibleWorkspaceIds.find(
    (accessibleWorkspaceId) => accessibleWorkspaceId === requestedWorkspaceId,
  );
  if (!matchedWorkspaceId) {
    return Result.err(
      new HandlerError({ status: 404, message: "Workspace not found" }),
    );
  }

  return Result.ok({ scope: "workspace", workspaceId: matchedWorkspaceId });
};

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
    body: {
      scope,
      kind,
      content,
      workspaceId: requestedWorkspaceId,
      pinned,
      language,
    },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    // Resolve ownership up front: the raw body workspaceId only becomes a
    // usable SafeId after matching the session's own accessible workspaces.
    const memoryScope = yield* resolveMemoryWorkspaceScope({
      scope,
      requestedWorkspaceId,
      accessibleWorkspaceIds: activeWorkspaceIds,
    });

    if (memoryScope.scope === "user" && MATTER_KINDS.has(kind)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `Kind "${kind}" is only allowed on workspace-scoped memory`,
        }),
      );
    }

    // Stored memory is replayed into future system prompts, so refuse
    // content carrying model-control sequences at the boundary.
    const sanitized = sanitizeMemoryContent(content);
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
            scope,
            userId: scope === "user" ? user.id : null,
            workspaceId: memoryScope.workspaceId,
            kind,
            content: sanitized.value,
            language: language ?? null,
            source: "user",
            pinned: pinned ?? false,
            createdBy: user.id,
          })
          .returning({ id: aiMemories.id });

        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
            resourceId: row.id,
            workspaceId: memoryScope.workspaceId,
            changes: {
              created: {
                old: null,
                new: { scope, kind },
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
