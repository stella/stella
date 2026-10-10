import { Result } from "better-result";

import { createMemoryBodySchema } from "@/api/handlers/memories/create-schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizePersonMemoryContent } from "@/api/lib/memory/memory-content-safety";
import {
  memoryWriteRefusalHandlerError,
  persistExplicitMemory,
  resolveMemoryWriteScope,
} from "@/api/lib/memory/persist-explicit-memory";

const config = {
  // Memory is part of the AI assistant; gate on the chat capability.
  // Firm-scoped writes go through the separate, permission-gated route.
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
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
    const { content, pinned, language } = body;
    const accessibleWorkspaces = yield* Result.await(
      Result.tryPromise(async () => await getAccessibleWorkspaces()),
    );
    // The body's workspace id only becomes the row's owner after it matches
    // one of the session's own accessible, active workspaces.
    const scope = yield* resolveMemoryWriteScope({
      accessibleWorkspaces,
      authority: memberRole,
      organizationId: session.activeOrganizationId,
      request: body,
      userId: user.id,
    }).mapError(memoryWriteRefusalHandlerError);

    // Stored memory is replayed into future system prompts, so refuse
    // content carrying model-control sequences at the boundary.
    const sanitized = sanitizePersonMemoryContent(content);
    if (Result.isError(sanitized)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Memory content contains disallowed sequences",
        }),
      );
    }

    const created = yield* Result.await(
      safeDb(
        async (tx) =>
          await persistExplicitMemory({
            tx,
            recordAuditEvent,
            scope,
            metadataOnConflict: {
              ...(language !== undefined ? { language } : {}),
              ...(pinned !== undefined ? { pinned } : {}),
            },
            memory: {
              content: sanitized.value,
              language: language ?? null,
              sourceDataWorkspaceIds: [],
              source: "user",
              pinned: pinned ?? false,
            },
          }),
      ),
    );

    return Result.ok(created);
  },
);

export default createMemory;
