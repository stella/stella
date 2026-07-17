import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeMemoryContent } from "@/api/lib/memory/memory-content-safety";
import { createMemoryDedupIdentity } from "@/api/lib/memory/memory-dedup";
import { persistExplicitMemory } from "@/api/lib/memory/persist-explicit-memory";

const config = {
  // Firm-wide memory is governance-gated: only roles granted
  // `firmMemory.create` (admin, owner) may write it. Everyone reads it.
  permissions: { firmMemory: ["create"] },
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
  async function* ({ body, recordAuditEvent, safeDb, session, user }) {
    // Firm memory is replayed into every member's chat prompt, so this is
    // the highest-blast-radius write; refuse model-control sequences here
    // even though only admins reach this route.
    const sanitized = sanitizeMemoryContent(body.content);
    if (Result.isError(sanitized)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Memory content contains disallowed sequences",
        }),
      );
    }
    const identity = createMemoryDedupIdentity({
      scope: "organization",
      userId: null,
      workspaceId: null,
      kind: body.kind,
      content: sanitized.value,
      sourceDataWorkspaceIds: [],
    });

    const created = yield* Result.await(
      safeDb(
        async (tx) =>
          await persistExplicitMemory({
            tx,
            recordAuditEvent,
            values: {
              organizationId: session.activeOrganizationId,
              scope: "organization",
              userId: null,
              workspaceId: null,
              kind: body.kind,
              content: sanitized.value,
              dedupKey: identity.dedupKey,
              language: body.language ?? null,
              sourceDataWorkspaceIds: identity.sourceDataWorkspaceIds,
              source: "user",
              status: "active",
              pinned: body.pinned ?? false,
              createdBy: user.id,
            },
          }),
      ),
    );

    return Result.ok(created);
  },
);

export default createFirmMemory;
