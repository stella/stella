import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import type { PermissionInput } from "@stll/permissions";

import { aiMemories } from "@/api/db/schema";
import type { AiMemoryScope } from "@/api/db/schema";
import { canManageMemory } from "@/api/handlers/memories/authorization";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { AI_MEMORY_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { sanitizePersonMemoryContent } from "@/api/lib/memory/memory-content-safety";
import { createMemoryDedupIdentity } from "@/api/lib/memory/memory-dedup";
import { holdCurrentMemoryWriteAuthority } from "@/api/lib/memory/persist-explicit-memory";
import { PG_ERROR } from "@/api/lib/pg-error";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  featureAccess: { type: "required", featureId: AI_MEMORY_FEATURE_ID },
  contract: "patch",
  description:
    "Change one assistant memory: accept a suggested memory (status " +
    "active), retire it (status archived), pin or unpin it, or edit its " +
    "content. Archiving is how a memory is removed; an archived memory must " +
    "be set active again before its content can change. Firm-wide memory " +
    "needs firm-memory permission, matter memory needs permission to update " +
    "that active matter.",
  permissions: { chat: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    confirmation: "required",
    reason: "assistant_memory",
    consumesServices: false,
  },
  realtime: noResourceSetUpdates(
    "Memory mutation callers invalidate the caller-scoped memory queries after a successful write.",
  ),
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

const REDACTED_AUDIT_VALUE = "[redacted]";
const MEMORY_UPDATE_PERMISSIONS = {
  organization: { firmMemory: ["update"] },
  user: { chat: ["update"] },
  workspace: { chat: ["update"], workspace: ["update"] },
} satisfies Record<AiMemoryScope, PermissionInput>;

const updateMemory = createSafeRootHandler(
  config,
  async function* ({
    body,
    getAccessibleWorkspaces,
    memberRole,
    params,
    recordAuditEvent,
    safeDb,
    user,
  }) {
    // An edited body re-enters future prompts, so re-run the same fail-closed
    // sanitizer the create paths use before opening the transaction.
    let sanitizedContent: string | undefined;
    if (body.content !== undefined) {
      const sanitized = sanitizePersonMemoryContent(body.content);
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

    const accessibleWorkspaces = yield* Result.await(
      Result.tryPromise(async () => await getAccessibleWorkspaces()),
    );

    const updateResult = yield* Result.ok(
      await safeDb(async (tx) => {
        // Read only the immutable ownership fields before locking. The live
        // authority hold must precede the memory-row lock so archive, deletion,
        // and member offboarding cannot commit between the final check and write.
        const targets = await tx
          .select({
            organizationId: aiMemories.organizationId,
            scope: aiMemories.scope,
            workspaceId: aiMemories.workspaceId,
          })
          .from(aiMemories)
          .where(eq(aiMemories.id, params.memoryId))
          .limit(1);
        const target = targets.at(0);
        if (!target) {
          return { type: "not_found" } as const;
        }
        if (
          !(await holdCurrentMemoryWriteAuthority({
            organizationId: target.organizationId,
            permissions: MEMORY_UPDATE_PERMISSIONS[target.scope],
            scope: target.scope,
            tx,
            userId: user.id,
            workspaceId: target.workspaceId,
          }))
        ) {
          return { type: "forbidden" } as const;
        }

        const lock = await withAggregateLock({
          aggregate: "memory",
          id: {
            id: params.memoryId,
            organizationId: target.organizationId,
          },
          mode: "update",
          tx,
        });
        if (lock.status !== "locked") {
          return { type: "not_found" } as const;
        }

        // Lock the row that drives authorization, lifecycle validation, dedup,
        // mutation, and audit. No curator or concurrent PATCH can change its
        // status between those decisions and the write.
        const existing = await tx
          .select({
            content: aiMemories.content,
            kind: aiMemories.kind,
            organizationId: aiMemories.organizationId,
            pinned: aiMemories.pinned,
            scope: aiMemories.scope,
            sourceDataWorkspaceIds: aiMemories.sourceDataWorkspaceIds,
            status: aiMemories.status,
            userId: aiMemories.userId,
            workspaceId: aiMemories.workspaceId,
          })
          .from(aiMemories)
          .where(eq(aiMemories.id, params.memoryId))
          .limit(1);

        const row = existing.at(0);
        if (!row) {
          return { type: "not_found" } as const;
        }
        if (
          row.organizationId !== target.organizationId ||
          row.scope !== target.scope ||
          row.workspaceId !== target.workspaceId
        ) {
          return { type: "forbidden" } as const;
        }

        if (
          !canManageMemory({
            accessibleWorkspaces,
            currentUserId: user.id,
            memberRole,
            memory: row,
          })
        ) {
          return { type: "forbidden" } as const;
        }

        if (sanitizedContent !== undefined && row.status === "archived") {
          return { type: "archived_content" } as const;
        }

        const contentChanged =
          sanitizedContent !== undefined && sanitizedContent !== row.content;
        const statusChanged =
          body.status !== undefined && body.status !== row.status;
        const pinnedChanged =
          body.pinned !== undefined && body.pinned !== row.pinned;
        if (!(contentChanged || statusChanged || pinnedChanged)) {
          return { type: "updated", id: params.memoryId } as const;
        }

        const dedupIdentity = (() => {
          if (!contentChanged || sanitizedContent === undefined) {
            return undefined;
          }
          const common = {
            kind: row.kind,
            content: sanitizedContent,
            sourceDataWorkspaceIds: row.sourceDataWorkspaceIds,
          } as const;
          if (row.scope === "organization") {
            return createMemoryDedupIdentity({
              ...common,
              scope: row.scope,
              userId: null,
              workspaceId: null,
            });
          }
          if (row.scope === "user" && row.userId !== null) {
            return createMemoryDedupIdentity({
              ...common,
              scope: row.scope,
              userId: row.userId,
              workspaceId: null,
            });
          }
          if (row.scope === "workspace" && row.workspaceId !== null) {
            return createMemoryDedupIdentity({
              ...common,
              scope: row.scope,
              userId: null,
              workspaceId: row.workspaceId,
            });
          }
          return panic("Invalid memory scope identity");
        })();
        const archiving = statusChanged && body.status === "archived";
        const activating = statusChanged && body.status === "active";
        const [result] = await tx
          .update(aiMemories)
          .set({
            ...(statusChanged ? { status: body.status } : {}),
            ...(pinnedChanged ? { pinned: body.pinned } : {}),
            ...(contentChanged && sanitizedContent !== undefined
              ? {
                  content: sanitizedContent,
                  ...(dedupIdentity
                    ? {
                        dedupKey: dedupIdentity.dedupKey,
                        sourceDataWorkspaceIds:
                          dedupIdentity.sourceDataWorkspaceIds,
                      }
                    : {}),
                }
              : {}),
            ...(archiving ? { archivedAt: new Date() } : {}),
            ...(activating ? { archivedAt: null, lastUsedAt: new Date() } : {}),
          })
          .where(eq(aiMemories.id, params.memoryId))
          .returning({ id: aiMemories.id });

        if (!result) {
          return { type: "not_found" } as const;
        }

        const changes: FieldDiffs = {
          ...(statusChanged
            ? { status: { old: row.status, new: body.status } }
            : {}),
          ...(pinnedChanged
            ? { pinned: { old: row.pinned, new: body.pinned } }
            : {}),
          ...(contentChanged
            ? {
                content: {
                  old: REDACTED_AUDIT_VALUE,
                  new: REDACTED_AUDIT_VALUE,
                },
              }
            : {}),
        };
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
          resourceId: result.id,
          workspaceId: row.workspaceId,
          changes,
        });

        return { type: "updated", id: result.id } as const;
      }),
    );

    if (Result.isError(updateResult)) {
      if (
        DatabaseError.is(updateResult.error) &&
        updateResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "An identical memory already exists",
          }),
        );
      }
      return Result.err(updateResult.error);
    }
    const outcome = updateResult.value;
    switch (outcome.type) {
      case "updated":
        return Result.ok({ id: outcome.id });
      case "not_found":
        return Result.err(
          new HandlerError({ status: 404, message: "Memory not found" }),
        );
      case "forbidden":
        return Result.err(
          new HandlerError({ status: 403, message: "Forbidden" }),
        );
      case "archived_content":
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Archived memories must be restored before editing",
          }),
        );
      default: {
        outcome satisfies never;
        return panic(`Unhandled outcome: ${String(outcome)}`);
      }
    }
  },
);

export default updateMemory;
