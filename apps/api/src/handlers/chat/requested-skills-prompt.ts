import type { Result } from "better-result";

import type { SafeDbError } from "@/api/db/safe-db";
import { chatPartText } from "@/api/handlers/chat/chat-message-parts";
import { buildRequestedSkillsSection } from "@/api/handlers/chat/chat-prompt";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { resolveRequestedSkills } from "@/api/lib/agent-skills/requested-skills";
import type { ResolveRequestedSkillsOptions } from "@/api/lib/agent-skills/requested-skills";
import type { ActiveChatSkillContext } from "@/api/lib/agent-skills/skills";

type RequestedSkillsPromptOptions = Omit<
  ResolveRequestedSkillsOptions,
  "activeSkillId" | "messageText"
> & {
  activeSkillContext: ActiveChatSkillContext | null;
  messages: readonly ChatMessage[];
};

/**
 * The prompt section carrying the skills the latest user message references
 * explicitly. They load for the whole turn, continuations included, so the
 * pick never depends on the model.
 */
export const loadRequestedSkillsPrompt = async ({
  activeSkillContext,
  messages,
  ...options
}: RequestedSkillsPromptOptions): Promise<Result<string, SafeDbError>> => {
  const latestUserMessage = messages.findLast(
    (message) => message.role === "user",
  );
  const messageText =
    latestUserMessage === undefined
      ? ""
      : latestUserMessage.parts
          .map((part) => chatPartText(part) ?? "")
          .join("\n");
  const requested = await resolveRequestedSkills({
    ...options,
    activeSkillId: activeSkillContext?.id,
    messageText,
  });
  return requested.map(buildRequestedSkillsSection);
};
