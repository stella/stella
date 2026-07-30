import type { ChatMessage } from "@stll/api/types";

type MobileChatThreadPage = {
  messages: ChatMessage[];
  olderCursor: string | null;
};

export const mergeMobileChatThreadPages = (
  pages: readonly MobileChatThreadPage[] | undefined,
): ChatMessage[] => pages?.toReversed().flatMap((page) => page.messages) ?? [];
