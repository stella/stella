import { chatSystemPrompts } from "@/api/handlers/chat/chat-request";
// oxlint-disable-next-line no-ad-hoc-chat-request/no-ad-hoc-chat-request
import { systemPromptsPatch } from "@/api/lib/tanstack-ai-generate";

declare const system: string;
declare const input: Parameters<typeof chatSystemPrompts>[0];

// A system prompt assembled by hand skips the cache layers.
// oxlint-disable-next-line no-ad-hoc-chat-request/no-ad-hoc-chat-request
const _handBuilt = { systemPrompts: [system] };

// Taken from the request module, it keeps them.
// expect-clean: no-ad-hoc-chat-request/no-ad-hoc-chat-request
const _built = { systemPrompts: chatSystemPrompts(input) };

export const __noAdHocChatRequestFixture = {
  _built,
  _handBuilt,
  systemPromptsPatch,
};
