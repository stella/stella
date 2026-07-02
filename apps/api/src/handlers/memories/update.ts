import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { roles } from "@stll/permissions";

import { aiMemories } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeMemoryContent } from "@/api/lib/memory/memory-content-safety";

const config = {
  permissions: { chat: ["update"] },
  params: t.Object({ memoryId: tSafeId("aiMemory") }),
  body: t.Object({
    // Accept a suggestion (-> active) or dismiss/retire it (-> archived).
    // "suggested" and "stale" are machine-only transitions.
    // Plain `t.Union` (not `t.UnionEnum`): an absent optional UnionEnum
    // coerces to its first member ("active"), which would silently
    // re-activate a memory on any PATCH that omits `status`. With
    // `t.Union` an absent field stays `undefined`, and the handler's
    // `status !== undefined` guards leave the persisted status unchanged.
    status: t.Optional(t.Union([t.Literal("active"), t.Literal("archived")])),
    pinned: t.Optional(t.Boolean()),
    content: t.Optional(t.String({ minLength: 1, maxLength: 4000 })),
  }),
} satisfies HandlerConfig;

const updateMemory = createSafeRootHandler(
  config,
  async function* ({ body, memberRole, params, recordAuditEvent, safeDb }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: aiMemories.id,
            scope: aiMemories.scope,
            workspaceId: aiMemories.workspaceId,
          })
          .from(aiMemories)
          .where(eq(aiMemories.id, params.memoryId))
          .limit(1),
      ),
    );

    const row = existing.at(0);
    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Memory not found" }),
      );
    }

    // Firm memory is governance-gated. The row's scope is only known
    // after the fetch, so the firm permission is checked here rather
    // than statically in `config` (static permissions cannot branch on
    // the persisted row).
    if (row.scope === "organization") {
      const allowed = roles[memberRole.role].authorize({
        firmMemory: ["update"],
      });
      if (!allowed.success) {
        return Result.err(
          new HandlerError({ status: 403, message: "Forbidden" }),
        );
      }
    }

    // An edited body re-enters future prompts, so re-run the same
    // fail-closed sanitizer the create paths use.
    let sanitizedContent: string | undefined;
    if (body.content !== undefined) {
      const sanitized = sanitizeMemoryContent(body.content);
      if (Result.isError(sanitized)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Memory content contains disallowed sequences",
          }),
        );
      }
      sanitizedContent = sanitized.value;
    }

    const archiving = body.status === "archived";
    const activating = body.status === "active";

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const [result] = await tx
          .update(aiMemories)
          .set({
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
            ...(sanitizedContent !== undefined
              ? { content: sanitizedContent }
              : {}),
            ...(archiving ? { archivedAt: new Date() } : {}),
            ...(activating ? { archivedAt: null } : {}),
          })
          .where(eq(aiMemories.id, params.memoryId))
          .returning({ id: aiMemories.id });

        if (result) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
            resourceId: result.id,
            workspaceId: row.workspaceId,
            changes: {
              updated: {
                old: null,
                new: {
                  ...(body.status !== undefined ? { status: body.status } : {}),
                  ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
                  ...(body.content !== undefined
                    ? { contentEdited: true }
                    : {}),
                },
              },
            },
          });
        }

        return result;
      }),
    );

    if (!updated) {
      return Result.err(
        new HandlerError({ status: 500, message: "Failed to update memory" }),
      );
    }

    return Result.ok({ id: updated.id });
  },
);

export default updateMemory;
