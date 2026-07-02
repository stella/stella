import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import type { SafeDb } from "@/api/db";
import { aiMemories } from "@/api/db/schema";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { sanitizeMemoryContent } from "@/api/lib/memory/memory-content-safety";

export const REMEMBER_TOOL_NAME = "remember";

// Matter-specific kinds may only live at workspace scope (DB CHECK
// `ai_memories_kind_scope_check`); cross-matter user memory is limited
// to preferences and standing instructions, enforced at execute time.
const MEMORY_KINDS = [
  "preference",
  "instruction",
  "fact",
  "decision",
  "relationship",
] as const;

const MATTER_KINDS: ReadonlySet<string> = new Set([
  "fact",
  "decision",
  "relationship",
]);

const rememberToolInputSchema = v.strictObject({
  content: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(2000),
    v.description(
      "The fact, preference, instruction, or decision to remember.",
    ),
  ),
  kind: v.optional(
    v.pipe(
      v.picklist(MEMORY_KINDS),
      v.description(
        "What kind of memory this is. `fact`, `decision`, and `relationship` are only valid when the chat is scoped to a matter.",
      ),
    ),
  ),
  scope: v.optional(
    v.pipe(
      v.picklist(["user", "workspace"]),
      v.description(
        "`user` for cross-matter preferences/instructions; `workspace` to scope the memory to the chat's matter (only available in a matter chat).",
      ),
    ),
  ),
});

const rememberToolOutputSchema = v.strictObject({
  status: v.literal("saved"),
});

type CreateRememberToolProps = {
  organizationId: SafeId<"organization">;
  // Memory writes must leave an audit trail like the REST memories
  // handlers; the audit row commits in the same transaction as the
  // insert.
  recordAuditEvent: AuditRecorder;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  // The matter this chat is bound to, when any. Required for
  // workspace-scoped memory and for the matter-specific kinds.
  workspaceId: SafeId<"workspace"> | null;
};

export const createRememberTool = ({
  organizationId,
  recordAuditEvent,
  safeDb,
  userId,
  workspaceId,
}: CreateRememberToolProps) =>
  toolDefinition({
    name: REMEMBER_TOOL_NAME,
    description:
      'Persist a durable memory about the user, the firm\'s standing preferences, or this matter so future chats can apply it. Use sparingly for genuinely reusable facts (a stated drafting preference, a recurring instruction, a settled decision about this matter), not for one-off task details. Defaults to a cross-matter `user` memory; pass `scope: "workspace"` only when the chat is connected to a matter and the memory is matter-specific.',
    inputSchema: toTanStackToolSchema(rememberToolInputSchema),
    outputSchema: toTanStackToolSchema(rememberToolOutputSchema),
  }).server(async ({ content, kind, scope }) => {
    const resolvedScope = scope ?? "user";

    if (resolvedScope === "workspace" && workspaceId === null) {
      throw new ChatToolError({
        message:
          "Workspace-scoped memory is only available when the chat is connected to a matter.",
      });
    }

    const resolvedKind = kind ?? "preference";
    if (resolvedScope === "user" && MATTER_KINDS.has(resolvedKind)) {
      throw new ChatToolError({
        message: `Kind "${resolvedKind}" is only allowed on matter-scoped memory.`,
      });
    }

    // The stored content is replayed into future system prompts across
    // this scope, so refuse anything carrying model-control sequences
    // before it can become a persistent injection vector.
    const sanitized = sanitizeMemoryContent(content);
    if (Result.isError(sanitized)) {
      throw new ChatToolError({
        message:
          "That memory could not be saved because it contained control or model-instruction sequences.",
      });
    }

    const memoryWorkspaceId =
      resolvedScope === "workspace" ? workspaceId : null;

    const insertResult = await safeDb(async (tx) => {
      const [row] = await tx
        .insert(aiMemories)
        .values({
          organizationId,
          scope: resolvedScope,
          userId: resolvedScope === "user" ? userId : null,
          workspaceId: memoryWorkspaceId,
          kind: resolvedKind,
          content: sanitized.value,
          // Workspace memory is derived from this matter's content, so
          // gate later RLS reads on the same workspace.
          sourceDataWorkspaceIds: memoryWorkspaceId ? [memoryWorkspaceId] : [],
          source: "tool",
          status: "active",
          createdBy: userId,
        })
        .returning({ id: aiMemories.id });

      if (row) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
          resourceId: row.id,
          workspaceId: memoryWorkspaceId,
          changes: {
            created: {
              old: null,
              new: { scope: resolvedScope, kind: resolvedKind },
            },
          },
        });
      }

      return row;
    });

    if (Result.isError(insertResult)) {
      throw new ChatToolError({
        message: "Failed to save memory.",
        cause: insertResult.error,
      });
    }
    if (!insertResult.value) {
      throw new ChatToolError({ message: "Failed to save memory." });
    }

    return { status: "saved" } as const;
  });
