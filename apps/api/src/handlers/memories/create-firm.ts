import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { AI_MEMORY_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { sanitizePersonMemoryContent } from "@/api/lib/memory/memory-content-safety";
import {
  memoryWriteRefusalHandlerError,
  persistExplicitMemory,
  resolveMemoryWriteScope,
} from "@/api/lib/memory/persist-explicit-memory";

const config = {
  featureAccess: { type: "required", featureId: AI_MEMORY_FEATURE_ID },
  contract: "patch",
  // Firm-wide memory is governance-gated: only roles granted
  // `firmMemory.create` (admin, owner) may write it. Everyone reads it.
  permissions: { firmMemory: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  body: v.object({
    kind: v.picklist(["preference", "instruction"]),
    content: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
    pinned: v.optional(v.boolean()),
    language: v.optional(v.pipe(v.string(), v.maxLength(10))),
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
