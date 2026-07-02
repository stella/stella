import { Result } from "better-result";
import { t } from "elysia";

import { aiMemories } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeMemoryContent } from "@/api/lib/memory/memory-content-safety";

const config = {
  // Firm-wide memory is governance-gated: only roles granted
  // `firmMemory.create` (admin, owner) may write it. Everyone reads it.
  permissions: { firmMemory: ["create"] },
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

    const created = yield* Result.await(
      safeDb(async (tx) => {
        const [row] = await tx
          .insert(aiMemories)
          .values({
            organizationId: session.activeOrganizationId,
            scope: "organization",
            userId: null,
            workspaceId: null,
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
            changes: {
              created: {
                old: null,
                new: { scope: "organization", kind: body.kind },
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

export default createFirmMemory;
