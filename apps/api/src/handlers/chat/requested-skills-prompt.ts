import type { Result } from "better-result";

import type { SafeDbError } from "@/api/db/safe-db";
import type { ActiveChatSkillContext } from "@/api/handlers/chat/active-skill-context";
import { chatPartText } from "@/api/handlers/chat/chat-message-parts";
import { buildRequestedSkillsSection } from "@/api/handlers/chat/chat-prompt";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { resolveRequestedSkills } from "@/api/lib/agent-skills/requested-skills";
import type { ResolveRequestedSkillsOptions } from "@/api/lib/agent-skills/requested-skills";
import { extractSkillRefSlugs } from "@/api/lib/agent-skills/skill-refs";

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
  const requested = await resolveRequestedSkills({
    ...options,
    activeSkillId: activeSkillContext?.id ?? undefined,
    messageText: latestUserMessageText(messages),
  });
  return requested.map(buildRequestedSkillsSection);
};

/**
 * The skills the latest user message references explicitly, by slug: the
 * user's own invocation, which is what lets a `manual` skill into the turn.
 */
export const requestedSkillNames = (
  messages: readonly Pick<ChatMessage, "parts" | "role">[],
): ReadonlySet<string> =>
  new Set(extractSkillRefSlugs(latestUserMessageText(messages)));

const latestUserMessageText = (
  messages: readonly Pick<ChatMessage, "parts" | "role">[],
): string => {
  const latestUserMessage = messages.findLast(
    (message) => message.role === "user",
  );
  return latestUserMessage === undefined
    ? ""
    : latestUserMessage.parts
        .map((part) => chatPartText(part) ?? "")
        .join("\n");
};
