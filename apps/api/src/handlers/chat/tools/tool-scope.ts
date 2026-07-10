import { APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME } from "@/api/handlers/chat/tools/active-docx-edit-tool";
import type { ChatToolMap } from "@/api/handlers/chat/tools/chat-tool-types";
import { SUGGEST_TEMPLATE_FIELDS_TOOL_NAME } from "@/api/handlers/chat/tools/template-tools";

/**
 * Named per-message tool scopes. A scoped send (for example the
 * Template Studio's "Suggest fields" preset) carries one of these
 * names; the server maps the name to a fixed allowlist below. The
 * client can only ever pick a scope by name — it cannot send an
 * arbitrary tool list, so a request can never widen its own tool
 * authorization, only narrow it.
 */
export const CHAT_TOOL_SCOPE = {
  suggestTemplateFields: "suggest-template-fields",
} as const;

export type ChatToolScope =
  (typeof CHAT_TOOL_SCOPE)[keyof typeof CHAT_TOOL_SCOPE];

const CHAT_TOOL_SCOPE_ALLOWLISTS = {
  [CHAT_TOOL_SCOPE.suggestTemplateFields]: new Set<string>([
    SUGGEST_TEMPLATE_FIELDS_TOOL_NAME,
    APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME,
  ]),
} as const satisfies Record<ChatToolScope, ReadonlySet<string>>;

/**
 * Whether `toolName` is on `scope`'s allowlist. Prompt construction
 * uses this to gate scope-restricted prompt flags (e.g. `subagents`)
 * on the same allowlist `restrictChatToolsToScope` enforces on the
 * streaming tool set, so the model is never steered toward a tool it
 * wasn't actually handed.
 */
export const scopeAllowsTool = (
  scope: ChatToolScope,
  toolName: string,
): boolean => CHAT_TOOL_SCOPE_ALLOWLISTS[scope].has(toolName);

/**
 * Narrow a turn's registered tools to the scope's allowlist. Applied
 * to the streaming tool set only; message validation keeps the broad
 * set so previously persisted tool parts still pass schema checks.
 */
export const restrictChatToolsToScope = (
  tools: ChatToolMap,
  scope: ChatToolScope,
): ChatToolMap => {
  const allowed = CHAT_TOOL_SCOPE_ALLOWLISTS[scope];
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => allowed.has(name)),
  );
};
