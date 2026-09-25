import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/subagent-tool-shared";

/**
 * Chat tool names a skill's `stella-chat-excluded-tools` frontmatter can
 * withhold. `spawn_subagents` is the one gated tool today; the registry guard
 * test fails a built-in skill that declares another name, and
 * `resolveActiveChatSkillContext` drops one an installed skill declares.
 * Generalise to a filter over the tool map only when a second tool needs
 * excluding. A leaf over the shared tool name, so the resolution that narrows
 * a skill's declaration does not pull in the tool registry.
 */
export const EXCLUDABLE_CHAT_TOOL_NAMES = [SPAWN_SUBAGENTS_TOOL_NAME] as const;

export type ExcludableChatToolName =
  (typeof EXCLUDABLE_CHAT_TOOL_NAMES)[number];

export type ExcludedChatTools = {
  excluded: readonly ExcludableChatToolName[];
  rejected: readonly string[];
};

/** Every name outside `EXCLUDABLE_CHAT_TOOL_NAMES` comes back in `rejected`. */
export const toExcludedChatTools = (
  names: readonly string[],
): ExcludedChatTools => {
  const excluded: ExcludableChatToolName[] = [];
  const rejected: string[] = [];
  for (const name of names) {
    const excludable = EXCLUDABLE_CHAT_TOOL_NAMES.find(
      (candidate) => candidate === name,
    );
    if (excludable === undefined) {
      rejected.push(name);
    } else {
      excluded.push(excludable);
    }
  }
  return { excluded, rejected };
};
