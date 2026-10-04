import { Result } from "better-result";
import { t } from "elysia";

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
  // Firm-wide memory is governance-gated: only roles granted
  // `firmMemory.create` (admin, owner) may write it. Everyone reads it.
  permissions: { firmMemory: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  body: t.Object({
    // Firm memory is matter-agnostic by construction.
    kind: t.UnionEnum(["preference", "instruction"]),
    content: t.String({ minLength: 1, maxLength: 4000 }),
    pinned: t.Optional(t.Boolean()),
    language: t.Optional(t.String({ maxLength: 10 })),
  }),
} satisfies HandlerConfig;

const createFirmMemory = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const scope = yield* resolveMemoryWriteScope({
      accessibleWorkspaces: [],
      authority: memberRole,
      organizationId: session.activeOrganizationId,
      request: { scope: "organization", kind: body.kind },
      userId: user.id,
    }).mapError(memoryWriteRefusalHandlerError);
    // Firm memory is replayed into every member's chat prompt, so this is
    // the highest-blast-radius write; refuse model-control sequences here
    // even though only admins reach this route.
    const sanitized = sanitizePersonMemoryContent(body.content);
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
            memory: {
              content: sanitized.value,
              language: body.language ?? null,
              sourceDataWorkspaceIds: [],
              source: "user",
              pinned: body.pinned ?? false,
            },
          }),
      ),
    );

    return Result.ok(created);
  },
);

export default createFirmMemory;
