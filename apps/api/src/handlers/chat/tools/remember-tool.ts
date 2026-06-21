import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import { Result } from "better-result";
import * as v from "valibot";

import type { SafeDb } from "@/api/db";
import { aiMemories } from "@/api/db/schema";
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
  safeDb: SafeDb;
  userId: SafeId<"user">;
  // The matter this chat is bound to, when any. Required for
  // workspace-scoped memory and for the matter-specific kinds.
  workspaceId: SafeId<"workspace"> | null;
};

export const createRememberTool = ({
  organizationId,
  safeDb,
  userId,
  workspaceId,
}: CreateRememberToolProps) =>
  tool({
    description:
      'Persist a durable memory about the user, the firm\'s standing preferences, or this matter so future chats can apply it. Use sparingly for genuinely reusable facts (a stated drafting preference, a recurring instruction, a settled decision about this matter), not for one-off task details. Defaults to a cross-matter `user` memory; pass `scope: "workspace"` only when the chat is connected to a matter and the memory is matter-specific.',
    inputSchema: valibotSchema(rememberToolInputSchema),
    outputSchema: valibotSchema(rememberToolOutputSchema),
    execute: async ({ content, kind, scope }) => {
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

      const insertResult = await safeDb((tx) =>
        tx.insert(aiMemories).values({
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
        }),
      );

      if (Result.isError(insertResult)) {
        throw new ChatToolError({
          message: "Failed to save memory.",
          cause: insertResult.error,
        });
      }

      return { status: "saved" } as const;
    },
  });
