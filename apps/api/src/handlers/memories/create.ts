import { Result } from "better-result";

import { roles } from "@stll/permissions";

import { createMemoryBodySchema } from "@/api/handlers/memories/create-schema";
import type { CreateMemoryBody } from "@/api/handlers/memories/create-schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeMemoryContent } from "@/api/lib/memory/memory-content-safety";
import { createMemoryDedupIdentity } from "@/api/lib/memory/memory-dedup";
import { persistExplicitMemory } from "@/api/lib/memory/persist-explicit-memory";

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
  request,
  accessibleWorkspaceIds,
}: {
  request: CreateMemoryBody;
  accessibleWorkspaceIds: SafeId<"workspace">[];
}): Result<MemoryWorkspaceScope, HandlerError<404>> => {
  if (request.scope === "user") {
    return Result.ok({ scope: "user", workspaceId: null });
  }

  const matchedWorkspaceId = accessibleWorkspaceIds.find(
    (accessibleWorkspaceId) => accessibleWorkspaceId === request.workspaceId,
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
  mcp: { type: "internal", reason: "assistant_chat" },
  body: createMemoryBodySchema,
} satisfies HandlerConfig;

const createMemory = createSafeRootHandler(
  config,
  async function* ({
    body,
    getAccessibleWorkspaces,
    memberRole,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const { kind, content, pinned, language } = body;
    const accessibleWorkspaces = yield* Result.await(
      Result.tryPromise(async () => await getAccessibleWorkspaces()),
    );
    // Resolve ownership up front: the raw body workspaceId only becomes a
    // usable SafeId after matching the session's own accessible workspaces.
    const memoryScope = yield* resolveMemoryWorkspaceScope({
      request: body,
      accessibleWorkspaceIds: accessibleWorkspaces
        .filter(({ status }) => status === "active")
        .map(({ id }) => id),
    });

    if (
      memoryScope.scope === "workspace" &&
      !roles[memberRole.role].authorize({ workspace: ["update"] }).success
    ) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

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
    const identity =
      memoryScope.scope === "user"
        ? createMemoryDedupIdentity({
            scope: memoryScope.scope,
            userId: user.id,
            workspaceId: null,
            kind,
            content: sanitized.value,
            sourceDataWorkspaceIds: [],
          })
        : createMemoryDedupIdentity({
            scope: memoryScope.scope,
            userId: null,
            workspaceId: memoryScope.workspaceId,
            kind,
            content: sanitized.value,
            sourceDataWorkspaceIds: [],
          });

    const created = yield* Result.await(
      safeDb(
        async (tx) =>
          await persistExplicitMemory({
            tx,
            recordAuditEvent,
            metadataOnConflict: {
              ...(language !== undefined ? { language } : {}),
              ...(pinned !== undefined ? { pinned } : {}),
            },
            values: {
              organizationId: session.activeOrganizationId,
              scope: memoryScope.scope,
              userId: memoryScope.scope === "user" ? user.id : null,
              workspaceId: memoryScope.workspaceId,
              kind,
              content: sanitized.value,
              dedupKey: identity.dedupKey,
              language: language ?? null,
              sourceDataWorkspaceIds: identity.sourceDataWorkspaceIds,
              source: "user",
              status: "active",
              pinned: pinned ?? false,
              createdBy: user.id,
            },
          }),
      ),
    );

    return Result.ok(created);
  },
);

export default createMemory;
